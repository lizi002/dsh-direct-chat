import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { nativeId } from '../server/native-history.mjs'

test('workspace archive archives idle archivable sessions for the target cwd and refreshes each engine once', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dchat-ws-archive-'))
  const store = join(temp, 'direct-chat')
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp
  t.after(async () => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    await rm(temp, { recursive: true, force: true })
  })

  const targetDir = join(temp, 'target-project')
  const otherDir = join(temp, 'other-project')
  await mkdir(targetDir, { recursive: true })
  await mkdir(otherDir, { recursive: true })

  const mkRecord = (engine, cwd, overrides = {}) => {
    const id = randomUUID()
    return {
      id,
      engine,
      remoteId: randomUUID(),
      cwd,
      title: id,
      messages: [{ role: 'user', text: 'fixture' }],
      options: [],
      ...overrides,
    }
  }
  const mkIndexed = (r, extra = {}) => ({
    ...r,
    id: nativeId(r.engine, r.remoteId),
    parentId: undefined,
    ...extra,
  })

  const s1 = mkRecord('codex', targetDir)
  const s2 = mkRecord('codex', targetDir)
  const busy = mkRecord('codex', targetDir)
  const unsupported = mkRecord('claude', targetDir)
  const alreadyArchived = mkRecord('codex', targetDir, { archived: true })
  const other = mkRecord('codex', otherDir)
  const nativeOnly = mkIndexed(mkRecord('codex', targetDir))

  const nativeRows = [
    mkIndexed(s1),
    mkIndexed(s2),
    mkIndexed(busy),
    mkIndexed(unsupported),
    mkIndexed(alreadyArchived, { archived: true }),
    mkIndexed(other),
    nativeOnly,
  ]

  await mkdir(join(store, 'workspace-state'), { recursive: true })
  for (const item of [s1, s2, busy, unsupported, alreadyArchived, other]) {
    await writeFile(join(store, item.id + '.json'), JSON.stringify(item))
  }
  await mkdir(join(temp, 'engines'))
  await mkdir(join(temp, 'server'))
  await Promise.all([
    'index.mjs', 'engines/cli-admin.mjs',
    'server/agy-session-history.mjs', 'server/account-usage-cache.mjs', 'server/tool-activity.mjs',
    'server/workspace-file.mjs', 'server/workspace-worktree.mjs', 'server/native-merge.mjs', 'server/workspace-diff.mjs', 'server/codex-commands.mjs',
  ].map(name => copyFile(new URL('../' + name, import.meta.url), join(temp, name))))

  await writeFile(join(temp, 'server', 'native-history.mjs'), `
    export { nativeId, nativeUuid, openNativeDatabase } from ${JSON.stringify(new URL('../server/native-history.mjs', import.meta.url).href)}
    export const entries = new Map(${JSON.stringify(nativeRows.map(row => [row.id, row]))})
    export const refreshCalls = []
    export const nativeCatalog = () => ({
      async list() { return new Map(entries) },
      async refreshEngine(engine) { refreshCalls.push(engine) },
      async children() { return [] },
      async metrics() {},
      async messages(entry) { return entry.messages },
    })
  `)
  await writeFile(join(temp, 'registry.mjs'), `
    import { entries } from './server/native-history.mjs'
    export let settleTurn
    export const archivedCalls = []
    async function start({ resumeId }) {
      return {
        id: resumeId, options: [], async close() {},
        prompt() {
          const result = Promise.withResolvers()
          settleTurn = result.resolve
          return result.promise
        },
      }
    }
    const codex = {
      id: 'codex', label: 'Codex', start,
      async setArchived({ remoteId, archived }) {
        archivedCalls.push({ remoteId, archived })
        for (const row of entries.values()) {
          if (row.engine === 'codex' && row.remoteId === remoteId) row.archived = archived
        }
      },
    }
    const claude = { id: 'claude', label: 'Claude Code', start }
    const engines = new Map([[codex.id, codex], [claude.id, claude]])
    export const createEngineRegistry = () => ({
      ready: Promise.resolve(),
      has: id => engines.has(id),
      get: id => engines.get(id),
      list: () => [...engines.values()],
    })
  `)

  const { apply } = await import(pathToFileURL(join(temp, 'index.mjs')))
  const registry = await import(pathToFileURL(join(temp, 'registry.mjs')))
  const historyMod = await import(pathToFileURL(join(temp, 'server', 'native-history.mjs')))
  const { call, dispose } = mount(apply)
  t.after(dispose)

  assert.equal((await call('POST', '/workspaces/archive', { cwd: targetDir }, false)).status, 401)
  assert.equal((await call('POST', '/workspaces/archive', { cwd: 123 })).status, 400)

  assert.equal((await call('POST', `/sessions/${busy.id}/prompt`, { text: 'running' })).status, 202)
  const result = await call('POST', '/workspaces/archive', { cwd: targetDir })
  assert.equal(result.status, 200)
  assert.deepEqual(new Set(result.data.archivedIds), new Set([s1.id, s2.id, nativeOnly.id]))
  assert.equal(result.data.skippedActive, 1)
  assert.equal(result.data.skippedUnsupported, 1)
  assert.deepEqual(historyMod.refreshCalls, ['codex'])
  assert.equal(registry.archivedCalls.length, 3)

  const rows = (await call('GET', '/sessions')).data.sessions
  assert.equal(rows.find(r => r.id === s1.id).archived, true)
  assert.equal(rows.find(r => r.id === s2.id).archived, true)
  assert.equal(rows.find(r => r.id === nativeOnly.id).archived, true)
  assert.equal(rows.find(r => r.id === busy.id).archived, false)
  assert.equal(rows.find(r => r.id === unsupported.id).archived, false)
  assert.equal(rows.find(r => r.id === other.id).archived, false)

  registry.settleTurn({ stopReason: 'cancelled' })
  await new Promise(resolve => setImmediate(resolve))
})

function mount(apply) {
  let dispatch, dispose
  apply({
    effect(fn) { dispose = fn() },
    connection: { admit(req) { return req.headers.cookie ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } },
    webServer: { register(route) { dispatch = route.handler; return () => {} } },
  })
  return {
    dispose,
    async call(method, path = '/sessions', body, authenticated = true) {
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
        url: '/api/direct-chat' + path,
        method,
        headers: { 'content-type': 'application/json', cookie: authenticated ? 'auth' : '' },
      })
      const res = Object.assign(new EventEmitter(), {
        writeHead(status) { this.status = status },
        write() {},
        end(str) { this.data = str && JSON.parse(str) },
      })
      await dispatch(req, res)
      return res
    },
  }
}
