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

test('web and imported sessions synchronize terminal history and resume the same native conversation', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dchat-native-sync-'))
  const store = join(temp, 'direct-chat')
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp
  t.after(async () => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    await rm(temp, { recursive: true, force: true })
  })

  const remoteId = randomUUID()
  const id = nativeId('agy', remoteId)
  const initialMessages = [
    { role: 'user', text: 'first prompt' },
    { role: 'assistant', text: 'first answer' },
  ]
  const entry = {
    id,
    remoteId,
    engine: 'agy',
    cwd: temp,
    title: 'Initial Title',
    nativeTitle: 'Initial Title',
    createdAt: 1000,
    updatedAt: 2000,
    archived: false,
    messages: initialMessages,
    metrics: { inputTokens: 10, outputTokens: 20 },
  }

  await mkdir(join(store, 'workspace-state'), { recursive: true })
  await mkdir(join(temp, 'engines'))
  await mkdir(join(temp, 'server'))
  await Promise.all([
    'index.mjs', 'engines/cli-admin.mjs',
    'server/agy-session-history.mjs', 'server/account-usage-cache.mjs', 'server/tool-activity.mjs',
    'server/workspace-file.mjs', 'server/workspace-worktree.mjs', 'server/native-merge.mjs', 'server/workspace-diff.mjs', 'server/codex-commands.mjs',
  ].map(name => copyFile(new URL('../' + name, import.meta.url), join(temp, name))))

  await writeFile(join(temp, 'server', 'native-history.mjs'), `
    export { nativeId, nativeUuid, openNativeDatabase } from ${JSON.stringify(new URL('../server/native-history.mjs', import.meta.url).href)}
    export const entries = new Map(${JSON.stringify([[id, entry]])})
    export const scopedEntries = new Map()
    export const nativeCatalog = () => ({
      async findInDirectory(engine, remoteId, directory) { return directory ? scopedEntries.get(directory + '/' + remoteId) : [...entries.values()].find(e => e.engine === engine && e.remoteId === remoteId) },
      async list() { return new Map(entries) },
      async refreshEngine() {},
      async children() { return [] },
      async metrics(item) { return item.metrics },
      async messages(item) { return item.messages ?? [] },
    })
  `)
  await writeFile(join(temp, 'registry.mjs'), `
    import { entries } from './server/native-history.mjs'
    export const resumed = []
    export let settlePrompt
    async function start({ resumeId, emit }) {
      const context = [...entries.values()].find(row => row.remoteId === resumeId)?.messages.map(m => m.text) || []
      resumed.push({ resumeId, context })
      return {
        id: resumeId,
        options: [],
        async close() {},
        async configure() { return [] },
        prompt(text) {
          if (text === 'what was the word?') emit('update', { update: { sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: context.find(value => value.startsWith('remember '))?.slice(9) || 'unknown' } } })
          const p = Promise.withResolvers()
          settlePrompt = p.resolve
          return p.promise
        },
      }
    }
    const agy = { id: 'agy', label: 'Antigravity', start }
    const claude = { id: 'claude', history: { terminalMessages: entry => entry.messages } }
    const engines = new Map([[agy.id, agy], [claude.id, claude], ['codex', { id: 'codex', start }]])
    export const createEngineRegistry = () => ({
      ready: Promise.resolve(),
      has: key => engines.has(key),
      get: key => engines.get(key),
      list: () => [...engines.values()],
    })
  `)

  const { apply } = await import(pathToFileURL(join(temp, 'index.mjs')))
  const historyMod = await import(pathToFileURL(join(temp, 'server', 'native-history.mjs')))
  const registry = await import(pathToFileURL(join(temp, 'registry.mjs')))
  const webId = randomUUID()
  const claudeRemote = randomUUID()
  const webMessage = { role: 'user', text: 'from web', attachments: [{ name: 'image.png' }] }
  const webRecord = { id: webId, engine: 'claude', remoteId: claudeRemote, cwd: temp, title: 'Web',
    updatedAt: 1000, messages: [webMessage], options: [], capabilities: [], queue: [] }
  await writeFile(join(store, webId + '.json'), JSON.stringify(webRecord))
  const terminalEntry = { ...entry, engine: 'claude', remoteId: claudeRemote,
    messages: [{ role: 'user', text: 'terminal follow-up' }] }
  historyMod.entries.set(nativeId('claude', claudeRemote), terminalEntry)
  const saved = {}
  const isolated = 'isolated-fixture'
  const remoteByEngine = {}
  for (const key of ['codex', 'agy', 'isolated']) {
    const engine = key === 'isolated' ? 'agy' : key
    const rid = randomUUID()
    const local = randomUUID()
    const entry = { id: nativeId(engine, rid), remoteId: rid, engine, updatedAt: 2200, cwd: temp,
      messages: [...initialMessages, { role: 'user', text: 'remember hazelnut' }, { role: 'assistant', text: 'stored' }] }
    saved[key] = local
    remoteByEngine[key] = entry
    if (key === 'isolated') {
      const directory = join(store, 'profiles', 'agy', isolated, '.gemini', 'antigravity-cli')
      historyMod.scopedEntries.set(directory + '/' + rid, entry)
      historyMod.entries.set(entry.id, { ...entry, messages: [{ role: 'user', text: 'wrong account' }] })
    } else historyMod.entries.set(entry.id, entry)
    await writeFile(join(store, local + '.json'), JSON.stringify({ ...webRecord, id: local, engine, remoteId: rid,
      messages: initialMessages, ...(key === 'isolated' ? { profileId: 'default', agyHistoryProfileId: isolated } : {}) }))
  }
  await writeFile(join(store, 'profiles.json'), JSON.stringify({ agy: { list: [{ id: isolated, kind: 'isolated', name: 'Work' }] } }))
  const { call, openEvents, dispose } = mount(apply)
  t.after(dispose)

  assert.deepEqual((await call('GET', '/' + webId)).data.messages, [webMessage, ...terminalEntry.messages])
  terminalEntry.messages.push({ role: 'assistant', text: 'terminal reply' })
  terminalEntry.updatedAt++
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await call('GET', '/' + webId)).data.messages, [webMessage, ...terminalEntry.messages])
  }

  for (const key of ['codex', 'agy', 'isolated']) {
    const path = '/' + saved[key]
    const terminal = remoteByEngine[key]
    if (key !== 'isolated') {
      const additions = terminal.messages.splice(2)
      const stream = openEvents(saved[key])
      t.after(() => stream.close())
      await new Promise(resolve => setTimeout(resolve, 30))
      // A pre-existing adapter loaded the old context.
      if (key === 'codex') await call('POST', path + '/configure', { id: 'fixture', value: 'fixture' })
      terminal.messages.push(...additions)
      terminal.updatedAt++
    }
    assert.equal((await call('POST', path + '/sync-native')).data.status, 'synced')
    const loaded = await call('GET', path)
    assert.equal(loaded.status, 200, key + ': ' + loaded.data.error)
    assert.deepEqual(loaded.data.messages, terminal.messages)
    assert.equal((await call('POST', path + '/sync-native')).data.status, 'current')
    if (key === 'isolated') {
      historyMod.scopedEntries.clear()
      assert.equal((await call('POST', path + '/sync-native')).data.status, 'unavailable')
      assert.equal((await call('POST', path + '/native-preview')).status, 404)
      continue
    }
    assert.equal((await call('POST', path + '/prompt', { text: 'what was the word?' })).status, 202)
    assert.equal(registry.resumed.at(-1).resumeId, terminal.remoteId)
    assert.ok(registry.resumed.at(-1).context.includes('remember hazelnut'))
    assert.equal((await call('POST', path + '/sync-native')).data.status, 'busy')
    registry.settlePrompt({ stopReason: 'end_turn' })
    await new Promise(resolve => setImmediate(resolve))
    terminal.messages = [{ role: 'user', text: 'separate branch' }]
    terminal.updatedAt++
    assert.equal((await call('POST', path + '/sync-native')).data.status, 'conflict')
    assert.equal((await call('GET', path)).data.nativeConflict, true)
    assert.equal((await call('GET', path)).data.messages.at(-1).text, 'hazelnut')
    assert.deepEqual((await call('POST', path + '/native-preview')).data.messages, terminal.messages)
  }

  // Initial load via GET + events opens the AGY adapter while keeping hasWebTurns false.
  const first = await call('GET', `/${id}`)
  assert.equal(first.status, 200)
  assert.equal(first.data.messages.length, 2)

  const stream = openEvents(id)
  t.after(() => stream.close())
  await new Promise(resolve => setTimeout(resolve, 40))

  // Simulate terminal AGY adding a new turn while the DSH adapter is open.
  const updatedEntry = {
    ...entry,
    updatedAt: 3000,
    nativeTitle: 'Updated Title',
    messages: [
      ...initialMessages,
      { role: 'user', text: 'terminal follow-up' },
      { role: 'assistant', text: 'terminal response' },
    ],
    metrics: { inputTokens: 30, outputTokens: 40 },
  }
  historyMod.entries.set(id, updatedEntry)

  const reloaded = await call('GET', `/${id}`)
  assert.equal(reloaded.status, 200)
  assert.equal(reloaded.data.messages.length, 4)
  assert.equal(reloaded.data.messages.at(-1).text, 'terminal response')
  assert.equal(reloaded.data.metrics.outputTokens, 40)
  assert.equal(reloaded.data.title, 'Updated Title')

  // Once a web turn occurs (hasWebTurns = true), native updates must not overwrite web messages.
  assert.equal((await call('POST', `/${id}/prompt`, { text: 'web prompt' })).status, 202)
  registry.settlePrompt({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))

  historyMod.entries.set(id, {
    ...updatedEntry,
    updatedAt: 4000,
    messages: [{ role: 'user', text: 'stale overwrite' }],
  })
  const afterWeb = await call('GET', `/${id}`)
  assert.equal(afterWeb.status, 200)
  assert.equal(afterWeb.data.messages.some(m => m.text === 'web prompt'), true)
  assert.equal(afterWeb.data.messages.some(m => m.text === 'stale overwrite'), false)
})

function mount(apply) {
  let dispatch, dispose
  apply({
    effect(fn) { dispose = fn() },
    connection: { admit() { return { peer: { principal: { kind: 'owner' } } } } },
    webServer: { register(route) { dispatch = route.handler; return () => {} } },
  })
  return {
    dispose,
    async call(method, suffix = '', body) {
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
        url: '/api/direct-chat/sessions' + suffix,
        method,
        headers: { 'content-type': 'application/json' },
      })
      const res = Object.assign(new EventEmitter(), {
        writeHead(status) { this.status = status },
        write() {},
        end(str) { this.data = str && JSON.parse(str) },
      })
      await dispatch(req, res)
      return res
    },
    openEvents(id) {
      const req = Object.assign(Readable.from([]), {
        url: `/api/direct-chat/sessions/${id}/events`,
        method: 'GET',
        headers: {},
      })
      const res = Object.assign(new EventEmitter(), {
        writeHead() {},
        write() {},
        end() {},
      })
      void dispatch(req, res)
      return { close() { res.emit('close') } }
    },
  }
}
