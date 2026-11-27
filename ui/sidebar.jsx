import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, HoverCard, IconArchiveOutlineRegular, IconBranchOutlineRegular, IconCopyOutlineRegular,
  IconEditOutlineRegular, IconEllipsisOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconProjectAddOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, IconUnarchiveOutlineRegular, IconUsersOutlineRegular,
  Menu, Modal, StateDot, Toast, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { archiveWorkspace, deleteSession, engineLabel, sessionAction } from './chat-state.mjs'
import { useTitleMarquee } from '@deepseek-ai/dsh-client-ui-workspace/src/client/rows/Rows.tsx'
import { EngineLogo } from './EngineHero.jsx'
import { hideNativeDraft, isVirtualGroup, mergeSidebarRows, projectSidebarGroups, sidebarAgentRows, sidebarRowVisible, sidebarTime } from './sidebar-history.mjs'

export const workspaceSessionsSlot = 'sidebar.workspaces.external-sessions'
export const workspaceProjectionSlot = 'sidebar.workspaces.direct-chat-projection'

export const sidebarCopy = {
  en: {
    'sidebar.agentFilter': 'Filter by Agent',
    'sidebar.allAgents': 'All agents',
    'sidebar.refresh': 'Refresh direct conversations',
    'sidebar.failed': 'Could not load direct conversations. Refresh to try again.',
    'sidebar.terminal': 'Terminal',
    'sidebar.moreActions': 'Actions for {name}',
    'sidebar.copyPath': 'Copy directory path',
    'sidebar.copyId': 'Copy session ID',
    'sidebar.register': 'Add to DSH workspaces',
    'sidebar.registered': 'Added to DSH workspaces',
    'sidebar.registerFailed': 'Could not add the directory to DSH workspaces',
    'sidebar.copied': 'Copied to clipboard',
    'sidebar.copyFailed': 'Could not copy to clipboard',
    'sidebar.rename': 'Rename',
    'sidebar.localRename': 'Rename in DSH',
    'sidebar.renameTitle': 'Rename session',
    'sidebar.sessionName': 'Session name',
    'sidebar.delete': 'Delete conversation',
    'sidebar.deleteTitle': 'Delete conversation?',
    'sidebar.deleteDescription': '“{name}” and any associated subagent conversations will be permanently deleted.',
    'sidebar.confirmDelete': 'Delete permanently',
    'sidebar.deleting': 'Deleting conversation…',
    'sidebar.deleted': 'Conversation deleted',
    'sidebar.deleteFailed': 'Could not delete the conversation.',
    'sidebar.fork': 'Fork session',
    'sidebar.forkUnavailable': 'The engine or current session state does not allow forking.',
    'sidebar.agyForkUnavailable': 'Open this conversation in the Antigravity terminal and run /fork.',
    'sidebar.forkArchived': 'Restore this session before forking.',
    'sidebar.forked': 'Session forked',
    'sidebar.pin': 'Pin session',
    'sidebar.unpin': 'Unpin session',
    'sidebar.pinned': 'Pinned session',
    'sidebar.archive': 'Archive',
    'sidebar.archiveUnavailable': 'Native archiving is unavailable for this session.',
    'sidebar.restoreLegacy': 'Restore from the old DSH archive',
    'sidebar.restore': 'Restore',
    'sidebar.archived': 'Conversation archived',
    'sidebar.restored': 'Conversation restored',
    'sidebar.restoreToOpen': 'Restore the conversation to open it.',
    'sidebar.archiveFolder': 'Archive all sessions',
    'sidebar.archiveFolderTitle': 'Archive all conversations in folder?',
    'sidebar.archiveFolderDescription': 'Archive {count} active conversation(s) in “{name}” to hide this folder from the sidebar. You can restore them anytime in Settings.',
    'sidebar.confirmArchiveFolder': 'Archive all',
    'sidebar.archivingFolder': 'Archiving conversations…',
    'sidebar.archivedFolder': 'Archived {count} conversation(s)',
    'sidebar.archivedFolderPartial': 'Archived {count} conversation(s); {skipped} active or unsupported session(s) remained.',
    'sidebar.archiveFolderNone': 'No idle archivable conversations in this folder.',
    'sidebar.archiveFolderFailed': 'Could not archive conversations in this folder.',
    'sidebar.actionFailed': 'Could not complete the session action',
    'sidebar.updatedAt': 'Updated {date}',
    'sidebar.createdAt': 'Created {date}',
    'sidebar.status.running': 'Running',
    'sidebar.status.attention': 'Needs approval',
    'sidebar.status.done': 'Completed',
  },
  zh: {
    'sidebar.agentFilter': '按 Agent 筛选',
    'sidebar.allAgents': '全部 Agent',
    'sidebar.refresh': '刷新直连会话',
    'sidebar.failed': '无法加载直连会话。点击刷新重试。',
    'sidebar.terminal': '终端',
    'sidebar.moreActions': '{name}的更多操作',
    'sidebar.copyPath': '复制目录路径',
    'sidebar.copyId': '复制会话 ID',
    'sidebar.register': '添加到 DSH 工作区',
    'sidebar.registered': '已添加到 DSH 工作区',
    'sidebar.registerFailed': '无法将目录添加到 DSH 工作区',
    'sidebar.copied': '已复制到剪贴板',
    'sidebar.copyFailed': '无法复制到剪贴板',
    'sidebar.rename': '重命名',
    'sidebar.localRename': '修改网页显示名',
    'sidebar.renameTitle': '重命名会话',
    'sidebar.sessionName': '会话名称',
    'sidebar.delete': '删除会话',
    'sidebar.deleteTitle': '删除会话？',
    'sidebar.deleteDescription': '「{name}」及其关联的子代理会话将被永久删除。',
    'sidebar.confirmDelete': '永久删除',
    'sidebar.deleting': '正在删除会话…',
    'sidebar.deleted': '已删除会话',
    'sidebar.deleteFailed': '无法删除会话。',
    'sidebar.fork': '分叉会话',
    'sidebar.forkUnavailable': '当前引擎或会话状态不支持分叉。',
    'sidebar.agyForkUnavailable': '请在 Antigravity 终端打开此会话并执行 /fork。',
    'sidebar.forkArchived': '请先恢复此会话，再创建分叉。',
    'sidebar.forked': '已分叉会话',
    'sidebar.pin': '置顶会话',
    'sidebar.unpin': '取消置顶',
    'sidebar.pinned': '已置顶会话',
    'sidebar.archive': '归档',
    'sidebar.archiveUnavailable': '此会话暂不支持原生归档。',
    'sidebar.restoreLegacy': '从旧版 DSH 归档恢复',
    'sidebar.restore': '恢复',
    'sidebar.archived': '已归档会话',
    'sidebar.restored': '已恢复会话',
    'sidebar.restoreToOpen': '恢复会话后即可打开。',
    'sidebar.archiveFolder': '归档全部会话',
    'sidebar.archiveFolderTitle': '归档目录中的全部会话？',
    'sidebar.archiveFolderDescription': '将归档「{name}」中的 {count} 个会话并使其从左侧边栏隐藏；之后可随时在「设置 → CLI 会话归档」中恢复。',
    'sidebar.confirmArchiveFolder': '全部归档',
    'sidebar.archivingFolder': '正在归档会话…',
    'sidebar.archivedFolder': '已归档 {count} 个会话',
    'sidebar.archivedFolderPartial': '已归档 {count} 个会话；另有 {skipped} 个运行中或不支持归档的会话保留。',
    'sidebar.archiveFolderNone': '该目录中没有可归档的空闲会话。',
    'sidebar.archiveFolderFailed': '无法归档该目录中的会话。',
    'sidebar.actionFailed': '无法完成此会话操作',
    'sidebar.updatedAt': '更新于 {date}',
    'sidebar.createdAt': '创建于 {date}',
    'sidebar.status.running': '运行中',
    'sidebar.status.attention': '等待审批',
    'sidebar.status.done': '已完成',
  },
}

export function SidebarSessions({ placement, history, t }) {
  const { pending, error } = useSyncExternalStore(history.subscribe, history.getSnapshot)
  if (placement !== 'toolbar') return null
  const label = t(error ? 'sidebar.failed' : 'sidebar.refresh')
  return <button type="button" className="dchat-sidebar-refresh" title={label} aria-label={label} data-error={error || undefined}
    aria-disabled={pending || undefined} onClick={() => { if (!pending) void history.refresh() }}>
    <IconRefreshOutlineRegular size={14} />
  </button>
}

const emptyStatusSnapshot = { list: [], byId: new Map() }
const fallbackStatusStore = { getSnapshot: () => emptyStatusSnapshot, subscribe: () => () => {} }

export function SidebarProjection({ render, history, statusStore = fallbackStatusStore, navigation, openDirect, usePanelInfo, panelId, engineSource, registerWorkspace, archiveRequest, t }) {
  const { byCwd } = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const { engines } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const [agent, setAgent] = useState('all')
  const directOnly = agent.startsWith('engine:')
  const filteredCwds = useMemo(() => sidebarAgentRows(byCwd, agent), [byCwd, agent])
  const agentIds = useMemo(() => {
    const ids = new Set(engines.map(engine => engine.id))
    for (const rows of byCwd.values()) for (const row of rows) if (row.engine) ids.add(row.engine)
    if (directOnly) ids.add(agent.slice(7))
    return [...ids]
  }, [engines, byCwd, agent, directOnly])
  const statusSnapshot = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot)
  const target = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  const active = usePanelInfo(info => info.activePanelId === panelId)
  const [expanded, setExpanded] = useState(() => new Set())
  const [notice, setNotice] = useState(null)
  const [renameTarget, setRenameTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [localArchiveTarget, setLocalArchiveTarget] = useState(null)
  const externalArchiveTarget = useSyncExternalStore(
    archiveRequest?.subscribe ?? fallbackStatusStore.subscribe,
    archiveRequest?.getSnapshot ?? (() => null),
  )
  const archiveTarget = externalArchiveTarget ?? localArchiveTarget
  const setArchiveTarget = next => {
    if (archiveRequest) archiveRequest.set(next)
    else setLocalArchiveTarget(next)
  }
  const groupCwdsRef = useRef(new Map())
  const report = (text, success) => setNotice(old => ({ id: (old?.id ?? 0) + 1, text, success }))
  const copy = async text => {
    const copied = await writeClipboard(text).catch(() => false)
    report(t(copied ? 'sidebar.copied' : 'sidebar.copyFailed'), copied)
  }
  const updateSession = async (row, action, data) => {
    await sessionAction(row.id, action, data)
    await history.refresh()
  }
  const removeSession = async row => {
    const { deletedIds } = await deleteSession(row.id)
    const removed = new Set(deletedIds)
    history.remove(removed)
    navigation.forget(removed, row)
    void history.refresh()
    report(t('sidebar.deleted'), true)
  }
  const extension = {
    agent,
    directOnly,
    setAgent,
    agentItems: [
      { type: 'separator', id: 'agent-separator' },
      { type: 'label', id: 'agent-label', text: t('sidebar.agentFilter') },
      { id: 'agent:all', label: t('sidebar.allAgents'), icon: <IconUsersOutlineRegular size={16} /> },
      { id: 'agent:native', label: t('engine.native'), icon: <EngineLogo engine={null} size={16} /> },
      ...agentIds.map(id => {
        const engine = engines.find(item => item.id === id)
        const label = engine?.label || id
        return { id: 'agent:engine:' + id, label, icon: <EngineLogo engine={id} label={label} icon={engine?.meta?.icon} size={16} /> }
      }),
    ],
    activeId: active && target.id ? `direct-chat:session:${target.id}` : undefined,
    groups: (groups, workspaces, expandedGroups, filter, orderBy) => {
      const nativeGroups = directOnly
        ? groups.filter(group => group.workspaceId !== undefined).map(group => ({ ...group, sessions: [], sessionCount: 0, latestSessionUpdate: 0, containsCurrent: false }))
        : groups
      const projected = projectSidebarGroups(nativeGroups, workspaces, expandedGroups, expanded, filteredCwds, filter, t('cwd.default'), active, orderBy)
      const nextCwds = new Map()
      for (const group of projected) {
        const path = group.directCwd ?? group.cwd
        if (path) nextCwds.set(group.key, path)
      }
      groupCwdsRef.current = nextCwds
      return projected
    },
    flat: (rows, filter, query = '') => mergeSidebarRows(directOnly ? [] : hideNativeDraft(rows, active),
      [...filteredCwds.values()].flat().filter(row => sidebarRowVisible(row, filter) &&
        (!query || [row.title, row.cwd, row.id].some(value => value?.toLowerCase().includes(query.toLowerCase()))))),
    expandGroup(key, open) {
      if (!isVirtualGroup(key)) return false
      setExpanded(current => {
        const next = new Set(current)
        if (open) next.add(key)
        else next.delete(key)
        return next
      })
      return true
    },
    renderRow: (node, css, compactTime, formatTime) => {
      const isRowActive = active && node.directChat.id === target.id
      const live = !node.archived ? statusSnapshot.byId.get(node.directChat.id) : undefined
      const liveState = live?.state === 'done' && isRowActive ? undefined : live?.state
      return <ExternalSessionRow key={node.id}
        node={node} css={css} label={engineLabel(engines, node.directChat.engine)} compactTime={compactTime} formatTime={formatTime}
        active={isRowActive} liveState={liveState} openDirect={openDirect} updateSession={updateSession}
        rename={setRenameTarget} confirmDelete={setDeleteTarget} copy={copy} report={report} t={t} />
    },
    renderFolderActions: (group, css, setGroupExpanded) => {
      if (group.directCwd === undefined) return null
      const rows = byCwd.get(group.directCwd) ?? []
      const archivableCount = rows.filter(row => !row.archived && row.archiveMode !== 'unsupported').length
      return <FolderActions path={group.directCwd} name={group.label} css={css} archivableCount={archivableCount}
        copy={copy} archiveAll={() => setArchiveTarget({ cwd: group.directCwd, name: group.label, count: archivableCount })}
        register={async () => {
          try {
            const workspace = await registerWorkspace(group.directCwd)
            setGroupExpanded(workspace.workspaceId, true)
            report(t('sidebar.registered'), true)
          } catch (error) {
            report(error.message || t('sidebar.registerFailed'), false)
          }
        }} t={t} />
    },
  }
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const rank = { attention: 3, running: 2, done: 1 }
    const cwdState = new Map()
    for (const item of statusSnapshot.list ?? []) {
      if (!item?.cwd || !item.state || agent === 'native') continue
      if (directOnly && !filteredCwds.get(item.cwd)?.some(row => row.id === item.id)) continue
      if (item.state === 'done' && active && item.id === target.id) continue
      const prev = cwdState.get(item.cwd)
      if (!prev || rank[item.state] > rank[prev]) cwdState.set(item.cwd, item.state)
    }
    for (const el of document.querySelectorAll('[data-row-key^="workspace:"]')) {
      const key = el.dataset.rowKey?.slice('workspace:'.length)
      const cwd = key ? (groupCwdsRef.current.get(key) ?? (key.startsWith('direct-chat:cwd:') ? key.slice('direct-chat:cwd:'.length) : undefined)) : undefined
      const state = cwd ? cwdState.get(cwd) : undefined
      if (state) el.dataset.directWorkspaceState = state
      else delete el.dataset.directWorkspaceState
    }
  }, [statusSnapshot, filteredCwds, agent, directOnly, expanded, active, target.id])

  return <>
    {render(extension)}
    {renameTarget && <SessionRename key={renameTarget.id} row={renameTarget}
      save={title => updateSession(renameTarget, 'rename', renameTarget.renameMode === 'local' ? { title, mode:'local' } : { title })} close={() => setRenameTarget(null)} t={t} />}
    {deleteTarget && <SessionDelete key={deleteTarget.id}
      name={deleteTarget.title || engineLabel(engines, deleteTarget.engine)}
      remove={() => removeSession(deleteTarget)} close={() => setDeleteTarget(null)} t={t} />}
    {archiveTarget && <WorkspaceArchive key={archiveTarget.cwd}
      name={archiveTarget.name} count={archiveTarget.count}
      archive={async () => {
        const result = await archiveWorkspace(archiveTarget.cwd)
        await history.refresh()
        const archivedCount = result?.archivedIds?.length ?? 0
        const skipped = (result?.skippedActive ?? 0) + (result?.skippedUnsupported ?? 0)
        if (archivedCount > 0 && skipped === 0) report(t('sidebar.archivedFolder', { count: archivedCount }), true)
        else if (archivedCount > 0) report(t('sidebar.archivedFolderPartial', { count: archivedCount, skipped }), true)
        else report(t('sidebar.archiveFolderNone'), false)
      }} close={() => setArchiveTarget(null)} t={t} />}
    {notice && <Toast key={notice.id} text={notice.text} tone={notice.success ? 'success' : undefined}
      onDone={() => setNotice(null)} />}
  </>
}

function MoreMenu({ name, css, open, setOpen, point, setPoint, items, select, t }) {
  const label = t('sidebar.moreActions', { name })
  return <Menu open={open} portal dense autoFocus align="end" items={items}
    getAnchorRect={point ? () => point : undefined}
    onClose={() => { setOpen(false); setPoint?.(null) }}
    onSelect={id => { setOpen(false); setPoint?.(null); select(id) }}
    anchor={<button type="button" className={css.iconButton} aria-label={label} title={label}
      data-direct-menu-trigger="" aria-haspopup="menu" aria-expanded={open} onClick={event => {
        event.stopPropagation()
        setPoint?.(null)
        setOpen(!open)
      }}>
      <IconEllipsisOutlineRegular size={16} />
    </button>} />
}

const icon = Icon => <Icon size={16} />

function SessionRename({ row, save, close, t }) {
  const [draft, setDraft] = useState(row.title || '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const composing = useRef(false)
  const title = draft.trim()
  const confirm = async () => {
    if (!title || pending) return
    setPending(true)
    setError('')
    try {
      await save(title)
      close()
    } catch (reason) {
      setError(reason.message || t('sidebar.actionFailed'))
      setPending(false)
    }
  }
  const dismiss = () => { if (!pending) close() }
  return <Modal open title={t('sidebar.renameTitle')} closeLabel={t('close')} onClose={dismiss}
    footer={<>
      <Button variant="outline" disabled={pending} onClick={dismiss}>{t('cancel')}</Button>
      <Button variant="primary" disabled={!title || pending} onClick={() => { void confirm() }}>{t('sidebar.rename')}</Button>
    </>}>
    <input aria-label={t('sidebar.sessionName')} className="dchat-sidebar-rename-input" data-modal-autofocus maxLength={256}
      value={draft} onFocus={event => event.currentTarget.select()} disabled={pending}
      onChange={event => { setDraft(event.currentTarget.value); setError('') }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.key !== 'Enter' || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        event.preventDefault()
        void confirm()
      }} />
    {error && <div className="dchat-sidebar-dialog-error" role="alert">{error}</div>}
  </Modal>
}

function ActionConfirmModal({ title, description, confirmLabel, pendingLabel, failedLabel, actionClassName, run, close, t }) {
  const running = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const dismiss = () => { if (!running.current) close() }
  const confirm = async () => {
    if (running.current) return
    running.current = true
    setPending(true)
    setError('')
    try {
      await run()
      close()
    } catch (reason) {
      setError(reason.message || failedLabel)
      running.current = false
      setPending(false)
    }
  }
  return <Modal open title={title} description={description}
    className="dchat-sidebar-delete-dialog" contentClassName="dchat-sidebar-delete-content"
    closeLabel={t('close')} onClose={dismiss} footer={<div className="dchat-sidebar-delete-actions">
      <Button variant="outline" data-modal-autofocus disabled={pending} onClick={dismiss}>{t('cancel')}</Button>
      <Button variant="outline" className={actionClassName} disabled={pending}
        onClick={() => void confirm()}>{confirmLabel}</Button>
    </div>}>
    {pending && <div className="dchat-sidebar-delete-status" role="status">{pendingLabel}</div>}
    {error && <div className="dchat-sidebar-dialog-error" role="alert">{error}</div>}
  </Modal>
}

function SessionDelete({ name, remove, close, t }) {
  return <ActionConfirmModal
    title={t('sidebar.deleteTitle')}
    description={t('sidebar.deleteDescription', { name })}
    confirmLabel={t('sidebar.confirmDelete')}
    pendingLabel={t('sidebar.deleting')}
    failedLabel={t('sidebar.deleteFailed')}
    actionClassName="dchat-sidebar-delete-action"
    run={remove} close={close} t={t} />
}

function WorkspaceArchive({ name, count, archive, close, t }) {
  return <ActionConfirmModal
    title={t('sidebar.archiveFolderTitle')}
    description={t('sidebar.archiveFolderDescription', { name, count })}
    confirmLabel={t('sidebar.confirmArchiveFolder')}
    pendingLabel={t('sidebar.archivingFolder')}
    failedLabel={t('sidebar.archiveFolderFailed')}
    run={archive} close={close} t={t} />
}

function FolderActions({ path, name, css, archivableCount, register, archiveAll, copy, t }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const items = [
    ...(path ? [
      { id: 'register', label: t('sidebar.register'), icon: icon(IconProjectAddOutlineRegular), disabled: pending },
      { id: 'path', label: t('sidebar.copyPath'), icon: icon(IconCopyOutlineRegular) },
      { type: 'separator', id: 'archive-separator' },
    ] : []),
    { id: 'archiveAll', label: t('sidebar.archiveFolder'), icon: icon(IconArchiveOutlineRegular), disabled: pending || archivableCount === 0 },
  ]
  return <MoreMenu name={name} css={css} open={open} setOpen={setOpen} t={t}
    items={items}
    select={async id => {
      if (id === 'path') return copy(path)
      if (id === 'archiveAll') {
        if (!pending && archivableCount > 0) archiveAll()
        return
      }
      if (pending) return
      setPending(true)
      try { await register() } finally { setPending(false) }
    }} />
}

function QuickAction({ css, label, Icon, disabled, onClick, pinned = false }) {
  return <Tooltip label={label} side="bottom" align="end" delayMs={500} portal>
    <button type="button" className={pinned ? `${css.iconButton} ${css.pinnedAction}` : css.iconButton}
      aria-label={label} disabled={disabled} data-direct-pinned-action={pinned || undefined} onClick={onClick}>
      <Icon size={14} />
    </button>
  </Tooltip>
}

function ExternalSessionRow({ node, css, label, compactTime, formatTime, active, liveState, openDirect, updateSession, rename, confirmDelete, copy, report, t }) {
  const row = node.directChat
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState(null)
  const [pending, setPending] = useState(false)
  const rowRef = useRef(null)
  const titleRef = useRef(null)
  const marquee = useTitleMarquee(titleRef)
  useEffect(() => {
    if (open || rowRef.current?.matches(':hover')) marquee.enter()
    else marquee.leave()
  }, [open, marquee])
  const title = row.title || label
  const origin = row.origin === 'terminal' ? t('sidebar.terminal') : undefined
  const created = sidebarTime(row.createdAt)
  const fullTime = node.updatedAt ? formatTime(node.updatedAt) : undefined
  const canArchive = row.archiveMode !== 'unsupported'
  const canDelete = row.actions?.delete === true
  const canRename = row.actions?.rename === true || row.renameMode === 'local'
  const archiveLabel = t(node.archived ? (row.archiveMode === 'legacy' ? 'sidebar.restoreLegacy' : 'sidebar.restore') : 'sidebar.archive')
  const pinLabel = t(node.pinned ? 'sidebar.unpin' : 'sidebar.pin')
  const ArchiveIcon = node.archived ? IconUnarchiveOutlineRegular : IconArchiveOutlineRegular
  const PinIcon = node.pinned ? IconPinFillRegular : IconPinOutlineRegular
  const canFork = row.canFork === true && !node.archived
  const forkReason = t(node.archived ? 'sidebar.forkArchived'
    : row.forkUnavailableReason === 'agy-acp' ? 'sidebar.agyForkUnavailable' : 'sidebar.forkUnavailable')
  const items = [
    ...(!node.archived ? [{ id: 'pin', label: pinLabel, icon: icon(PinIcon), disabled: pending }] : []),
    { id: 'rename', label: t(row.renameMode === 'local' ? 'sidebar.localRename' : 'sidebar.rename'), icon: icon(IconEditOutlineRegular), disabled: pending || !canRename },
    { id: 'fork', label: t('sidebar.fork'), icon: icon(IconBranchOutlineRegular), disabled: pending || !canFork },
    ...(!canFork ? [{ type: 'label', id: 'fork-unavailable', text: forkReason }] : []),
    { type: 'separator', id: 'copy-separator' },
    { id: 'id', label: t('sidebar.copyId'), icon: icon(IconCopyOutlineRegular) },
    ...(row.cwd ? [{ id: 'path', label: t('sidebar.copyPath'), icon: icon(IconCopyOutlineRegular) }] : []),
    { type: 'separator', id: 'archive-separator' },
    { id: 'archive', label: archiveLabel, disabled: pending || !canArchive, icon: icon(ArchiveIcon) },
    ...(!canArchive ? [{ type: 'label', id: 'archive-unavailable', text: t('sidebar.archiveUnavailable') }] : []),
    ...(canDelete ? [
      { type: 'separator', id: 'delete-separator' },
      { id: 'delete', label: t('sidebar.delete'), icon: icon(IconTrashOutlineRegular), danger: true, disabled: pending },
    ] : []),
  ]
  const mutate = async (action, data, notice) => {
    if (pending) return
    setPending(true)
    try {
      await updateSession(row, action, data)
      if (notice) report(t(notice), true)
    } catch (error) {
      report(error.message || t('sidebar.actionFailed'), false)
    } finally {
      setPending(false)
    }
  }
  const select = async id => {
    if (id === 'id' || id === 'path') return copy(id === 'id' ? row.id : row.cwd)
    if (pending) return
    if (id === 'rename' && canRename) rename(row)
    else if (id === 'delete' && canDelete) confirmDelete(row)
    else if (id === 'archive') await mutate('archive', { archived: !node.archived }, node.archived ? 'sidebar.restored' : 'sidebar.archived')
    else if (id === 'pin' && !node.archived) await mutate('pin', { pinned: !node.pinned })
    else if (id === 'fork' && canFork) await mutate('fork', {}, 'sidebar.forked')
  }
  const activate = () => node.archived ? report(t('sidebar.restoreToOpen'), false) : openDirect(row.id)
  const anchor = <div ref={rowRef} onPointerEnter={marquee.enter} onPointerLeave={() => { if (!open) marquee.leave() }} role="treeitem" tabIndex={0} data-row-key={`session:${node.id}`} data-direct-row=""
    data-live-state={liveState || undefined}
    className={[css.sessionRow, active && css.selected, node.archived && css.archived, open && css.menuOpen].filter(Boolean).join(' ')}
    aria-selected={active} aria-description={node.archived ? t('sidebar.restoreToOpen') : undefined}
    onClick={activate} onKeyDown={event => {
      if (event.currentTarget !== event.target || (event.key !== 'Enter' && event.key !== ' ')
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      activate()
    }} onContextMenu={event => {
      event.preventDefault()
      event.stopPropagation()
      setPoint(new DOMRect(event.clientX, event.clientY, 0, 0))
      setOpen(true)
    }}>
    <span className={`${css.slot} dchat-sidebar-slot`} aria-hidden="true">
      <EngineLogo engine={row.engine} label={label} size={14} />
    </span>
    <span ref={titleRef} className={css.title} onDoubleClick={event => {
      event.stopPropagation()
      if (!pending && canRename) rename(row)
    }}>{title}</span>
    <span className={css.rowResting}>
      {fullTime && <time className={`${css.time} ${css.timestamp}`} dateTime={new Date(node.updatedAt).toISOString()} title={fullTime}>
        {compactTime}
      </time>}
      {node.pinned && <span className={css.pinIndicator} role="img" title={t('sidebar.pinned')} aria-label={t('sidebar.pinned')}>
        <IconPinFillRegular size={14} />
      </span>}
    </span>
    <span className={css.rowActions} onClick={event => event.stopPropagation()}>
      <MoreMenu name={title} css={css} open={open} setOpen={setOpen} point={point} setPoint={setPoint} items={items}
        select={id => { void select(id) }} t={t} />
      <span className={css.rowQuickActions} data-direct-quick-actions="">
        {canArchive && <QuickAction css={css} label={archiveLabel} Icon={ArchiveIcon} disabled={pending} onClick={() => { void select('archive') }} />}
        {!node.archived && <QuickAction css={css} label={pinLabel} Icon={PinIcon} disabled={pending} pinned={node.pinned}
          onClick={() => { void select('pin') }} />}
      </span>
    </span>
  </div>
  return <HoverCard anchor={anchor} openDelayMs={800} grouped disabled={open} copyText={title} copyLabel={t('copy')}
    copiedLabel={t('sidebar.copied')} content={<div className={css.hoverContent}>
      <div className={css.hoverTitle}>{title}</div>
      {row.cwd && <div className={css.hoverPath}>{row.cwd}</div>}
      <div className={css.hoverTime}>{origin ? `${label} · ${origin}` : label}</div>
      {fullTime && <div className={css.hoverTime}>{t('sidebar.updatedAt', { date: fullTime })}</div>}
      {created > 0 && <div className={css.hoverTime}>{t('sidebar.createdAt', { date: formatTime(created) })}</div>}
      {liveState && <div className={css.hoverStatus}>
        <StateDot state={liveState === 'running' ? 'ongoing' : liveState === 'attention' ? 'warning' : 'done'} />
        <span>{t(`sidebar.status.${liveState}`)}</span>
      </div>}
    </div>} />
}
