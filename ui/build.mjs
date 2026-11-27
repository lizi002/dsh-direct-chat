import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const harnessPackages = new URL('../../deepseek-harness/node_modules/.pnpm/', import.meta.url)
let esbuild
try {
  esbuild = require('esbuild')
} catch {
  const esbuildPkg = new URL('esbuild@0.28.1/node_modules/esbuild/package.json', harnessPackages)
  if (!existsSync(esbuildPkg)) {
    throw new Error('esbuild is required to build ui/client.js; run `npm install` first or use the prebuilt ui/client.js.')
  }
  esbuild = createRequire(esbuildPkg)('.')
}
const { build } = esbuild
const forgePackage = '@deepseek-ai/dsh-experimental-client-ui-forge'

const nativePackages = ['dsh-experimental-client-ui-forge', 'dsh-client-ui-attachment', 'dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-client-ui-input-trigger', 'dsh-client-ui-jobs', 'dsh-client-ui-sidebar-right', 'dsh-client-ui-sidebar-terminal', 'dsh-client-ui-workspace']
  .map(name => '@deepseek-ai/' + name)

function replaceExact(source, before, after, label) {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Unexpected build patch point (${label}): ${before}`)
  }
  return source.replace(before, () => after)
}

function resolveNativePackages() {
  const installations = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .map(directory => join(directory, 'dsh')).filter(existsSync)
  for (const candidate of [require, ...installations.map(path => createRequire(realpathSync(path)))]) {
    try {
      for (const name of [...nativePackages, '@deepseek-ai/dsh-util-workspace-path', '@deepseek-ai/dsh-api-workspace-controller']) candidate.resolve(`${name}/package.json`)
      return candidate
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`Install DSH with ${forgePackage} or install the direct-chat development dependencies`)
}

const native = resolveNativePackages()
const rightbarSource = native.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/shell/SidebarRight.tsx')
const viewedFilesSource = native.resolve(`${forgePackage}/src/client/viewed-files.ts`)
const { outputFiles } = await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['index.jsx'],
  outfile: 'client.js',
  write: false,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text', '.module.css': 'local-css', '.png': 'dataurl' },
  nodePaths: [
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    fileURLToPath(new URL('@tanstack+react-virtual@3.14.9_react-dom@18.3.1_react@18.3.1__react@18.3.1/node_modules', harnessPackages)),
    fileURLToPath(new URL('clsx@2.1.1/node_modules', harnessPackages)),
  ].filter(existsSync),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{
    name: 'native-dsh-ui',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-util-workspace-path$/ }, () => ({
        path: native.resolve('@deepseek-ai/dsh-util-workspace-path/src/index.ts'),
      }))
      build.onResolve({ filter: /^@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$/ }, () => ({
        path: native.resolve('@deepseek-ai/dsh-api-workspace-controller/src/default-workspace.ts'),
      }))
      build.onResolve({ filter: /^@deepseek-ai\/dsh-(?:experimental-client-ui-forge|client-ui-(?:attachment|chat|conversation|input-trigger|jobs|sidebar-right|sidebar-terminal|workspace))\/src\// }, ({ path }) => ({
        path: native.resolve(path),
      }))
      build.onLoad({ filter: /JobListAction\.tsx$/ }, async ({ path }) => {
        if (!path.includes('dsh-client-ui-jobs')) return
        const source = await readFile(path, 'utf8')
        // The rc.1 host exposes the checklist icon for the task list.
        const contents = replaceExact(source, 'IconLayersOutlineRegular,', 'IconChecklistOutlineRegular as IconLayersOutlineRegular,', 'JobListAction icon')
        return { contents, loader: 'tsx', resolveDir: dirname(path) }
      })
      build.onLoad({ filter: /tree\.ts$/ }, async ({ path }) => {
        if (!path.includes('dsh-client-ui-workspace')) return
        const source = await readFile(path, 'utf8')
        const contents = replaceExact(source, 'sessionCount: g.sessions.length,',
          'sessionCount: g.sessions.length,\n      latestSessionUpdate: g.sessions.reduce((latest, session) => session.blank ? latest : Math.max(latest, session.updatedAt || 0), 0),',
          'Workspace group activity before folding')
        return { contents, loader: 'ts' }
      })
      build.onLoad({ filter: /WorkspaceBrowser\.tsx$/ }, async ({ path }) => {
        if (!path.includes('dsh-client-ui-workspace')) return
        let source = await readFile(path, 'utf8')
        source = replaceExact(source,
          "import { ProjectRowItem, SearchResultItem, SessionNodeItem } from './Rows.tsx'",
          "import { ProjectRowItem, SearchResultItem, SessionNodeItem, timeLabel } from './Rows.tsx'\nimport RowsCss from './Rows.module.css'\nconst directChatClock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' })\nfunction directChatFormatTime(at: number) { return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? directChatClock.format(at) : undefined }",
          'WorkspaceBrowser imports')
        source = replaceExact(source,
          'function SessionTree({\n  list,',
          'function SessionTree({\n  extension,\n  list,',
          'SessionTree params')
        source = replaceExact(source,
          '}: SessionTreeProps) {',
          '}: SessionTreeProps & { extension?: any }) {',
          'SessionTree type')
        source = replaceExact(source,
          'const groups = useMemo(\n    () => deriveGroups(list, workspaces, rowState, statuses, {\n      expandedGroups,\n      ungroupedOrder: ungroupedSessionIds,\n    }),\n    [list, workspaces, rowState, statuses, expandedGroups, ungroupedSessionIds],\n  )',
          'const nativeGroups = useMemo(\n    () => deriveGroups(list, workspaces, rowState, statuses, {\n      expandedGroups,\n      ungroupedOrder: ungroupedSessionIds,\n    }),\n    [list, workspaces, rowState, statuses, expandedGroups, ungroupedSessionIds],\n  )\n  const groups = extension?.groups(nativeGroups, workspaces, expandedGroups, rowState.archivedFilter, extension.orderBy) ?? nativeGroups',
          'SessionTree groups')
        source = replaceExact(source,
          '  const baselines = new Map(groups.map(group => [group.key, Math.max(SESSION_WATERMARK_BASE, requiredWatermark(\n    group.sessions,\n    current,',
          '  const baselines = new Map(groups.map(group => [group.key, Math.max(SESSION_WATERMARK_BASE, requiredWatermark(\n    group.sessions,\n    current ?? extension?.activeId,',
          'SessionTree baselines')
        source = replaceExact(source,
          'const renderedSessions = watermarkRows(group.sessions, sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE).rows',
          'const renderedSessions = watermarkRows(group.sessions, sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE).rows.filter((node: any) => !node.directChat)',
          'SessionTree commitSessionDrag')
        source = replaceExact(source,
          '    const sessions = visible.rows\n    for (const node of sessions) rowKeys.push(`session:${node.id}`)',
          '    const sessions = visible.rows\n    for (const node of sessions) if (!(node as any).directChat) rowKeys.push(`session:${node.id}`)',
          'SessionTree rowKeys')
        source = replaceExact(source,
          '          drag={workspaceDragProps}\n        />',
          '          drag={workspaceDragProps}\n          directActions={(group as any).directCwd === undefined ? undefined : extension?.renderFolderActions(group, RowsCss, setGroupExpanded)}\n        />',
          'ProjectRowItem directActions')
        source = replaceExact(source,
          '        {sessions.map((node) => {\n        // Session drag',
          '        {sessions.map((node) => {\n          if ((node as any).directChat) return extension.renderRow(node, RowsCss, timeLabel(node.updatedAt, now, t), directChatFormatTime)\n        // Session drag',
          'SessionTree directChat row')
        source = replaceExact(source,
          'function FlatList({\n  list,',
          'function FlatList({\n  extension,\n  list,',
          'FlatList params')
        source = replaceExact(source,
          '> & {\n  list: SessionListState\n  sessionIds: readonly SessionId[]\n}) {',
          '> & {\n  extension?: any\n  list: SessionListState\n  sessionIds: readonly SessionId[]\n}) {',
          'FlatList type')
        source = replaceExact(source,
          '  const rows = useMemo(\n    () => deriveFlat(list, sessionIds, rowState, statuses),\n    [list, sessionIds, rowState, statuses],\n  )',
          '  const nativeRows = useMemo(\n    () => deriveFlat(list, sessionIds, rowState, statuses),\n    [list, sessionIds, rowState, statuses],\n  )\n  const rows = extension?.flat(nativeRows, rowState.archivedFilter) ?? nativeRows',
          'FlatList rows')
        source = replaceExact(source,
          'const nextOrder = sessionDragOrder(sessionIds, rows, activeDrag, over)',
          'const nextOrder = sessionDragOrder(sessionIds, rows.filter((node: any) => !node.directChat), activeDrag, over)',
          'FlatList drag order')
        source = replaceExact(source,
          '        {rows.map((node) => {\n          const active = drag !== null && drag.pinned === node.pinned',
          '        {rows.map((node) => {\n          if ((node as any).directChat) return extension.renderRow(node, RowsCss, timeLabel(node.updatedAt, now, t), directChatFormatTime)\n          const active = drag !== null && drag.pinned === node.pinned',
          'FlatList directChat row')
        source = replaceExact(source,
          '  renderSlot, renderFactorySlot, useContextMenuTarget, useContextMenu,\n  t,\n}: WorkspaceBrowserProps) {',
          '  renderSlot, renderFactorySlot, useContextMenuTarget, useContextMenu,\n  t,\n  extension,\n}: WorkspaceBrowserProps & { extension?: any }) {',
          'WorkspaceBrowser params')
        source = replaceExact(source,
          '        <div className={clsx(css.headerActions, wide && searchExpanded && css.headerActionsHidden)}>',
          '        {wide && !searchExpanded && extension?.renderToolbar?.()}\n        <div className={clsx(css.headerActions, wide && searchExpanded && css.headerActionsHidden)}>',
          'WorkspaceBrowser toolbar')
        source = replaceExact(source,
          '              <FlatList\n                useSessionAccess={useSessionAccess}',
          '              <FlatList\n                extension={extension}\n                useSessionAccess={useSessionAccess}',
          'WorkspaceBrowser FlatList')
        source = replaceExact(source,
          '              <SessionTree\n                useSessionAccess={useSessionAccess}',
          '              <SessionTree\n                extension={{ ...extension, orderBy }}\n                useSessionAccess={useSessionAccess}',
          'WorkspaceBrowser SessionTree')
        source = replaceExact(source,
          '                setGroupExpanded={actions.setGroupExpanded}',
          '                setGroupExpanded={(key, expanded) => { if (!extension?.expandGroup(key, expanded)) actions.setGroupExpanded(key, expanded) }}',
          'WorkspaceBrowser setGroupExpanded')
        source = replaceExact(source, 'function ViewOptionsMenu({ groupBy,', 'function ViewOptionsMenu({ extension, groupBy,', 'Agent menu props')
        source = replaceExact(source, '      <ViewOptionsMenu', '      <ViewOptionsMenu extension={extension}', 'Agent menu')
        source = replaceExact(source, '      selectedIds={[\n        groupBy,',
          '      selectedIds={[\n        "agent:" + extension.agent,\n        groupBy,', 'Selected Agent')
        source = replaceExact(source, "icon: <IconArchiveCheckOutlineRegular /> },",
          "icon: <IconArchiveCheckOutlineRegular /> },\n        ...extension.agentItems,", 'Agent choices')
        source = replaceExact(source, "        if (id === 'workspace' ||", "        if (id.startsWith('agent:')) extension.setAgent(id.slice(6))\n        else if (id === 'workspace' ||", 'Agent selection')
        source = replaceExact(source, "{wide && (normalizedQuery !== ''", "{wide && (normalizedQuery !== '' && !extension.directOnly", 'Agent search results')
        source = replaceExact(source, ": groupBy === 'flat'", ": groupBy === 'flat' || (normalizedQuery && extension.directOnly)", 'Filtered search list')
        source = replaceExact(source, '<FlatList\n                extension={extension}', '<FlatList\n                extension={{ ...extension, query: normalizedQuery }}', 'Filtered search query')
        source = replaceExact(source, 'extension?.flat(nativeRows, rowState.archivedFilter)', 'extension?.flat(nativeRows, rowState.archivedFilter, extension.query)', 'Filter direct matches')
        return { contents: source, loader: 'tsx' }
      })
      build.onLoad({ filter: /Rows\.tsx$/ }, async ({ path }) => {
        if (!path.includes('dsh-client-ui-workspace')) return
        let source = await readFile(path, 'utf8')
        source = replaceExact(source, 'function useTitleMarquee(', 'export function useTitleMarquee(', 'Rows title marquee')
        source = replaceExact(source,
          'function timeLabel(',
          'export function timeLabel(',
          'Rows export timeLabel')
        source = replaceExact(source,
          'function hoverTimeLabel(',
          "const directChatClock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' })\nfunction directChatFormatTime(at: number) { return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? directChatClock.format(at) : undefined }\nfunction hoverTimeLabel(",
          'Rows directChatFormatTime')
        source = replaceExact(source,
          'type ProjectRowItemProps = {',
          'type ProjectRowItemProps = {\n  directActions?: ReactNode',
          'Rows ProjectRowItemProps')
        source = replaceExact(source,
          'function ProjectRow({\n  group, containsCurrentDescendant = false, onToggle, drag: offeredDrag, home, newShortcut, t, actions,',
          'function ProjectRow({\n  group, containsCurrentDescendant = false, onToggle, drag: offeredDrag, home, newShortcut, t, actions, directActions,',
          'Rows ProjectRow params')
        source = replaceExact(source,
          "const label = row.workspaceId === undefined ? t('group.ungrouped') : row.label",
          "const label = row.workspaceId === undefined && !(row as any).directCwd ? t('group.ungrouped') : row.label",
          'Rows ProjectRow label')
        source = replaceExact(source,
          '      <span className={css.rowActions}>\n        {workspaceMenuTarget !== undefined && (',
          '      <span className={css.rowActions}>\n        {directActions}\n        {workspaceMenuTarget !== undefined && (',
          'Rows ProjectRow directActions')
        source = replaceExact(source,
          '{!node.blank && <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now, t)}</div>}',
          '{!node.blank && <div className={css.hoverTime}>{directChatFormatTime(node.updatedAt) ?? hoverTimeLabel(node.updatedAt, now, t)}</div>}',
          'Rows hoverTime')
        source = replaceExact(source,
          '          <span\n            className={clsx(css.time, primaryStatus.trailingLabel === undefined && css.timestamp)}\n            aria-hidden={primaryStatus.trailingLabel === undefined ? undefined : true}\n          >',
          '          <span\n            className={clsx(css.time, primaryStatus.trailingLabel === undefined && css.timestamp)}\n            title={directChatFormatTime(row.updatedAt)}\n            aria-hidden={primaryStatus.trailingLabel === undefined ? undefined : true}\n          >',
          'Rows time title')
        return { contents: source, loader: 'tsx' }
      })
      // rc.5 shares its dock kit publicly but keeps the two panel buttons local to this module.
      build.onLoad({ filter: /SidebarRight\.tsx$/ }, async ({ path }) => {
        if (path !== rightbarSource) return
        const source = await readFile(path, 'utf8')
        return { contents: source + '\nexport { PanelChrome }\n', loader: 'tsx' }
      })
      build.onLoad({ filter: /viewed-files\.ts$/ }, async ({ path }) => {
        if (path !== viewedFilesSource) return
        const contents = await readFile(path, 'utf8')
        const prefix = "const PREFIX = 'dsh.forge-viewed.v1'"
        if (!contents.includes(prefix)) throw new Error('The installed Forge viewed storage layout has changed')
        // Isolate direct sessions from the native package's shared retention index.
        return { contents: contents.replace(prefix, "const PREFIX = 'dsh-direct-chat.forge-viewed.v1'"), loader: 'ts' }
      })
    },
  }],
})
const js = outputFiles.find(file => file.path.endsWith('.js'))
const css = outputFiles.find(file => file.path.endsWith('.css'))
const license = await readFile(join(dirname(native.resolve(`${forgePackage}/package.json`)), 'LICENSE'), 'utf8')
await writeFile(js.path, '// Built from ui/index.jsx by npm run build:ui.\n'
  + `/*! ${nativePackages.join(", ")}\n${license.trimEnd()}\n*/\n`
  + 'window.__ModuleLoader__.load({ id: "dsh-direct-chat", factory(require) {\n'
  + 'const module = { exports: {} };\n'
  + `const compiledNativeStyles = ${JSON.stringify(css.text)};\n`
  + js.text + 'return module.exports;\n} });\n')
