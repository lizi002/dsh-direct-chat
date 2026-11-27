import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { spawnCli } from '../engines/cli-admin.mjs'
import { claudeContextSize, claudeInput, claudeRequestContext } from './claude-usage.mjs'
import { claudeAccountUsage, claudeContextSummary } from './claude-native.mjs'
import { codexCommands, parseCodexCommand } from './codex-commands.mjs'
import { codexRateLimits, codexRequestContext } from './codex-usage.mjs'
import { codexSessionTokens } from './persisted-metrics.mjs'
import { appendExecutionText, claudeCommandResult, claudeToolActivity, codexCommandActivity, codexExecution, codexFileActivity, completeExecution } from './tool-activity.mjs'

const MODELS = 'model'
const EFFORT = 'reasoning_effort'
const MODE = 'mode'
const DEFAULT_EFFORT = 'default'
const cliDefaultMode = { value: 'cli-default', name: 'CLI default', description: 'Use the agent’s configured permissions.' }
const codexModes = [
  { value: 'on-request', name: 'Default', description: 'Edit within the workspace and ask for approval outside it.',
    sandbox: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  { value: 'plan', name: 'Plan mode', description: 'Plan changes without executing edits.',
    collaborationMode: 'plan' },
  { value: 'auto-review', name: 'Approve for me', description: 'Let Codex review requests to go outside the workspace sandbox.',
    sandbox: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  { value: 'untrusted', name: 'Untrusted', description: 'Require approval for untrusted operations.',
    sandbox: 'workspaceWrite', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  { value: 'never', name: 'No approvals', description: 'Stay within the workspace sandbox without asking for approval.',
    sandbox: 'workspaceWrite', approvalPolicy: 'never', approvalsReviewer: 'user' },
  { value: 'read-only', name: 'Read Only', description: 'Ask for approval before writing files or accessing the internet.',
    sandbox: 'readOnly', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
]
const claudeModes = [
  { value: 'manual', name: 'Ask before edits', description: 'Prompt for tool approvals.' },
  { value: 'acceptEdits', name: 'Accept edits', description: 'Automatically approve file edits.' },
  { value: 'plan', name: 'Plan mode', description: 'Plan changes without executing edits.' },
  { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Run tools without approval prompts.' },
  { value: 'dontAsk', name: 'Don’t ask', description: 'Deny operations that would require approval.' },
  { value: 'auto', name: 'Auto', description: 'Let Claude review tool permissions automatically.' },
]
const codexArgs = ['app-server', '--stdio']
const codexImageTypes = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ALLOW = 'allow-once'
const REJECT = 'reject-once'
const CANCELLED = { stopReason: 'cancelled' }
const codexAgentStatuses = new Map(Object.entries({
  pendingInit: 'queued', running: 'running', interrupted: 'interrupted', completed: 'completed',
  errored: 'failed', shutdown: 'interrupted', notFound: 'failed',
}))
const codexAgentActivity = new Map(Object.entries({
  started: 'running', completed: 'completed', interrupted: 'interrupted',
}))
const claudeTaskStatuses = new Map(Object.entries({
  pending: 'queued', running: 'running', paused: 'waiting', completed: 'completed',
  failed: 'failed', killed: 'interrupted', stopped: 'interrupted',
}))
const claudeAgentTools = new Set(['Agent', 'Task'])

function select(id, name, category, currentValue, options) {
  return { id, name, category, type: 'select', currentValue, options }
}

function effortChoice(value, description) {
  return { value, name: value[0].toUpperCase() + value.slice(1), description }
}

function tokenCounts(outputTokens, cacheReadTokens, cacheWriteTokens, inputTokens) {
  return Object.fromEntries(Object.entries({ outputTokens, cacheReadTokens, cacheWriteTokens, inputTokens })
    .filter(([, count]) => Number.isSafeInteger(count) && count >= 0))
}

function agentUpdates(emit, defaultName) {
  const agents = new Map()
  return (id, status, name, detail) => {
    if (typeof id !== 'string' || !id || !status) return
    const previous = agents.get(id)
    const next = { id, status, name: name || previous?.name || defaultName }
    if (typeof detail === 'string' && detail.trim()) next.detail = detail
    else if (status === previous?.status && previous.detail) next.detail = previous.detail
    if (status === previous?.status && next.name === previous.name && next.detail === previous.detail) return
    agents.set(id, next)
    emit('agent', next)
  }
}

function codexRequestError(method, { message } = {}) {
  if (method === 'turn/steer') {
    return Object.assign(new Error('Codex rejected steering the active turn'), { status: 409 })
  }
  if (!['thread/resume', 'thread/read'].includes(method) || typeof message !== 'string') return
  const reasons = [
    [/already has an active writer|already has a live local writer|is closing; retry thread\/resume/i,
      'codex_session_in_use', 409, 'This Codex conversation is open in another process. Close it there, then try again.'],
    [/\bis archived\b|\bunarchive it first\b/i,
      'codex_session_archived', 409, 'Restore the Codex conversation before continuing.'],
    [/\bno rollout found\b|\bthread not found\b|\bsession not found\b|\bthread not loaded\b/i,
      'codex_session_missing', 404, 'Codex could not find this conversation in its native history.'],
    [/\binvalid (?:session|thread) id\b/i,
      'codex_session_invalid', 400, 'The Codex conversation ID is invalid.'],
    [/failed to (?:load|read).*history|did not include persisted history|error resuming thread|failed to read thread/i,
      'codex_session_unreadable', 409, 'Codex could not load the saved history. Open the conversation in Codex to check whether it can be continued.'],
  ]
  const reason = reasons.find(([pattern]) => pattern.test(message))
  if (reason) return Object.assign(new Error(reason[3]), { code: reason[1], status: reason[2] })
  if (method === 'thread/resume') return new Error('Codex could not reopen this conversation. Try opening it in Codex.')
}

function connect(engine, args, { cwd, env }, onMessage, onFailure) {
  const codex = engine === 'codex'
  const label = codex ? 'Codex' : 'Claude Code'
  const group = process.platform !== 'win32'
  const child = spawnCli(engine, args, { cwd, env, detached: group, stdio: ['pipe', 'pipe', 'ignore'] })
  const ended = Promise.withResolvers()
  const pending = new Map()
  let nextId = 0
  let failure
  let termTimer
  let killTimer

  function stop(error) {
    if (failure) return
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    onFailure(error)
  }

  function kill(signal) {
    try {
      if (group && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill(signal)
    }
  }

  function close(error = new Error(`${label} session closed`)) {
    stop(error)
    if (!termTimer && child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      termTimer = setTimeout(() => kill('SIGTERM'), 1_000)
      killTimer = setTimeout(() => kill('SIGKILL'), 3_000)
    }
    return ended.promise
  }

  function send(message) {
    if (failure) throw failure
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  async function request(method, params, optionalTimeout) {
    const id = codex ? ++nextId : String(++nextId)
    const result = Promise.withResolvers()
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out during ${method}`)
      if (optionalTimeout === undefined) void close(error)
      else result.reject(error)
    }, optionalTimeout ?? 30_000)
    try {
      pending.set(id, { method, ...result })
      send(codex
        ? { id, method, params }
        : { type: 'control_request', request_id: id, request: { subtype: method, ...params } })
      return await result.promise
    } finally {
      pending.delete(id)
      clearTimeout(timer)
    }
  }

  child.on('error', error => {
    stop(new Error(error.code === 'ENOENT' ? `${label} executable or workspace was not found` : `${label} process failed to start`))
  })
  child.stdin.on('error', () => {
    void close(new Error(`${label} connection closed`))
  })
  child.on('close', (code, signal) => {
    clearTimeout(termTimer)
    clearTimeout(killTimer)
    stop(new Error(`${label} exited (${signal ?? code})`))
    ended.resolve()
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('error', () => {
    void close(new Error(`${label} connection closed`))
  })
  lines.on('line', line => {
    if (failure || !line.trim()) return
    try {
      const message = JSON.parse(line)
      const response = codex && !message.method ? message
        : !codex && message.type === 'control_response' ? message.response
        : undefined
      const request = pending.get(codex ? response?.id : response?.request_id)
      if (request) {
        if (codex ? response.error : response.subtype !== 'success') {
          request.reject((codex && codexRequestError(request.method, response.error)) || new Error(`${label} rejected ${request.method}`))
        } else {
          request.resolve(codex ? response.result : response.response)
        }
      } else if (!response) {
        onMessage(message)
      }
    } catch {
      void close(new Error(`${label} sent an invalid protocol message`))
    }
  })

  return { request, send, close }
}

async function initializeCodex(wire, experimentalApi = false) {
  await wire.request('initialize', {
    clientInfo: { name: 'dsh-direct-chat', title: 'Direct Chat', version: '1.0.0' },
    capabilities: { experimentalApi, requestAttestation: false },
  })
  wire.send({ method: 'initialized' })
}

async function withCodexServer({ cwd, signal, env, extraArgs = [], waitForExit = true }, use) {
  signal?.throwIfAborted()
  const wire = connect('codex', [...extraArgs,...codexArgs], { cwd, env: env ? {...process.env,...env} : process.env }, () => {}, () => {})
  const abort = () => { void wire.close() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await initializeCodex(wire)
    signal?.throwIfAborted()
    return await use(wire)
  } finally {
    signal?.removeEventListener('abort', abort)
    const closed = wire.close()
    if (waitForExit) await closed
  }
}

export function setCodexArchived({ remoteId, cwd, archived, signal }) {
  return withCodexServer({ cwd, signal }, wire => wire.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: remoteId }))
}

export async function renameCodexThread({ remoteId, cwd, title, signal }) {
  await withCodexServer({ cwd, signal }, wire => wire.request('thread/name/set', { threadId: remoteId, name: title }))
}

export async function readCodexAccountUsage({ cwd, signal, env, extraArgs }) {
  try {
    return codexRateLimits(await withCodexServer({ cwd, signal, env, extraArgs, waitForExit: false }, wire => wire.request('account/rateLimits/read', undefined, 5_000)))
  } catch {
    signal?.throwIfAborted()
    return codexRateLimits()
  }
}

async function readCodexSkills(wire, cwd) {
  const reply = await wire.request('skills/list', { cwds: [cwd] }, 1_500).catch(() => undefined)
  const entries = Array.isArray(reply?.data) ? reply.data.find(entry => entry?.cwd === cwd)?.skills : undefined
  const skills = new Map()
  const ambiguous = new Set()
  for (const skill of Array.isArray(entries) ? entries : []) {
    const { name, path, enabled } = skill ?? {}
    if (enabled !== true || typeof name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(name) ||
        typeof path !== 'string' || !isAbsolute(path) || ambiguous.has(name) || codexCommands.some(command => command.name === name)) continue
    if (skills.has(name) && skills.get(name).path !== path) {
      ambiguous.add(name)
      skills.delete(name)
      continue
    }
    skills.set(name, { name, path, description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description ?? '' })
  }
  return skills
}

async function readCodexGoals(wire, threadId) {
  let cursor
  const seen = new Set()
  do {
    const reply = await wire.request('experimentalFeature/list', { threadId, cursor, limit: 100 }, 1_000).catch(() => undefined)
    const feature = Array.isArray(reply?.data) ? reply.data.find(entry => entry?.name === 'goals') : undefined
    if (feature) return feature.enabled === true
    cursor = reply?.nextCursor
    if (seen.has(cursor)) break
    seen.add(cursor)
  } while (cursor)
  return false
}

async function readCodexModels(wire, modelProvider, timeout) {
  const catalog = new Map()
  const seen = new Set()
  let cursor
  do {
    const page = await wire.request('model/list', { modelProvider, cursor }, timeout)
    for (const entry of page?.data ?? []) {
      if (typeof entry.model !== 'string' || entry.hidden) continue
      catalog.set(entry.model, {
        choice: { value: entry.model, name: entry.displayName ?? entry.model, description: entry.description },
        efforts: (entry.supportedReasoningEfforts ?? []).map(option => effortChoice(option.reasoningEffort, option.description)),
        defaultEffort: entry.defaultReasoningEffort,
        image: Array.isArray(entry.inputModalities) && entry.inputModalities.includes('image'),
        isDefault: entry.isDefault === true,
      })
    }
    cursor = page?.nextCursor
    if (seen.has(cursor)) break
    seen.add(cursor)
  } while (cursor)
  return catalog
}

function defaultCodexModel(catalog) {
  return [...catalog].find(([, entry]) => entry.isDefault)?.[0] ?? catalog.keys().next().value
}

function codexPermissionMode({ sandbox, approvalPolicy, approvalsReviewer, activePermissionProfile, collaborationMode }) {
  if (collaborationMode?.mode === 'plan') return codexModes.find(choice => choice.value === 'plan')
  if (!sandbox?.type) return cliDefaultMode
  const known = codexModes.find(choice => choice.sandbox === sandbox.type && choice.approvalPolicy === approvalPolicy &&
    (approvalPolicy === 'never' || choice.approvalsReviewer === approvalsReviewer))
  if (typeof activePermissionProfile?.id === 'string' && !activePermissionProfile.id.startsWith(':')) {
    return { value: 'custom', name: 'Custom permissions', description: 'Use the active Codex permission profile.' }
  }
  if (known) return known
  if (sandbox.type === 'dangerFullAccess' && approvalPolicy === 'never') {
    return { value: 'full-access', name: 'Full Access', description: 'Run without file or network sandbox restrictions or approval prompts.' }
  }
  const sandboxName = { readOnly: 'Read Only', workspaceWrite: 'Workspace', dangerFullAccess: 'Full filesystem access', externalSandbox: 'External sandbox' }[sandbox.type]
  const approvalName = { 'on-request': approvalsReviewer === 'auto_review' ? 'Approve for me' : 'Ask for approval', never: 'No approvals', untrusted: 'Untrusted' }[approvalPolicy]
  const name = [sandboxName, approvalName].filter(Boolean).join(' · ') || 'Custom permissions'
  return { value: 'custom', name, description: 'Use the active Codex sandbox and approval policy.' }
}

function codexOptions(catalog, model, effort, mode) {
  if (!model) return []
  const efforts = catalog.get(model)?.efforts ?? []
  const choices = codexModes.includes(mode) ? codexModes : [mode, ...codexModes]
  return [select(MODELS, 'Model', 'model', model, [...catalog.values()].map(entry => entry.choice)),
    ...efforts.length ? [select(EFFORT, 'Reasoning effort', 'thought_level', effort, efforts)] : [],
    select(MODE, 'Permission', 'mode', mode.value, choices.map(({ value, name, description }) => ({ value, name, description }))),
  ]
}

function codexCapabilities(catalog, model, goals) {
  return { steer: true, ...catalog.get(model)?.image ? { image: true, imageMimeTypes: codexImageTypes } : {}, ...goals ? { goal: true } : {} }
}

function codexCommandList(skills, goals) {
  return [...codexCommands.filter(command => command.name !== 'goal' || goals),
    ...[...skills.values()].map(({ name, description }) => ({ name, description })),
  ]
}

export async function inspectCodexThread({ remoteId, cwd, model: persistedModel, effort: persistedEffort, savedOptions, signal, env, extraArgs }) {
  return withCodexServer({ cwd, signal, env, extraArgs }, async wire => {
    const { thread } = await wire.request('thread/read', { threadId: remoteId, includeTurns: false }, 4_000)
    if (thread?.id !== remoteId) throw new Error('Codex returned an invalid conversation')
    const [catalog, skills, goals] = await Promise.all([
      readCodexModels(wire, thread.modelProvider, 2_500).catch(() => new Map()),
      readCodexSkills(wire, thread.cwd ?? cwd),
      // This app server does not load the thread. It resolves feature settings from its workspace config.
      readCodexGoals(wire),
    ])
    const wanted = Array.isArray(savedOptions) ? savedOptions : []
    const defaultModel = defaultCodexModel(catalog)
    const savedModel = wanted.find(option => option?.id === MODELS)?.currentValue
    const model = [savedModel, persistedModel].find(value => catalog.has(value)) ??
      (defaultModel && thread.modelProvider === 'openai' ? defaultModel : persistedModel ?? defaultModel)
    if (model && !catalog.has(model)) catalog.set(model, { choice: { value: model, name: model } })
    const modelInfo = catalog.get(model)
    const savedEffort = wanted.find(option => option?.id === EFFORT)?.currentValue
    const effort = [savedEffort, persistedEffort, modelInfo?.defaultEffort].find(value => modelInfo?.efforts?.some(choice => choice.value === value))
      ?? modelInfo?.efforts?.[0]?.value
    const savedMode = wanted.find(option => option?.id === MODE)
    const savedModes = Array.isArray(savedMode?.options) ? savedMode.options : []
    const mode = codexModes.find(choice => choice.value === savedMode?.currentValue)
      ?? savedModes.find(choice => choice?.value === savedMode.currentValue && typeof choice.name === 'string')
      ?? cliDefaultMode
    return { options: codexOptions(catalog, model, effort, mode), capabilities: codexCapabilities(catalog, model, goals), commands: codexCommandList(skills, goals) }
  })
}

function approvalPrompt(emit) {
  const pending = new Map()
  return {
    ask(nativeId, toolCall, respond) {
      if (pending.has(nativeId)) return
      const toolCallId = randomUUID()
      const options = [
        { optionId: ALLOW, name: 'Allow once', kind: 'allow_once' },
        { optionId: REJECT, name: 'Reject', kind: 'reject_once' },
      ]
      pending.set(nativeId, { toolCallId, respond })
      emit('permission', { toolCall: { ...toolCall, toolCallId }, options })
    },
    answer(id, option) {
      for (const [nativeId, request] of pending) {
        if (request.toolCallId !== id) continue
        if (option !== REJECT && option !== ALLOW) throw new Error('Invalid permission decision')
        pending.delete(nativeId)
        request.respond(option === ALLOW)
        return
      }
      throw new Error('Permission request has expired')
    },
    forget(id) { pending.delete(id) },
    clear() {
      const requests = [...pending.values()]
      pending.clear()
      for (const { respond } of requests) {
        try { respond(false) } catch { /* The transport can already be closed. */ }
      }
    },
  }
}

function codexAdapter(wire, { cwd, resumeId, forkFrom, modelProvider, switchingAccount, update, publish, approvals, getTurn, emit }) {
  let catalog = new Map()
  const subagents = new Map()
  const runningCommands = new Map()
  const reportAgent = agentUpdates(emit, 'Codex agent')
  let skills = new Map()
  let skillsRevision = 0
  let skillsCwd = cwd
  let threadId
  let goals = false
  let contextUsage
  let model
  let activeProvider
  let effort
  let mode = cliDefaultMode
  let previousTurnId
  let tokenTotals = resumeId || forkFrom ? undefined : { counts: { ...tokenCounts(0, 0, 0, 0), reasoningTokens: 0 }, totalTokens: 0 }

  const effortOptions = () => catalog.get(model)?.efforts ?? []
  const options = () => codexOptions(catalog, model, effort, mode)

  async function refreshSkills() {
    const revision = ++skillsRevision
    const next = await readCodexSkills(wire, skillsCwd)
    if (revision !== skillsRevision) return
    skills = next
    publish({ sessionUpdate: 'available_commands_update', availableCommands: codexCommandList(skills, goals) })
  }

  async function listMcp() {
    const rows = []
    const connectionStates = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'])
    const authStates = new Set(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth', 'oauth'])
    const seen = new Set()
    let cursor
    do {
      const page = await wire.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', cursor })
      if (!Array.isArray(page?.data)) throw new Error('Codex returned invalid MCP status')
      for (const server of page.data) {
        if (typeof server?.name !== 'string' || !server.name.trim()) continue
        const name = server.name.replace(/[^\p{L}\p{N}_.:-]+/gu, ' ').trim().slice(0, 120)
        if (!name) continue
        const values = []
        if (connectionStates.has(server.runtimeStatus)) values.push(server.runtimeStatus)
        if (authStates.has(server.authStatus)) values.push(server.authStatus)
        if (server.tools && typeof server.tools === 'object' && !Array.isArray(server.tools)) values.push(`${Object.keys(server.tools).length} tools`)
        rows.push(`- ${name}${values.length ? ` · ${values.join(' · ')}` : ''}`)
      }
      cursor = page.nextCursor
      if (seen.has(cursor)) throw new Error('Codex repeated an MCP status page')
      seen.add(cursor)
    } while (cursor)
    return rows.length ? `MCP servers\n\n${rows.join('\n')}` : 'No MCP servers configured.'
  }

  async function goalStatus({ action, objective, status }) {
    if (!goals) throw new Error('Codex goals are disabled for this conversation')
    const result = await wire.request(`thread/goal/${action}`, { threadId, objective, status })
    if (action === 'clear') return result?.cleared === true ? 'Goal cleared.' : 'No goal is set.'
    const goal = result?.goal
    if (!goal && action === 'get') return 'No goal is set.'
    if (goal?.threadId !== threadId || typeof goal.objective !== 'string' ||
        !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)) {
      throw new Error('Codex returned an invalid goal')
    }
    const tokens = Number.isSafeInteger(goal.tokensUsed) && goal.tokensUsed >= 0
      ? `\n\nTokens used: ${goal.tokensUsed}${Number.isSafeInteger(goal.tokenBudget) ? ` / ${goal.tokenBudget}` : ''}` : ''
    return `Goal (${goal.status})\n\n${goal.objective}${tokens}`
  }

  function rememberSubagent(id) {
    if (typeof id === 'string' && id && id !== threadId && !subagents.has(id)) subagents.set(id, new Map())
  }

  async function ownsSubagent(id) {
    if (subagents.has(id)) return true
    if (typeof id !== 'string' || !id) return false
    try {
      const { thread } = await wire.request('thread/read', { threadId: id, includeTurns: false })
      const parent = thread?.parentThreadId ?? thread?.source?.subAgent?.thread_spawn?.parent_thread_id
      if (thread?.id !== id || (parent !== threadId && !subagents.has(parent))) return false
      rememberSubagent(id)
      return true
    } catch {
      return false
    }
  }

  async function onRequest({ id, method, params = {} }, turn) {
    const respond = result => wire.send({ id, result })
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const allowed = params.availableDecisions ?? ['accept', 'decline', 'cancel']
      const reject = allowed.includes('decline') ? 'decline' : 'cancel'
      if (!turn?.id || turn.cancelled || turn.finished || !allowed.includes('accept')) {
        respond({ decision: reject })
        return
      }
      const isRoot = params.threadId === threadId
      const valid = isRoot ? params.turnId === turn.id : await ownsSubagent(params.threadId)
      const item = (isRoot ? turn.items : subagents.get(params.threadId))?.get(params.itemId)
      const command = params.command ?? item?.command
      const paths = item?.changes?.map(change => change.path)
      const title = command ?? (paths?.length
        ? `Apply file changes to ${paths.join(', ')}`
        : params.grantRoot ? `Apply file changes under ${params.grantRoot}` : 'Apply file changes')
      const rawInput = {
        command, paths, cwd: params.cwd, reason: params.reason, grantRoot: params.grantRoot,
        network: params.networkApprovalContext, permissions: params.additionalPermissions,
      }
      if (!valid || getTurn() !== turn || turn.cancelled || turn.finished || !(command || paths?.length || params.grantRoot)) {
        respond({ decision: reject })
        return
      }
      approvals.ask(id, { title, rawInput }, accepted => respond({ decision: accepted ? 'accept' : reject }))
    } else if (method === 'item/permissions/requestApproval') {
      respond({ permissions: {}, scope: 'turn' })
    } else if (method === 'item/tool/requestUserInput') {
      respond({ answers: {} })
    } else if (method === 'mcpServer/elicitation/request') {
      respond({ action: 'decline', content: null, _meta: null })
    } else {
      wire.send({ id, error: { code: -32601, message: 'Unsupported app-server request' } })
    }
  }

  function onMessage(message) {
    const { method, params = {} } = message
    const turn = getTurn()
    const id = params.turnId ?? params.turn?.id
    if (turn && !turn.id && params.threadId === threadId && typeof id === 'string' && id !== previousTurnId &&
        (method === 'turn/started' || (turn.command === 'compact' && params.item?.type === 'contextCompaction'))) {
      turn.id = id
      clearTimeout(turn.startTimer)
      if (turn.cancelled) void interrupt(turn).catch(() => {
        if (getTurn() === turn && !turn.finished) return wire.close()
      })
    }
    if (message.id !== undefined) {
      void onRequest(message, turn).catch(() => wire.close())
      return
    }
    if (method === 'serverRequest/resolved') {
      approvals.forget(params.requestId)
      return
    }
    if (method === 'skills/changed') {
      if (threadId) void refreshSkills()
      return
    }
    if (!threadId) return
    if (method === 'thread/name/updated' && params.threadId === threadId) {
      publish({ sessionUpdate: 'session_info_update', title: params.threadName })
      return
    }
    if (params.threadId !== threadId) {
      const items = subagents.get(params.threadId)
      if (items && params.item?.id) {
        if (method === 'item/started' && ['commandExecution', 'fileChange'].includes(params.item.type)) {
          items.set(params.item.id, params.item)
        } else if (method === 'item/completed') {
          items.delete(params.item.id)
        }
      }
      return
    }
    if (method === 'thread/settings/updated' && params.threadSettings?.sandboxPolicy) {
      mode = codexPermissionMode({ ...params.threadSettings, sandbox: params.threadSettings.sandboxPolicy })
      publish({ sessionUpdate: 'config_option_update', configOptions: options() })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const context = codexRequestContext(params.tokenUsage, model)
      if (context) {
        contextUsage = context
        const { used, size } = context
        if (used !== undefined || size !== undefined) emit('update', { update: {
          sessionUpdate: 'usage_update', ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}),
        } })
      }
      const totals = params.tokenUsage?.total
      if (!totals) return
      const counts = tokenCounts(totals.outputTokens, totals.cachedInputTokens, totals.cacheWriteInputTokens, totals.inputTokens)
      if (Number.isSafeInteger(totals.reasoningOutputTokens) && totals.reasoningOutputTokens >= 0) counts.reasoningTokens = totals.reasoningOutputTokens
      if (turn && !turn.finished && id && id === turn.id) {
        const sessionTokens = codexSessionTokens(totals)
        if (sessionTokens) turn.usage.sessionTokens = sessionTokens
        // The same total can be emitted repeatedly, including on auxiliary updates.
        if (tokenTotals) {
          const differences = Object.entries(counts).map(([key, count]) => [key, count - tokenTotals.counts[key]])
          if (differences.some(([, count]) => count > 0) || totals.totalTokens > tokenTotals.totalTokens) {
            for (const [key, count] of differences) {
              if (count >= 0) turn.usage[key] = (turn.usage[key] ?? 0) + count
            }
          }
        }
      }
      tokenTotals = { counts, totalTokens: totals.totalTokens }
      return
    }
    const item = params.item
    if (method === 'item/completed' && item?.type === 'subAgentActivity') {
      rememberSubagent(item.agentThreadId)
      reportAgent(item.agentThreadId, codexAgentActivity.get(item.kind), item.agentPath)
      return
    }
    if (method === 'item/completed' && item?.type === 'collabAgentToolCall') {
      for (const [agentId, state] of Object.entries(item.agentsStates ?? {})) {
        rememberSubagent(agentId)
        reportAgent(agentId, codexAgentStatuses.get(state?.status), undefined, state?.message)
      }
      return
    }
    const activeTurn = turn && !turn.finished && !turn.cancelled && id && id === turn.id
    if (method === 'item/commandExecution/outputDelta' || method === 'item/commandExecution/terminalInteraction') {
      const command = runningCommands.get(params.itemId)
      if (!command || (command.turnId !== id && !(method.endsWith('/terminalInteraction') && activeTurn))) return
      const field = method.endsWith('/outputDelta') ? 'output' : 'input'
      const execution = appendExecutionText(command.execution, field, field === 'output' ? params.delta : params.stdin)
      if (execution !== command.execution) {
        command.execution = execution
        publish({ sessionUpdate: 'tool_call_update', toolCallId: params.itemId, execution })
      }
      return
    }
    if (item?.type === 'commandExecution' && typeof item.id === 'string' &&
        (method === 'item/started' || method === 'item/completed')) {
      const original = runningCommands.get(item.id)
      const started = method === 'item/started'
      if (!activeTurn && (started || !original || original.turnId !== id)) return
      const execution = completeExecution(original?.execution, codexExecution(item))
      if (started) {
        turn.items.set(item.id, item)
        runningCommands.set(item.id, { turnId: id, item, execution })
        if (runningCommands.size > 128) runningCommands.delete(runningCommands.keys().next().value)
      } else {
        runningCommands.delete(item.id)
      }
      publish({
        sessionUpdate: started ? 'tool_call' : 'tool_call_update', toolCallId: item.id,
        title: execution?.command ?? 'Shell',
        status: started ? 'in_progress' : ['failed', 'declined', 'interrupted'].includes(item.status) ? 'failed' : 'completed',
        ...codexCommandActivity(item.commandActions ?? original?.item.commandActions, item.cwd ?? original?.item.cwd),
        ...(execution ? { execution } : {}),
      })
      return
    }
    if (!turn || turn.finished || !id || id !== turn.id) return
    if (turn.command && method === 'error' && params.willRetry === false) turn.commandError = params.error
    if (method === 'turn/completed') {
      const { status } = params.turn
      const error = params.turn.error ?? turn.commandError
      previousTurnId = turn.id
      turn.finished = true
      if (turn.compactionItem) {
        publish({ sessionUpdate: 'tool_call_update', toolCallId: turn.compactionItem,
          title: 'Compact context',
          status: status === 'completed' && !error && !turn.cancelled ? 'completed' : 'failed' })
      }
      if (Object.keys(turn.usage).length) emit('usage', turn.usage)
      if (turn.cancelled || status === 'interrupted') turn.result.resolve(CANCELLED)
      else if (status === 'completed' && (!turn.command || !error)) {
        if (turn.command === 'review' && !turn.reviewText) update('agent_message_chunk', turn.reviewOutput)
        turn.result.resolve({ stopReason: 'end_turn' })
      }
      else if (error?.codexErrorInfo === 'contextWindowExceeded') turn.result.resolve({ stopReason: 'max_tokens' })
      else {
        const detail = typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : typeof error?.additionalDetails === 'string' && error.additionalDetails.trim()
            ? error.additionalDetails.trim()
            : ''
        const prefix = turn.command === 'compact' ? 'Codex context compaction failed'
          : turn.command === 'review' ? 'Codex review failed' : 'Codex turn failed'
        turn.result.reject(new Error(detail ? `${prefix}: ${detail}` : prefix))
      }
      return
    }
    if (turn.cancelled) return
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta' || method === 'item/reasoning/summaryTextDelta') {
      turn.streamed.add(params.itemId)
      if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
        if (params.delta) turn.reviewText = true
        update('agent_message_chunk', params.delta, { messageId: params.itemId, phase: turn.items.get(params.itemId)?.phase })
      } else {
        update('agent_thought_chunk', params.delta)
      }
    } else if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      publish({
        sessionUpdate: 'plan',
        entries: params.plan.map(step => ({
          content: step.step,
          status: step.status === 'inProgress' ? 'in_progress' : step.status,
          priority: 'medium',
        })),
      })
    } else if (params.item && (method === 'item/started' || method === 'item/completed')) {
      const { item } = params
      const started = method === 'item/started'
      if (started && item.type === 'agentMessage') turn.items.set(item.id, item)
      if (turn.command === 'compact' && item.type === 'contextCompaction') {
        turn.compactionItem = item.id
        if (started) publish({ sessionUpdate: 'tool_call', toolCallId: item.id, title: 'Compact context', kind: 'other', status: 'in_progress' })
      }
      if (!started && turn.command === 'review' && item.type === 'exitedReviewMode') turn.reviewOutput = item.review
      if (!started && !turn.streamed.has(item.id)) {
        if (item.type === 'agentMessage') {
          if (item.text) turn.reviewText = true
          update('agent_message_chunk', item.text, { messageId: item.id, phase: item.phase })
        }
        if (item.type === 'reasoning') update('agent_thought_chunk', item.summary?.join('\n'))
      }
      if (['fileChange', 'mcpToolCall', 'imageView', 'webSearch'].includes(item.type)) {
        if (started) turn.items.set(item.id, item)
        const original = turn.items.get(item.id)
        let metadata = { kind: 'other' }
        let title = item.tool ?? original?.tool ?? 'MCP tool'
        if (item.type === 'fileChange') {
          metadata = codexFileActivity(item.changes ?? original?.changes)
          title = 'File changes'
        } else if (item.type === 'imageView') {
          metadata = { kind: 'read', locations: [{ path: item.path ?? original?.path }] }
          title = 'View image'
        } else if (item.type === 'webSearch') {
          metadata = { kind: 'search' }
          title = 'Web search'
        }
        publish({
          sessionUpdate: started ? 'tool_call' : 'tool_call_update', toolCallId: item.id, title,
          status: started ? 'in_progress' : ['failed', 'declined', 'interrupted'].includes(item.status) ? 'failed' : 'completed',
          ...metadata,
        })
      }
    }
  }

  async function interrupt(turn) {
    if (turn.id && !turn.interrupted) {
      turn.interrupted = true
      await wire.request('turn/interrupt', { threadId, turnId: turn.id })
    }
  }

  function inputItems(text, attachments) {
    const input = attachments.map(({ mimeType, data }) => {
      if (!codexImageTypes.includes(mimeType)) throw new Error('Unsupported Codex image format')
      return { type: 'image', url: `data:${mimeType};base64,${data}` }
    })
    const leading = text.trimStart()
    const command = /^\/(\S+)/.exec(leading)
    const skill = skills.get(command?.[1])
    const prompt = skill ? `$${skill.name}${leading.slice(command[0].length)}` : text
    if (prompt.trim()) input.push({ type: 'text', text: prompt, text_elements: [] })
    if (skill) input.push({ type: 'skill', name: skill.name, path: skill.path })
    return input
  }

  return {
    onMessage,
    options,
    get capabilities() {
      return codexCapabilities(catalog, model, goals)
    },
    get modelProvider() { return activeProvider },
    context: () => contextUsage,
    mcpStatus: () => listMcp(),
    accountUsage: async () => codexRateLimits(await wire.request('account/rateLimits/read', undefined, 5_000)),
    async start() {
      await initializeCodex(wire, true)
      const sourceId = forkFrom ?? resumeId
      const method = forkFrom ? 'thread/fork' : resumeId ? 'thread/resume' : 'thread/start'
      const thread = await wire.request(method, {
        cwd,
        ...sourceId ? { threadId: sourceId } : {},
        ...forkFrom ? { ephemeral: false } : {},
        ...modelProvider ? {modelProvider} : {},
      })
      threadId = thread?.thread?.id
      model = thread?.model
      activeProvider = thread?.modelProvider
      if (!threadId || !model) throw new Error('Codex returned an invalid session')
      if (modelProvider && activeProvider!==modelProvider) throw new Error('Codex did not select the configured model provider')
      if (forkFrom && (threadId === forkFrom || thread.thread.ephemeral === true)) {
        throw new Error('Codex did not return a durable fork')
      }
      mode = codexPermissionMode(thread)
      skillsCwd = thread.thread.cwd ?? cwd
      catalog = await readCodexModels(wire, thread.modelProvider)
      const useCatalog = switchingAccount || (resumeId && activeProvider === 'openai' && catalog.size > 0)
      if (!catalog.has(model)) {
        if (useCatalog) {
          model = defaultCodexModel(catalog)
          if (!model) throw Object.assign(new Error('Codex did not report any available models for this account'), { status: 409 })
        } else catalog.set(model, { choice: { value: model, name: model } })
      }
      const defaultEffort = catalog.get(model).defaultEffort ?? effortOptions()[0]?.value
      effort = thread.reasoningEffort ?? defaultEffort
      if (effort && !effortOptions().some(choice => choice.value === effort)) {
        if (useCatalog) effort = defaultEffort
        else catalog.get(model).efforts = [...effortOptions(), effortChoice(effort)]
      }
      goals = await readCodexGoals(wire, threadId)
      await refreshSkills()
      return threadId
    },
    async configure(id, value) {
      if (id === MODELS) {
        model = value
        if (!effortOptions().some(choice => choice.value === effort)) {
          effort = catalog.get(model).defaultEffort ?? effortOptions()[0]?.value
        }
      } else if (id === MODE) {
        if (value === mode.value) return
        const choice = codexModes.find(choice => choice.value === value)
        if (!choice) throw new Error('Invalid Codex permission mode')
        const previous = mode
        if (choice.collaborationMode === 'plan') {
          await wire.request('thread/settings/update', {
            threadId,
            collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } },
          })
        } else {
          const { approvalPolicy, approvalsReviewer } = choice
          const sandboxPolicy = mode.sandbox === choice.sandbox ? undefined : { type: choice.sandbox }
          await wire.request('thread/settings/update', {
            threadId, approvalPolicy, approvalsReviewer, sandboxPolicy,
            ...(mode.collaborationMode === 'plan'
              ? { collaborationMode: { mode: 'default', settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } } }
              : {}),
          })
        }
        if (mode === previous) mode = choice
      } else {
        effort = value
      }
    },
    async prompt(text, turn, attachments) {
      const native = parseCodexCommand(text, attachments.length)
      turn.command = native?.name
      if (native?.name === 'mcp' || native?.name === 'goal') {
        const result = await (native.name === 'mcp' ? listMcp() : goalStatus(native))
        turn.finished = true
        if (!turn.cancelled) update('agent_message_chunk', result)
        turn.result.resolve(turn.cancelled ? CANCELLED : { stopReason: 'end_turn' })
        return
      }
      if (native?.name === 'compact') {
        await wire.request('thread/compact/start', { threadId })
        if (!turn.id && !turn.finished) {
          turn.startTimer = setTimeout(() => {
            void wire.close(new Error('Codex did not start context compaction'))
          }, 10_000)
        }
        return
      }
      if (native?.name === 'review') {
        const response = await wire.request('review/start', { threadId, delivery: 'inline', target: native.target })
        if (response?.reviewThreadId !== threadId || !response.turn?.id || (turn.id && turn.id !== response.turn.id)) {
          void wire.close()
          throw new Error('Codex returned an invalid review turn')
        }
        turn.id = response.turn.id
        return
      }
      const response = await wire.request('turn/start', {
        threadId, input: inputItems(text, attachments), model, effort,
        ...(mode.collaborationMode === 'plan'
          ? { collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } } }
          : {}),
      })
      const id = response?.turn?.id
      if (!id || (turn.id && turn.id !== id)) {
        void wire.close()
        throw new Error('Codex returned an invalid turn')
      }
      turn.id = id
    },
    async steer(text, turn, attachments) {
      const expectedTurnId = turn?.id
      if (typeof expectedTurnId !== 'string' || !expectedTurnId || turn.command || turn.cancelled || turn.finished) {
        throw Object.assign(new Error('No active Codex turn can receive steering'), { status: 409 })
      }
      const response = await wire.request('turn/steer', {
        threadId, expectedTurnId, clientUserMessageId: randomUUID(), input: inputItems(text, attachments),
      }, 10_000)
      if (response?.turnId !== expectedTurnId) throw new Error('Codex returned an invalid steering acknowledgement')
    },
    interrupt,
  }
}

export async function requestClaudeControl({ cwd, remoteId, signal, method, params, env: customEnv, waitForExit = true }) {
  signal?.throwIfAborted()
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--strict-mcp-config', '--setting-sources', '',
    ...(remoteId ? [`--resume=${remoteId}`] : ['--no-session-persistence'])]
  const env = { ...process.env, ...customEnv, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }
  delete env.CLAUDECODE
  const wire = connect('claude', args, { cwd, env }, () => {}, () => {})
  const abort = () => { void wire.close(signal.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await wire.request('initialize', {}, 8_000)
    signal?.throwIfAborted()
    return await wire.request(method, params, 12_000)
  } finally {
    signal?.removeEventListener('abort', abort)
    const closed = wire.close()
    if (waitForExit) await closed
  }
}

function claudeAdapter(wire, { id, update, publish, approvals, getTurn, emit }) {
  const models = new Map()
  const tasks = new Map()
  const taskByTool = new Map()
  const terminalCommands = new Set()
  const reportAgent = agentUpdates(emit, 'Claude agent')
  let commands
  let model = 'default'
  let effort = DEFAULT_EFFORT
  let permissionMode = cliDefaultMode.value
  let mcpServers = []
  let contextGeneration = 0
  let summaryContext = false
  let contextCache
  let lastRequestContext
  const effortLevels = () => models.get(model)?.efforts ?? []
  const options = () => [
    select(MODELS, 'Model', 'model', model, [...models.values()].map(entry => entry.choice)),
    ...effortLevels().length
      ? [select(EFFORT, 'Reasoning effort', 'thought_level', effort, [effortChoice(DEFAULT_EFFORT), ...effortLevels().map(value => effortChoice(value))])]
      : [],
    select(MODE, 'Permission', 'mode', permissionMode,
      permissionMode === cliDefaultMode.value ? [cliDefaultMode, ...claudeModes] : claudeModes),
  ]

  function nativePermissionMode(value) {
    const mode = value === 'default' ? 'manual' : value
    return claudeModes.find(choice => choice.value === mode)?.value
  }

  function publishContext(used, size) {
    if (used === undefined && size === undefined) return
    publish({ sessionUpdate: 'usage_update', used, size })
  }

  function enableSummary(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[+ -])/.exec(version)
    if (!match) return
    const [, major, minor, patch] = match.map(Number)
    // Older builds can ignore summary and make paid token-count requests.
    summaryContext = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 316)))
  }

  async function nativeContext() {
    if (!summaryContext) return
    const generation = contextGeneration
    if (contextCache?.generation !== generation) {
      const work = wire.request('get_context_usage', { detail: 'summary' }, 1_000)
        .then(claudeContextSummary).catch(() => undefined)
      contextCache = { generation, work }
    }
    const cached = contextCache
    const result = await cached.work
    if (!result && contextCache === cached) contextCache = undefined
    if (generation === contextGeneration) return result
  }

  async function refreshContext(used, size) {
    const result = await nativeContext()
    if (result) publishContext(used ?? result.used, size ?? result.size)
  }

  function publishCommands(entries = commands) {
    if (!Array.isArray(entries)) return
    commands = entries
    const availableCommands = entries.flatMap(entry => {
      const { name, description, argumentHint } = entry ?? {}
      if (typeof name !== 'string' || !name || terminalCommands.has(name)) return []
      return [{ name, description: description ?? '', ...argumentHint ? { input: { hint: argumentHint } } : {} }]
    })
    publish({ sessionUpdate: 'available_commands_update', availableCommands })
  }

  function reportTask(task, status, detail) {
    if (!status) return
    task.status = status
    reportAgent(task.id, status, task.name, detail)
  }

  function onTask(message, turn) {
    const { task_id: taskId, run_id: runId, tool_use_id: toolId, subtype } = message
    if (!taskId) return
    let task = tasks.get(taskId)
    if (subtype === 'task_started') {
      const { task_type: type, subagent_type: agentType, description } = message
      const tool = turn?.items.get(toolId)
      if (!['local_agent', 'remote_agent', 'in_process_teammate'].includes(type) && !agentType && !claudeAgentTools.has(tool?.name)) return
      task = { id: taskId, runId, name: description || agentType }
      tasks.set(taskId, task)
      if (toolId) taskByTool.set(toolId, task)
      reportTask(task, 'running')
    } else if (task && (!runId || !task.runId || runId === task.runId)) {
      if (subtype === 'task_updated') {
        reportTask(task, claudeTaskStatuses.get(message.patch?.status), message.patch?.error)
      } else if (subtype === 'task_progress' && task.status === 'running') {
        reportTask(task, 'running', message.summary)
      } else if (subtype === 'task_notification') {
        const report = message.handback_report
        const detail = report?.text ? [report.warning, report.text].filter(Boolean).join('\n') : task.detail || message.summary
        reportTask(task, claudeTaskStatuses.get(message.status), detail)
      }
    }
  }

  function onAgentToolResult(block, output, tool) {
    let task = taskByTool.get(block.tool_use_id)
    const status = block.is_error ? 'failed' : output?.status === 'completed' ? 'completed'
      : output?.status === 'async_launched' ? 'running' : undefined
    if (!status) return
    if (!task && typeof output?.agentId === 'string') {
      task = { id: output.agentId, name: tool.input?.description || tool.input?.subagent_type }
      tasks.set(task.id, task)
      taskByTool.set(block.tool_use_id, task)
    }
    if (!task) return
    const report = output?.handbackReport
    const content = block.is_error ? block.content : output?.content
    const detail = report?.text ? [report.warning, report.text].filter(Boolean).join('\n')
      : typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n')
      : undefined
    if (detail) task.detail = detail
    if (status !== 'running' || !task.status || task.status === 'running') reportTask(task, status, detail)
  }

  function onMessage(message) {
    const turn = getTurn()
    if (message.type === 'control_cancel_request') {
      approvals.forget(message.request_id)
      return
    }
    if (message.type === 'control_request') {
      const { request, request_id } = message
      const response = result => wire.send({
        type: 'control_response', response: { subtype: 'success', request_id, response: result },
      })
      if (request?.subtype === 'can_use_tool') {
        const decision = allowed => response(allowed
          ? { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
          : { behavior: 'deny', message: 'Permission denied', toolUseID: request.tool_use_id })
        if (!turn || turn.cancelled || turn.finished) {
          decision(false)
          return
        }
        const rawInput = { tool: request.tool_name, input: request.input, reason: request.decision_reason }
        const title = request.input?.command ?? request.input?.file_path ?? request.title ?? request.tool_name
        approvals.ask(request_id, { title, rawInput }, decision)
      } else {
        wire.send({ type: 'control_response', response: { subtype: 'error', request_id, error: 'Unsupported Claude control request' } })
      }
      return
    }
    if (message.session_id && message.session_id !== id) return
    if (message.type === 'system') {
      if (message.subtype === 'commands_changed') publishCommands(message.commands)
      if (!message.parent_tool_use_id && ['init', 'status'].includes(message.subtype)) {
        const mode = nativePermissionMode(message.permissionMode)
        if (mode && mode !== permissionMode) {
          permissionMode = mode
          publish({ sessionUpdate: 'config_option_update', configOptions: options() })
        }
      }
      if (message.subtype === 'init') {
        enableSummary(message.claude_code_version)
        if (Array.isArray(message.mcp_servers)) mcpServers = message.mcp_servers
        if (Array.isArray(message.terminal_slash_commands)) {
          for (const name of message.terminal_slash_commands) terminalCommands.add(name)
          publishCommands()
        }
      }
      onTask(message, turn)
      return
    }
    if (!turn || turn.finished || message.parent_tool_use_id) return
    if (message.type === 'result') {
      turn.finished = true
      // Claude's result usage covers the main agent loop for this turn.
      const usage = message.usage
      const counts = tokenCounts(usage?.output_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens, claudeInput(usage))
      if (!turn.cancelled && message.subtype === 'success' && !message.is_error) {
        const size = claudeContextSize(message.modelUsage, turn.contextRequest?.model)
        const currentContext = claudeRequestContext(turn.contextRequest, size)
        lastRequestContext = currentContext ?? lastRequestContext
        const used = currentContext?.used
        if (used !== undefined) counts.contextUsed = used
        if (size !== undefined) counts.contextSize = size
        publishContext(used, size)
        if (summaryContext && (used === undefined || size === undefined)) void refreshContext(used, size)
      }
      if (Object.keys(counts).length) emit('usage', counts)
      if (turn.cancelled) turn.result.resolve(CANCELLED)
      else if (message.stop_reason === 'max_tokens') turn.result.resolve({ stopReason: 'max_tokens' })
      else if (message.stop_reason === 'refusal') turn.result.resolve({ stopReason: 'refusal' })
      else if (message.subtype === 'error_max_turns') turn.result.resolve({ stopReason: 'max_turn_requests' })
      else if (message.is_error || message.subtype !== 'success') {
        const details = [turn.claudeError, ...(Array.isArray(message.errors) ? message.errors : []), message.result]
          .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
        const reason = [...new Set(details)].join(' · ')
          .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]')
          .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1500)
        turn.result.reject(new Error(reason || 'Claude Code turn failed'))
      }
      else {
        if (!turn.hasText) update('agent_message_chunk', message.result)
        turn.result.resolve({ stopReason: 'end_turn' })
      }
      return
    }
    if (turn.cancelled) return
    if (message.type === 'stream_event') {
      const event = message.event
      if (event?.type === 'message_start') turn.streamed.clear()
      const block = event?.content_block
      if (event?.type === 'content_block_start' && block?.type === 'tool_use' && block.id && !turn.items.has(block.id)) {
        turn.items.set(block.id, block)
        publish({
          sessionUpdate: 'tool_call', toolCallId: block.id, title: block.name, status: 'in_progress',
          ...claudeToolActivity(block.name, block.input),
        })
      }
      if (event?.delta?.type === 'text_delta' && event.delta.text) {
        turn.streamed.add(event.index ?? 'text')
        turn.hasText = true
        update('agent_message_chunk', event.delta.text)
      }
      if (event?.delta?.type === 'thinking_delta' && event.delta.thinking) {
        turn.streamed.add(event.index ?? 'thinking')
        update('agent_thought_chunk', event.delta.thinking)
      }
    } else if (message.type === 'assistant' && message.error) {
      const content = message.message?.content
      const text = Array.isArray(content) ? content.find(block => block?.type === 'text')?.text : undefined
      turn.claudeError = [message.apiErrorStatus, message.error, text]
        .filter(value => typeof value === 'string' || typeof value === 'number').join(' · ')
    } else if (message.type === 'assistant') {
      if (typeof message.message?.id === 'string' && message.message.model !== '<synthetic>') {
        turn.contextRequest = message.message
      }
      for (const [index, block] of (message.message?.content ?? []).entries()) {
        if (turn.streamed.has(index) || turn.streamed.has(block.type)) continue
        if (block.type === 'text' && block.text) {
          turn.hasText = true
          update('agent_message_chunk', block.text)
        }
        if (block.type === 'thinking') update('agent_thought_chunk', block.thinking)
        if (block.type === 'tool_use' && block.id) {
          const started = turn.items.has(block.id)
          turn.items.set(block.id, block)
          publish({
            sessionUpdate: started ? 'tool_call_update' : 'tool_call',
            toolCallId: block.id, title: block.name, ...(started ? {} : { status: 'in_progress' }),
            ...claudeToolActivity(block.name, block.input),
          })
          if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
            publish({
              sessionUpdate: 'plan',
              entries: block.input.todos.map(item => ({
                content: String(item?.content ?? ''),
                status: ['completed', 'in_progress', 'pending'].includes(item?.status) ? item.status : 'pending',
                priority: 'medium',
              })).filter(item => item.content),
            })
          }
        }
      }
    } else if (message.type === 'user') {
      const content = message.message?.content
      const blocks = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : []
      for (const block of blocks) {
        if (!turn.items.has(block.tool_use_id)) continue
        const tool = turn.items.get(block.tool_use_id)
        const result = blocks.length === 1 ? message.tool_use_result : undefined
        if (claudeAgentTools.has(tool.name)) onAgentToolResult(block, message.tool_use_result, tool)
        const execution = completeExecution(claudeToolActivity(tool.name, tool.input).execution,
          claudeCommandResult(tool.name, block, result))
        publish({
          sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id,
          status: block.is_error ? 'failed' : 'completed',
          ...(execution ? { execution } : {}),
        })
      }
    }
  }

  function sendUserFrame(text, files = [], imageMimeTypes = []) {
    const content = files.map(file => {
      if (file.type !== 'image' || !imageMimeTypes.includes(file.mimeType)) {
        throw new Error('Claude Code accepts PNG, JPEG, GIF and WebP images')
      }
      return { type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } }
    })
    if (text) content.unshift({ type: 'text', text })
    contextGeneration++
    wire.send({
      type: 'user', session_id: id, parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: 'user', content },
    })
  }

  async function setEffort(value) {
    await wire.request('apply_flag_settings', { settings: { effortLevel: value === DEFAULT_EFFORT ? null : value } })
    effort = value
  }

  return {
    onMessage,
    context: async () => await nativeContext() ?? lastRequestContext,
    options,
    accountUsage: async () => claudeAccountUsage(await wire.request('get_usage', { skip_behaviors: true }, 8_000)),
    mcpStatus() {
      if (!mcpServers.length) return 'No MCP servers configured.'
      return mcpServers.map(s => `- **${s.name || 'server'}**: ${s.status || 'unknown'}`).join('\n')
    },
    get capabilities() {
      return { steer: true, image: true, imageMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] }
    },
    async start() {
      const response = await wire.request('initialize')
      permissionMode = nativePermissionMode(response?.current_permission_mode) ?? permissionMode
      enableSummary(response?.claude_code_version)
      publishCommands(response?.commands)
      for (const entry of response?.models ?? []) {
        if (typeof entry.value !== 'string') continue
        models.set(entry.value, {
          choice: { value: entry.value, name: entry.displayName ?? entry.value, description: entry.description },
          efforts: entry.supportedEffortLevels ?? (entry.supportsEffort ? ['low', 'medium', 'high'] : []),
        })
      }
      if (!models.has(model)) models.set(model, { choice: { value: model, name: 'Default' } })
      return id
    },
    async configure(id, value) {
      if (id === EFFORT) {
        await setEffort(value)
        contextGeneration++
      } else if (id === MODE) {
        if (value === permissionMode) return
        const result = await wire.request('set_permission_mode', { mode: value })
        permissionMode = result?.mode === undefined ? value : nativePermissionMode(result.mode) ?? cliDefaultMode.value
        if (permissionMode !== value) throw new Error('Claude did not confirm the permission mode')
      } else if (model !== value) {
        contextGeneration++
        if (effort !== DEFAULT_EFFORT && !models.get(value).efforts?.includes(effort)) await setEffort(DEFAULT_EFFORT)
        await wire.request('set_model', { model: value })
        model = value
      }
    },
    prompt(text, turn, files = []) {
      sendUserFrame(text, files, this.capabilities.imageMimeTypes)
    },
    steer(text, turn, files = []) {
      if (!turn || turn.finished || turn.interrupted) {
        throw Object.assign(new Error('No active Claude turn can receive steering'), { status: 409 })
      }
      sendUserFrame(text, files, this.capabilities.imageMimeTypes)
    },
    async interrupt(turn) {
      if (turn.interrupted) return
      turn.interrupted = true
      await wire.request('interrupt', { cancel_queued: true })
    },
  }
}

export async function startOther({ engine, cwd, env: customEnv, extraArgs, modelProvider, resumeId, forkFrom, claudeFork, switchingAccount, emit, signal }) {
  if (engine !== 'codex' && engine !== 'claude') throw new Error('Unsupported chat engine')
  if (forkFrom !== undefined && (engine !== 'codex' || resumeId || typeof forkFrom !== 'string' || !forkFrom)) {
    throw new Error('Invalid Codex fork request')
  }
  if (claudeFork && (engine !== 'claude' || resumeId)) throw new Error('Invalid Claude fork request')
  signal?.throwIfAborted()
  const claudeId = claudeFork?.sessionId ?? resumeId ?? randomUUID()
  const args = engine === 'codex'
    ? [...(Array.isArray(extraArgs) ? extraArgs : []), ...codexArgs]
    : [
        '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--include-partial-messages', '--permission-prompts', 'host',
        '--permission-prompt-tool', 'stdio',
        ...claudeFork
          ? [`--resume=${claudeFork.sourceId}`, '--fork-session', `--session-id=${claudeId}`, `--resume-session-at=${claudeFork.messageId}`]
          : [resumeId ? `--resume=${claudeId}` : `--session-id=${claudeId}`],
      ]
  const baseEnv = customEnv ? { ...process.env, ...customEnv } : process.env
  const env = engine === 'claude' ? { ...baseEnv, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } : baseEnv
  if (engine === 'claude') delete env.CLAUDECODE
  let closed = false
  let configuring = false
  let active
  const approvals = approvalPrompt(emit)
  const wire = connect(engine, args, { cwd, env }, message => driver.onMessage(message), error => {
    closed = true
    signal?.removeEventListener('abort', close)
    if (active?.cancelled) active.result.resolve(CANCELLED)
    else active?.result.reject(error)
  })
  const context = {
    cwd, resumeId, forkFrom, modelProvider, switchingAccount, approvals, emit, id: claudeId, getTurn: () => active,
    publish(update) { emit('update', { update }) },
    update(sessionUpdate, text, fields) {
      if (typeof text === 'string' && text) {
        emit('update', { update: { sessionUpdate, content: { type: 'text', text }, ...fields } })
      }
    },
  }
  const driver = engine === 'codex' ? codexAdapter(wire, context) : claudeAdapter(wire, context)

  function close() {
    if (active) active.cancelled = true
    approvals.clear()
    return wire.close()
  }
  signal?.addEventListener('abort', close, { once: true })

  function requireIdle() {
    if (closed) throw new Error('Chat session is closed')
    if (active || configuring) throw new Error('Chat session is busy')
  }

  function validateInput(text, attachments) {
    const capabilities = driver.capabilities
    if (!Array.isArray(attachments) || attachments.some(file =>
      !['image', 'audio'].includes(file?.type) || !capabilities?.[file.type])) throw new Error('Unsupported attachment type')
    if (typeof text !== 'string' || (!text.trim() && !attachments.length)) throw new Error('Enter a message or attach a file')
  }

  async function interrupt(turn) {
    if (turn.finished) return
    try {
      await driver.interrupt(turn)
    } catch {
      if (active === turn && !turn.finished) await close()
    }
  }

  try {
    const id = await driver.start()
    return {
      id,
      get options() { return driver.options() },
      get capabilities() { return driver.capabilities ?? {} },
      ...(driver.modelProvider ? {modelProvider:driver.modelProvider} : {}),
      context: driver.context ? () => driver.context() : undefined,
      ...(driver.mcpStatus ? { mcpStatus: driver.mcpStatus } : {}),
      ...(driver.accountUsage ? { accountUsage: driver.accountUsage } : {}),
      ...(driver.steer ? {
        async steer(text, attachments = []) {
          validateInput(text, attachments)
          await driver.steer(text, active, attachments)
        },
      } : {}),
      async prompt(text, attachments = []) {
        requireIdle()
        validateInput(text, attachments)
        const turn = { result: Promise.withResolvers(), items: new Map(), streamed: new Set(), usage: {} }
        void turn.result.promise.catch(() => {})
        active = turn
        try {
          await driver.prompt(text, turn, attachments)
          if (turn.cancelled) await interrupt(turn)
          return await turn.result.promise
        } catch (error) {
          if (turn.cancelled) return CANCELLED
          throw error
        } finally {
          clearTimeout(turn.startTimer)
          clearTimeout(turn.cancelTimer)
          approvals.clear()
          active = undefined
        }
      },
      async configure(id, value) {
        requireIdle()
        const option = driver.options().find(option => option.id === id)
        if (!option?.options.some(choice => choice.value === value)) throw new Error('Invalid chat configuration')
        configuring = true
        try {
          await driver.configure(id, value)
          return driver.options()
        } finally {
          configuring = false
        }
      },
      approve(id, option) { approvals.answer(id, option) },
      async cancel() {
        const turn = active
        if (!turn || turn.cancelled || turn.finished) return
        turn.cancelled = true
        approvals.clear()
        turn.cancelTimer = setTimeout(() => { void close() }, 5_000)
        await interrupt(turn)
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
