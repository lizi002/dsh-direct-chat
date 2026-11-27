import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSidebarHistory, sidebarAgentRows, hideNativeDraft, groupSidebarSessions, mergeSidebarRows, projectSidebarGroups, virtualGroupKey,
} from './sidebar-history.mjs'

test('sidebar history groups by exact cwd and sorts each group by recency', () => {
  const first = { id: 'first', engine: 'codex', cwd: '/projects/A', updatedAt: 1 }
  const second = { id: 'second', engine: 'claude', cwd: '/projects/A', updatedAt: '2026-11-20T00:00:00Z' }
  const child = { id: 'child', engine: 'agy', cwd: '/projects/A/sub' }
  const legacy = { id: 'legacy', engine: 'agy', cwd: '/projects/A' }
  const rows = [first, legacy, second, child]
  const groups = groupSidebarSessions(rows)
  assert.deepEqual([...groups], [['/projects/A', [second, first, legacy]], ['/projects/A/sub', [child]]])
  assert.deepEqual(rows, [first, legacy, second, child])
})

test('external sessions share native recency order without moving native manual, blank or pinned entries', () => {
  const native = [
    { id: 'draft', blank: true }, { id: 'pinned', pinned: true, updatedAt: 10 },
    { id: 'recent', updatedAt: 300 }, { id: 'old', updatedAt: 100 },
  ]
  const external = [{ id: 'newer', updatedAt: 400 }, { id: 'middle', createdAt: 200 }]
  assert.deepEqual(mergeSidebarRows(native, external).map(row => row.id), [
    'draft', 'pinned', 'direct-chat:session:newer', 'recent', 'direct-chat:session:middle', 'old',
  ])
  const manual = [native[0], native[1], native[3], native[2]]
  assert.deepEqual(mergeSidebarRows(manual, external).filter(row => !row.directChat), manual)
  assert.equal(mergeSidebarRows(native, []), native)
})

test('external pins lead the recency block in pin order and never promote an archived row', () => {
  const native = [
    { id: 'blank', blank: true }, { id: 'native-pin-1', pinned: true }, { id: 'native-pin-2', pinned: true },
    { id: 'native-recent', updatedAt: 300 }, { id: 'native-old', updatedAt: 100 },
  ]
  const external = [
    { id: 'pinned-before', pinned: true, pinnedAt: 20, updatedAt: 500 },
    { id: 'pinned-after', pinned: true, pinnedAt: 30, updatedAt: 50 },
    { id: 'archived-pin', pinned: true, pinnedAt: 40, updatedAt: 10, archived: true },
    { id: 'normal', pinned: false, updatedAt: 400 },
  ]
  const merged = mergeSidebarRows(native, external)
  assert.deepEqual(merged.map(row => row.directChat?.id ?? row.id), [
    'blank', 'native-pin-1', 'native-pin-2', 'pinned-after', 'pinned-before', 'normal', 'native-recent', 'native-old', 'archived-pin',
  ])
  assert.equal(merged.find(row => row.directChat?.id === 'archived-pin').pinned, false)
  assert.deepEqual(mergeSidebarRows([], external).map(row => row.directChat.id), ['pinned-after', 'pinned-before', 'normal', 'archived-pin'])
})

test('archive filters apply to registered and unregistered roots and exclude child sessions', () => {
  const byCwd = groupSidebarSessions([
    { id: 'registered-live', cwd: '/project', updatedAt: 80 },
    { id: 'registered-old', cwd: '/project', updatedAt: 70, archived: true },
    { id: 'child', cwd: '/project', createdAt: 75, parentId: 'registered-live' },
    { id: 'child-flag', cwd: '/project', isChild: true },
    { id: 'other-live', cwd: '/other', createdAt: 55 },
    { id: 'other-old', cwd: '/other', createdAt: 50, archived: true },
  ])
  assert.deepEqual(byCwd.get('/project').map(row => row.id), ['registered-live', 'registered-old'])
  const workspaces = [{ workspaceId: 'project', title: 'Project', path: '/project', createdAt: 60 }]
  const live = projectSidebarGroups([], workspaces, ['project'], new Set(), byCwd, 'default', 'Home directory')
  assert.deepEqual(live.map(group => [group.key, group.sessions.map(row => row.directChat.id)]), [
    ['project', ['registered-live']], [virtualGroupKey('/other'), []],
  ])
  const archived = projectSidebarGroups([], workspaces, ['project'], new Set([virtualGroupKey('/other')]), byCwd, 'only', 'Home directory')
  assert.deepEqual(archived.map(group => [group.label, group.sessions.map(row => row.directChat.id)]), [
    ['Project', ['registered-old']], ['other', ['other-old']],
  ])
  assert.ok(archived.flatMap(group => group.sessions).every(row => row.archived))
})

test('sidebar shares one request, discards stale responses and retains rows on refresh failure', async () => {
  const focus = new EventTarget()
  const requests = []
  const history = createSidebarHistory(signal => new Promise((resolve, reject) => {
    requests.push({ signal, resolve, reject })
  }), focus)
  const releaseFirst = history.subscribe(() => {})
  const releaseSecond = history.subscribe(() => {})
  assert.equal(requests.length, 1)
  assert.equal(history.getSnapshot().pending, true)

  focus.dispatchEvent(new Event('focus'))
  assert.equal(requests.length, 2)
  assert.equal(requests[0].signal.aborted, true)
  requests[0].resolve([{ id: 'stale', cwd: '/project' }])
  await Promise.resolve()
  assert.equal(history.getSnapshot().byCwd.size, 0)

  const row = { id: 'latest', cwd: '/project', engine: 'agy' }
  requests[1].resolve([row])
  await Promise.resolve()
  assert.deepEqual(history.getSnapshot().byCwd.get('/project'), [row])
  assert.equal(history.getSnapshot().pending, false)

  const manual = history.refresh()
  requests[2].reject(new Error('Fixture failure'))
  await manual
  assert.deepEqual(history.getSnapshot().byCwd.get('/project'), [row])
  assert.equal(history.getSnapshot().error, true)

  const interrupted = history.refresh()
  releaseFirst()
  assert.equal(requests[3].signal.aborted, false)
  releaseSecond()
  assert.equal(requests[3].signal.aborted, true)
  requests[3].resolve([])
  await interrupted
  focus.dispatchEvent(new Event('focus'))
  assert.equal(requests.length, 4)
  assert.deepEqual(history.getSnapshot().byCwd.get('/project'), [row])
})

test('confirmed deletions disappear from shared history even if refresh fails', async () => {
  const requests = []
  const history = createSidebarHistory(signal => new Promise((resolve, reject) => {
    requests.push({ signal, resolve, reject })
  }), new EventTarget())
  const unsubscribe = history.subscribe(() => {})
  const deleted = { id: 'deleted', cwd: '/empty' }
  const kept = { id: 'kept', cwd: '/project' }
  requests[0].resolve([deleted, kept])
  await Promise.resolve()

  const stale = history.refresh()
  history.remove(new Set([deleted.id]))
  assert.equal(requests[1].signal.aborted, true)
  requests[1].resolve([deleted, kept])
  await stale

  const reload = history.refresh()
  requests[2].reject(new Error('Fixture failure'))
  await reload
  assert.deepEqual([...history.getSnapshot().byCwd], [['/project', [kept]]])
  assert.equal(history.getSnapshot().error, true)
  unsubscribe()
})

test('native provisional rows are visible only on the native conversation panel', () => {
  const blank = { id:'draft', blank:true }
  const named = { id:'saved', title:'New Session' }
  const rows = [blank, named]
  assert.equal(hideNativeDraft(rows,false),rows)
  assert.deepEqual(hideNativeDraft(rows,true),[named])
  const groups = [{key:'a',workspaceId:'a',expanded:true,containsCurrent:true,sessionCount:2,sessions:rows}]
  const workspaces = [{workspaceId:'a',path:'/work',title:'Work'}]
  const [group] = projectSidebarGroups(groups,workspaces,['a'],new Set(),new Map(),'hide','default',true)
  assert.deepEqual(group.sessions,[named])
  assert.equal(group.sessionCount,1)
  assert.equal(group.containsCurrent,false)
})

test('agent filtering preserves workspaces and row order for current and historical engines', () => {
  const codex = { id: 'a', engine: 'codex', archived: true }
  const legacy = { id: 'b', engine: 'removed' }
  const groups = new Map([['/one', [legacy, codex]], ['/two', [legacy]]])
  assert.equal(sidebarAgentRows(groups, 'all'), groups)
  assert.equal(sidebarAgentRows(groups, 'native').size, 0)
  assert.deepEqual([...sidebarAgentRows(groups, 'engine:codex')], [['/one', [codex]]])
  assert.deepEqual([...sidebarAgentRows(groups, 'engine:removed')], [['/one', [legacy]], ['/two', [legacy]]])
})

test('recent workspace order includes visible activity in folded native, mixed and direct-only workspaces', () => {
  const workspaces = ['old', 'native', 'mixed'].map(id => ({ workspaceId: id, path: '/' + id }))
  const native = workspaces.map(({ workspaceId }, i) => ({
    key: workspaceId, workspaceId, sessions: [], expanded: false, latestSessionUpdate: [1, 20, 5][i],
  }))
  const direct = groupSidebarSessions([
    { cwd: '/mixed', updatedAt: 30 }, { cwd: '/virtual', updatedAt: 40 },
    { cwd: '/old', updatedAt: 90, archived: true },
  ])
  const order = (mode, filter, sources = direct) => projectSidebarGroups(native, workspaces, [], new Set(),
    sources, filter, '', false, mode).map(group => group.key)
  const virtual = virtualGroupKey('/virtual')
  assert.deepEqual(order('updated', 'default'), [virtual, 'mixed', 'native', 'old'])
  assert.deepEqual(order('updated', 'show'), ['old', virtual, 'mixed', 'native'])
  assert.deepEqual(order('manual', 'default'), ['old', 'native', 'mixed', virtual])
  assert.deepEqual(order('updated', 'default', new Map()), ['native', 'mixed', 'old'])
})
