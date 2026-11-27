import { listSessions } from './chat-state.mjs'

export function sidebarTime(raw) {
  const value = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : 0
}

function time(row) {
  return sidebarTime(row.updatedAt) || sidebarTime(row.createdAt)
}

export function groupSidebarSessions(rows) {
  const byCwd = new Map()
  const rootRows = rows.filter(row => !row.isChild && !row.parentId)
  for (const row of rootRows.sort((a, b) => time(b) - time(a))) {
    const cwd = row.cwd || ''
    const group = byCwd.get(cwd)
    if (group) group.push(row)
    else byCwd.set(cwd, [row])
  }
  return byCwd
}

const virtualPrefix = 'direct-chat:cwd:'

export function virtualGroupKey(cwd) {
  return virtualPrefix + cwd
}

export function isVirtualGroup(key) {
  return key.startsWith(virtualPrefix)
}

export function sidebarRowVisible(row, filter) {
  if (filter === 'show') return true
  return Boolean(row.archived) === (filter === 'only')
}

export function sidebarAgentRows(byCwd, agent) {
  if (agent === 'all') return byCwd
  const matches = new Map()
  if (agent === 'native') return matches
  for (const [cwd, rows] of byCwd) {
    const selected = rows.filter(row => agent === 'engine:' + row.engine)
    if (selected.length) matches.set(cwd, selected)
  }
  return matches
}

export function mergeSidebarRows(nativeRows, externalRows) {
  if (!externalRows.length) return nativeRows
  const pinned = []
  const external = []
  for (const row of externalRows) {
    const node = { id: `direct-chat:session:${row.id}`, directChat: row, updatedAt: time(row),
      archived: Boolean(row.archived), pinned: Boolean(row.pinned && !row.archived) }
    if (node.pinned) pinned.push(node)
    else external.push(node)
  }
  pinned.sort((a, b) => sidebarTime(b.directChat.pinnedAt) - sidebarTime(a.directChat.pinnedAt) || b.updatedAt - a.updatedAt)
  external.sort((a, b) => b.updatedAt - a.updatedAt)

  // The native account already orders its blank row and pins. External pins
  // follow those entries, and the remaining rows share the recency list.
  const regular = nativeRows.findIndex(row => !row.blank && !row.pinned)
  const offset = regular < 0 ? nativeRows.length : regular
  const combined = nativeRows.slice(0, offset).concat(pinned)
  let nextExternal = 0
  for (const row of nativeRows.slice(offset)) {
    while (nextExternal < external.length && external[nextExternal].updatedAt > time(row)) {
      combined.push(external[nextExternal++])
    }
    combined.push(row)
  }
  return combined.concat(external.slice(nextExternal))
}

export function hideNativeDraft(rows, directPanelActive) {
  return directPanelActive ? rows.filter(row => !row.blank) : rows
}

export function projectSidebarGroups(nativeGroups, workspaces, expandedGroups, extraExpansion, byCwd, filter, defaultName, directPanelActive = false, orderBy = 'manual') {
  if (directPanelActive) {
    nativeGroups = nativeGroups.map(group => {
      const sessions = hideNativeDraft(group.sessions, true)
      const hidden = group.sessions.length - sessions.length
      return hidden ? { ...group, sessions, containsCurrent: false,
        sessionCount: typeof group.sessionCount === 'number' ? group.sessionCount - hidden : undefined } : group
    })
  }
  if (!byCwd.size && orderBy !== 'updated') return nativeGroups
  const nativeById = new Map(nativeGroups.map(group => [group.workspaceId, group]))
  const expanded = new Set(expandedGroups)
  const registered = new Set(workspaces.map(workspace => workspace.path))
  const groups = []
  for (const workspace of workspaces) {
    const rows = (byCwd.get(workspace.path) ?? []).filter(row => sidebarRowVisible(row, filter))
    const native = nativeById.get(workspace.workspaceId)
    if (!native && !rows.length) continue
    const group = native ?? {
      key: workspace.workspaceId,
      workspaceId: workspace.workspaceId,
      cwd: workspace.path,
      label: workspace.title,
      createdAt: sidebarTime(workspace.createdAt) || undefined,
      expanded: expanded.has(workspace.workspaceId),
      sessions: [],
    }
    if (!rows.length) groups.push(group)
    else groups.push({ ...group, latestSessionUpdate: rows.reduce((latest, row) => Math.max(latest, time(row)), group.latestSessionUpdate || 0), sessions: group.expanded ? mergeSidebarRows(group.sessions, rows) : group.sessions })
  }
  groups.push(...nativeGroups.filter(group => group.workspaceId === undefined))
  for (const [cwd, items] of byCwd) {
    if (registered.has(cwd)) continue
    const rows = items.filter(row => sidebarRowVisible(row, filter))
    if (!rows.length) continue
    const key = virtualGroupKey(cwd)
    const expanded = extraExpansion.has(key)
    const created = rows.map(row => sidebarTime(row.createdAt)).filter(Boolean)
    groups.push({
      key, directCwd: cwd, cwd: cwd || undefined,
      label: cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || defaultName,
      createdAt: created.length ? Math.min(...created) : undefined,
      latestSessionUpdate: rows.reduce((latest, row) => Math.max(latest, time(row)), 0),
      expanded, sessions: expanded ? mergeSidebarRows([], rows) : [],
    })
  }
  if (orderBy === 'updated') groups.sort((a, b) => (b.latestSessionUpdate || 0) - (a.latestSessionUpdate || 0))
  return groups
}

export function createSidebarHistory(load = listSessions, focus = globalThis.window) {
  const listeners = new Set()
  let snapshot = { byCwd: new Map(), pending: false, error: false }
  let activeRequest

  function publish(next) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  async function refresh() {
    if (!listeners.size) return
    activeRequest?.abort()
    const request = new AbortController()
    activeRequest = request
    publish({ ...snapshot, pending: true, error: false })
    try {
      const rows = await load(request.signal)
      if (!request.signal.aborted) publish({ byCwd: groupSidebarSessions(rows), pending: false, error: false })
    } catch {
      if (!request.signal.aborted) publish({ ...snapshot, pending: false, error: true })
    } finally {
      if (activeRequest === request) activeRequest = undefined
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        focus?.addEventListener('focus', refresh)
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          focus?.removeEventListener('focus', refresh)
          activeRequest?.abort()
        }
      }
    },
    remove(ids) {
      activeRequest?.abort()
      const byCwd = new Map()
      for (const [cwd, rows] of snapshot.byCwd) {
        const remaining = rows.filter(row => !ids.has(row.id))
        if (remaining.length) byCwd.set(cwd, remaining)
      }
      publish({ ...snapshot, byCwd, pending: false })
    },
    refresh,
  }
}
