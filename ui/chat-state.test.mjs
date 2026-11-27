import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accountChoiceLabel, composerAccount, applyEvent, attachmentIssue, attachmentKind, hasDraggedFiles, configGroups, createEngineCatalog, createSession, deleteSession, engineLabel, fileUriReference, inlineFileReference,
  listEngines, markdownFileReference, normalizeMarkdownFileUrls, previewAttachment, previewFile, projectActivity, promptDelivery, stageCommand,
} from './chat-state.mjs'

const update = (sessionUpdate, fields) => ({ update: { sessionUpdate, ...fields } })
const chunk = text => ({ type: 'update', data: update('agent_message_chunk', { content: { type: 'text', text } }) })
const snapshot = data => ({ type: 'snapshot', data })

test('opening a composer prepares an ephemeral session in the picked directory', async ({ mock }) => {
  const request = mock.method(globalThis, 'fetch', async () => new Response('{"id":"draft"}', { status: 201 }))
  assert.deepEqual(await createSession('agy', '/tmp/example'), { id: 'draft' })
  const [url, init] = request.mock.calls[0].arguments
  assert.equal(url, '/api/direct-chat/sessions')
  assert.deepEqual(JSON.parse(init.body), { engine: 'agy', cwd: '/tmp/example', draft: true })
})

test('permanent deletion sends the exact session ID for confirmation and returns all removed IDs', async ({ mock }) => {
  const deletedIds = ['local-engine/parent', 'local-engine/child']
  const request = mock.method(globalThis, 'fetch', async () => Response.json({ deletedIds }))
  assert.deepEqual(await deleteSession(deletedIds[0]), { deletedIds })
  assert.deepEqual(request.mock.calls[0].arguments, ['/api/direct-chat/sessions/local-engine%2Fparent', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmId: deletedIds[0] }),
  }])
})

test('a reconnect replaces partial output before appending later chunks', () => {
  const initial = { messages: [{ role: 'user', text: 'Question' }], busy: true, permissions: [], updates: [] }
  const first = applyEvent(applyEvent(null, snapshot(initial)), chunk('Partial'))
  const missed = { ...initial, messages: [...first.messages.slice(0, 1), { role: 'assistant', text: 'Partial update' }] }
  const restored = applyEvent(first, snapshot(missed))
  const finished = applyEvent(applyEvent(restored, chunk('.')), { type: 'done', data: { stopReason: 'end_turn' } })
  assert.equal(finished.messages[1].text, 'Partial update.')
  assert.equal(first.messages[1].text, 'Partial')
  assert.equal(finished.busy, false)
})

test('permissions from a snapshot and live events resolve by tool call ID', () => {
  const first = { toolCall: { toolCallId: 'a' } }
  const second = { toolCall: { toolCallId: 'b' }, options: [{ optionId: 'allow' }] }
  const session = applyEvent(null, snapshot({ permissions: [first], busy: true }))
  const pending = applyEvent(session, { type: 'permission', data: second })
  const resolved = applyEvent(pending, { type: 'permission_resolved', data: { id: 'a' } })
  assert.deepEqual(resolved.permissions, [second])
  assert.deepEqual(applyEvent(resolved, { type: 'error', data: { message: 'Fixture failure' } }).permissions, [])
})

test('live metrics and agent lists replace the previous server values', () => {
  const agent = { id: 'one', name: 'Explore', status: 'running' }
  const child = { id: 'two', sessionId: 'child', name: 'Review', status: 'completed' }
  const start = applyEvent(null, snapshot({ metrics: { cacheWriteTokens: 20 }, agents: [agent] }))
  const withMetrics = applyEvent(start, { type: 'metrics', data: { outputTokens: 30, tps: 12.5, cacheReadTokens: 0 } })
  const withAgents = applyEvent(withMetrics, { type: 'agents', data: [child] })
  assert.deepEqual(withAgents.metrics, { outputTokens: 30, tps: 12.5, cacheReadTokens: 0 })
  assert.deepEqual(withAgents.agents, [child])
  assert.deepEqual(start.agents, [agent])
  assert.deepEqual(applyEvent(withAgents, snapshot({ parentId: 'parent', agents: [] })), {
    parentId: 'parent', agents: [], error: '',
  })
})

test('select choices retain provider groups and ungrouped options in their advertised order', () => {
  const choice = value => ({ value, name: value })
  const provider = Object.freeze([choice('a'), choice('b')])
  assert.deepEqual(configGroups({ options: [
    choice('first'),
    { name: 'Provider', options: provider },
    choice('last'),
    { name: 'Empty', options: [] },
  ] }), [
    { choices: [choice('first')] },
    { name: 'Provider', choices: provider },
    { choices: [choice('last')] },
  ])
  assert.deepEqual(configGroups(undefined), [])
})

test('ignores malformed model choices and incomplete config notifications', () => {
  assert.deepEqual(configGroups({ options: { value:'invalid' } }), [])
  assert.deepEqual(configGroups({ options: [null, { value: 1 }, { name: 'Models', options: [false,{ name:'Valid',value:'valid' }] }] }), [
    { name: 'Models', choices: [{ name:'Valid',value:'valid' }] },
  ])
  const state = { options: [{ id: 'model' }] }
  assert.equal(applyEvent(state,{type:'update',data:{update:{sessionUpdate:'config_option_update'}}}),state)
})

test('staging a slash command keeps task text and replaces an existing advertised command', () => {
  const commands = [{ name: 'teamwork' }, { name: 'swarm' }]
  assert.equal(stageCommand('/tmp/notes\nReview changes', 'teamwork', commands), '/teamwork /tmp/notes\nReview changes')
  assert.equal(stageCommand('/teamwork  Review changes', 'swarm', commands), '/swarm  Review changes')
  assert.equal(stageCommand('/swarm', 'teamwork', commands), '/teamwork ')
})

test('engine labels come from the host and older engine IDs stay readable', async ({ mock }) => {
  const catalog = [{ id: 'fixture-engine', label: 'Fixture engine' }]
  const request = mock.method(globalThis, 'fetch', async () => Response.json({ engines: catalog }))
  const engines = await listEngines()
  assert.deepEqual(engines, catalog)
  assert.equal(request.mock.calls[0].arguments[0], '/api/direct-chat/engines')
  assert.equal(engineLabel(engines, 'fixture-engine'), 'Fixture engine')
  assert.equal(engineLabel(engines, 'retired-engine'), 'retired-engine')
})

test('file previews use a session-scoped encoded path and preserve rejection status', async ({ mock }) => {
  const request = mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Forbidden' }, { status: 403 }))
  await assert.rejects(previewFile('one/two', 'src/a & b#c.js'), { status: 403 })
  const [url, init] = request.mock.calls[0].arguments
  const parsed = new URL(url, 'https://example.test')
  assert.equal(parsed.pathname, '/api/direct-chat/sessions/one%2Ftwo/file')
  assert.equal(parsed.searchParams.get('path'), 'src/a & b#c.js')
  assert.equal(init.credentials, 'same-origin')
})

test('attachment previews use the historical attachment key within its conversation', async ({ mock }) => {
  const image = { path: 'example.png', mimeType: 'image/png', data: 'AA==', truncated: false }
  const request = mock.method(globalThis, 'fetch', async () => Response.json(image))
  assert.deepEqual(await previewAttachment('child', 'key + 1'), image)
  const [url] = request.mock.calls[0].arguments
  const parsed = new URL(url, 'https://example.test')
  assert.equal(parsed.pathname, '/api/direct-chat/sessions/child/attachment')
  assert.equal(parsed.searchParams.get('key'), 'key + 1')
})

test('inline code recognizes file paths and source lines without treating commands as files', () => {
  assert.deepEqual(inlineFileReference('src/example.ts:12:4'), { path: 'src/example.ts', line: 12 })
  assert.deepEqual(inlineFileReference('/workspace/name with spaces.md#L8-L10'), { path: '/workspace/name with spaces.md', line: 8 })
  assert.deepEqual(inlineFileReference('README.md'), { path: 'README.md', line: undefined })
  assert.equal(inlineFileReference('cat src/example.ts'), undefined)
  assert.equal(inlineFileReference('https://example.test/src/example.ts'), undefined)
  assert.equal(inlineFileReference('package.json#L9-L2'), undefined)
})

test('Markdown file destinations accept colon positions and prefer an explicit line fragment', () => {
  assert.deepEqual(markdownFileReference('/workspace/src/file.js:15:4'), { path: '/workspace/src/file.js', line: 15 })
  assert.deepEqual(markdownFileReference('src/file:15', 3), { path: 'src/file:15', line: 3 })
  assert.deepEqual(markdownFileReference('src/file#L15'), { path: 'src/file#L15', line: undefined })
  assert.deepEqual(markdownFileReference('file:///home/user/notes.md#L10-L20'), { path: '/home/user/notes.md', line: 10 })
  assert.deepEqual(fileUriReference('file:///home/user/my%20file.ts:42'), { path: '/home/user/my file.ts', line: 42 })
  assert.deepEqual(inlineFileReference('file:///home/user/notes.md#L8'), { path: '/home/user/notes.md', line: 8 })
  assert.equal(normalizeMarkdownFileUrls('See [notes.md](file:///home/user/notes.md#L10-L20)'), 'See [notes.md](/home/user/notes.md#L10-L20)')
  assert.equal(fileUriReference('https://example.com/a.md'), undefined)
})

test('activity projects latest command catalog and usage, and folds tool updates', () => {
  const latestCommands = [{ name: 'help', description: 'Help' }]
  const activity = projectActivity([
    update('available_commands_update', { availableCommands: [] }),
    update('available_commands_update', { availableCommands: latestCommands }),
    update('usage_update', { used: 28, size: 100 }),
    update('tool_call', { title: 'Read file', toolCallId: 'a', status: 'pending' }),
    update('tool_call_update', { toolCallId: 'a', status: 'completed' }),
  ])
  assert.equal(activity.commands, latestCommands)
  assert.equal(activity.usage.used, 28)
  assert.deepEqual(activity.tools.map(tool => [tool.title, tool.status]), [['Read file', 'completed']])
})

test('live command snapshots replace output in first-seen order and keep the final result', () => {
  const start = { toolCallId: 'one', kind: 'execute', status: 'in_progress', execution: { command: 'printf first' } }
  const second = { toolCallId: 'two', kind: 'execute', status: 'pending', execution: { command: 'printf second' } }
  const thought = update('agent_thought_chunk', { content: { type: 'text', text: 'Checking output.' } })
  const revision = { ...start.execution, stdout: 'first\n' }
  const initialUpdates = [update('tool_call', start), thought, update('tool_call', second),
    update('tool_call_update', { toolCallId: 'one', execution: revision })]
  const initial = applyEvent(null, snapshot({ messages: [], updates: initialUpdates }))
  assert.equal(initial.updates.length, 3)
  assert.deepEqual(projectActivity(initial.updates).tools[0].execution, revision)

  const send = (session, fields) => applyEvent(session, { type: 'update', data: update('tool_call_update', fields) })
  const settled = { ...revision, stdout: 'first\nlast\n', exitCode: 0 }
  const afterOutput = send(initial, { toolCallId: 'one', execution: settled })
  const finished = send(afterOutput, { toolCallId: 'one', status: 'completed' })
  assert.equal(finished.updates.length, 3)
  const { tools, steps } = projectActivity(finished.updates)
  assert.deepEqual(steps.map(step => step.tool?.toolCallId ?? step.kind), ['one', 'thought', 'two'])
  assert.equal(tools[0].status, 'completed')
  assert.equal(tools[0].execution, settled)
  assert.equal(steps[0].tool, tools[0])
  assert.equal(initial.updates.length, 3)
  assert.equal(initialUpdates.length, 4)
})

test('generic attachments and native media share the size and count checks', () => {
  const png = { type: 'image/png', size: 1024 }
  const wav = { type: 'audio/wav', size: 8 * 1024 * 1024 }
  const markdown = { type: 'text/markdown', size: 0 }
  assert.equal(attachmentKind(png, { image: true }), 'image')
  assert.equal(attachmentKind(png, { image: true, imageMimeTypes: ['image/jpeg'] }), 'file')
  assert.equal(attachmentKind(wav, { audio: true }), 'audio')
  assert.equal(attachmentKind(markdown, { image: true }), 'file')
  assert.equal(attachmentIssue([markdown]), '')
  assert.equal(attachmentIssue([wav, png]), 'attachment.size')
  assert.equal(attachmentIssue(Array(17).fill(png)), 'attachment.count')
  assert.equal(hasDraggedFiles({ types: ['text/uri-list'] }), false)
  assert.equal(hasDraggedFiles({ types: ['Files'] }), true)
})

test('busy Enter follows the DSH delivery preference only when steering is available', () => {
  assert.equal(promptDelivery(false, true, 'steer'), undefined)
  assert.equal(promptDelivery(false, false, 'queue', true), undefined)
  assert.equal(promptDelivery(false, true, 'steer', true, true), 'queue')
  assert.equal(promptDelivery(true, false, 'steer', true), 'queue')
  assert.equal(promptDelivery(true, true, undefined), 'queue')
  assert.equal(promptDelivery(true, true, 'queue', true), 'steer')
  assert.equal(promptDelivery(true, true, 'steer'), 'steer')
  assert.equal(promptDelivery(true, true, 'steer', true), 'queue')
})

test('composer identity follows the selected profile while preparing a draft', () => {
  const catalog = { defaultProfileId: 'work', profiles: [
    { id: 'default', name: 'Default' }, { id: 'work', name: 'Work', account: 'Example User' },
  ] }
  const previous = { id: 'default', label: 'Personal', account: 'Personal User' }
  assert.equal(accountChoiceLabel(composerAccount(previous, catalog, true, 'work'), 'Default account'), 'Work · Example User')
  assert.equal(composerAccount(undefined, catalog, true).id, 'work')
  const existing = composerAccount({id:'work', label:'Work', canSwitch:false, choices:[]}, catalog, false)
  assert.equal(existing.account, 'Example User')
  assert.equal(existing.canSwitch, false)
  assert.deepEqual(existing.choices, [])
  assert.equal(accountChoiceLabel({ id: 'default', label: 'Default configuration', account: 'Example User' }, 'Default account'), 'Example User')
  assert.equal(accountChoiceLabel({ id: 'default', label: 'Default', account: 'Google OAuth' }, 'Default account'), 'Default account')
})

test('AGY composer uses the updated session identity when the engine catalog has an older login', () => {
  const profile = { id: 'work', name: 'Work', account: 'old@example.test' }
  const catalog = { id: 'agy', defaultProfileId: 'work', profiles: [profile] }
  const signedOut = { id: 'work', label: 'Work', canSwitch: true, choices: [{ id: 'work', label: 'Work' }] }
  assert.deepEqual(composerAccount(signedOut, catalog, false), signedOut)
  assert.equal(composerAccount(signedOut, catalog, true).account, undefined)
  assert.equal(composerAccount(undefined, catalog, true).account, 'old@example.test')
})

test('independent CLI updates overlap while duplicate and all-engine operations wait for idle', async () => {
  const catalog = createEngineCatalog(async () => [])
  const gate = Promise.withResolvers()
  const first = catalog.runOperation('claude', 'update', () => gate.promise)
  const unexpected = () => assert.fail('conflicting action started')
  await catalog.runOperation('claude', 'check', unexpected)
  await catalog.runOperation('all', 'check', unexpected)
  assert.equal(await catalog.runOperation('codex', 'update', async () => 'updated'), 'updated')
  assert.deepEqual([...catalog.getSnapshot().operations], [['claude', 'update']])
  gate.resolve()
  await first
  const all = Promise.withResolvers()
  const check = catalog.runOperation('all', 'check', () => all.promise)
  await catalog.runOperation('agy', 'update', unexpected)
  all.reject(new Error('offline'))
  await assert.rejects(check, /offline/)
  assert.equal(catalog.getSnapshot().operations.size, 0)
})
