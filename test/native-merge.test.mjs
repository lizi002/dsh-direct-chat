import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { compareNativeHistory, compareNativeTail, formatFilePrompt } from '../server/native-merge.mjs'

const user = (text, fields) => ({ role: 'user', text, ...fields })
const assistant = (text, fields) => ({ role: 'assistant', text, ...fields })

test('adds only the native user turn after matching history and preserves the original web rows', () => {
  const web = [
    user(' question ', { attachments: [{ name: 'image.png' }], timestamp: 10, queueItemId: 'queue-id' }),
    assistant('', { plan: [{ content: 'Check it' }] }),
    assistant('Looking. ', { phase: 'commentary', tools: [{ toolCallId: 'web-tool' }] }),
    assistant('All good.'),
  ]
  const native = [
    user('question'),
    assistant('Looking. All good.'),
    user('terminal follow-up'),
    assistant('Found it.', { steps: [{ kind: 'tool', tool: { toolCallId: 'native-tool' } }] }),
  ]
  const original = structuredClone(web)

  assert.deepEqual(compareNativeHistory(web, native), { status: 'synced', additions: native.slice(2) })
  assert.deepEqual(web, original)
})

test('equal and shorter native histories leave the web history current', () => {
  const web = [user('first'), assistant('first reply'), user('next'), assistant('second reply')]
  for (const native of [[], web.slice(0, 2), web.slice(0, 3), [...web.slice(0, 3), assistant('second')], web]) {
    assert.deepEqual(compareNativeHistory(web, native), { status: 'current' })
  }
})

test('rejects an altered previous prompt or reply even when later text matches', () => {
  const shared = [user('repeated prompt'), assistant('shared reply')]
  const web = [user('first'), assistant('web reply'), ...shared]
  for (const native of [
    [user('changed'), ...web.slice(1), user('new')],
    [web[0], assistant('changed'), ...shared, user('new')],
    [web[0], assistant('web'), ...shared, user('new')],
    [...web, assistant('more from the previous turn'), user('new')],
  ]) {
    assert.deepEqual(compareNativeHistory(web, native), { status: 'conflict' })
  }
})

test('a prompt without native text cannot establish the shared history', () => {
  const web = [user('', { attachments: [{ name: 'image.png' }] }), assistant('image reviewed')]
  const native = [assistant('image reviewed'), user('terminal follow-up')]

  assert.deepEqual(compareNativeHistory(web, native), { status: 'conflict' })
  assert.deepEqual(compareNativeHistory(web, []), { status: 'current' })
})

test('matches the exact native suffix generated for web file attachments', () => {
  const files = [
    { type: 'file', name: 'results.csv', mimeType: 'text/csv', previewId: 'file-one' },
    { type: 'file', name: 'summary.txt', mimeType: 'text/plain', previewId: 'file-two' },
  ]
  const attachmentPath = file => resolve('media', file.previewId)
  const references = files.map(file => ({ name: file.name, mimeType: file.mimeType, path: attachmentPath(file) }))
  const web = [user('Inspect these', { attachments: [...files, { type: 'image', name: 'chart.png' }] }), assistant('Done')]
  const additions = [user('terminal follow-up')]
  const makeNative = text => [user(text), assistant('Done'), ...additions]
  const native = makeNative(formatFilePrompt('Inspect these', references))

  assert.deepEqual(compareNativeHistory(web, native, { attachmentPath }), { status: 'synced', additions })
  assert.deepEqual(compareNativeHistory(web, native), { status: 'conflict' })
  assert.deepEqual(compareNativeHistory(web, native, { attachmentPath: () => 'relative/path' }), { status: 'conflict' })
  for (const unverified of [
    [],
    references.slice(0, 1),
    [...references, references[0]],
    [{ ...references[0], name: 'changed.csv' }, references[1]],
    [{ ...references[0], mimeType: 'text/plain' }, references[1]],
    [{ ...references[0], path: resolve('elsewhere', 'file-one') }, references[1]],
    [{ ...references[0], path: 'file-one' }, references[1]],
    [{ ...references[0], type: 'file' }, references[1]],
  ]) {
    assert.deepEqual(compareNativeHistory(web, makeNative(formatFilePrompt('Inspect these', unverified)), { attachmentPath }),
      { status: 'conflict' })
  }
  const noPrompt = [user('', { attachments: files }), assistant('Done')]
  assert.deepEqual(compareNativeHistory(noPrompt, makeNative(formatFilePrompt('', references)), { attachmentPath }),
    { status: 'conflict' })
})

test('an empty base can accept a first user turn, but a missing web prefix conflicts', () => {
  const native = [user('terminal'), assistant('native reply')]
  const web = [user('earlier web prompt'), assistant('web reply'), ...native]

  assert.deepEqual(compareNativeHistory([], native), { status: 'synced', additions: native })
  assert.deepEqual(compareNativeTail([], native), { status: 'synced', additions: native })
  assert.deepEqual(compareNativeHistory(web, native), { status: 'conflict' })
  assert.deepEqual(compareNativeTail([], [assistant('orphan text'), ...native]), { status: 'conflict' })
})

test('refreshes a growing native tail, including text and updated tool state', () => {
  const running = { toolCallId: 'cmd', status: 'in_progress' }
  const completed = { ...running, status: 'completed', execution: { exitCode: 0 } }
  const previous = [user('terminal'), assistant('Output: par'), assistant('', { tools: [running] })]
  const native = [
    user('terminal'), assistant('Output: partial', { tools: [completed] }),
    user('next'), assistant('another reply'),
  ]

  assert.deepEqual(compareNativeTail(previous, native), { status: 'synced', additions: native })
  assert.deepEqual(compareNativeTail(native, structuredClone(native)), { status: 'current' })
  assert.deepEqual(compareNativeTail(native, native.slice(0, 2)), { status: 'current' })
})

test('updates native tool state without duplicating an existing user turn', () => {
  const tool = { toolCallId: 'cmd', status: 'in_progress' }
  const previous = [user('terminal'), assistant('', { steps: [{ kind: 'tool', tool }] })]
  const native = [user('terminal'), assistant('', { tools: [{ ...tool, status: 'completed' }] })]

  assert.deepEqual(compareNativeTail(previous, native), { status: 'synced', additions: native })
  assert.deepEqual(compareNativeTail(previous, [user('terminal'), assistant('Output')]), { status: 'conflict' })
})

test('leaves a shorter pending native reply alone and rejects a diverged tail', () => {
  const previous = [user('terminal'), assistant('first reply'), user('other'), assistant('second reply')]
  assert.deepEqual(compareNativeTail(previous, [previous[0], assistant('first rep')]), { status: 'current' })
  for (const native of [
    [user('changed'), ...previous.slice(1)],
    [previous[0], assistant('first reply, revised'), ...previous.slice(2)],
    [...previous.slice(0, 3), assistant('different second reply')],
    [...previous.slice(0, 3), assistant('second rep'), user('next')],
  ]) {
    assert.deepEqual(compareNativeTail(previous, native), { status: 'conflict' })
  }
})
