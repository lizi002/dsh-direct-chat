const sessionsUrl = '/api/direct-chat/sessions'
const colonLine = /:([1-9]\d*)(?::[1-9]\d*)?$/

const attachmentMime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i

export function engineLabel(catalog, id) {
  return catalog.find(engine => engine.id === id)?.label ?? id
}

// The built-in CLI profile and the engine's selected default can be different accounts.
export function composerAccount(bound, engine, draft, requestedId) {
  const profiles = engine?.profiles ?? []
  if (!profiles.length) return bound
  if (!draft) {
    if (!bound || engine.id === 'agy') return bound
    const withIdentity = choice => {
      const profile = profiles.find(item => item.id === choice.id)
      return { ...choice, account: choice.account || profile?.account }
    }
    return { ...withIdentity(bound), choices: bound.choices?.map(withIdentity) }
  }
  const id = requestedId ?? bound?.id ?? engine.defaultProfileId ?? 'default'
  const choices = profiles.map(profile => {
    const known = bound?.choices?.find(choice => choice.id === profile.id)
    const account = engine.id === 'agy' && known ? known.account : (known?.account || profile.account)
    return { id: profile.id, label: known?.label || profile.name, account }
  })
  const selected = choices.find(choice => choice.id === id)
  return { ...selected, ...(bound?.id === id ? bound : {}), id, choices,
    canSwitch: choices.some(choice => choice.id !== id) }
}

export function accountChoiceLabel(item, defaultLabel) {
  const name = (item.label || item.name || '').trim()
  const identity = typeof item.account === 'string' ? item.account.trim() : ''
  const generic = !name || (item.id === 'default' && ['Default', 'Default configuration'].includes(name)) ||
    name === 'Google OAuth' || /^Antigravity #\d+$/.test(name)
  if (identity && identity !== 'Google OAuth') {
    return generic || identity === name ? identity : name + ' · ' + identity
  }
  return generic && item.id === 'default' ? defaultLabel : name || item.id
}

export function createEngineCatalog(load = listEngines) {
  const listeners = new Set()
  let snapshot = { engines: [], status: 'idle' }
  let pending
  const publish = next => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  let operations = new Map()
  const runOperation = async (id, kind, action) => {
    if (operations.has('all') || operations.has(id) || (id === 'all' && operations.size)) return
    operations = new Map(operations).set(id, kind)
    publish({ ...snapshot, operations })
    try {
      const result = await action()
      // An in-flight catalog read may predate this operation's completion.
      if (pending) await pending
      await refresh()
      return result
    } finally {
      operations = new Map(operations)
      operations.delete(id)
      publish({ ...snapshot, operations })
    }
  }
  const refresh = () => {
    if (pending) return pending
    pending = Promise.resolve().then(load).then(engines => {
      publish({ ...snapshot, engines, status: 'ready' })
    }, () => {
      publish({ ...snapshot, status: 'error' })
    }).finally(() => { pending = undefined })
    if (snapshot.status !== 'ready') publish({ ...snapshot, status: 'loading' })
    return pending
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    runOperation,
    subscribe(listener) {
      listeners.add(listener)
      if (snapshot.status === 'idle') void refresh()
      return () => listeners.delete(listener)
    },
  }
}

export function attachmentKind(file, capabilities) {
  const type = file.type?.split('/')[0]
  if (!file.size || !attachmentMime.test(file.type ?? '')) return 'file'
  if (type === 'image' && capabilities.image &&
      (!capabilities.imageMimeTypes || capabilities.imageMimeTypes.includes(file.type))) return 'image'
  if (type === 'audio' && capabilities.audio) return 'audio'
  return 'file'
}

export function attachmentIssue(files) {
  if (files.length > 16) return 'attachment.count'
  if (files.some(file => !Number.isSafeInteger(file?.size) || file.size < 0)) return 'attachment.unsupported'
  if (files.reduce((size, file) => size + file.size, 0) > 8 * 1024 * 1024) return 'attachment.size'
  return ''
}

export function hasDraggedFiles(transfer) {
  return Array.from(transfer?.types ?? []).includes('Files')
}

export async function encodeAttachment(file, capabilities) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return { type: attachmentKind(file, capabilities), mimeType: attachmentMime.test(file.type) ? file.type : 'application/octet-stream', data, name: file.name }
}

export async function listSessions(signal) {
  const result = await request(sessionsUrl, { signal })
  return result.sessions
}

export async function listEngines() {
  const result = await request('/api/direct-chat/engines')
  if (!Array.isArray(result.engines)) throw new Error('Invalid engine catalog')
  return result.engines
}

export function checkEngineUpdate(engineId = 'all') {
  return request(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/check`, { method: 'POST' })
}

export function updateEngineCli(engineId) {
  return request(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/update`, { method: 'POST' })
}

export function logoutEngineCli(engineId, profileId) {
  return sendJson(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/logout`, 'POST', profileId ? { profileId } : {})
}

export async function listEngineProfiles(engineId) {
  const result = await request(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/profiles`)
  return Array.isArray(result.profiles) ? result.profiles : []
}

export async function mutateEngineProfile(engineId, payload) {
  const result = await sendJson(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/profiles`, 'POST', payload)
  return Array.isArray(result.profiles) ? result.profiles : []
}

export function startEngineLogin(engineId, payload = {}) {
  return sendJson(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/login/start`, 'POST', payload)
}

export function readActiveEngineLogin(signal) {
  return request('/api/direct-chat/engines/all/login/active', { signal })
}

export function pollEngineLogin(engineId, loginId) {
  return request(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/login/${encodeURIComponent(loginId)}`)
}

export function submitEngineLoginCode(engineId, loginId, code) {
  return sendJson(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/login/${encodeURIComponent(loginId)}/code`, 'POST', { code })
}

export function cancelEngineLogin(engineId, loginId) {
  return sendJson(`/api/direct-chat/engines/${encodeURIComponent(engineId)}/login/${encodeURIComponent(loginId)}/cancel`, 'POST', {})
}

export function previewFile(id, path, signal) {
  const query = new URLSearchParams({ path })
  return request(`${sessionsUrl}/${encodeURIComponent(id)}/file?${query}`, { signal })
}

export function previewAttachment(id, key, signal) {
  const query = new URLSearchParams({ key })
  return request(`${sessionsUrl}/${encodeURIComponent(id)}/attachment?${query}`, { signal })
}

export function fileUriReference(href) {
  if (typeof href !== 'string' || !/^file:\/\//i.test(href)) return
  let url
  try { url = new URL(href) } catch { return }
  if (url.protocol !== 'file:' || (url.hostname && url.hostname.toLowerCase() !== 'localhost')) return
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { return }
  if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1)
  if (!pathname) return
  const hash = url.hash ? url.hash.slice(1) : ''
  const frag = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(hash)
  if (frag) {
    const line = Number(frag[1])
    if (Number.isSafeInteger(line)) return { path: pathname, line }
  }
  return markdownFileReference(pathname)
}

export function markdownFileReference(path, line) {
  if (typeof path === 'string' && /^file:\/\//i.test(path)) {
    const parsed = fileUriReference(path)
    if (parsed) return { path: parsed.path, line: line ?? parsed.line }
  }
  if (line !== undefined) return { path, line }
  const position = colonLine.exec(path)
  const sourceLine = position ? Number(position[1]) : undefined
  if (Number.isSafeInteger(sourceLine) && position.index > 0) {
    return { path: path.slice(0, position.index), line: sourceLine }
  }
  return { path, line }
}

export function normalizeMarkdownFileUrls(text) {
  if (typeof text !== 'string' || !text.includes('file://')) return text ?? ''
  return text.replace(/\]\((file:\/\/[^)\s]+)\)/gi, (full, href) => {
    const parsed = fileUriReference(href)
    if (!parsed) return full
    const hashIndex = href.indexOf('#')
    const hash = hashIndex >= 0 ? href.slice(hashIndex) : (parsed.line ? `#L${parsed.line}` : '')
    return `](${encodeURI(parsed.path)}${hash})`
  })
}

export function inlineFileReference(value) {
  if (!value || value.trim() !== value) return
  if (/^file:\/\//i.test(value)) return fileUriReference(value)
  const fragment = /#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(value)
  const position = fragment ?? colonLine.exec(value)
  const line = position ? Number(position[1]) : undefined
  if (line !== undefined && !Number.isSafeInteger(line)) return
  if (fragment?.[2] && (!Number.isSafeInteger(Number(fragment[2])) || Number(fragment[2]) < line)) return
  const path = position ? value.slice(0, position.index) : value
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return
  if (line === undefined && /^(?:thread|turn|account|item|model|skills)\/(?:[a-z][a-zA-Z]*\/)*(?:resume|start|read|list|updated|completed|set|clear|fork|interrupt|archive|unarchive|delete)$/.test(path)) return
  const drive = /^[a-z]:[\\/]/i.test(path)
  if (drive || /^(?:[\\/]|\.{1,2}[\\/])/.test(path)) return { path, line }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || /\s/.test(path)) return
  if (/[\\/]/.test(path) || /\.[a-z\d-]{1,12}$/i.test(path) || /^(README|LICENSE|Makefile|Dockerfile)$/i.test(path)) {
    return { path, line }
  }
}

export function createSession(engine, cwd, profileId) {
  return sendJson(sessionsUrl, 'POST', { engine, cwd: cwd || undefined, ...(profileId ? { profileId } : {}), draft: true })
}

export function sessionAction(id, action, data = {}) {
  return sendJson(`${sessionsUrl}/${encodeURIComponent(id)}/${action}`, 'POST', data)
}

export function archiveWorkspace(cwd) {
  return sendJson('/api/direct-chat/workspaces/archive', 'POST', { cwd })
}

export function getGitBranches(cwd, signal) {
  return request(`/api/direct-chat/workspaces/git-branches?cwd=${encodeURIComponent(cwd || '')}`, { signal })
}

export function createWorktree(cwd, from) {
  return sendJson('/api/direct-chat/workspaces/worktree', 'POST', { cwd, from: from ?? null })
}

export function deleteSession(id) {
  return sendJson(`${sessionsUrl}/${encodeURIComponent(id)}`, 'DELETE', { confirmId: id })
}

export function openEvents(id) {
  return new EventSource(`${sessionsUrl}/${encodeURIComponent(id)}/events`)
}

function sendJson(url, method, data) {
  return request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function request(url, options) {
  const response = await fetch(url, { ...options, credentials: 'same-origin' })
  const result = await response.json().catch(() => undefined)
  if (!response.ok || !result) {
    const message = result?.message ?? result?.error
    throw Object.assign(new Error(typeof message === 'string' ? message : `HTTP ${response.status}`), { status: response.status, code:result?.code })
  }
  return result
}

export function permissionId(permission) {
  return permission.toolCall.toolCallId
}

export function configGroups(option) {
  const groups = []
  let ungrouped
  const isChoice = row => typeof row?.value === 'string' && typeof row?.name === 'string'
  for (const row of Array.isArray(option?.options) ? option.options : []) {
    if (Array.isArray(row?.options)) {
      const choices = row.options.filter(isChoice)
      if (choices.length > 0) groups.push({ name: typeof row.name === 'string' ? row.name : undefined, choices })
      ungrouped = undefined
    } else if (isChoice(row)) {
      if (!ungrouped) {
        ungrouped = []
        groups.push({ choices: ungrouped })
      }
      ungrouped.push(row)
    }
  }
  return groups
}

export function promptDelivery(busy, canSteer, preferred, alternate = false, hasQueue = false) {
  if (!busy) return hasQueue ? 'queue' : undefined
  if (!canSteer) return 'queue'
  return (preferred === 'steer') !== alternate ? 'steer' : 'queue'
}

export function stageCommand(text, name, commands) {
  const existing = /^\/(\S+)/.exec(text)
  if (existing && commands.some(command => command.name === existing[1])) {
    return `/${name}${text.slice(existing[0].length) || ' '}`
  }
  return `/${name} ${text}`
}

export function applyEvent(session, { type, data }) {
  if (type === 'snapshot') return {
    ...data,
    ...(Array.isArray(data?.updates) ? { updates: compactToolUpdates(data.updates) } : {}),
    error: '',
  }
  if (!session) return session
  switch (type) {
    case 'options':
      return { ...session, options: data }
    case 'metrics':
      return { ...session, metrics: data }
    case 'agents':
      return { ...session, agents: data }
    case 'permission': {
      const id = permissionId(data)
      const permissions = session.permissions.filter(item => permissionId(item) !== id)
      return { ...session, permissions: [...permissions, data] }
    }
    case 'permission_resolved':
      return { ...session, permissions: session.permissions.filter(item => permissionId(item) !== data.id) }
    case 'done':
      return { ...session, busy: false, runStartedAt: undefined, permissions: [], stopReason: data.stopReason }
    case 'error':
      return { ...session, busy: false, runStartedAt: undefined, permissions: [], error: data.message }
    case 'message': {
      const { index, message, clearActivity } = data
      if (!Number.isInteger(index) || index < 0 || index > session.messages.length) return session
      const messages = session.messages.slice()
      messages[index] = message
      const updates = clearActivity ? session.updates.filter(({ update }) =>
        ['available_commands_update', 'usage_update'].includes(update?.sessionUpdate)) : session.updates
      return { ...session, messages, updates }
    }
    case 'update':
      return applyUpdate(session, data)
    default:
      return session
  }
}

function toolUpdateId(update) {
  if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') return update.toolCallId
}

function compactToolUpdates(updates) {
  const compacted = []
  const positions = new Map()
  for (const params of updates) {
    const id = toolUpdateId(params.update)
    const index = positions.get(id)
    if (index !== undefined) {
      compacted[index] = { ...params, update: { ...compacted[index].update, ...params.update } }
    } else {
      if (id) positions.set(id, compacted.length)
      compacted.push(params)
    }
  }
  return compacted
}

function applyUpdate(session, params) {
  const update = params.update
  if (!update) return session
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    const messages = session.messages.slice()
    const index = messages.length - 1
    if (messages[index]?.role === 'assistant') {
      messages[index] = { ...messages[index], text: messages[index].text + update.content.text }
    } else {
      messages.push({ role: 'assistant', text: update.content.text })
    }
    return { ...session, messages }
  }
  if (update.sessionUpdate === 'config_option_update') {
    return Array.isArray(update.configOptions) ? { ...session, options: update.configOptions } : session
  }
  const toolCallId = toolUpdateId(update)
  if (toolCallId) {
    const index = session.updates.findIndex(item => toolUpdateId(item.update) === toolCallId)
    if (index !== -1) {
      const updates = session.updates.slice()
      updates[index] = { ...params, update: { ...updates[index].update, ...update } }
      return { ...session, updates }
    }
  }
  return { ...session, updates: [...session.updates, params] }
}

export function projectActivity(updates) {
  let thought = ''
  let plan = []
  let commands = []
  let usage
  const tools = new Map()
  const steps = []
  const toolStepById = new Map()
  let planStep
  for (const { update } of updates) {
    switch (update?.sessionUpdate) {
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') {
          const chunk = update.content.text
          thought += chunk
          const last = steps.at(-1)
          if (last?.kind === 'thought') last.text += chunk
          else steps.push({ kind: 'thought', text: chunk })
        }
        break
      case 'tool_call':
      case 'tool_call_update': {
        const { toolCallId } = update
        const nextTool = { ...tools.get(toolCallId), ...update }
        tools.set(toolCallId, nextTool)
        const existingStep = toolStepById.get(toolCallId)
        if (existingStep) existingStep.tool = nextTool
        else {
          const step = { kind: 'tool', tool: nextTool }
          toolStepById.set(toolCallId, step)
          steps.push(step)
        }
        break
      }
      case 'plan':
        if (!Array.isArray(update.entries)) break
        plan = update.entries
        if (!planStep && plan.length) {
          planStep = { kind: 'plan' }
          steps.push(planStep)
        }
        if (planStep) planStep.entries = plan
        break
      case 'available_commands_update':
        commands = update.availableCommands
        break
      case 'usage_update':
        usage = update
        break
    }
  }
  const cleanSteps = steps
    .map(step => step.kind === 'thought' ? { kind: 'thought', text: step.text.trim() } : step)
    .filter(step => (step.kind !== 'thought' || step.text) && (step.kind !== 'plan' || step.entries.length))
  return { thought, plan, commands, usage, tools: [...tools.values()], steps: cleanSteps }
}

export function createDirectStatusStore() {
  const listeners = new Set()
  let snapshot = { list: [], byId: new Map() }
  let source = null
  let retryTimer = null
  const publish = list => {
    const rows = Array.isArray(list) ? list : []
    snapshot = {
      list: rows,
      byId: new Map(rows.map(item => [item.id, item])),
    }
    for (const listener of listeners) listener()
  }
  const connect = () => {
    if (typeof EventSource !== 'function' || source) return
    const es = new EventSource('/api/direct-chat/status')
    source = es
    es.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data)
        publish(parsed?.sessions)
      } catch {}
    }
    es.onerror = () => {
      es.close()
      if (source === es) source = null
      if (listeners.size && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (listeners.size) connect()
        }, 3000)
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      connect()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(retryTimer)
          retryTimer = null
          source?.close()
          source = null
        }
      }
    },
    ack(id) {
      if (id) {
        const next = snapshot.list.filter(item => !(item.id === id && item.state === 'done'))
        if (next.length !== snapshot.list.length) publish(next)
      } else {
        const next = snapshot.list.filter(item => item.state !== 'done')
        if (next.length !== snapshot.list.length) publish(next)
      }
      return fetch('/api/direct-chat/status/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(id ? { id } : {}),
      }).catch(() => {})
    },
  }
}
