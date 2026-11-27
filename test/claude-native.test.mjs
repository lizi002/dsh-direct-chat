import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { engine } from '../engines/claude.mjs'
import { claudeAccountUsage, claudeCachedAccountUsage, claudeContextSummary } from '../server/claude-native.mjs'

test('Claude uses only native control requests for rename, plan limits and cached local context details', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-native-test-'))
  const log = join(cwd, 'requests.jsonl')
  const savedPath = process.env.PATH
  t.after(async () => {
    process.env.PATH = savedPath
    await rm(cwd, { recursive: true, force: true })
  })
  process.env.PATH = cwd + delimiter + savedPath
  await writeFile(join(cwd, 'claude'), `#!/usr/bin/env node
const { appendFileSync, createReadStream, writeSync } = require('node:fs')
const { createInterface } = require('node:readline')
if (process.argv.includes('--no-session-persistence')) setInterval(() => {}, 1000)
createInterface({ input: createReadStream(null, { fd: 0 }) }).on('line', line => {
  const request = JSON.parse(line)
  if (request.type !== 'control_request') throw Error('Unexpected prompt')
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), request: request.request }) + '\\n')
  const results = {
    initialize: { claude_code_version: '2.1.316' }, rename_session: {},
    get_usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 30, resets_at: '2026-11-20T14:00:00Z' } } },
    get_context_usage: { model: 'claude-model', totalTokens: 20, rawMaxTokens: 100, categories: [
      { name: 'Messages', tokens: 20, kind: 'used' }, { name: 'Free space', tokens: 80, kind: 'free' },
    ] },
  }
  writeSync(1, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
    response: results[request.request.subtype] } }) + '\\n')
})
`, { mode: 0o755 })
  const remoteId = randomUUID()
  await engine.rename({ cwd, remoteId, title: 'Fixture title' })
  const usage = { status: 'available', limits: [
    { label: '5-hour window', poolId: 'subscription', poolLabel: 'Claude', windowLabel: '5h', usedPercent: 30,
      resetsAt: Date.parse('2026-11-20T14:00:00Z') },
  ] }
  assert.deepEqual(await engine.accountUsage({ cwd }), usage)
  const readRequests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const quotaProbe = (await readRequests()).find(r => r.request.subtype === 'get_usage')
  assert.ok(quotaProbe.args.includes('--no-session-persistence'))
  process.kill(quotaProbe.pid, 'SIGTERM')
  const adapter = await engine.start({ cwd, resumeId: remoteId, emit() {} })
  t.after(() => adapter.close())
  assert.deepEqual(await adapter.accountUsage(), usage)
  const expected = { source: 'native', model: 'claude-model', used: 20, size: 100, categories: [{ name: 'Messages', tokens: 20 }] }
  assert.deepEqual(await adapter.context(), expected)
  assert.deepEqual(await adapter.context(), expected)
  const requests = await readRequests()
  const rename = requests.find(r => r.request.subtype === 'rename_session')
  assert.deepEqual(rename.request, { subtype: 'rename_session', title: 'Fixture title', source: 'host' })
  assert.ok(rename.args.includes(`--resume=${remoteId}`))
  assert.ok(requests.filter(r => r.request.subtype === 'get_usage').at(-1).args.includes(`--resume=${remoteId}`))
  assert.deepEqual(requests.filter(r => !['initialize', 'rename_session'].includes(r.request.subtype)).map(r => r.request), [
    { subtype: 'get_usage', skip_behaviors: true },
    { subtype: 'get_usage', skip_behaviors: true }, { subtype: 'get_context_usage', detail: 'summary' },
  ])
})

test('Claude groups all-model windows and preserves the model-specific quotas', () => {
  const { limits } = claudeAccountUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 20 },
    seven_day: { utilization: 50 },
    seven_day_sonnet: { utilization: 30 },
    model_scoped: [{ display_name: 'Sonnet', utilization: 30 }, { display_name: 'Opus', utilization: 70 }],
  } })
  assert.deepEqual(limits.map(({ poolId, windowLabel, usedPercent }) => [poolId, windowLabel, usedPercent]), [
    ['subscription', '5h', 20], ['subscription', '7d', 50], ['model:Sonnet', '7d', 30], ['model:Opus', '7d', 70],
  ])
})

test('Claude leaves unavailable or invalid native quota values empty', () => {
  assert.deepEqual(claudeAccountUsage({ rate_limits_available: false, rate_limits: null }), { limits: [], status: 'unavailable' })
  assert.deepEqual(claudeAccountUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: -1 } } }),
    { limits: [], status: 'unavailable' })
  assert.deepEqual(claudeContextSummary({ rawMaxTokens: 200 }), { source: 'native', categories: [], size: 200 })
})

test('Claude saved quotas retain the observation time and require the matching native account', () => {
  const now = Date.parse('2026-11-20T14:00:00Z')
  const accountUuid = randomUUID()
  const cachedUsageUtilization = {
    accountUuid, fetchedAtMs: now - 90_000, utilization: {
      five_hour: { utilization: 35, resets_at: '2026-11-20T15:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2026-11-20T13:59:00Z' },
    },
  }
  const config = { oauthAccount: { accountUuid }, cachedUsageUtilization }
  assert.deepEqual(claudeCachedAccountUsage(config, now), { status: 'available', observedAt: now - 90_000, limits: [
    { label: '5-hour window', poolId: 'subscription', poolLabel: 'Claude', windowLabel: '5h', usedPercent: 35,
      resetsAt: Date.parse('2026-11-20T15:00:00Z') },
  ] })
  assert.equal(claudeCachedAccountUsage({ ...config, oauthAccount: { accountUuid: randomUUID() } }, now), undefined)
  assert.equal(claudeCachedAccountUsage(config, now - 100_000), undefined)
  assert.equal(claudeCachedAccountUsage(config, now + 60 * 60_000), undefined)
})

test('Claude terminal continuation keeps repeated prompts and skips prior SDK turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-continuation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = { file: join(dir, 'session.jsonl') }
  const turns = [['cli','user','old'], ['sdk-ts','user','again'], ['sdk-ts','assistant','web answer'],
    ['cli','user','again'], ['cli','assistant','new answer']]
  const rows = turns.map(([entrypoint,type,text], i) => ({ entrypoint, type, uuid: String(i),
    parentUuid: i ? String(i - 1) : null, timestamp: new Date(1000 + i).toISOString(), message: { content: text } }))
  await writeFile(entry.file, rows.map(row => JSON.stringify(row)).join('\n'))
  assert.deepEqual((await engine.history.terminalMessages(entry, 1002)).map(m => m.text), ['again','new answer'])
  assert.deepEqual(await engine.history.terminalMessages(entry, 1005), [])
})
