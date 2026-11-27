import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { engine as codexEngine } from '../engines/codex.mjs'
import { inspectCodexThread, startOther } from '../server/other.mjs'

const header = `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createReadStream, existsSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
// Direct reads and writes also work when the sandbox restricts fd inspection.
const lines = createInterface({ input: createReadStream(null, { fd: 0 }) })
const send = msg => writeSync(1, JSON.stringify(msg) + '\\n')
`

const codex = header + `
assert.deepEqual(process.argv.slice(2), ['app-server', '--stdio'])
const threadId = 'native-codex-thread'
const alternateAccount = process.env.DSH_TEST_CODEX_PROFILE === 'limited'
const nativePermissions = () => existsSync('codex-auto-review')
  ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } }
  : existsSync('codex-read-only')
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } }
let turnId, serial = 0
let showSkill = true
let compactCount = 0
let reviewCount = 0
let goal
let tokens = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
const note = (method, params) => send({ method, params: { threadId, turnId, ...params } })
const complete = status => note('turn/completed', { turn: { id: turnId, status } })
const usage = () => note('thread/tokenUsage/updated', { tokenUsage: { total: tokens, modelContextWindow: 65536, last: { totalTokens: 700, outputTokens: 3 } } })
const addUsage = (outputTokens, cachedInputTokens, cacheWriteInputTokens) => {
  tokens = {
    totalTokens: tokens.totalTokens + 100 + outputTokens,
    inputTokens: tokens.inputTokens + 100,
    outputTokens: tokens.outputTokens + outputTokens,
    cachedInputTokens: tokens.cachedInputTokens + cachedInputTokens,
    cacheWriteInputTokens: tokens.cacheWriteInputTokens + cacheWriteInputTokens,
  }
  usage()
}
lines.on('line', line => {
  const { id, method, params, result } = JSON.parse(line)
  const respond = result => send({ id, result })
  if (method === 'initialize') return respond({})
  if (method === 'initialized') return
  if (method === 'thread/name/set') {
    assert.match(params.threadId, /^[0-9a-f-]{36}$/)
    assert.equal(params.name, 'Native fixture name')
    return respond({})
  }
  if (method === 'account/rateLimits/read') {
    return respond({ rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 30, windowDurationMins: 10080 },
      credits: { credential: 'fixture-account-secret' },
    }, partner: {
      limitName: 'Codex', primary: { usedPercent: 87, windowDurationMins: 43200 },
    } } })
  }
  if (method === 'experimentalFeature/list') {
    if (params.threadId !== undefined) assert.equal(params.threadId, threadId)
    return respond({ data: [{ name: 'goals', enabled: !existsSync('codex-goals-disabled') }] })
  }
  if (method === 'mcpServerStatus/list') {
    assert.equal(params.threadId, threadId)
    assert.equal(params.detail, 'toolsAndAuthOnly')
    return respond(params.cursor ? { data: [{ name: 'second', runtimeStatus: 'disabled', tools: {} }] } : {
      data: [{ name: 'first', runtimeStatus: 'connected', authStatus: 'bearerToken',
        serverInfo: { token: 'fixture-mcp-secret' }, tools: { smoke: { description: 'fixture-tool-secret' } } }], nextCursor: 'second',
    })
  }
  if (method?.startsWith('thread/goal/')) {
    assert.equal(params.threadId, threadId)
    if (method.endsWith('/get')) return respond({ goal })
    if (method.endsWith('/clear')) {
      goal = undefined
      return respond({ cleared: true })
    }
    assert.equal(params.status, 'paused')
    goal = { threadId, status: 'paused', objective: params.objective ?? goal?.objective, tokensUsed: 0 }
    return respond({ goal })
  }
  if (method === 'thread/archive' || method === 'thread/unarchive') {
    assert.deepEqual(Object.keys(params), ['threadId'])
    const name = 'rollout-' + params.threadId + '.jsonl'
    const active = join(process.env.CODEX_HOME, 'sessions', name)
    const archived = join(process.env.CODEX_HOME, 'archived_sessions', name)
    const archive = method === 'thread/archive'
    const [from, to] = archive ? [active, archived] : [archived, active]
    if (!existsSync(from)) return send({ id, error: { code: -32600, message: 'no rollout found' } })
    renameSync(from, to)
    return respond(archive ? {} : { thread: { id: params.threadId } })
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    assert.equal(params.approvalsReviewer, undefined)
    assert.equal(params.sandbox, undefined)
    assert.equal(params.approvalPolicy, undefined)
    assert.equal(params.cwd, process.cwd())
    if (method === 'thread/resume') {
      if (/^[0-9a-f-]{36}$/.test(params.threadId)) {
        return send({ id, error: { code: -32600,
          message: 'thread ' + params.threadId + ' already has an active writer; private detail fixture-secret' } })
      }
      assert.equal(params.threadId, threadId)
      assert.ok(existsSync('codex-history'))
      assert.notEqual(params.excludeTurns, true)
      respond({ thread: { id: threadId }, model: 'fast', reasoningEffort: 'low',
        ...(alternateAccount ? { modelProvider: 'openai' } : {}), ...nativePermissions() })
      turnId = 'restored-turn'
      return addUsage(900, 80, 70)
    }
    return respond({ thread: { id: threadId }, model: 'fast', reasoningEffort: 'low', ...nativePermissions() })
  }
  if (method === 'thread/settings/update') {
    assert.deepEqual(params, {
      threadId, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly' },
    })
    send({ method: 'thread/settings/updated', params: { threadId, threadSettings: params } })
    return respond({})
  }
  if (method === 'model/list') {
    if (alternateAccount) return respond({ data: [{ model: 'limited', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] })
    const model = params.cursor ? 'smart' : 'fast'
    const inputModalities = model === 'fast' ? ['text', 'image'] : ['text']
    return respond({ data: [{ model, inputModalities, supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'low' }], nextCursor: params.cursor ? null : 'second' })
  }
  if (method === 'skills/list') {
    assert.deepEqual(params.cwds, [process.cwd()])
    const skill = (name, file, enabled = true) => ({ name, path: join(process.cwd(), file), enabled })
    const skills = showSkill ? [
      { ...skill('verify', 'verify/SKILL.md'), description: 'Verify the project' },
      skill('disabled', 'disabled/SKILL.md', false),
      skill('review', 'shadowed/SKILL.md'),
      skill('ambiguous', 'original/SKILL.md'), skill('ambiguous', 'alternate/SKILL.md'),
    ] : []
    return respond({ data: [{ cwd: process.cwd(), skills }] })
  }
  if (method === 'thread/read') {
    assert.equal(params.includeTurns, false)
    if (/^[0-9a-f-]{36}$/.test(params.threadId)) {
      return respond({ thread: { id: params.threadId, cwd: process.cwd(), modelProvider: 'openai' } })
    }
    return respond({ thread: {
      id: params.threadId,
      parentThreadId: params.threadId === 'owned-worker' ? threadId : 'another-root',
    } })
  }
  if (method === 'thread/compact/start') {
    assert.deepEqual(params, { threadId })
    const count = ++compactCount
    turnId = String(++serial)
    respond({})
    return setTimeout(() => {
      const item = { type: 'contextCompaction', id: 'compact-' + count }
      // App-server usually sends turn/started, but the typed compaction item also identifies the turn.
      note('item/started', { item })
      if (count === 2) {
        note('error', { error: { message: 'Compaction failed' }, willRetry: false })
        return complete('completed')
      }
      if (count === 3) return
      note('item/completed', { item })
      complete('completed')
    }, 25)
  }
  if (method === 'review/start') {
    assert.equal(params.threadId, threadId)
    assert.equal(params.delivery, 'inline')
    const targets = [
      { type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'origin/main' },
      { type: 'commit', sha: 'd34db33f' }, { type: 'custom', instructions: 'Check tests' },
      { type: 'custom', instructions: 'Review failure fixture' },
    ]
    assert.deepEqual(params.target, targets[reviewCount])
    turnId = String(++serial)
    note('turn/started', { turn: { id: turnId } })
    respond({ turn: { id: turnId }, reviewThreadId: threadId })
    if (reviewCount === 4) return complete('failed')
    note('item/completed', { item: { type: 'exitedReviewMode', id: 'review-marker', review: 'Fallback review text' } })
    if (reviewCount++ > 0) note('item/completed', { item: { type: 'agentMessage', id: 'review-output', text: 'Native review text' } })
    return complete('completed')
  }
  if (method === 'turn/start') {
    assert.equal(params.approvalPolicy, undefined)
    assert.equal(params.approvalsReviewer, undefined)
    assert.equal(params.sandboxPolicy, undefined)
    turnId = String(++serial)
    const text = params.input.find(item => item.type === 'text')?.text ?? ''
    assert.doesNotMatch(text, /^\\/(compact|review|mcp|goal)(?=\\s|$)/)
    const image = { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }
    if (text === '$verify test') assert.deepEqual(params.input, [image,
      { type: 'text', text, text_elements: [] },
      { type: 'skill', name: 'verify', path: join(process.cwd(), 'verify/SKILL.md') },
    ])
    else if (!text) assert.deepEqual(params.input, [image])
    else assert.deepEqual(params.input, [{ type: 'text', text, text_elements: [] }])
    if (text === 'cancel') return setTimeout(() => respond({ turn: { id: turnId } }), 40)
    note('turn/started', { turn: { id: turnId } })
    respond({ turn: { id: turnId } })
    if (text === 'steering fixture') {
      return note('item/agentMessage/delta', { itemId: 'message', delta: 'Ready' })
    }
    if (text === 'ordered progress') {
      note('item/started', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary' } })
      note('item/agentMessage/delta', { itemId: 'progress', delta: 'Checking.' })
      note('item/completed', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking.' } })
      for (let i = 0; i < 5; i++) {
        const command = { type: 'commandExecution', id: 'read-' + i, command: 'echo ' + i }
        note('item/started', { item: command })
        note('item/completed', { item: { ...command, status: 'completed' } })
      }
      note('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } })
      return complete('completed')
    }
    if (text === 'skills changed') {
      showSkill = false
      send({ method: 'skills/changed' })
    }
    if (text === 'permission') {
      return send({ id: 'permission', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo safe', cwd: process.cwd() } })
    }
    if (text === 'persistent-only') {
      return send({ id: 'persistent-only', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo safe', availableDecisions: ['acceptForSession', 'decline'] } })
    }
    if (text === 'owned-worker' || text === 'outside-worker') {
      return send({ id: text, method: 'item/commandExecution/requestApproval', params: {
        threadId: text, turnId: 'worker-turn', command: 'echo worker',
      } })
    }
    writeFileSync('codex-history', text)
    if (text === 'delegate') {
      const worker = (agentThreadId, kind, agentPath) => note('item/completed', { item: {
        type: 'subAgentActivity', agentThreadId, kind, agentPath,
      } })
      worker('native-a', 'started', '/root/alpha')
      worker('native-b', 'started', '/root/beta')
      addUsage(4, 11, 5)
      usage()
      note('item/completed', { item: { type: 'collabAgentToolCall', tool: 'wait', agentsStates: {
        'native-a': { status: 'completed', message: 'Alpha found the answer' },
        'native-b': { status: 'errored', message: 'Beta failed' },
      } } })
      worker('native-a', 'completed', '/root/alpha')
      addUsage(3, 7, 0)
    } else if (text === 'current usage') {
      usage()
      addUsage(5, 0, 0)
    } else if (text === 'replay usage') {
      usage()
    } else if (text === 'file activity') {
      const item = { id: 'file', type: 'fileChange', changes: [{ path: 'notes.md', kind: { type: 'add' }, diff: 'Private fixture content' }] }
      note('item/started', { item })
      note('item/completed', { item: { ...item, status: 'completed' } })
      const command = { id: 'read', type: 'commandExecution', command: 'cat docs/notes.md', cwd: process.cwd(),
        commandActions: [{ type: 'read', path: 'docs/notes.md' }] }
      note('item/started', { item: command })
      note('item/completed', { item: { id: 'read', type: 'commandExecution', status: 'completed' } })
    } else if (text === 'command output') {
      const command = { id: 'shell', type: 'commandExecution', command: 'echo fixture', env: { PRIVATE: 'do not pass through' } }
      note('item/started', { item: command })
      note('command/exec/outputDelta', { itemId: 'shell', delta: 'app server process output' })
      note('item/commandExecution/outputDelta', { itemId: 'unknown', delta: 'unrelated output' })
      note('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'first\\n' })
      note('item/commandExecution/terminalInteraction', { itemId: 'shell', stdin: 'test input\\n' })
      note('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'second\\n' })
      note('item/completed', { item: { id: 'shell', type: 'commandExecution', status: 'failed',
        aggregatedOutput: 'first\\nsecond\\n', exitCode: 7 } })
    }
    note('item/reasoning/summaryTextDelta', { itemId: 'thought', delta: 'thinking' })
    note('item/agentMessage/delta', { itemId: 'message', delta: params.model + '/' + params.effort + ': ' })
    note('item/agentMessage/delta', { itemId: 'message', delta: text })
    note('item/completed', { item: { id: 'message', type: 'agentMessage', text } })
    complete('completed')
  } else if (method === 'turn/steer') {
    assert.equal(params.threadId, threadId)
    assert.equal(params.expectedTurnId, turnId)
    assert.match(params.clientUserMessageId, /^[a-f0-9-]{36}$/)
    const text = params.input.find(item => item.type === 'text')?.text
    if (text === 'reject steering') {
      return send({ id, error: { code: -32600, message: 'expected active turn id did not match' } })
    }
    if (text === 'wrong acknowledgement') return respond({ turnId: 'different-turn' })
    assert.deepEqual(params.input, [{ type: 'image', url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'text', text: 'Follow-up', text_elements: [] }])
    respond({ turnId })
    note('item/agentMessage/delta', { itemId: 'message', delta: ' followed' })
    complete('completed')
  } else if (method === 'turn/interrupt') {
    assert.equal(params.turnId, turnId)
    respond({})
    complete('interrupted')
  } else if (id === 'permission' || id === 'persistent-only' || id === 'owned-worker' || id === 'outside-worker') {
    note('item/agentMessage/delta', { itemId: 'message', delta: result.decision })
    complete('completed')
  }
})
`

const claude = header + `
const flags = process.argv.slice(2)
const alternateAccount = process.env.DSH_TEST_CLAUDE_PROFILE === 'limited'
assert.ok(flags.includes('--permission-prompt-tool'))
assert.ok(flags.includes('stdio'))
assert.ok(!flags.includes('--permission-mode'))
assert.equal(flags[flags.indexOf('--permission-prompts') + 1], 'host')
const resume = flags.find(flag => flag.startsWith('--resume='))
const sessionId = (resume ?? flags.find(flag => flag.startsWith('--session-id='))).split('=')[1]
assert.match(sessionId, /^[a-f0-9-]{36}$/)
if (resume) assert.ok(existsSync('claude-history'))
let model = 'default'
let effort = 'default'
let contextMode
const event = (type, fields) => send({ type, session_id: sessionId, ...fields })
const complete = () => event('result', { subtype: 'success' })
lines.on('line', line => {
  const { type, request_id, request, message, response } = JSON.parse(line)
  if (type === 'control_request') {
    const respond = response => send({ type: 'control_response', response: { subtype: 'success', request_id, response } })
    switch (request.subtype) {
      case 'initialize': return respond({
        current_permission_mode: existsSync('claude-plan') ? 'plan' : (existsSync('claude-auto') ? 'auto' : 'default'),
        models: [
          { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'high'] },
          alternateAccount ? { value: 'light', displayName: 'Light' }
            : { value: 'smart', displayName: 'Smart', supportedEffortLevels: ['low', 'high'] },
        ],
        commands: [
          { name: 'team-onboarding', description: 'Onboard a team', argumentHint: '[task]' },
          { name: 'exit', description: 'Exit Claude' },
        ],
      })
      case 'set_permission_mode': return respond({ mode: request.mode === 'manual' ? 'default' : request.mode })
      case 'set_model': model = request.model; return respond({})
      case 'get_context_usage':
        assert.equal(request.detail, 'summary')
        if (contextMode === 'silence') return
        return setTimeout(() => respond({ totalTokens: 777, rawMaxTokens: 200000, maxTokens: 170000 }), 35)
      case 'apply_flag_settings': effort = request.settings.effortLevel ?? 'default'; return respond({})
      case 'interrupt':
        assert.equal(request.cancel_queued, true)
        respond({})
        return complete()
    }
  } else if (type === 'user') {
    if (message.content.some(item => item.type === 'image')) {
      const last = message.content.at(-1)
      assert.deepEqual(last, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } })
      assert.ok(message.content.length === 1 || message.content[0].text === 'caption')
      return complete()
    }
    const [{ text }] = message.content
    if (text === 'cancel') return
    if (text === 'missing model') {
      event('assistant', { error: 'model_not_found', apiErrorStatus: 404,
        message: { content: [{ type: 'text', text: 'Unknown model fixture-model' }] } })
      return event('result', { subtype: 'success', is_error: true })
    }
    if (text === 'execution failure') return event('result', { subtype: 'error_during_execution', errors: ['Login expired'] })
    if (text === 'empty failure') return event('result', { subtype: 'success', is_error: true })
    if (text.startsWith('context ')) {
      contextMode = text.slice('context '.length)
      event('system', { subtype: 'init', claude_code_version: contextMode === 'legacy' ? '2.1.300' : '2.1.316' })
      event('assistant', { message: { id: 'request', model: 'claude-actual', usage: {
        input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5,
      } } })
      event('assistant', { parent_tool_use_id: 'agent-call', message: { id: 'agent', model: 'other-model', usage: {
        input_tokens: 900, output_tokens: 900,
      } } })
      return event('result', { subtype: 'success', usage: { input_tokens: 120, output_tokens: 50 }, modelUsage:
        contextMode === 'reported' ? { alias: { canonicalModel: 'claude-actual', contextWindow: 100000 }, other: { contextWindow: 300000 } }
          : { other: { contextWindow: 300000 } },
      })
    }
    if (text === 'file activity') {
      event('assistant', { message: { content: [{ type: 'tool_use', id: 'file', name: 'Read', input: { file_path: 'notes.md', offset: 5 } }] } })
      event('user', { message: { content: [{ type: 'tool_result', tool_use_id: 'file' }] } })
      return complete()
    }
    if (text === 'command output') {
      event('assistant', { message: { content: [
        { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'echo fixture', env: { PRIVATE: 'do not pass through' } } },
      ] } })
      event('user', { message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'not the split streams' }] },
        tool_use_result: { stdout: 'first\\n', stderr: 'second\\n', env: { PRIVATE: 'do not pass through' } } })
      return complete()
    }
    if (text === '/team-onboarding once' || text === '/team-onboarding twice') {
      const second = text.endsWith('twice')
      const task = (subtype, fields) => event('system', { subtype, ...fields })
      task('init', { terminal_slash_commands: ['exit'] })
      task('task_started', { task_id: 'shell', task_type: 'local_bash', description: 'Shell' })
      task('task_started', { task_id: 'native-a', task_type: 'local_agent', tool_use_id: 'agent-call', description: 'Alpha' })
      task('task_started', { task_id: 'native-b', task_type: 'in_process_teammate', description: 'Beta' })
      task('task_progress', { task_id: 'native-b', summary: 'Reviewing' })
      task('task_notification', { task_id: 'native-b', status: 'failed', summary: 'Beta failed' })
      event('assistant', { message: { content: [
        { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { description: 'Alpha' } },
      ] } })
      event('user', { message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call' }] },
        tool_use_result: { status: 'completed', agentId: 'native-a', content: [{ type: 'text', text: 'Alpha found the answer' }] } })
      task('task_notification', { task_id: 'native-a', status: 'completed', summary: 'Alpha completed' })
      return event('result', { subtype: 'success', result: text, usage: {
        input_tokens: 30, output_tokens: second ? 5 : 8,
        cache_read_input_tokens: second ? 0 : 20, cache_creation_input_tokens: second ? 3 : 0,
      }, modelUsage: { smart: { outputTokens: 1000 } } })
    }
    if (text === 'permission') {
      return send({ type: 'control_request', request_id: 'permission', request: {
        subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input: { command: 'echo safe' },
      } })
    }
    if (text === 'ordered progress') {
      const stream = eventData => event('stream_event', { event: eventData })
      const first = { type: 'text', text: 'Checking.' }
      const tool = { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'notes.md' } }
      const last = { type: 'text', text: 'Done.' }
      stream({ type: 'message_start' })
      stream({ index: 0, delta: { type: 'text_delta', text: first.text } })
      stream({ type: 'content_block_start', index: 1, content_block: { ...tool, input: {} } })
      stream({ index: 2, delta: { type: 'text_delta', text: last.text } })
      event('assistant', { message: { content: [first, tool, last] } })
      event('user', { message: { content: [{ type: 'tool_result', tool_use_id: tool.id }] } })
      return complete()
    }
    writeFileSync('claude-history', text)
    event('stream_event', { event: { type: 'message_start' } })
    event('stream_event', { event: { delta: { type: 'thinking_delta', thinking: 'thinking' } } })
    event('stream_event', { event: { delta: { type: 'text_delta', text: model + '/' + effort + ': ' } } })
    event('stream_event', { event: { delta: { type: 'text_delta', text } } })
    event('assistant', { message: { content: [{ type: 'text', text }] } })
    complete()
  } else if (type === 'control_response' && response.request_id === 'permission') {
    if (response.response.behavior === 'allow') {
      assert.deepEqual(response.response.updatedInput, { command: 'echo safe' })
      assert.equal(response.response.toolUseID, 'tool-1')
    }
    event('result', { subtype: 'success', result: response.response.behavior })
  }
})
`

const oldPath = process.env.PATH
let cwd
before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'dsh-direct-chat-engines-'))
  writeFileSync(join(cwd, 'codex'), codex, { mode: 0o700 })
  writeFileSync(join(cwd, 'claude'), claude, { mode: 0o700 })
  process.env.PATH = cwd + delimiter + oldPath
})
after(() => {
  process.env.PATH = oldPath
  if (cwd) rmSync(cwd, { recursive: true, force: true })
})

function collect() {
  const chunks = []
  const permissions = []
  const events = []
  const emit = (type, data) => {
    events.push([type, data])
    if (type === 'permission') permissions.shift().resolve(data)
    else if (data.update?.content?.type === 'text') chunks.push(data.update)
  }
  return {
    emit,
    events,
    nextPermission() {
      const result = Promise.withResolvers()
      permissions.push(result)
      return result.promise
    },
    text: () => chunks.splice(0).map(chunk => chunk.content.text).join(''),
  }
}

test('Codex archives and restores native history with idempotent retries', { timeout: 7000 }, async t => {
  const directory = join(cwd, 'archive-fixture')
  const { CODEX_HOME: savedHome } = process.env
  process.env.CODEX_HOME = directory
  t.after(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
  })
  const remoteId = randomUUID()
  mkdirSync(join(directory, 'sessions'), { recursive: true })
  mkdirSync(join(directory, 'archived_sessions'))
  const file = join(directory, 'sessions', 'rollout-' + remoteId + '.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd, source: 'cli' } }) + '\n')

  const options = { remoteId, cwd }
  const reason = new Error('Cancelled by caller')
  await assert.rejects(codexEngine.setArchived({ ...options, archived: true, signal: AbortSignal.abort(reason) }), reason)
  assert.equal((await codexEngine.history.list({ directory }))[0].archived, false)
  for (const archived of [true, true, false, false]) {
    await codexEngine.setArchived({ ...options, archived })
    const [thread] = await codexEngine.history.list({ directory })
    assert.equal(thread.remoteId, remoteId)
    assert.equal(thread.archived, archived)
  }
  await assert.rejects(codexEngine.setArchived({ cwd, remoteId: randomUUID(), archived: true }), /rejected thread\/archive/)
})

test('Codex displays the native default and preserves it until the user changes it', { timeout: 7000 }, async t => {
  const directory = join(cwd, 'codex-effective-permissions')
  mkdirSync(directory)
  writeFileSync(join(directory, 'codex-auto-review'), '')
  const session = await startOther({ engine: 'codex', cwd: directory, emit() {} })
  t.after(() => session.close())
  const mode = () => session.options.find(option => option.id === 'mode')
  assert.equal(mode().currentValue, 'auto-review')
  assert.equal(mode().options.find(choice => choice.value === 'auto-review').name, 'Approve for me')
  assert.equal((await session.prompt('use native settings')).stopReason, 'end_turn')
  await session.configure('mode', 'read-only')
  assert.equal(mode().currentValue, 'read-only')
  assert.equal((await session.prompt('use the selected settings')).stopReason, 'end_turn')
  await session.close()
  const resumed = await startOther({ engine: 'codex', cwd: directory, resumeId: session.id, emit() {} })
  t.after(() => resumed.close())
  assert.equal(resumed.options.find(option => option.id === 'mode').currentValue, 'auto-review')
})

test('Codex distinguishes a native read-only sandbox with no approvals from full access', { timeout: 7000 }, async t => {
  const directory = join(cwd, 'codex-read-only-permissions')
  mkdirSync(directory)
  writeFileSync(join(directory, 'codex-read-only'), '')
  const session = await startOther({ engine: 'codex', cwd: directory, emit() {} })
  t.after(() => session.close())
  const mode = session.options.find(option => option.id === 'mode')
  assert.equal(mode.options.find(choice => choice.value === mode.currentValue).name, 'Read Only · No approvals')
  assert.equal((await session.prompt('use the read-only sandbox')).stopReason, 'end_turn')
})

test('Claude displays native permission modes and confirms explicit changes', { timeout: 7000 }, async t => {
  const directory = join(cwd, 'claude-effective-permissions')
  mkdirSync(directory)
  writeFileSync(join(directory, 'claude-auto'), '')
  const session = await startOther({ engine: 'claude', cwd: directory, emit() {} })
  t.after(() => session.close())
  const mode = () => session.options.find(option => option.id === 'mode')
  assert.equal(mode().currentValue, 'auto')
  await session.configure('mode', 'acceptEdits')
  assert.equal(mode().currentValue, 'acceptEdits')
  await session.configure('mode', 'manual')
  assert.equal(mode().currentValue, 'manual')
})

test('Codex streams native subagent results and reports per-turn token deltas across a resume', { timeout: 7000 }, async t => {
  const output = collect()
  const opts = { engine: 'codex', cwd, emit: output.emit }
  const session = await startOther(opts)
  t.after(() => session.close())
  assert.deepEqual(await session.prompt('delegate'), { stopReason: 'end_turn' })
  assert.deepEqual(output.events.filter(([type]) => type === 'agent').map(([, data]) => data), [
    { id: 'native-a', name: '/root/alpha', status: 'running' },
    { id: 'native-b', name: '/root/beta', status: 'running' },
    { id: 'native-a', name: '/root/alpha', status: 'completed', detail: 'Alpha found the answer' },
    { id: 'native-b', name: '/root/beta', status: 'failed', detail: 'Beta failed' },
  ])
  assert.ok(output.events.some(([type, data]) => type === 'update' &&
    data.update.sessionUpdate === 'usage_update' && data.update.used === 700 && data.update.size === 65536))
  assert.deepEqual(await session.prompt('replay usage'), { stopReason: 'end_turn' })
  await session.close()
  const resumed = await startOther({ ...opts, resumeId: session.id })
  t.after(() => resumed.close())
  assert.deepEqual(await resumed.prompt('current usage'), { stopReason: 'end_turn' })
  assert.deepEqual(output.events.filter(([type]) => type === 'usage').map(([, data]) => data), [
    { outputTokens: 7, cacheReadTokens: 18, cacheWriteTokens: 5, inputTokens: 200,
      sessionTokens: { input: 200, output: 7, cacheRead: 18, total: 207 } },
    { sessionTokens: { input: 200, output: 7, cacheRead: 18, total: 207 } },
    { outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100,
      sessionTokens: { input: 200, output: 905, cacheRead: 80, total: 1105 } },
  ])
})

test('Codex advertises callable skills and supports mixed and image-only prompts on capable models', { timeout: 7000 }, async t => {
  const output = collect()
  const changed = Promise.withResolvers()
  const session = await startOther({ engine: 'codex', cwd, emit(type, data) {
    output.emit(type, data)
    if (data.update?.sessionUpdate === 'available_commands_update' && !data.update.availableCommands.some(command => command.name === 'verify')) changed.resolve()
  } })
  t.after(() => session.close())
  const commands = output.events.find(([, data]) => data.update?.sessionUpdate === 'available_commands_update')[1].update.availableCommands
  assert.deepEqual(commands.map(command => command.name), ['compact', 'mcp', 'goal', 'review', 'verify'])
  assert.deepEqual(commands.at(-1), { name: 'verify', description: 'Verify the project' })
  assert.equal(session.capabilities.image, true)
  const png = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
  await assert.rejects(session.prompt('Unsupported', [{ ...png, mimeType: 'image/svg+xml' }]), /image format/)
  assert.equal((await session.prompt('/verify test', [png])).stopReason, 'end_turn')
  assert.equal((await session.prompt('', [png])).stopReason, 'end_turn')
  await session.configure('model', 'smart')
  assert.equal(session.capabilities.image, undefined)
  await assert.rejects(session.prompt('Unsupported', [png]), /attachment type/)
  assert.equal((await session.prompt('/clear')).stopReason, 'end_turn')
  await session.prompt('skills changed')
  await changed.promise
  assert.equal((await session.prompt('/verify removed')).stopReason, 'end_turn')
})

test('Codex dispatches compact and inline review through native turns and handles failures and cancellation', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit: output.emit })
  t.after(() => session.close())
  await assert.rejects(session.prompt('/compact extra'), /does not accept arguments/)
  await assert.rejects(session.prompt('/review base'), /one branch name/)
  await assert.rejects(session.prompt('/review commit --all'), /commit hash/)
  await assert.rejects(session.prompt('/review', [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]), /does not accept attachments/)
  assert.deepEqual(await session.prompt('/compact'), { stopReason: 'end_turn' })
  await assert.rejects(session.prompt('/compact'), /context compaction failed/)
  const compact = session.prompt('/compact')
  await assert.rejects(session.steer('follow-up during compaction'), { status: 409 })
  await session.cancel()
  assert.deepEqual(await compact, { stopReason: 'cancelled' })
  const states = output.events.map(([, data]) => data.update).filter(update => update?.sessionUpdate === 'tool_call_update')
  assert.deepEqual(states.map(update => update.status), ['completed', 'failed'])

  assert.deepEqual(await session.prompt('/review'), { stopReason: 'end_turn' })
  assert.equal(output.text(), 'Fallback review text')
  for (const text of ['/review base origin/main', '/review commit d34db33f', '/review custom Check tests']) {
    assert.deepEqual(await session.prompt(text), { stopReason: 'end_turn' })
    assert.equal(output.text(), 'Native review text')
  }
  await assert.rejects(session.prompt('/review Review failure fixture'), /Codex review failed/)
})

test('Codex steers the identified turn and keeps using it after a rejected request', { timeout: 7000 }, async t => {
  const ready = Promise.withResolvers()
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit(type, data) {
    output.emit(type, data)
    if (data.update?.content?.text === 'Ready') ready.resolve()
  } })
  t.after(() => session.close())
  assert.equal(session.capabilities.steer, true)
  await assert.rejects(session.steer('no active turn'), { status: 409 })
  const turn = session.prompt('steering fixture')
  await assert.rejects(session.steer('turn identity missing'), { status: 409 })
  await ready.promise
  await assert.rejects(session.steer('reject steering'), { status: 409 })
  await assert.rejects(session.steer('wrong acknowledgement'), /invalid steering acknowledgement/)
  await session.steer('Follow-up', [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }])
  assert.deepEqual(await turn, { stopReason: 'end_turn' })
  assert.equal(output.text(), 'Ready followed')
  await assert.rejects(session.steer('turn is finished'), { status: 409 })
})

test('Codex dispatches read-only MCP status and gated paused goals without model turns or secret fields', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit: output.emit })
  t.after(() => session.close())
  assert.equal(session.capabilities.goal, true)
  await session.prompt('/mcp')
  const status=output.text()
  assert.match(status,/first · connected · bearerToken · 1 tools/)
  assert.match(status,/second · disabled/)
  assert.doesNotMatch(status,/fixture-.*-secret/)
  await session.prompt('/goal')
  assert.match(output.text(),/No goal is set/)
  await session.prompt('/goal set Temporary fixture objective')
  assert.match(output.text(),/Goal \(paused\).*Temporary fixture objective/s)
  await session.prompt('/goal pause')
  assert.match(output.text(),/Goal \(paused\)/)
  await session.prompt('/goal clear')
  assert.match(output.text(),/Goal cleared/)
  await assert.rejects(session.prompt('/goal resume'), /Automatic execution is not available/)
  await session.close()

  const disabledCwd=mkdtempSync(join(cwd,'disabled-'))
  writeFileSync(join(disabledCwd,'codex-goals-disabled'),'')
  const disabled=await startOther({ engine: 'codex', cwd: disabledCwd, emit: output.emit })
  t.after(() => disabled.close())
  assert.equal(disabled.capabilities.goal, undefined)
  const commands=output.events.findLast(([,data])=>data.update?.sessionUpdate==='available_commands_update')[1].update.availableCommands
  assert.ok(!commands.some(command=>command.name==='goal'))
  await assert.rejects(disabled.prompt('/goal'), /goals are disabled/)
})

test('Codex maps native rate-limit fields and sends rename without opening a model thread', async () => {
  await codexEngine.rename({ remoteId: randomUUID(), title: 'Native fixture name' })
  await assert.rejects(codexEngine.rename({ remoteId: 'title', title: 'Native fixture name' }), /native Codex session ID/)
  const usage=await codexEngine.accountUsage({})
  assert.deepEqual(JSON.parse(JSON.stringify(usage)), { status:'available', limits:[
    {label:'Codex 5h',poolId:'codex',poolLabel:'Codex',windowLabel:'5h',usedPercent:21,resetsAt:1_800_000_000_000},
    {label:'Codex 7d',poolId:'codex',poolLabel:'Codex',windowLabel:'7d',usedPercent:30},
    {label:'Codex 30d',poolId:'partner',poolLabel:'Codex',windowLabel:'30d',usedPercent:87},
  ] })
})

test('Codex inspects composer options without resume and reports native writer conflicts safely', { timeout: 7000 }, async () => {
  const remoteId = randomUUID()
  const configuration = await codexEngine.inspect({remoteId,cwd,savedOptions:[
    {id:'model',currentValue:'smart'}, {id:'reasoning_effort',currentValue:'high'},
  ]})
  assert.deepEqual(configuration.options.map(({id,currentValue})=>[id,currentValue]),[['model','smart'],['reasoning_effort','high'],['mode','cli-default']])
  const configured = await codexEngine.inspect({ remoteId, cwd, savedOptions: [{ id: 'mode', currentValue: 'auto-review' }] })
  assert.equal(configured.options.find(option => option.id === 'mode').currentValue, 'auto-review')
  assert.equal(configuration.capabilities.image,undefined)
  assert.ok(configuration.commands.some(command=>command.name==='verify'))
  await assert.rejects(codexEngine.start({resumeId:remoteId,cwd,emit(){}}), error => {
    assert.equal(error.status,409)
    assert.equal(error.code,'codex_session_in_use')
    assert.match(error.message,/open in another process/)
    assert.doesNotMatch(error.message,/fixture-secret/)
    return true
  })
  await assert.rejects(codexEngine.start({resumeId:remoteId,cwd:join(cwd,'missing'),emit(){}}), {code:'codex_workspace_missing'})
})

test('Codex resume and inspection use the selected account catalog when the recorded model is unavailable', { timeout: 7000 }, async t => {
  writeFileSync(join(cwd, 'codex-history'), 'fixture previous turn')
  const env = { DSH_TEST_CODEX_PROFILE: 'limited' }
  const session = await startOther({ engine: 'codex', cwd, env, resumeId: 'native-codex-thread', switchingAccount: true, emit() {} })
  t.after(() => session.close())
  const choices = option => session.options.find(item => item.id === option)
  assert.deepEqual(choices('model').options.map(option => option.value), ['limited'])
  assert.equal(choices('model').currentValue, 'limited')
  assert.equal(choices('reasoning_effort').currentValue, 'medium')
  await assert.rejects(session.configure('model', 'fast'), /Invalid chat configuration/)
  const inspected = await inspectCodexThread({ cwd, env, remoteId: randomUUID(), model: 'fast', effort: 'low' })
  assert.deepEqual(inspected.options[0].options.map(option => option.value), ['limited'])
  assert.equal(inspected.options[0].currentValue, 'limited')
})

test('Claude Code exposes the resumed account native model choices', { timeout: 7000 }, async t => {
  writeFileSync(join(cwd, 'claude-history'), 'fixture previous turn')
  const session = await startOther({ engine: 'claude', cwd, env: { DSH_TEST_CLAUDE_PROFILE: 'limited' },
    resumeId: randomUUID(), switchingAccount: true, emit() {} })
  t.after(() => session.close())
  assert.deepEqual(session.options[0].options.map(option => option.value), ['default', 'light'])
  await assert.rejects(session.configure('model', 'smart'), /Invalid chat configuration/)
})

test('Claude exposes CLI errors per turn without emitting synthetic assistant text', async t => {
  const output = collect()
  const session = await startOther({ engine: 'claude', cwd, emit: output.emit })
  t.after(() => session.close())
  await assert.rejects(session.prompt('missing model'), /404.*model_not_found.*fixture-model/)
  await assert.rejects(session.prompt('execution failure'), { message: 'Login expired' })
  await assert.rejects(session.prompt('empty failure'), { message: 'Claude Code turn failed' })
  assert.equal(output.text(), '')
})

test('Claude sends supported images with and without a caption', { timeout: 7000 }, async t => {
  const session = await startOther({ engine: 'claude', cwd, emit() {} })
  t.after(() => session.close())
  assert.ok(session.capabilities.image)
  assert.equal(session.capabilities.steer, true)
  assert.equal(typeof session.steer, 'function')
  const image = { type:'image', mimeType:'image/png', data:'AQID' }
  for(const caption of ['', 'caption']) {
    assert.equal((await session.prompt(caption,[image])).stopReason,'end_turn')
  }
  await assert.rejects(session.prompt('caption',[{...image,mimeType:'image/svg+xml'}]))
})

test('Claude advertises native commands, reports agent results and reads the result usage for each turn', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'claude', cwd, emit: output.emit })
  t.after(() => session.close())
  assert.deepEqual((await session.prompt('/team-onboarding once')).stopReason, 'end_turn')
  assert.equal(output.text(), '/team-onboarding once')
  const commands = output.events.filter(([, data]) => data.update?.sessionUpdate === 'available_commands_update').at(-1)[1].update.availableCommands
  assert.deepEqual(commands, [{ name: 'team-onboarding', description: 'Onboard a team', input: { hint: '[task]' } }])
  assert.deepEqual(output.events.filter(([type]) => type === 'agent').map(([, data]) => data), [
    { id: 'native-a', name: 'Alpha', status: 'running' },
    { id: 'native-b', name: 'Beta', status: 'running' },
    { id: 'native-b', name: 'Beta', status: 'running', detail: 'Reviewing' },
    { id: 'native-b', name: 'Beta', status: 'failed', detail: 'Beta failed' },
    { id: 'native-a', name: 'Alpha', status: 'completed', detail: 'Alpha found the answer' },
  ])
  assert.deepEqual((await session.prompt('/team-onboarding twice')).stopReason, 'end_turn')
  assert.deepEqual(output.events.filter(([type]) => type === 'usage').map(([, data]) => data), [
    { outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 0, inputTokens: 50 },
    { outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 3, inputTokens: 33 },
  ])
})

test('Claude distinguishes the latest context request from turn totals and treats summary as optional', { timeout: 7000 }, async t => {
  const output = collect()
  const summary = Promise.withResolvers()
  const session = await startOther({ engine: 'claude', cwd, emit(type,data) {
    output.emit(type,data)
    if (data.update?.sessionUpdate === 'usage_update' && data.update.size === 200000) summary.resolve(data.update)
  } })
  t.after(() => session.close())
  const usages = () => output.events.filter(([type]) => type === 'usage').map(([, data]) => data)
  const contexts = () => output.events.map(([, data]) => data.update).filter(update => update?.sessionUpdate === 'usage_update')

  await session.prompt('context reported')
  assert.deepEqual(usages().at(-1), { inputTokens: 120, outputTokens: 50, contextUsed: 65, contextSize: 100000 })
  await session.prompt('context summary')
  assert.deepEqual(usages().at(-1), { inputTokens: 120, outputTokens: 50, contextUsed: 65 })
  assert.deepEqual(await summary.promise, { sessionUpdate: 'usage_update', used: 65, size: 200000 })

  // A model switch fences off a pending summary from the previous model.
  await session.prompt('context summary')
  await session.configure('model', 'smart')
  await session.prompt('context legacy')
  assert.deepEqual(await session.context(), {
    source: 'lastRequest', model: 'claude-actual', used: 65, size: undefined,
    requestTokens: { input: 55, output: 10, cacheRead: 20, cacheWrite: 5 },
  })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(contexts().filter(update => update.size === 200000).length, 1)

  // An unresponsive optional request expires without closing the conversation.
  await session.prompt('context silence')
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal((await session.prompt('context reported')).stopReason, 'end_turn')
})

test('Codex offers one-time approval for its own subagent and declines another thread', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit: output.emit })
  t.after(() => session.close())
  const request = output.nextPermission()
  const turn = session.prompt('owned-worker')
  const { toolCall, options } = await request
  assert.equal(toolCall.title, 'echo worker')
  assert.deepEqual(options.map(option => option.kind), ['allow_once', 'reject_once'])
  session.approve(toolCall.toolCallId, options[0].optionId)
  assert.deepEqual(await turn, { stopReason: 'end_turn' })
  assert.equal(output.text(), 'accept')
  const unexpected = output.nextPermission().then(() => assert.fail('Approval was offered for another thread'))
  assert.deepEqual(await Promise.race([session.prompt('outside-worker'), unexpected]), { stopReason: 'end_turn' })
  assert.equal(output.text(), 'decline')
})

const finished = { stopReason: 'end_turn' }

test('Codex streams native commentary before the five commands and the final answer after them', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit: output.emit })
  t.after(() => session.close())
  assert.deepEqual(await session.prompt('ordered progress'), finished)
  const updates = output.events.map(([, data]) => data.update).filter(update => update &&
    ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate))
  assert.deepEqual(updates.map(update => update.toolCallId ? [update.toolCallId, update.status]
    : [update.messageId, update.phase, update.content.text]), [
    ['progress', 'commentary', 'Checking.'],
    ...Array.from({ length: 5 }, (_, i) => [['read-' + i, 'in_progress'], ['read-' + i, 'completed']]).flat(),
    ['answer', 'final_answer', 'Done.'],
  ])
})

test('Claude publishes streamed tool starts before later text and fills in input details', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'claude', cwd, emit: output.emit })
  t.after(() => session.close())
  assert.deepEqual(await session.prompt('ordered progress'), finished)
  const updates = output.events.map(([, data]) => data.update).filter(update =>
    ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(update?.sessionUpdate))
  assert.deepEqual(updates.map(update => update.content?.text ?? [update.sessionUpdate, update.toolCallId, update.status, update.locations]), [
    'Checking.',
    ['tool_call', 'read', 'in_progress', undefined],
    'Done.',
    ['tool_call_update', 'read', undefined, [{ path: 'notes.md' }]],
    ['tool_call_update', 'read', 'completed', undefined],
  ])
})

test('Codex streams only tracked tool output and finishes with the native exit code', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'codex', cwd, emit: output.emit, signal: t.signal })
  t.after(() => session.close())
  await session.prompt('command output')
  const tools = output.events.map(([, data]) => data.update).filter(update => update?.toolCallId === 'shell')
  assert.deepEqual(tools.map(tool => tool.execution), [
    { command: 'echo fixture' },
    { command: 'echo fixture', output: 'first\n' },
    { command: 'echo fixture', output: 'first\n', input: 'test input\n' },
    { command: 'echo fixture', input: 'test input\n', output: 'first\nsecond\n' },
    { command: 'echo fixture', input: 'test input\n', output: 'first\nsecond\n', exitCode: 7 },
  ])
  assert.equal(tools.at(-1).status, 'failed')
  assert.equal(JSON.stringify(output.events).includes('do not pass through'), false)
  assert.equal(JSON.stringify(output.events).includes('unrelated output'), false)
  assert.equal(JSON.stringify(output.events).includes('app server process output'), false)
})

test('Claude turns Bash results into separate streams without inferring an exit code', { timeout: 7000 }, async t => {
  const output = collect()
  const session = await startOther({ engine: 'claude', cwd, emit: output.emit, signal: t.signal })
  t.after(() => session.close())
  await session.prompt('command output')
  const tools = output.events.map(([, data]) => data.update).filter(update => update?.toolCallId === 'shell')
  assert.deepEqual(tools.map(tool => tool.execution), [
    { command: 'echo fixture' },
    { command: 'echo fixture', stdout: 'first\n', stderr: 'second\n' },
  ])
  assert.equal(tools.at(-1).status, 'completed')
  assert.equal(JSON.stringify(output.events).includes('do not pass through'), false)
})

for (const engine of ['codex', 'claude']) {
  test(`${engine} publishes native file tool locations`, { timeout: 7000 }, async t => {
    const output = collect()
    const session = await startOther({ engine, cwd, emit: output.emit })
    t.after(() => session.close())
    assert.deepEqual(await session.prompt('file activity'), finished)
    const updates = output.events.map(([, data]) => data.update).filter(update => update?.sessionUpdate.startsWith('tool_call'))
    const started = updates[0]
    assert.equal(started?.kind, engine === 'codex' ? 'write' : 'read')
    assert.deepEqual(started?.locations, [engine === 'codex' ? { path: 'notes.md' } : { path: 'notes.md', line: 5 }])
    if (engine === 'codex') {
      const read = updates.findLast(update => update.toolCallId === 'read')
      assert.equal(read.kind, 'read')
      assert.deepEqual(read.locations, [{ path: join(cwd, 'docs/notes.md') }])
      assert.equal(read.status, 'completed')
    }
  })

  test(`${engine} selects model and effort, streams once, cancels, and resumes`, { timeout: 7000 }, async t => {
    const output = collect()
    const opts = { engine, cwd, emit: output.emit }
    const session = await startOther(opts)
    t.after(() => session.close())
    await session.configure('model', 'smart')
    await session.configure('reasoning_effort', 'high')
    const prompt = '--first line\nquotes :)'
    assert.deepEqual(await session.prompt(prompt), finished)
    assert.equal(output.text(), 'thinkingsmart/high: ' + prompt)
    const pending = session.prompt('cancel')
    await session.cancel()
    assert.deepEqual(await pending, { stopReason: 'cancelled' })
    if (engine === 'claude') await session.configure('reasoning_effort', 'default')
    assert.deepEqual(await session.prompt('after cancel'), finished)
    assert.equal(output.text(), 'thinkingsmart/' + (engine === 'claude' ? 'default' : 'high') + ': after cancel')
    await session.close()
    const resumed = await startOther({ ...opts, resumeId: session.id })
    t.after(() => resumed.close())
    assert.equal(resumed.id, session.id)
    assert.deepEqual(await resumed.prompt('next turn'), finished)
    assert.ok(output.text().endsWith(': next turn'))
  })

  test(`${engine} supports explicit approval and rejection without persistent grants`, { timeout: 7000 }, async t => {
    const output = collect()
    const session = await startOther({ engine, cwd, emit: output.emit })
    t.after(() => session.close())
    for (const approve of [true, false]) {
      const request = output.nextPermission()
      const turn = session.prompt('permission')
      const { toolCall, options } = await request
      assert.equal(toolCall.title, 'echo safe')
      assert.deepEqual(options.map(option => option.kind), ['allow_once', 'reject_once'])
      assert.throws(() => session.approve(toolCall.toolCallId, 'always'), /Invalid permission decision/)
      session.approve(toolCall.toolCallId, options[approve ? 0 : 1].optionId)
      assert.deepEqual(await turn, finished)
      assert.equal(output.text(), engine === 'codex' ? (approve ? 'accept' : 'decline') : (approve ? 'allow' : 'deny'))
      assert.throws(() => session.approve(toolCall.toolCallId, 'allow-once'), /expired/)
    }
    if (engine === 'codex') {
      assert.deepEqual(await session.prompt('persistent-only'), finished)
      assert.equal(output.text(), 'decline')
    }
  })
}
