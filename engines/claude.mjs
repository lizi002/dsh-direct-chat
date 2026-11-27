import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createClaudeFork, recoverClaudeFork } from '../server/claude-fork.mjs'
import { requestClaudeControl, startOther } from '../server/other.mjs'
import { claudeAccountUsage, claudeCachedAccountUsage } from '../server/claude-native.mjs'
import { asMillis, lastModified, latestTimestamp, messageText, nativeUuid, transcriptFiles, transcriptLines } from '../server/native-history.mjs'
import { recentTranscript, summedUsage, turnMetrics } from '../server/persisted-metrics.mjs'
import { claudeContextUsed, claudeInput, claudeRequestContext } from '../server/claude-usage.mjs'
import { claudeCommandResult, claudeToolActivity, completeExecution } from '../server/tool-activity.mjs'
import { claudeCliAdmin, claudeExternalAuthEnvKeys } from './cli-admin.mjs'

const agentIdPattern = /^[A-Za-z0-9_-]+$/
const titleFields = new Map([['custom-title', 'customTitle'], ['ai-title', 'aiTitle'], ['summary', 'summary']])
const localCommand = /^<(?:command-name|local-command-(?:caveat|stdout|stderr))>|^\/recap(?:\s|$)/i
const conversationCache = new Map()
const usageFields = {
  inputTokens: claudeInput,
  outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens',
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function teamLeaders(directory) {
  const root = join(directory, 'teams')
  const leaders = new Map()
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const team = readJson(join(root, entry.name, 'config.json'))
      if (nativeUuid.test(team?.leadSessionId)) leaders.set(team.name || entry.name, team.leadSessionId)
    }
  }
  return leaders
}

async function userRecord(file, matches) {
  for await (const entry of transcriptLines(file)) {
    if (entry.type === 'user' && !entry.isMeta && matches(entry)) return entry
  }
}

async function conversationMetadata(file, remoteId) {
  const stats = statSync(file, { throwIfNoEntry: false })
  if (!stats) return
  const version = [stats.size, stats.mtimeMs, stats.ctimeMs].join(':')
  const cached = conversationCache.get(file)
  if (cached?.version === version) return cached.metadata
  const titles = new Map()
  let record
  let prompt
  let updatedAt
  let substantive = false
  for await (const row of transcriptLines(file)) {
    if (row.isSidechain || (row.sessionId && row.sessionId !== remoteId)) continue
    const field = titleFields.get(row.type)
    if (field && typeof row[field] === 'string') titles.set(field, row[field].trim())
    updatedAt = asMillis(row.timestamp) ?? updatedAt
    if (row.isMeta || row.isSynthetic) continue
    if (row.type === 'user') {
      if (!record && row.cwd) {
        const { cwd, timestamp, teamName, agentName } = row
        record = { cwd, timestamp, teamName, agentName }
      }
      if (!prompt) {
        const content = row.message?.content
        const text = messageText(content).trim()
        if (text && !localCommand.test(text)) prompt = text
        substantive ||= Array.isArray(content) && content.some(block => ['image', 'document'].includes(block?.type))
      }
    } else if (row.type === 'assistant' && !prompt && !substantive) {
      substantive = Boolean(messageText(row.message?.content).trim())
    }
  }
  const title = titles.get('customTitle') || titles.get('aiTitle') || titles.get('summary') || prompt
  const metadata = record && (title || substantive) ? { record, title, updatedAt: updatedAt ?? stats.mtimeMs } : undefined
  conversationCache.set(file, { version, metadata })
  return metadata
}

async function listAgents(parent) {
  const root = join(dirname(parent.file), parent.remoteId, 'subagents')
  const entries = []
  for (const file of transcriptFiles(root, 3)) {
    const name = basename(file, '.jsonl')
    if (!name.startsWith('agent-')) continue
    const agentId = name.slice('agent-'.length)
    if (!agentIdPattern.test(agentId)) continue
    const matches = row => row.isSidechain && row.agentId === agentId && row.sessionId === parent.remoteId
    const record = await userRecord(file, matches)
    if (!record) continue
    const details = readJson(file.slice(0, -'.jsonl'.length) + '.meta.json')
    const parentAgent = details?.parentAgentId
    const nativeParent = agentIdPattern.test(parentAgent ?? '') && parentAgent !== agentId
      ? parent.remoteId + '/' + parentAgent
      : parent.remoteId
    entries.push({
      remoteId: parent.remoteId + '/' + agentId,
      nativeParent, agentId, file,
      cwd: record.cwd || parent.cwd,
      title: details?.name || details?.description || details?.agentType || messageText(record.message?.content),
      createdAt: record.timestamp,
      updatedAt: (await latestTimestamp(file, matches)) ?? lastModified(file),
      status: details?.stoppedByUser ? 'cancelled' : details?.finished ? 'idle' : undefined,
      resumable: false,
    })
  }
  return entries
}

async function list({ home, directory = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude') }) {
  const leaders = teamLeaders(directory)
  const entries = []
  for (const file of transcriptFiles(join(directory, 'projects'), 1)) {
    const remoteId = basename(file, '.jsonl')
    if (!nativeUuid.test(remoteId)) continue
    const metadata = await conversationMetadata(file, remoteId)
    if (!metadata) continue
    const { record, title, updatedAt } = metadata
    const parent = leaders.get(record.teamName)
    const nativeParent = parent !== remoteId ? parent : undefined
    const entry = {
      remoteId, file, cwd: record.cwd,
      nativeParent,
      title: nativeParent ? record.agentName || title : title || record.agentName,
      createdAt: record.timestamp,
      updatedAt,
    }
    entries.push(entry, ...await listAgents(entry))
  }
  return entries
}

const claudeInternalTag = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|bash-stdout|bash-stderr)\b/i

function formatClaudeUserText(raw) {
  const trimmed = raw.trim()
  if (!trimmed || claudeInternalTag.test(trimmed)) return ''
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/i.exec(trimmed)
  if (bash) return `\`! ${bash[1].trim()}\``
  return raw
}

async function messages({ file, agentId }, terminalSince) {
  const chain = new Map()
  let tail
  for await (const row of transcriptLines(file)) {
    if (!row.uuid || !('parentUuid' in row)) continue
    if (agentId ? !row.isSidechain || row.agentId !== agentId : row.isSidechain) continue
    chain.set(row.uuid, row)
    if (['user', 'assistant'].includes(row.type)) tail = row
  }
  const rawRows = []
  const visited = new Set()
  while (tail && !visited.has(tail.uuid)) {
    visited.add(tail.uuid)
    if (!tail.isMeta && !tail.isSynthetic && !tail.isCompactSummary && ['user', 'assistant'].includes(tail.type)) {
      rawRows.push(tail)
    }
    tail = chain.get(tail.parentUuid)
  }
  rawRows.reverse()
  if (terminalSince !== undefined) {
    const lastWeb = rawRows.findLastIndex(row => row.entrypoint === 'sdk-ts')
    const first = rawRows.findIndex((row, index) => index > lastWeb && row.entrypoint === 'cli' &&
      row.type === 'user' && asMillis(row.timestamp) > terminalSince)
    if (first < 0) return []
    rawRows.splice(0, first)
  }
  const ordered = []
  const toolsById = new Map()
  let pendingThought = ''
  let pendingTools = []
  let pendingSteps = []
  let nextToolId = 0
  const flushTo = target => {
    if (!pendingThought && !pendingTools.length && !pendingSteps.length) return
    if (!target) {
      target = { role: 'assistant', text: '' }
      ordered.push(target)
    }
    if (pendingThought) {
      target.thought = target.thought ? `${target.thought}\n\n${pendingThought}` : pendingThought
      pendingThought = ''
    }
    if (pendingTools.length) {
      target.tools = [...(target.tools || []), ...pendingTools]
      pendingTools = []
    }
    if (pendingSteps.length) {
      target.steps = [...(target.steps || []), ...pendingSteps]
      pendingSteps = []
    }
  }
  for (const row of rawRows) {
    if (row.type === 'user') {
      const content = row.message?.content
      const results = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : []
      for (const block of results) {
        const previous = toolsById.get(block.tool_use_id)
        if (!previous || previous.tool.kind !== 'execute') continue
        const result = results.length === 1 ? row.toolUseResult ?? row.tool_use_result : undefined
        const execution = completeExecution(previous.tool.execution, claudeCommandResult(previous.name, block, result))
        if (execution) previous.tool.execution = execution
        previous.tool.status = block.is_error ? 'failed' : 'completed'
      }
      const raw = messageText(row.message?.content)
      const text = formatClaudeUserText(raw)
      if (text.trim()) {
        flushTo()
        ordered.push({ role: 'user', text })
      }
    } else if (row.type === 'assistant') {
      const content = row.message?.content
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }]
      let text = []
      const flushText = () => {
        const combined = text.join('\n')
        text = []
        if (!combined.trim()) return
        const msg = { role: 'assistant', text: combined }
        flushTo(msg)
        ordered.push(msg)
      }
      for (const block of blocks) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          flushText()
          const thought = block.thinking.trim()
          pendingThought = pendingThought ? `${pendingThought}\n\n${thought}` : thought
          const last = pendingSteps.at(-1)
          if (last?.kind === 'thought') last.text = `${last.text}\n\n${thought}`
          else pendingSteps.push({ kind: 'thought', text: thought })
        } else if (block?.type === 'tool_use' && block.name) {
          flushText()
          const input = block.input ?? {}
          const detail = input.file_path || input.path || input.command || input.pattern || ''
          const tool = {
            toolCallId: block.id || `tool-${nextToolId++}`,
            title: detail ? `${block.name}: ${String(detail).slice(0, 80)}` : block.name,
            status: 'completed',
            ...claudeToolActivity(block.name, input),
          }
          if (block.id) toolsById.set(block.id, { name: block.name, tool })
          pendingTools.push(tool)
          pendingSteps.push({ kind: 'tool', tool })
        } else {
          const part = messageText([block])
          if (part) text.push(part)
        }
      }
      flushText()
    }
  }
  flushTo()
  return ordered.map((msg, i) =>
    msg.role === 'assistant' && ordered[i + 1]?.role === 'assistant'
      ? { ...msg, phase: 'commentary' }
      : msg
  )
}

function promptRow(row) {
  if (row.type !== 'user' || row.isMeta || row.isSynthetic || row.isCompactSummary || row.sourceToolAssistantUUID) return false
  const content = row.message?.content
  return typeof content === 'string' ? Boolean(content.trim()) && !localCommand.test(content.trim())
    : Array.isArray(content) && !content.some(block => block?.type === 'tool_result') &&
      content.some(block => ['text', 'image', 'document'].includes(block?.type))
}

function assistantRow(row) {
  return row.type === 'assistant' && !row.isMeta && !row.isSynthetic && !row.isApiErrorMessage && row.message?.model !== '<synthetic>'
}

async function* activeBranch({ file, remoteId, agentId }) {
  const chain = new Map()
  const sessionId = agentId ? remoteId?.split('/')[0] : remoteId
  let tail
  for (const row of await recentTranscript(file)) {
    if (!row.uuid || !('parentUuid' in row) || (row.sessionId && row.sessionId !== sessionId)) continue
    if (agentId ? !row.isSidechain || row.agentId !== agentId : row.isSidechain) continue
    chain.set(row.uuid, row)
    if (['user', 'assistant'].includes(row.type) || row.subtype === 'turn_duration') tail = row
  }

  const visited = new Set()
  while (tail && !visited.has(tail.uuid)) {
    visited.add(tail.uuid)
    yield tail
    tail = chain.get(tail.parentUuid)
  }
}

async function metrics(entry) {
  const requests = new Map()
  let terminal, child, duration
  let context = {}
  let completeUsage = true
  for await (const tail of activeBranch(entry)) {
    if (!terminal && assistantRow(tail) && ['end_turn', 'stop_sequence'].includes(tail.message?.stop_reason)) {
      terminal = tail
      duration = child?.subtype === 'turn_duration' ? child.durationMs : undefined
      const contextUsed = claudeContextUsed(tail.message?.usage)
      if (contextUsed !== undefined) context = { contextUsed }
    }
    if (terminal) {
      if (promptRow(tail)) {
        const counts = completeUsage ? summedUsage([...requests.values()], usageFields) : {}
        return turnMetrics({ ...counts, ...context }, duration)
      }
      if (tail.subtype === 'turn_duration' || tail.subtype === 'compact_boundary' || tail.isCompactSummary) break
      if (assistantRow(tail)) {
        const { id, usage } = tail.message ?? {}
        if (typeof id !== 'string' || !id) completeUsage = false
        else if (!requests.has(id)) requests.set(id, usage)
      }
    }
    child = tail
  }
  return turnMetrics(context, duration)
}

async function context(entry) {
  for await (const row of activeBranch(entry)) {
    if (row.subtype === 'compact_boundary' || row.isCompactSummary) return
    if (!assistantRow(row)) continue
    const reading = claudeRequestContext(row.message)
    if (reading) return reading
  }
}

export const engine = {
  id: 'claude',
  label: 'Claude Code',
  composerVersion: 1,
  meta: { accentColor: '#d88167' },
  ...claudeCliAdmin,
  async rename({ cwd, remoteId, title, signal }) {
    if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native Claude session ID is required')
    if (typeof title !== 'string' || !title.trim() || title.length > 256) throw new Error('Invalid Claude session title')
    await requestClaudeControl({ cwd, remoteId, signal, method: 'rename_session', params: { title, source: 'host' } })
  },
  async accountUsage({ cwd, signal, env }) {
    const result = await requestClaudeControl({ cwd, signal, env, method: 'get_usage', params: { skip_behaviors: true }, waitForExit: false })
      .catch(() => undefined)
    signal?.throwIfAborted()
    return claudeAccountUsage(result)
  },
  async cachedAccountUsage({ cwd = homedir(), signal, env }) {
    signal?.throwIfAborted()
    const effectiveEnv={...process.env,...env}
    if (claudeExternalAuthEnvKeys.some(key => effectiveEnv[key])) return
    const directory = resolve(cwd,effectiveEnv.CLAUDE_CONFIG_DIR || effectiveEnv.HOME || homedir())
    if (effectiveEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined &&
        resolve(cwd, effectiveEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR || join(effectiveEnv.HOME || homedir(), '.claude')) !==
          resolve(cwd, effectiveEnv.CLAUDE_CONFIG_DIR || join(effectiveEnv.HOME || homedir(), '.claude'))) return
    try {
      const config = JSON.parse(await readFile(join(directory, '.claude.json'), { encoding: 'utf8', signal }))
      return claudeCachedAccountUsage(config)
    } catch { signal?.throwIfAborted() }
  },
  async start({ forkRecipe, resumeId, ...options }) {
    const claudeFork = forkRecipe && await recoverClaudeFork({ cwd: options.cwd, resumeId, forkRecipe, env:options.env })
    return startOther({ ...options, engine: 'claude', resumeId: claudeFork ? undefined : resumeId, claudeFork })
  },
  async fork({ sourceId, sourceRecipe, ...options }) {
    const forkRecipe = await createClaudeFork({ cwd: options.cwd, sourceId, sourceRecipe, env:options.env })
    const adapter = await startOther({ ...options, engine: 'claude', claudeFork: forkRecipe })
    adapter.forkRecipe = forkRecipe
    return adapter
  },
  history: { list, messages, metrics, context, terminalMessages: (entry, since) => messages(entry, since) },
}

export default engine
