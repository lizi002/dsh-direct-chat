import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { stripVTControlCharacters } from 'node:util'

let dshRequire
function getDshRequire() {
  if (!dshRequire) {
    try {
      dshRequire = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
    } catch {
      dshRequire = createRequire(import.meta.url)
    }
  }
  return dshRequire
}

import { createAccountUsageCache, excludesSubscriptionQuota } from './server/account-usage-cache.mjs'
import { agyDataDirectory, migrateAgySharedHistory } from './server/agy-session-history.mjs'
import { claudeExternalAuthEnvKeys, spawnCli } from './engines/cli-admin.mjs'
import { createEngineRegistry } from './registry.mjs'

function compareSemver(a, b) {
  const parse = v => /(\d+\.\d+\.\d+)/.exec(String(v || ''))?.[1]?.split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}
import { workspaceDiff, workspaceDiffText } from './server/workspace-diff.mjs'
import { createWorkspaceWorktree, gitBranchInfo } from './server/workspace-worktree.mjs'
import { imageType, listWorkspaceDirectory, openMediaFile, sendDocument, sendDownload, sendMedia, previewFile } from './server/workspace-file.mjs'
import { compareNativeHistory, compareNativeTail, formatFilePrompt } from './server/native-merge.mjs'
import { nativeCatalog, nativeId, nativeUuid } from './server/native-history.mjs'
import { commandExecution, completeExecution, toolLocations } from './server/tool-activity.mjs'

export const name = 'direct-chat'
export const inject = { webServer: true, connection: true }
const base = '/api/direct-chat/sessions'
const store = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'direct-chat')
const reject = (status, message) => Object.assign(new Error(message), { status })
const validSessionId = id => nativeUuid.test(id) || /^local-[\da-f]{32}$/.test(id)
const textField = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw reject(400, label + ' is required')
  return value
}
const attachmentLimit = 8 * 1024 * 1024
const attachmentMime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i
const attachmentExtension = name => /\.[a-z0-9]{1,20}$/i.exec(name)?.[0] ?? ''
function attachmentName(name) {
  const filename = typeof name === 'string'
    ? basename(name.replaceAll('\\','/')).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu,'_').trim() : ''
  if (!filename || filename === '.' || filename === '..') return 'file'
  const ext = attachmentExtension(filename)
  return filename.slice(0, filename.length - ext.length).slice(0, 255 - ext.length).toWellFormed() + ext
}
function attachmentFilename({ type, name, previewId }) {
  if (typeof previewId !== 'string' || !nativeUuid.test(previewId)) return
  return type === 'file' ? previewId + attachmentExtension(name) : previewId
}
function attachmentsFor(input, capabilities) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 16) throw reject(400, 'Invalid attachment list')
  let bytes = 0
  return input.map(file => {
    const generic = file?.type === 'file'
    if (!generic && (!['image','audio'].includes(file?.type) || !capabilities?.[file.type])) throw reject(400, 'Unsupported attachment type')
    const mimeType = generic && (file.mimeType === undefined || file.mimeType === '') ? 'application/octet-stream' : file.mimeType
    if (typeof mimeType !== 'string' || mimeType !== mimeType.trim() || !attachmentMime.test(mimeType) || (!generic && !mimeType.startsWith(file.type + '/'))) throw reject(400, 'Invalid attachment media type')
    if (file.type==='image' && capabilities.imageMimeTypes && !capabilities.imageMimeTypes.includes(mimeType)) throw reject(400,'Unsupported image format')
    if (typeof file.data !== 'string' || (!generic && !file.data.length) || file.data.length % 4 || /[^a-z0-9+/=]|=[^=]|={3}/i.test(file.data)) throw reject(400, 'Invalid attachment encoding')
    bytes += Buffer.byteLength(file.data,'base64')
    if (bytes > attachmentLimit) throw reject(413, 'Attachments exceed 8 MiB')
    return {type:file.type,mimeType,data:file.data,name:generic ? attachmentName(file.name) : String(file.name || file.type).slice(0,255)}
  })
}
const bodyLimit = 12 * 1024 * 1024
async function body(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw reject(415, 'Expected JSON')
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > bodyLimit) throw reject(413, 'Request exceeds 12 MiB')
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks))
    if (data && !Array.isArray(data) && typeof data === 'object') return data
  } catch {}
  throw reject(400, 'Invalid JSON object')
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function normalizeContext(value) {
  if (!value) return
  const label = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined
  const count = tokens => Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined
  const categories = Array.isArray(value.categories) ? value.categories.flatMap(row => {
    const name = label(row?.name)
    const tokens = count(row?.tokens)
    return name && tokens !== undefined ? [{ name, tokens }] : []
  }) : []
  const requestTokens = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].flatMap(key => {
    const tokens = count(value.requestTokens?.[key])
    return tokens === undefined ? [] : [[key, tokens]]
  }))
  const { source } = value
  const used = count(value.used)
  const size = count(value.size) || undefined
  if (used === undefined && size === undefined && !categories.length && !Object.keys(requestTokens).length) return
  return { used, size, categories, model: label(value.model),
    ...(used !== undefined && typeof value.estimated === 'boolean' ? { estimated: value.estimated } : {}),
    ...(['native', 'lastRequest'].includes(source) ? { source } : {}),
    ...(Object.keys(requestTokens).length ? { requestTokens } : {}) }
}
export function apply(ctx, config = {}) {
  mkdirSync(store, { recursive: true, mode: 0o700 })
  const mediaRoot = join(realpathSync(store), 'media')
  function mediaDirectory(id, create = false) {
    if (typeof id !== 'string' || basename(id) !== id || !id || id === '.' || id === '..') throw reject(404,'Attachment not found')
    const directory = join(mediaRoot, id)
    for (const path of [mediaRoot, directory]) {
      if (create) {
        try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (!stat) return
      if (!stat.isDirectory()) throw reject(403, 'Attachment storage is not accessible')
    }
    return directory
  }
  function storedAttachment(record, key) {
    if (!record || typeof key !== 'string' || !nativeUuid.test(key)) throw reject(404, 'Attachment not found')
    const attachment = record.messages?.flatMap(message => message.attachments || []).find(item => item.previewId === key)
    const directory = attachment && mediaDirectory(record.id)
    if (!directory) throw reject(404, 'Attachment not found')
    const filename = attachmentFilename(attachment)
    if (!lstatSync(join(directory, filename), { throwIfNoEntry: false })?.isFile()) throw reject(404, 'Attachment not found')
    return { attachment, directory, filename }
  }
  const sessions = new Map()
  const engines = createEngineRegistry(config)
  const catalog = nativeCatalog({registry:engines})
  const viewDir = join(store,'workspace-state')
  mkdirSync(viewDir,{recursive:true,mode:0o700})
  const archivePath = join(viewDir,'archive.json')
  const archives = new Map(existsSync(archivePath) ? JSON.parse(readFileSync(archivePath,'utf8')) : [])
  const preferencesPath = join(viewDir,'preferences.json')
  const preferences = new Map(existsSync(preferencesPath) ? JSON.parse(readFileSync(preferencesPath,'utf8')) : [])
  function writeViewState(path, entries) {
    writeFileSync(path+'.tmp',JSON.stringify([...entries]),{mode:0o600})
    renameSync(path+'.tmp',path)
  }
  function storePreferences(id, value) {
    const next = new Map(preferences)
    next.set(id, value)
    writeViewState(preferencesPath,next)
    preferences.set(id,value)
  }
  const archiveChanges = new Set()
  const renameChanges = new Set()
  const accountChanges = new Set()
  const agySigningOut = new Set()
  const deleting = new Set()
  const deleted = new Map()
  let accountUsage = createAccountUsageCache()
  const changeKey = record => nativeId(record.engine,record.remoteId || record.id)
  const isChild = (record, indexed) => Boolean(record.parentId || record.nativeParent || record.isChild ||
    indexed?.parentId || indexed?.nativeParent || indexed?.isChild)
  const activeSession = s => s.busy || s.forking || s.opening || s.cancelling || s.switchingAccount || activeTask(s.record.taskStatus)
  function requirePresent(id, record = sessions.get(id)?.record) {
    const key=record && changeKey(record)
    if (deleted.has(id) || deleted.has(key)) throw reject(404,'Unknown session')
    if (deleting.has(id) || deleting.has(key)) throw reject(409,'Session deletion in progress')
  }
  async function deleteProvider(record, indexed) {
    if (typeof record.remoteId !== 'string' || !nativeUuid.test(record.remoteId) || isChild(record,indexed)) return
    const provider=engines.get(record.engine)
    if (typeof provider?.deleteSession !== 'function') return
    if (provider.supportsDelete && !await provider.supportsDelete()) return
    return provider
  }
  function nativeDescendants(root, catalogRows) {
    const children=new Map()
    for (const row of catalogRows.values()) {
      if (row.engine!==root.engine || !row.nativeParent || !nativeUuid.test(row.remoteId)) continue
      if (!children.has(row.nativeParent)) children.set(row.nativeParent,[])
      children.get(row.nativeParent).push(row.remoteId)
    }
    const ids=new Set([root.remoteId])
    for (const id of ids) for (const child of children.get(id) || []) ids.add(child)
    return ids
  }
  function deleteScope(record, remoteIds) {
    const aliases=[...sessions.values()].filter(s=>s.record.engine===record.engine && remoteIds.has(s.record.remoteId))
    const nativeIds=[...remoteIds].map(remoteId=>nativeId(record.engine,remoteId))
    const targets=new Set([record.id,...nativeIds,...aliases.map(s=>s.record.id)])
    const related=new Set(aliases)
    for (const s of sessions.values()) {
      if (targets.has(s.record.parentId)) related.add(s)
    }
    const keys=new Set([...targets,...[...related].flatMap(s=>[s.record.id,changeKey(s.record)])])
    return {aliases,related,keys}
  }
  function purgeDeleted(ids) {
    for (const id of ids) {
      const s=sessions.get(id)
      if (s) {
        clearTimeout(s.idleTimer)
        clearTimeout(s.saveTimer)
        clearInterval(s.indexTimer)
        for (const term of s.terminals?.values() ?? []) term.dispose()
        sessions.delete(id)
        for (const res of s.clients) res.end()
      }
      rmSync(join(store,id+'.json'),{force:true})
      rmSync(join(store,id+'.json.tmp'),{force:true})
      if (lstatSync(mediaRoot,{throwIfNoEntry:false})?.isDirectory()) rmSync(join(mediaRoot,id),{recursive:true,force:true})
    }
    for (const [path, current] of [[preferencesPath,preferences],[archivePath,archives]]) {
      if (!ids.some(id=>current.has(id))) continue
      const next=new Map(current)
      for (const id of ids) next.delete(id)
      writeViewState(path,next)
      for (const id of ids) current.delete(id)
    }
  }
  async function deleteSession(id, data) {
    if (!validSessionId(id) || data.confirmId!==id) throw reject(400,'Confirm the exact session ID')
    if (deleting.has(id)) throw reject(409,'Session deletion in progress')
    if (deleted.has(id)) {
      const deletedIds=deleted.get(id)
      purgeDeleted(deletedIds)
      return {deletedIds}
    }
    const native=await catalog.list(true)
    const record=sessions.get(id)?.record ?? native.get(id)
    if (!record) throw reject(404,'Unknown session')
    const provider=await deleteProvider(record,native.get(changeKey(record)))
    if (!provider) throw reject(409,'This session does not support native deletion')
    requirePresent(id,record)

    const remoteIds=nativeDescendants(record,native)
    const {aliases,related,keys}=deleteScope(record,remoteIds)
    if ([...keys].some(key=>deleting.has(key) || archiveChanges.has(key) || renameChanges.has(key)) || [...related].some(activeSession)) {
      throw reject(409,'Wait for the session and active subagents to finish')
    }
    if (!aliases.every(s=>validSessionId(s.record.id))) throw reject(409,'A session alias could not be verified')
    for (const key of keys) deleting.add(key)
    try {
      for (const s of aliases) {
        clearTimeout(s.idleTimer)
        if (s.closing) await s.closing
        if (!s.adapter) continue
        const adapter=s.adapter
        s.adapter=null
        await adapter.close()
      }
      await provider.deleteSession({remoteId:record.remoteId,cwd:record.cwd,signal:controller.signal})
      const rootIds=[id,changeKey(record),...aliases.filter(s=>s.record.remoteId===record.remoteId).map(s=>s.record.id)]
      const deletedIds=[...new Set(rootIds)]
      for (const removed of deletedIds) deleted.set(removed,deletedIds)
      const current=await catalog.refreshEngine(record.engine).then(()=>catalog.list()).catch(()=>undefined)
      for (const remoteId of remoteIds) {
        const nativeKey=nativeId(record.engine,remoteId)
        if (remoteId===record.remoteId || !current || current.has(nativeKey)) continue
        deletedIds.push(nativeKey,...aliases.filter(s=>s.record.remoteId===remoteId).map(s=>s.record.id).filter(alias=>alias!==nativeKey))
      }
      for (const removed of deletedIds) deleted.set(removed,deletedIds)
      purgeDeleted(deletedIds)
      return {deletedIds}
    } finally {
      for (const key of keys) deleting.delete(key)
    }
  }
  function legacyArchived(record) {
    return Boolean(preferences.get(record.id)?.archived ?? archives.get(record.id))
  }
  function supportsNativeArchive(record) {
    return Boolean(record.remoteId && typeof engines.get(record.engine)?.setArchived === 'function')
  }
  function archiveMode(record, indexed) {
    if (indexed?.archived !== true && legacyArchived(record)) return 'legacy'
    return supportsNativeArchive(record) ? 'native' : 'unsupported'
  }
  function isArchived(record, indexed) {
    return Boolean((indexed?.archived ?? record.archived) || legacyArchived(record))
  }
  function syncArchived(record, entry) {
    if (typeof entry?.archived === 'boolean') record.archived=entry.archived
  }
  async function changeArchive(record, archived, entry, { refresh = true } = {}) {
    requirePresent(record.id,record)
    const key=changeKey(record)
    if (archiveChanges.has(key)) throw reject(409,'Archive change in progress')
    if (renameChanges.has(key)) throw reject(409,'Rename in progress')
    const all=[...sessions.values()]
    const aliases=all.filter(s=>s.record.id===record.id ||
      (record.remoteId && s.record.engine===record.engine && s.record.remoteId===record.remoteId))
    const roots=new Set([record.id,...aliases.map(s=>s.record.id)])
    const mode=archiveMode(record,entry)
    if(mode==='unsupported' || (mode==='legacy' && archived && !engines.get(record.engine)?.setArchived)) {
      throw reject(409,'This engine does not support native archiving')
    }
    if(aliases.some(activeSession) ||
        (archived && all.some(child=>roots.has(child.record.parentId) && child.busy))) {
      throw reject(409,'Wait for the active session or subagent to finish')
    }
    archiveChanges.add(key)
    try {
      if(mode==='native' || archived) {
        for(const s of aliases) {
          if(s.closing) await s.closing
          if(!s.adapter) continue
          clearTimeout(s.idleTimer)
          const adapter=s.adapter
          s.adapter=null
          await adapter.close()
        }
        const provider=engines.get(record.engine)
        const launch=record.engine==='agy' ? accountLaunch(record,provider,agyHistoryProfileId(record)) : {}
        await provider.setArchived({remoteId:record.remoteId,cwd:record.cwd,archived,signal:controller.signal,...launch})
        record.archived=archived
        for(const s of aliases) {
          s.record.archived=archived
          if (record.engine==='agy' && agyHistoryProfileId(record)!=='default') save(s)
        }
        if (refresh) await catalog.refreshEngine(record.engine)
      }
      const previous=preferences.get(record.id) || {}
      // Clear the legacy override, including archive.json, without masking subsequent CLI changes.
      if (legacyArchived(record) || (archived && previous.pinnedAt)) {
        storePreferences(record.id,{...previous,archived:false,pinnedAt:archived ? undefined : previous.pinnedAt})
      }
      return {archived}
    } finally { archiveChanges.delete(key) }
  }
  async function archiveWorkspace(cwd) {
    const native = await catalog.list()
    const cached = [...sessions.values()].map(s => s.record)
    const knownIds = new Set(cached.map(r => r.engine + '/' + r.remoteId))
    const entries = [...cached.filter(r => r.messages.length || r.queue.length || r.imported || r.forkedFrom || r.parentId),
      ...[...native.values()].filter(r => !knownIds.has(r.engine + '/' + r.remoteId))]
    const archivedIds = []
    const refreshedEngines = new Set()
    let skippedActive = 0
    let skippedUnsupported = 0
    for (const r of entries) {
      const key = changeKey(r)
      if (!engines.has(r.engine) || deleted.has(r.id) || deleted.has(key)) continue
      const indexed = native.get(r.id) || (r.remoteId && native.get(nativeId(r.engine, r.remoteId)))
      if (isChild(r, indexed)) continue
      if ((r.cwd || '') !== cwd) continue
      syncArchived(r, indexed)
      if (isArchived(r, indexed)) continue
      const mode = archiveMode(r, indexed)
      if (mode === 'unsupported' || (mode === 'legacy' && !engines.get(r.engine)?.setArchived)) {
        skippedUnsupported += 1
        continue
      }
      try {
        await changeArchive(r, true, indexed, { refresh: false })
        archivedIds.push(r.id)
        refreshedEngines.add(r.engine)
        const current = sessions.get(r.id)
        if (current) broadcast(current, 'snapshot', snapshot(current))
      } catch (error) {
        if (error?.status === 409) skippedActive += 1
        else throw error
      }
    }
    if (refreshedEngines.size) {
      await Promise.all([...refreshedEngines].map(engine => catalog.refreshEngine(engine)))
    }
    return { cwd, archivedIds, skippedActive, skippedUnsupported }
  }
  function renameMode(record, entry) {
    if (isChild(record,entry) || isArchived(record,entry) || record.resumable===false || entry?.resumable===false) return 'unsupported'
    const provider=engines.get(record.engine)
    if (typeof provider?.rename === 'function') return record.remoteId ? 'native' : 'unsupported'
    return provider?.localRename === true ? 'local' : 'unsupported'
  }
  async function renameSession(record, entry, title, mode) {
    const supported=renameMode(record,entry)
    if (mode!==undefined && mode!=='local') throw reject(400,'Unknown rename mode')
    if (supported==='local' && mode==='local') {
      storePreferences(record.id,{...preferences.get(record.id),title})
      return {title}
    }
    if (supported!=='native') {
      if (isArchived(record,entry)) throw reject(409,'Restore the session before renaming it')
      if (supported==='local') throw reject(409,'This engine requires explicit local renaming')
      throw reject(409,'This conversation does not support native renaming')
    }
    if (mode==='local') throw reject(400,'Use native renaming for this engine')
    const provider=engines.get(record.engine)
    const key=changeKey(record)
    if (archiveChanges.has(key) || renameChanges.has(key) || accountChanges.has(key)) throw reject(409,'Another session change is in progress')
    title=title.replace(/\s+/g,' ').trim()
    renameChanges.add(key)
    try {
      const launch=record.engine==='agy' ? accountLaunch(record,provider,agyHistoryProfileId(record)) : {}
      await provider.rename({remoteId:record.remoteId,cwd:record.cwd,title,signal:controller.signal,...launch})
      const aliases=[...sessions.values()].filter(s=>s.record.id===record.id || changeKey(s.record)===key)
      const ids=new Set([record.id,key,...aliases.map(s=>s.record.id)])
      const next=new Map(preferences)
      for (const id of ids) {
        const previous=next.get(id)
        if (!previous || !Object.hasOwn(previous,'title')) continue
        const {title: oldTitle,...remaining}=previous
        if (Object.keys(remaining).length) next.set(id,remaining)
        else next.delete(id)
      }
      if ([...ids].some(id=>preferences.get(id)!==next.get(id))) {
        writeViewState(preferencesPath,next)
        for (const id of ids) {
          if (next.has(id)) preferences.set(id,next.get(id))
          else preferences.delete(id)
        }
      }
      for (const s of aliases) {
        s.record.nativeTitle=title
        s.record.nativeRenamed=true
        save(s)
        broadcast(s,'snapshot',snapshot(s))
      }
      await catalog.refreshEngine(record.engine)
      return {title}
    } finally { renameChanges.delete(key) }
  }
  function displayTitle(record, indexed) {
    return preferences.get(record.id)?.title ?? (record.forkedFrom && !record.nativeRenamed ? record.title : undefined) ?? indexed?.nativeTitle ?? record.nativeTitle ?? record.title
  }
  function forkTitle(record) {
    const title=displayTitle(record)
    const suffix=/(?:\((\d+)\)|（(\d+)）)$/u.exec(title)
    if(!suffix) return title+' (1)'
    const next=BigInt(suffix[1] ?? suffix[2])+1n
    return title.slice(0,suffix.index)+(suffix[1] ? '('+next+')' : '（'+next+'）')
  }
  function canFork(record) {
    const definition = engines.get(record.engine)
    return Boolean(record.remoteId && !record.parentId && !record.nativeParent && record.resumable !== false &&
      typeof definition?.fork === 'function' && (definition.forkCapability !== 'negotiated' || record.capabilitiesMedia?.fork))
  }
  function agyForkUnavailable(record) {
    return record.engine==='agy' && engines.get('agy')?.forkCapability==='negotiated' && !record.capabilitiesMedia?.fork
  }
  const activeTask = status => ['queued','running','waiting'].includes(status)
  const transcriptVersion = engine => ['agy','codex'].includes(engine) ? 9 : 8
  const capabilityUpdates = list => (Array.isArray(list) ? list : [])
    .filter(item => ['available_commands_update', 'usage_update'].includes(item?.update?.sessionUpdate))
  const hasDisplayActivity = update =>
    (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text' &&
      typeof update.content.text === 'string' && Boolean(update.content.text.trim())) ||
    ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && Boolean(update.toolCallId)) ||
    (update.sessionUpdate === 'plan' && Array.isArray(update.entries) && update.entries.length > 0)
  function compactTool(tool) {
    if (!tool || typeof tool !== 'object') return tool
    const locations = toolLocations(tool.locations)
    const execution = commandExecution(tool.execution)
    return {
      ...(tool.sessionUpdate ? { sessionUpdate: tool.sessionUpdate } : {}),
      toolCallId: tool.toolCallId,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.kind !== undefined ? { kind: tool.kind } : {}),
      ...(tool.status !== undefined ? { status: tool.status } : {}),
      ...(locations.length ? { locations } : {}),
      ...(execution ? { execution } : {}),
    }
  }
  const compactMessages = messages => messages.map(message => {
    const tools = message?.tools?.length ? message.tools.map(compactTool) : undefined
    const steps = Array.isArray(message?.steps) && message.steps.length
      ? message.steps.map(step => step?.kind === 'tool' ? { kind: 'tool', tool: compactTool(step.tool) } : step)
      : undefined
    return (tools || steps) ? { ...message, ...(tools ? { tools } : {}), ...(steps ? { steps } : {}) } : message
  })
  // Repair only an adjacent inversion whose user input and answer are unique in the native log.
  function restoreAgySteeringOrder(messages, native) {
    const positions = new Map()
    for (const [index, row] of native.entries()) {
      if (!row.text) continue
      const key = row.role + '\n' + row.text.trim()
      positions.set(key, positions.has(key) ? -1 : index)
    }
    for (let i = 1; i + 1 < messages.length; i++) {
      const [previous, answer, input] = messages.slice(i - 1, i + 2)
      if (previous.role !== 'user' || answer.role !== 'assistant' || input.role !== 'user' || !answer.text || !input.text) continue
      const pos = positions.get('user\n' + input.text.trim())
      if (!(pos > 0) || positions.get('assistant\n' + answer.text.trim()) !== pos + 1) continue
      const activity = native[pos - 1]
      const hasActivity = activity.role === 'assistant' && !activity.text
      const preceding = native[pos - (hasActivity ? 2 : 1)]
      if (preceding?.role !== 'user' || preceding.text.trim() !== previous.text.trim()) continue
      messages.splice(i, 2, ...(hasActivity ? [activity] : []), input, {...answer,...native[pos + 1]})
      i += hasActivity ? 2 : 1
    }
  }
  function turnsByText(messages) {
    const turns = new Map()
    let turn = []
    const addTurn = () => {
      if (!turn.length) return
      const text = turn.filter(message => message.role === 'user' || message.text)
      const key = JSON.stringify(text.map(({ role, text }) => [role, text.trim()]))
      turns.set(key, turns.has(key) ? undefined : turn)
    }
    for (const message of messages) {
      if (message.role === 'user') {
        addTurn()
        turn = [message]
      } else if (turn.length) {
        turn.push(message)
      }
    }
    addTurn()
    return turns
  }
  function restoreImportedCodexToolOrder(saved, native) {
    const nativeTurns = turnsByText(native)
    for (const [key, savedTurn] of turnsByText(saved)) {
      const nativeTurn = nativeTurns.get(key)
      if (!savedTurn || !nativeTurn) continue
      const turn = savedTurn.filter(message => message.role === 'user' || message.text)
      const source = nativeTurn.filter(message => message.role === 'user' || message.text)
      // Match existing tool IDs inside a uniquely identified turn and keep the saved tool metadata.
      for (let index = 1; index < turn.length - 1; index++) {
        const progress = turn[index]
        const next = turn[index + 1]
        if (progress.phase !== 'commentary' || !progress.tools?.length) continue
        const nextIds = new Set(source[index + 1].tools?.map(tool => tool.toolCallId))
        const nextTools = new Set(next.tools?.map(tool => tool.toolCallId))
        const moved = progress.tools.filter(tool => nextIds.has(tool.toolCallId) && !nextTools.has(tool.toolCallId))
        if (!moved.length) continue
        const movedIds = new Set(moved.map(tool => tool.toolCallId))
        const previousTools = progress.tools.filter(tool => !movedIds.has(tool.toolCallId))
        const previousSteps = progress.steps?.filter(step => step?.kind !== 'tool' || !movedIds.has(step.tool?.toolCallId))
        if (previousTools.length) progress.tools = previousTools
        else delete progress.tools
        if (previousSteps?.length) progress.steps = previousSteps
        else delete progress.steps
        const nextSteps = next.steps ?? [
          ...(next.thought ? [{ kind: 'thought', text: next.thought }] : []),
          ...(next.plan?.length ? [{ kind: 'plan', entries: next.plan }] : []),
          ...(next.tools ?? []).map(tool => ({ kind: 'tool', tool })),
        ]
        next.tools = [...moved, ...(next.tools ?? [])]
        next.steps = [...moved.map(tool => ({ kind: 'tool', tool })), ...nextSteps]
      }
    }
  }
  function restoreCommandExecutions(saved, native, engine) {
    const tools = message => message.tools?.length ? message.tools
      : message.steps?.filter(step => step?.kind === 'tool').map(step => step.tool) ?? []
    const indexed = (messages, keyFor = tool => tool.toolCallId) => {
      const index = new Map()
      for (const message of messages) {
        for (const tool of tools(message)) {
          const key = tool && keyFor(tool)
          if (key) index.set(key, index.has(key) ? undefined : tool)
        }
      }
      return index
    }
    const synthetic = tool => /^tool-\d+$/.test(tool.toolCallId)
    const agyCommand = tool => tool.kind === 'execute' ? tool.execution?.command : undefined
    const agySavedCommand = tool => tool.kind === 'execute' && tool.sessionUpdate && !synthetic(tool)
      ? tool.execution?.command ?? tool.title : undefined
    const nativeById = indexed(native)
    const addExecution = (message, findNative) => {
      const executionById = new Map()
      for (const tool of tools(message)) {
        const source = tool && findNative(tool)
        if (!source?.execution) continue
        const execution = commandExecution(completeExecution(source.execution, tool.execution))
        if (isDeepStrictEqual(execution, tool.execution)) continue
        const status = source.execution.exitCode !== undefined && (isPendingToolStatus(tool.status) || !tool.status)
          ? source.status ?? tool.status : tool.status
        executionById.set(tool.toolCallId, { execution, status })
      }
      if (executionById.size) {
        const enrich = tool => executionById.has(tool?.toolCallId)
          ? compactTool({ ...tool, ...executionById.get(tool.toolCallId) }) : tool
        if (message.tools) message.tools = message.tools.map(enrich)
        if (message.steps) message.steps = message.steps.map(step =>
          step?.kind === 'tool' ? { ...step, tool: enrich(step.tool) } : step)
      }
    }
    for (const message of saved) {
      addExecution(message, tool => synthetic(tool) ? undefined : nativeById.get(tool.toolCallId))
    }
    const nativeTurns = turnsByText(native)
    for (const [key, turn] of turnsByText(saved)) {
      const nativeTurn = nativeTurns.get(key)
      if (!turn || !nativeTurn) continue
      const source = indexed(nativeTurn)
      const nativeCommands = engine === 'agy' ? indexed(nativeTurn, agyCommand) : undefined
      const savedCommands = nativeCommands ? indexed(turn, agySavedCommand) : undefined
      for (const message of turn) {
        addExecution(message, tool => {
          if (synthetic(tool)) {
            const match = source.get(tool.toolCallId)
            if (match?.title === tool.title && match?.kind === tool.kind) return match
          } else if (savedCommands) {
            const command = agySavedCommand(tool)
            if (savedCommands.get(command) === tool) return nativeCommands.get(command)
          }
        })
      }
    }
  }
  function foldTurnActivity(updates) {
    let thought = ''
    let plan = []
    const tools = new Map()
    const steps = []
    const toolStepById = new Map()
    let planStep
    for (const { update } of Array.isArray(updates) ? updates : []) {
      if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
        const chunk = update.content.text
        thought += chunk
        const last = steps.at(-1)
        if (last?.kind === 'thought') last.text += chunk
        else steps.push({ kind: 'thought', text: chunk })
      } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        const nextTool = compactTool({ ...tools.get(update.toolCallId), ...update })
        tools.set(update.toolCallId, nextTool)
        const existingStep = toolStepById.get(update.toolCallId)
        if (existingStep) existingStep.tool = nextTool
        else {
          const step = { kind: 'tool', tool: nextTool }
          toolStepById.set(update.toolCallId, step)
          steps.push(step)
        }
      } else if (update?.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
        plan = update.entries
        if (!planStep && plan.length) {
          planStep = { kind: 'plan' }
          steps.push(planStep)
        }
        if (planStep) planStep.entries = plan
      }
    }
    const cleanSteps = steps
      .map(step => step.kind === 'thought' ? { kind: 'thought', text: step.text.trim() } : step)
      .filter(step => (step.kind !== 'thought' || step.text) && (step.kind !== 'plan' || step.entries.length))
    return { thought: thought.trim(), plan, tools: [...tools.values()], steps: cleanSteps }
  }
  const statusClients = new Set()
  const isChildSession = r => Boolean(r?.parentId || r?.nativeParent || r?.isChild)
  function sessionStatusSnapshot() {
    const items = []
    for (const s of sessions.values()) {
      const r = s.record
      if (isChildSession(r)) continue
      const state = s.permissions.size > 0
        ? 'attention'
        : (s.busy || s.opening || hasPendingTools(s))
          ? 'running'
          : s.unreadDone
            ? 'done'
            : null
      if (!state) continue
      items.push({
        id: r.id,
        title: displayTitle(r),
        engine: r.engine,
        cwd: r.cwd,
        state,
        updatedAt: r.updatedAt || Date.now(),
        ...(s.permissions.size > 0 ? {
          permissions: [...s.permissions.values()].map(req => ({
            id: req.toolCall.toolCallId,
            title: req.toolCall.title || '',
            detail: req.toolCall.rawInput?.command || req.toolCall.rawInput?.file_path || req.toolCall.rawInput?.path || '',
            options: Array.isArray(req.options) ? req.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })) : [],
          })),
        } : {}),
      })
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  function broadcastGlobalStatus() {
    if (!statusClients.size) return
    const frame = 'data: ' + JSON.stringify({ sessions: sessionStatusSnapshot() }) + '\n\n'
    for (const client of statusClients) client.write(frame)
  }
  const profilesFile = join(store, 'profiles.json')
  function readProfiles() {
    try {
      const parsed = JSON.parse(readFileSync(profilesFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  function writeProfiles(data) {
    writeFileSync(profilesFile + '.tmp', JSON.stringify(data), { mode: 0o600 })
    renameSync(profilesFile + '.tmp', profilesFile)
    accountUsage=createAccountUsageCache()
  }
  function engineProfiles(engineId) {
    const all = readProfiles()
    const entry = all[engineId] || {}
    const list = Array.isArray(entry.list) ? entry.list : []
    const defaultProfileId = typeof entry.defaultProfileId === 'string' ? entry.defaultProfileId : 'default'
    const overrides = entry.overrides && typeof entry.overrides === 'object' ? entry.overrides : {}
    const defaultOptions = entry.defaultOptions && typeof entry.defaultOptions === 'object' ? entry.defaultOptions : {}
    return { defaultProfileId, list, overrides, defaultOptions }
  }
  function sanitizeEnvMap(raw) {
    const env = {}
    for (const [k, v] of Object.entries(raw || {})) {
      if (typeof k === 'string' && /^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string' && v.trim()) {
        env[k] = v.trim()
      }
    }
    return Object.keys(env).length ? env : undefined
  }
  function linkSharedItem(src, dst) {
    if (!existsSync(src) || existsSync(dst)) return
    const isDir = (() => { try { return statSync(src).isDirectory() } catch { return false } })()
    try {
      symlinkSync(src, dst, process.platform === 'win32' && isDir ? 'junction' : undefined)
    } catch {
      if (process.platform === 'win32' && !isDir) {
        try { linkSync(src, dst) } catch {}
      }
    }
  }
  function agyIsolatedEnv(profileId) {
    const dir = join(store, 'profiles', 'agy', profileId)
    const config = join(dir, '.config')
    mkdirSync(config, { recursive: true, mode: 0o700 })
    const nativeAgy = agyDataDirectory(homedir())
    const isolatedAgy = agyDataDirectory(dir)
    migrateAgySharedHistory(nativeAgy, isolatedAgy, linkSharedItem)
    const winDirs = process.platform === 'win32' ? {
      USERPROFILE: dir,
      APPDATA: join(dir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(dir, 'AppData', 'Local'),
    } : {}
    for (const folder of Object.values(winDirs)) mkdirSync(folder, { recursive: true, mode: 0o700 })
    return {
      HOME: dir,
      XDG_CONFIG_HOME: config,
      ...winDirs,
      // AGY's Linux keyring uses one entry for all homes; disable D-Bus so it
      // falls back to file storage. On Windows, SSH_CONNECTION forces file-based
      // credential fallback instead of sharing Windows Credential Manager.
      ...(process.platform === 'linux'
        ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null/dsh-agy-private-bus', ANTIGRAVITY_CREDENTIAL_SCOPE: undefined }
        : process.platform === 'win32'
          ? { SSH_CONNECTION: '127.0.0.1 12345 127.0.0.1 22', ANTIGRAVITY_CREDENTIAL_SCOPE: undefined }
          : { ANTIGRAVITY_CREDENTIAL_SCOPE: `dsh-agy-${profileId}` }),
      ANTIGRAVITY_GEMINI_DIR: undefined,
      ANTIGRAVITY_APP_DATA_DIR: undefined,
      ANTIGRAVITY_CONFIG_REL_DIR: undefined,
      AGY_ACCOUNT: undefined,
      AGY_ADC_AUTH: undefined,
    }
  }
  function migrateAllAgyProfiles() {
    const agyProfilesDir = join(store, 'profiles', 'agy')
    if (!existsSync(agyProfilesDir)) return
    const nativeAgy = agyDataDirectory(homedir())
    for (const entry of readdirSync(agyProfilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        migrateAgySharedHistory(nativeAgy, agyDataDirectory(join(agyProfilesDir, entry.name)), linkSharedItem)
      } catch {}
    }
  }
  migrateAllAgyProfiles()
  function resolveProfileEnv(engineId, profileId, pendingProfile) {
    if (!profileId || profileId === 'default') return undefined
    const profile = pendingProfile || engineProfiles(engineId).list.find(item => item.id === profileId)
    if (!profile) return undefined
    if (engineId === 'agy' && profile.kind !== 'env') {
      return profile.kind === 'isolated' ? agyIsolatedEnv(profileId) : undefined
    }
    if (profile.kind === 'env') {
      const env = {}
      for (const [k, v] of Object.entries(profile.env || {})) {
        if (typeof k === 'string' && /^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string' && v) env[k] = v
      }
      return Object.keys(env).length ? env : undefined
    }
    const dir = join(store, 'profiles', engineId, profile.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (engineId === 'codex') {
      const base = process.env.CODEX_HOME || join(homedir(), '.codex')
      for (const item of ['sessions', 'archived_sessions', 'state_5.sqlite', 'session_index.jsonl']) {
        linkSharedItem(join(base, item), join(dir, item))
      }
      return {
        CODEX_HOME: dir,
        OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined,
        OPENAI_FEDERATION_RULE_ID: undefined, OPENAI_IDENTITY_TOKEN_FILE: undefined, OPENAI_WORKLOAD_IDENTITY_CONTEXT: undefined,
      }
    }
    if (engineId === 'claude') {
      const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
      linkSharedItem(join(base, 'projects'), join(dir, 'projects'))
      return {
        CLAUDE_CONFIG_DIR: dir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
        ...Object.fromEntries(claudeExternalAuthEnvKeys.map(key => [key, undefined])),
      }
    }
    return undefined
  }
  function sessionProfiles(provider, {list, overrides} = engineProfiles(provider.id)) {
    const defaults = [{id:'default', name:'Default', kind:'default'}]
    const raw = provider.id === 'agy'
      ? [...defaults, ...list.filter(item => item.kind === 'isolated')]
      : [...defaults, ...(provider.configProfiles?.() || []), ...list].filter(item => {
          if (item.kind === 'env') return Boolean(sanitizeEnvMap(item.env) || sanitizeEnvMap(overrides[item.id]?.env))
          return item.kind !== 'snapshot' && (item.kind !== 'isolated' || ['codex','claude'].includes(provider.id))
        })
    return raw.map(item => ({ ...item, disabled: Boolean(overrides[item.id]?.disabled) }))
  }
  function agyAutomaticName(item) {
    return item.kind === 'isolated' && (item.autoNamed ?? /^Antigravity #\d+$/.test(item.name))
  }
  let defaultAgyAuth, defaultAgyAuthPending
  async function profileAuthStatus(provider, profileId, env) {
    const options = { signal: controller.signal, env }
    if (provider.id !== 'agy' || profileId !== 'default') return provider.authStatus(options)
    if (!defaultAgyAuthPending) {
      const pending = Promise.resolve().then(() => provider.authStatus(options)).then(auth => {
        if (defaultAgyAuthPending === pending) defaultAgyAuth = auth
        return auth
      }).finally(() => {
        if (defaultAgyAuthPending === pending) defaultAgyAuthPending = undefined
      })
      defaultAgyAuthPending = pending
    }
    return defaultAgyAuthPending
  }
  function sessionProfileIdentity(provider, item) {
    if (item.kind !== 'default' && item.kind !== 'isolated') return
    if (provider.id === 'agy') {
      if (item.id === 'default' && provider.authStatus) {
        const account = defaultAgyAuth?.authenticated ? defaultAgyAuth.account : undefined
        return account !== 'Google OAuth' ? account : undefined
      }
      const home = item.id === 'default' ? undefined : join(store, 'profiles', 'agy', item.id)
      return provider.readOAuthAccount?.(home)
    }
    const status = engineAdmin.get(provider.id)
    if (status?.authProfileId === item.id && status.authenticated) return status.authIdentity
  }
  function sessionProfileName(provider, item, account) {
    if (provider.id === 'agy' && (item.id === 'default' || agyAutomaticName(item))) return account || item.name
    return item.name
  }
  function sessionProfileId(record) {
    return record.profileId ?? (record.imported || record.engine==='agy' ? 'default' : engineProfiles(record.engine).defaultProfileId)
  }
  function agyHistoryProfileId(record) {
    return record.agyHistoryProfileId ?? sessionProfileId(record)
  }
  function agyHistoryDirectory(record, provider) {
    return agyDataDirectory(accountLaunch(record,provider,agyHistoryProfileId(record)).env?.HOME)
  }
  function agyRuntimeRoot(record) {
    return join(store,'agy-sessions',record.remoteId)
  }
  function agyArtifact(record, requestedPath) {
    if (!nativeUuid.test(record.remoteId)) return {requestedPath,allowedRoots:[]}
    const provider=engines.get(record.engine)
    const brain=join(agyHistoryDirectory(record,provider),'brain',record.remoteId)
    if (!lstatSync(brain,{throwIfNoEntry:false})?.isDirectory()) return {requestedPath,allowedRoots:[]}
    const canonical=realpathSync(brain)
    let absolute=requestedPath
    if (typeof absolute==='string' && absolute.startsWith('file://')) {
      try { absolute=fileURLToPath(absolute) } catch { absolute=undefined }
    }
    if (typeof absolute==='string' && isAbsolute(absolute)) {
      const nativePath=relative(brain,absolute)
      const [runtimeId,account,folder,id,...path]=relative(join(store,'agy-sessions'),absolute).split(sep)
      if (nativeUuid.test(runtimeId) && account?.startsWith('account-') && folder==='brain' && id===record.remoteId) requestedPath=join(canonical,...path)
      else if (!isAbsolute(nativePath) && nativePath!=='..' && !nativePath.startsWith('..'+sep)) requestedPath=join(canonical,nativePath)
    }
    return {requestedPath,allowedRoots:[canonical]}
  }
  function hasSessionHistory(record) {
    return Boolean(record.imported || record.forkedFrom || record.hasWebTurns || record.messages.length)
  }
  function profileSettings(profile, overrides) {
    const provider = profile.modelProvider && overrides[`provider:${profile.modelProvider}`]
    const own = overrides[profile.id]
    return { env:{...sanitizeEnvMap(profile.env),...sanitizeEnvMap(provider?.env),...sanitizeEnvMap(own?.env)},
      baseUrl:own?.baseUrl || provider?.baseUrl }
  }
  function profileModelProvider(provider, profile, overrides) {
    if (!profile || provider.id!=='codex') return
    const env=profile.kind==='isolated' ? {CODEX_HOME:join(store,'profiles','codex',profile.id)} : profileSettings(profile,overrides).env
    return profile.modelProvider || provider.defaultModelProvider?.(env,profile.configProfile)
  }
  const historyEnv = /^(HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_(CONFIG|DATA|STATE)_HOME)$/i
  function sharesSessionHistory(engine, profile, overrides) {
    if (!profile || !['codex','claude'].includes(engine) || Object.keys(profileSettings(profile,overrides).env).some(key=>historyEnv.test(key))) return false
    if (profile.kind !== 'isolated') return true
    const root = engine === 'codex' ? process.env.CODEX_HOME || join(homedir(),'.codex') : process.env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude')
    const directory = join(store,'profiles',engine,profile.id)
    const trees = engine === 'codex' ? ['sessions','archived_sessions'] : ['projects']
    return trees.every(name=>{
      const rootPath=join(root,name), profilePath=join(directory,name)
      try {
        if (!lstatSync(profilePath,{throwIfNoEntry:false})) return true
        return realpathSync(rootPath)===realpathSync(profilePath)
      } catch { return false }
    })
  }
  function sessionAccount(s) {
    const r=s.record
    const id=sessionProfileId(r)
    const provider=engines.get(r.engine)
    const profiles=engineProfiles(r.engine)
    const available=provider ? sessionProfiles(provider,profiles) : []
    const current=available.find(item=>item.id===id)
    const describe=item=>{
      const account=sessionProfileIdentity(provider,item)
      const name=sessionProfileName(provider,item,account ?? null)
      const label=item.id==='default'
        ? (name !== item.name && name) || account || 'Default configuration'
        : name || item.id
      return {id:item.id,label,...(account ? {account} : {})}
    }
    const retainedHistory=hasSessionHistory(r)
    const canResumeAgy=r.engine==='agy' && (!retainedHistory || nativeUuid.test(r.remoteId))
    const modelProvider=r.engine==='codex' && retainedHistory && (r.modelProvider || profileModelProvider(provider,current,profiles.overrides))
    const choices=available.filter(item=>item.id===id || (!item.disabled && (canResumeAgy || (sharesSessionHistory(r.engine,item,profiles.overrides) &&
      (!modelProvider || modelProvider===profileModelProvider(provider,item,profiles.overrides))))))
      .map(describe)
    const key=changeKey(r)
    const canChoose=Boolean(current && choices.length>1 && (canResumeAgy || sharesSessionHistory(r.engine,current,profiles.overrides)) &&
      (!retainedHistory || r.remoteId))
    const readOnly=isChildSession(r) || r.resumable===false || isArchived(r)
    const busy=canChoose && (activeSession(s) || accountChanges.has(key) || archiveChanges.has(key) || renameChanges.has(key) || deleting.has(key) ||
      r.queue.length || s.permissions.size || hasPendingTools(s) || [...sessions.values()].some(other=>other!==s && (
        (other.record.parentId===r.id && activeSession(other)) ||
        (r.remoteId && other.record.engine===r.engine && other.record.remoteId===r.remoteId && (other.adapter || activeSession(other)))
      )))
    const canSwitch=canChoose && !readOnly && !busy
    const switchBlockedReason=!canSwitch && available.some(item=>item.id!==id && !item.disabled)
      ? !current ? 'unavailable' : readOnly ? 'readOnly' : busy ? 'busy' : 'history'
      : undefined
    const selected=choices.find(choice=>choice.id===id) ?? {id,label:profiles.list.find(item=>item.id===id)?.name || id}
    return {...selected,canSwitch,choices,
      ...(switchBlockedReason ? {switchBlockedReason} : {})}
  }
  function accountLaunch(record, provider, profileId = sessionProfileId(record), switching = false) {
    const profiles=engineProfiles(record.engine)
    const profile=sessionProfiles(provider,profiles).find(item=>item.id===profileId)
    if (!profile) throw reject(409,'The account bound to this session is unavailable')
    const {env:overrides,baseUrl}=profileSettings(profile,profiles.overrides)
    const baseEnv=profile.kind==='isolated' ? resolveProfileEnv(record.engine,profileId) : undefined
    const env={...overrides,...baseEnv}
    const modelProvider=profile.modelProvider || (switching ?
      hasSessionHistory(record) && profileModelProvider(provider,profile,profiles.overrides) : record.modelProvider)
    const extraArgs=record.engine==='codex' ? [
      ...(profileId.startsWith('config:') ? ['-c',`profile=${profileId.slice('config:'.length)}`] :
        profileId.startsWith('provider:') ? ['-c',`model_provider=${modelProvider}`] : []),
      ...(baseUrl && modelProvider ? ['-c',`model_providers.${modelProvider}.base_url=${JSON.stringify(baseUrl)}`] : []),
    ] : []
    return { ...(Object.keys(env).length ? {env} : {}), ...(extraArgs.length ? {extraArgs} : {}), ...(modelProvider ? {modelProvider} : {}) }
  }
  function profileLoginCommand(provider, env) {
    const base = provider?.loginCommand || provider?.id || ''
    if (!base) return ''
    if (!env) return base
    const unset = Object.entries(env).filter(([, value]) => value === undefined).map(([key]) => '-u ' + key)
    const prefix = Object.entries(env)
      .filter(([k, v]) => v && ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'ANTIGRAVITY_CREDENTIAL_SCOPE'].includes(k))
      .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`)
      .join(' ')
    return [unset.length ? 'env ' + unset.join(' ') : '', prefix, base].filter(Boolean).join(' ')
  }
  function closeIdleAdapters(engineId, profileId) {
    const closing = []
    for (const s of sessions.values()) {
      if (s.record.engine !== engineId || (profileId && sessionProfileId(s.record) !== profileId) ||
          activeSession(s) || hasPendingTools(s)) continue
      if (s.adapter) {
        const adapter = s.adapter
        s.adapter = null
        s.view = undefined
        const closed = Promise.resolve().then(() => adapter.close()).finally(() => { s.closing = null })
        s.closing = closed.catch(() => {})
        closing.push(closed)
      } else if (s.closing) {
        closing.push(s.closing)
      }
    }
    return closing
  }

  function broadcastEngineAccountSnapshots(engineId) {
    for (const s of sessions.values()) {
      if (s.record.engine === engineId && s.clients.size) broadcast(s, 'snapshot', snapshot(s))
    }
  }

  async function listEngineProfilesWithStatus(provider) {
    const { defaultProfileId, list, overrides } = engineProfiles(provider.id)
    const configList = typeof provider.configProfiles === 'function' ? provider.configProfiles() : []
    const entries = [
      { id: 'default', name: 'Default', kind: 'default', isDefault: defaultProfileId === 'default' },
      ...configList.map(item => ({ ...item, isDefault: defaultProfileId === item.id })),
      ...list.map(item => ({ ...item, isDefault: defaultProfileId === item.id })),
    ]
    return Promise.all(entries.map(async item => {
      const override = overrides[item.id]
      const env = item.kind === 'config'
        ? sanitizeEnvMap(override?.env)
        : resolveProfileEnv(provider.id, item.id)
      let auth
      if (item.kind === 'config') {
        const providerOverride = item.modelProvider ? overrides[`provider:${item.modelProvider}`] : undefined
        if (item.envKey) {
          const hasKey = Boolean(env?.[item.envKey] || providerOverride?.env?.[item.envKey] || process.env[item.envKey] || item.hasInlineKey)
          const effectiveUrl = override?.baseUrl || providerOverride?.baseUrl || item.defaultBaseUrl || ''
          auth = {
            authenticated: hasKey,
            account: hasKey
              ? (effectiveUrl ? `${item.name} · ${effectiveUrl}` : item.name)
              : `Missing ${item.envKey}`,
          }
        } else if (item.hasInlineKey) {
          auth = { authenticated: true, account: item.defaultBaseUrl ? `${item.name} · ${item.defaultBaseUrl}` : item.name }
        } else {
          auth = typeof provider.authStatus === 'function'
            ? await provider.authStatus({ signal: controller.signal }).catch(() => ({}))
            : {}
        }
      } else if (item.kind === 'snapshot' && provider.id === 'agy') {
        auth = { authenticated: false, account: item.name }
      } else {
        auth = typeof provider.authStatus === 'function'
          ? await profileAuthStatus(provider, item.id, env).catch(() => ({}))
          : {}
      }
      return {
        id: item.id,
        name: provider.id === 'agy' && agyAutomaticName(item) && auth?.account && auth.account !== 'Google OAuth'
          ? auth.account : item.name,
        kind: item.kind,
        isDefault: item.isDefault,
        disabled: Boolean(override?.disabled),
        authenticated: auth?.authenticated,
        account: auth?.account,
        authLabel: auth?.label,
        envKey: item.envKey || '',
        defaultBaseUrl: item.defaultBaseUrl || '',
        baseUrl: override?.baseUrl || item.defaultBaseUrl || '',
        hasEnvKeyOverride: Boolean(item.envKey && env?.[item.envKey]),
        envKeys: item.kind === 'env' ? Object.keys(item.env || {}) : Object.keys(env || {}).filter(key => env[key] !== undefined),
        loginCommand: ['env', 'config', 'snapshot'].includes(item.kind) ? '' : profileLoginCommand(provider, env),
      }
    }))
  }

  const loginJobs = new Map()
  const loginInProgress = job => job.status === 'waiting_url' || job.status === 'waiting_auth' || job.status === 'finishing'
  const activeLogin = engineId => [...loginJobs.values()].reverse().find(job =>
    (!engineId || job.engineId === engineId) && loginInProgress(job))
  const loginDetails = job => ({
    engineId: job.engineId,
    loginId: job.id,
    profileId: job.profileId,
    authUrl: job.authUrl,
    needsCode: job.needsCode,
    status: job.status,
    account: job.account,
    error: job.error,
    errorCode: job.errorCode,
  })
  function retainFinishedLogin(job, status, error) {
    clearTimeout(job.timer)
    job.status = status
    job.error = error
    job.authUrl = undefined
    job.timer = setTimeout(() => loginJobs.delete(job.id), 5 * 60_000)
    job.timer.unref?.()
  }
  function removePendingProfile(job) {
    if (!job.pendingProfile) return
    try { rmSync(join(store, 'profiles', job.engineId, job.profileId), { recursive: true, force: true }) } catch {}
  }
  function stopLogin(job, status, error) {
    if (!loginInProgress(job)) return
    retainFinishedLogin(job, status, error)
    try { job.child.kill() } catch {}
  }
  function startEngineLogin(provider, { profileId, createProfile } = {}) {
    if (!provider?.loginSpec?.bin) throw reject(400, 'This engine does not support interactive web login')
    if (profileId !== undefined) textField(profileId, 'profileId')
    if (createProfile !== undefined && typeof createProfile !== 'boolean') throw reject(400, 'createProfile must be a boolean')
    const profiles = engineProfiles(provider.id)
    let targetProfileId = profileId || profiles.defaultProfileId
    const existing = activeLogin(provider.id)
    if (existing) {
      if (existing.creating === Boolean(createProfile) && (createProfile || existing.profileId === targetProfileId)) return loginDetails(existing)
      throw reject(409, 'Finish or cancel the current sign-in before starting another')
    }
    const isAgy = provider.id === 'agy'
    let pendingProfile
    if (createProfile) {
      if (!provider.loginSpec.multiOAuth || !['agy', 'claude', 'codex'].includes(provider.id)) {
        throw reject(409, 'This engine does not support isolated OAuth accounts')
      }
      targetProfileId = randomUUID()
      pendingProfile = { id: targetProfileId, kind: 'isolated' }
    } else if (targetProfileId !== 'default' && !sessionProfiles(provider, profiles).some(item => item.id === targetProfileId && item.kind === 'isolated')) {
      throw reject(409, 'Choose a default or isolated OAuth account to sign in')
    }
    if (isAgy && (agySigningOut.has(targetProfileId) || [...sessions.values()].some(session =>
      session.record.engine === 'agy' && session.switchingAccount === targetProfileId))) {
      throw reject(409, 'The account is changing in a session')
    }
    const env = resolveProfileEnv(provider.id, targetProfileId, pendingProfile)
    const finishDefaultAgyOAuth = isAgy && targetProfileId === 'default' && provider.finishDefaultOAuth
    const previousOAuthMarker = finishDefaultAgyOAuth ? provider.nativeOAuthMarker?.(env) : undefined
    const child = spawnCli(provider.loginSpec.bin, provider.loginSpec.args || [], {
      cwd: isAgy && env?.HOME ? env.HOME : homedir(),
      env: { ...process.env, ...env, BROWSER: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const job = {
      id: randomUUID(),
      engineId: provider.id,
      profileId: targetProfileId,
      creating: Boolean(createProfile),
      pendingProfile,
      child,
      needsCode: Boolean(provider.loginSpec.needsCode),
      status: 'waiting_url',
      timer: setTimeout(() => stopLogin(job, 'error', 'Sign-in timed out'), 5 * 60_000),
    }
    job.timer.unref?.()
    loginJobs.set(job.id, job)
    let output = ''
    let diagnosticTail = ''
    let nativeLoginOutput = ''
    const onChunk = chunk => {
      if (isAgy && loginInProgress(job)) {
        const recent = diagnosticTail + stripVTControlCharacters(chunk.toString())
        if (/invalid_grant|access_denied/i.test(recent)) job.errorCode = 'engineSettings.oauthRejected'
        else if (!job.errorCode && /failed to exchange|token exchange failed/i.test(recent)) job.errorCode = 'engineSettings.oauthExchange'
        else if (!job.errorCode && /failed to (?:save|store|write) (?:oauth |the )?(?:token|credentials)/i.test(recent)) job.errorCode = 'engineSettings.oauthStore'
        diagnosticTail = recent.slice(-48)
      }
      if (job.status !== 'waiting_url') return
      output = (output + chunk.toString()).slice(-16000)
      const text = stripVTControlCharacters(output)
      const pattern = isAgy
        ? /https:\/\/accounts\.google\.com\/[^\s"'<>]+(?=[\s"'<>])/
        : /https:\/\/[^\s"'<>]+(?=[\s"'<>])/
      const match = pattern.exec(text)
      if (match) {
        job.authUrl = match[0]
        job.status = 'waiting_auth'
      }
    }
    child.stdout?.on('data', chunk => {
      if (finishDefaultAgyOAuth) nativeLoginOutput = (nativeLoginOutput + chunk.toString()).slice(-2048)
      onChunk(chunk)
    })
    child.stderr?.on('data', onChunk)
    child.stdin?.on('error', () => {})
    child.once('error', err => {
      if (loginInProgress(job)) retainFinishedLogin(job, 'error', err.message)
      removePendingProfile(job)
    })
    child.once('close', async code => {
      if (!loginInProgress(job)) {
        removePendingProfile(job)
        return
      }
      diagnosticTail = ''
      if (code !== 0) {
        retainFinishedLogin(job, 'error', `Sign-in exited (${code ?? 'signal'})`)
        removePendingProfile(job)
        return
      }
      job.status = 'finishing'
      clearTimeout(job.timer)
      try {
        const auth = finishDefaultAgyOAuth
          ? await finishDefaultAgyOAuth({ output: stripVTControlCharacters(nativeLoginOutput), previousMarker: previousOAuthMarker,
            signal: controller.signal, env })
          : await provider.authStatus?.({ signal: controller.signal, env })
        if (!loginInProgress(job)) return
        if (typeof provider.authStatus === 'function' && auth?.authenticated !== true) {
          if (isAgy) job.errorCode ??= 'engineSettings.oauthMissing'
          if (isAgy) throw new Error('Antigravity finished without saving OAuth credentials for this account. Start a new sign-in and submit the code or final callback URL from that attempt.')
          throw new Error(`${provider.label} exited without storing OAuth credentials`)
        }
        job.account = auth?.account
        const all = readProfiles()
        const cur = all[provider.id] || { defaultProfileId: 'default', list: [] }
        if (job.pendingProfile) {
          const list = Array.isArray(cur.list) ? cur.list : []
          let number = list.length + 1
          while (list.some(item => item.name === `${provider.label} #${number}`)) number++
          const fallbackName = `${provider.label} #${number}`
          const name = !isAgy && job.account && job.account !== 'Google OAuth' ? job.account : fallbackName
          cur.list = [...list, { ...job.pendingProfile, name, ...(isAgy ? { autoNamed: true } : {}) }]
          all[provider.id] = cur
          writeProfiles(all)
          job.pendingProfile = undefined
        } else if (!isAgy && job.account && job.account !== 'Google OAuth') {
          const item = cur.list?.find(profile => profile.id === targetProfileId)
          if (item?.autoNamed) {
            item.name = job.account
            delete item.autoNamed
            writeProfiles(all)
          }
        }
        closeIdleAdapters(provider.id, targetProfileId)
        accountUsage = createAccountUsageCache()
        await inspectEngineAdmin(provider, { remote: false })
        if (finishDefaultAgyOAuth) {
          defaultAgyAuthPending = undefined
          defaultAgyAuth = auth
        }
        broadcastEngineAccountSnapshots(provider.id)
        if (loginInProgress(job)) retainFinishedLogin(job, 'done')
      } catch (error) {
        if (loginInProgress(job)) retainFinishedLogin(job, 'error', error.message)
      } finally {
        removePendingProfile(job)
      }
    })
    return loginDetails(job)
  }

  const engineAdmin = new Map()
  async function inspectEngineAdmin(provider, { remote = false } = {}) {
    if (!provider) return undefined
    const prev = engineAdmin.get(provider.id) || {}
    if (prev.pending) return prev.pending
    const job = (async () => {
      const next = { ...prev, updating: false, error: undefined }
      const { defaultProfileId, list, overrides } = engineProfiles(provider.id)
      const defaultEnv = resolveProfileEnv(provider.id, defaultProfileId)
      const unavailableAgy = provider.id === 'agy' && defaultProfileId !== 'default' &&
        !list.some(item => item.id === defaultProfileId && item.kind === 'isolated')
      try {
        const info = !remote && typeof provider.cliInfo === 'function'
          ? await provider.cliInfo({ signal: controller.signal, env: defaultEnv })
          : typeof provider.checkUpdate === 'function'
          ? await provider.checkUpdate({ signal: controller.signal, remote, env: defaultEnv })
          : typeof provider.cliInfo === 'function'
            ? await provider.cliInfo({ signal: controller.signal, env: defaultEnv })
            : undefined
        if (info?.version) { next.version = info.version; next.installed = true }
        if (info?.latestVersion) next.latestVersion = info.latestVersion
        next.updateAvailable = Boolean(next.version && next.latestVersion && compareSemver(next.version, next.latestVersion) < 0)
      } catch (error) {
        if (error.code === 'ENOENT') {
          next.installed = false
          delete next.version
          delete next.latestVersion
          delete next.authenticated
          delete next.account
          delete next.authIdentity
          next.updateAvailable = false
        }
      }
      if (next.installed !== false && typeof provider.authStatus === 'function') {
        try {
          const auth = unavailableAgy ? { authenticated: false } : await profileAuthStatus(provider, defaultProfileId, defaultEnv)
          next.authProfileId = defaultProfileId
          if (auth && auth.authenticated !== undefined) next.authenticated = auth.authenticated
          next.account = auth?.account
          next.authLabel = auth?.label
          next.authIdentity = auth?.identity && !sanitizeEnvMap(overrides[defaultProfileId]?.env) &&
            !excludesSubscriptionQuota(provider.id, provider.defaultModelProvider?.(defaultEnv), { ...process.env, ...defaultEnv })
            ? auth.identity : undefined
        } catch {}
      }
      if (provider.loginCommand) next.loginCommand = unavailableAgy ? undefined : profileLoginCommand(provider, defaultEnv)
      next.checkedAt = Date.now()
      delete next.pending
      engineAdmin.set(provider.id, next)
      return next
    })()
    engineAdmin.set(provider.id, { ...prev, pending: job })
    return job
  }
  async function updateEngineAdmin(provider) {
    if (!provider || typeof provider.updateCli !== 'function') throw reject(400, 'This engine does not support CLI updates')
    const prev = engineAdmin.get(provider.id) || {}
    if (prev.updating) throw reject(409, 'Engine update already in progress')
    engineAdmin.set(provider.id, { ...prev, updating: true, error: undefined })
    try {
      const res = await provider.updateCli({ signal: controller.signal })
      let busySessions = 0
      for (const s of sessions.values()) {
        if (s.record.engine !== provider.id || !s.adapter) continue
        if (s.busy || s.opening || hasPendingTools(s)) {
          busySessions++
        } else {
          const adapter = s.adapter
          s.adapter = null
          s.closing = Promise.resolve(adapter.close()).catch(() => {}).finally(() => { s.closing = null })
        }
      }
      const next = {
        ...prev,
        updating: false,
        version: res?.version || prev.version,
        latestVersion: res?.version || prev.latestVersion,
        updateAvailable: false,
        restartRequired: busySessions > 0 || Boolean(res?.restartSuggested),
        busySessions,
        lastOutput: res?.output,
        checkedAt: Date.now(),
      }
      engineAdmin.set(provider.id, next)
      return next
    } catch (err) {
      const next = { ...prev, updating: false, error: err?.message || 'Update failed' }
      engineAdmin.set(provider.id, next)
      throw err
    }
  }
  const startupCheckTimer = setTimeout(() => {
    void engines.ready.then(() => Promise.allSettled(
      engines.list().filter(p => p.cliInfo || p.checkUpdate || p.authStatus).map(p => inspectEngineAdmin(p, { remote: false }))
    ))
  }, 1500)
  startupCheckTimer.unref?.()
  const controller = new AbortController()
  function attach(record, draft = false) {
    record.profileId ??= sessionProfileId(record)
    record.capabilities = capabilityUpdates(record.capabilities)
    record.queue ??= []
    const session = { record, draft, clients: new Set(), permissions: new Map(), updates: [...record.capabilities], busy: false, queuePaused: Boolean(record.queue.length), lastText: null, adapter: null, opening: null, closing: null, idleTimer: null, saveTimer: null }
    for (const item of record.queue) {
      if (!item.attachments?.some(file => file.bytes === undefined)) continue
      try {
        const files = queuedFiles(session, item)
        item.attachments.forEach((file, index) => {
          if (file.bytes === undefined && typeof files[index]?.data === 'string') {
            file.bytes = Buffer.byteLength(files[index].data, 'base64')
          }
        })
      } catch { /* Missing payloads can still be removed from a restored queue. */ }
    }
    sessions.set(record.id, session)
    return session
  }
  for (const file of readdirSync(store).filter(file => file.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(store, file), 'utf8'))
    if (typeof record.engine === 'string' && file === record.id + '.json') {
      const stat=statSync(join(store,file))
      if (record.imported && record.updatedAt > record.sourceModified) record.hasWebTurns = true
      record.createdAt ||= stat.birthtimeMs || stat.mtimeMs
      record.updatedAt ||= stat.mtimeMs
      record.messages = compactMessages(record.messages)
      const unbound = record.profileId == null
      const session = attach(record)
      let changed = unbound
      if (activeTask(record.taskStatus)) {
        record.taskStatus = 'interrupted'
        changed = true
      }
      if (record.nativeAgents?.some(agent => activeTask(agent.status))) {
        record.nativeAgents = record.nativeAgents.map(agent => activeTask(agent.status) ? {...agent,status:'interrupted'} : agent)
        changed = true
      }
      if (Array.isArray(record.messages)) {
        const settleTool = tool => (tool && (tool.status === 'in_progress' || tool.status === 'pending')
          ? { ...tool, status: 'interrupted' }
          : tool)
        let toolsChanged = false
        const settledMessages = record.messages.map(msg => {
          if (!msg || typeof msg !== 'object') return msg
          const hasPendingTools = Array.isArray(msg.tools) && msg.tools.some(t => t && (t.status === 'in_progress' || t.status === 'pending'))
          const hasPendingSteps = Array.isArray(msg.steps) && msg.steps.some(st => st?.kind === 'tool' && st.tool && (st.tool.status === 'in_progress' || st.tool.status === 'pending'))
          if (!hasPendingTools && !hasPendingSteps) return msg
          toolsChanged = true
          return {
            ...msg,
            ...(hasPendingTools ? { tools: msg.tools.map(settleTool) } : {}),
            ...(hasPendingSteps ? { steps: msg.steps.map(st => st?.kind === 'tool' ? { ...st, tool: settleTool(st.tool) } : st) } : {}),
          }
        })
        if (toolsChanged) {
          record.messages = settledMessages
          changed = true
        }
      }
      if (changed) save(session)
    }
  }
  function save(s, record = s.record, force = false) {
    clearTimeout(s.saveTimer)
    s.saveTimer = null
    if (deleted.has(record.id) || (!force && !record.queue.length &&
        (s.importViewOnly || (s.draft && record.messages.length === 0)))) return
    const path = join(store, record.id + '.json')
    writeFileSync(path + '.tmp', JSON.stringify(record), { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }
  const isPendingToolStatus = status => status === 'in_progress' || status === 'pending'
  const hasPendingTools = s => Boolean(s.pendingTools?.size)
  function scheduleRelease(s) {
    clearTimeout(s.idleTimer)
    if (s.clients.size || s.busy || s.opening || s.cancelling || s.switchingAccount || hasPendingTools(s) || (!s.adapter && !s.importViewOnly)) return
    s.idleTimer = setTimeout(() => {
      const adapter = s.adapter
      s.adapter = null
      if (!s.terminals?.size && !s.record.queue.length && (s.importViewOnly || (s.draft && !s.record.messages.length))) sessions.delete(s.record.id)
      if (!adapter) return
      s.closing = Promise.resolve(adapter.close()).catch(() => {}).finally(() => { s.closing = null })
    }, 10 * 60_000).unref()
  }
  function broadcast(s, type, data) {
    const frame = 'data: ' + JSON.stringify({ type, data }) + '\n\n'
    for (const res of s.clients) res.write(frame)
  }
  function publishMessage(s, message, clearActivity = false) {
    broadcast(s, 'message', { index: s.record.messages.lastIndexOf(message), message, clearActivity })
  }
  function isExecutionProgress(previous, next) {
    return next.execution && previous && isPendingToolStatus(next.status) && next.status === previous.status &&
      next.title === previous.title && next.kind === previous.kind && isDeepStrictEqual(next.locations, previous.locations)
  }
  function queueExecutionPreview(s, id, preview) {
    if (!s.clients.size) return
    const previews = s.executionPreviews ??= new Map()
    previews.set(id, preview)
    s.executionPreviewTimer ??= setTimeout(() => {
      s.executionPreviewTimer = undefined
      const messages = new Set()
      for (const item of previews.values()) {
        if (item.message) messages.add(item.message)
        else if (s.updates.includes(item)) broadcast(s, 'update', item)
      }
      previews.clear()
      for (const message of messages) {
        if (s.record.messages.includes(message)) publishMessage(s, message)
      }
    }, 50).unref()
  }
  function setNativeTitle(s, value, notify = true) {
    const title = typeof value === 'string' ? value.replace(/\s+/g,' ').trim().slice(0,256) || undefined : undefined
    if (title === s.record.nativeTitle) return false
    s.record.nativeTitle=title
    if (notify && s.clients.size) broadcast(s,'snapshot',snapshot(s))
    return true
  }
  function nativeSyncBusy(s) {
    return s.busy || s.opening || s.forking || s.cancelling || s.switchingAccount ||
      s.permissions.size > 0 || hasPendingTools(s)
  }
  function releaseNativeAdapter(s) {
    const adapter = s.adapter
    if (!adapter) return
    s.adapter = null
    s.view = undefined
    s.closing = Promise.resolve().then(() => adapter.close()).catch(() => {}).finally(() => { s.closing = null })
  }
  async function nativeEntryFor(r, force = false) {
    if (!r.remoteId) return
    const provider = engines.get(r.engine)
    if (!provider) return
    if (['agy', 'codex', 'claude'].includes(r.engine)) {
      const id = r.engine === 'agy' ? agyHistoryProfileId(r) : sessionProfileId(r)
      const settings = engineProfiles(r.engine)
      const profile = sessionProfiles(provider, settings).find(item => item.id === id)
      if (!profile) return
      const env = profileSettings(profile, settings.overrides).env
      const home = env.HOME || env.USERPROFILE
      const privateHome = profile.kind === 'isolated' ? join(store, 'profiles', r.engine, id) : undefined
      let directory
      if (r.engine === 'agy' && (privateHome || home)) directory = agyDataDirectory(privateHome || home)
      if (r.engine === 'codex') directory = privateHome || env.CODEX_HOME || (home && join(home, '.codex'))
      if (r.engine === 'claude') directory = privateHome || env.CLAUDE_CONFIG_DIR || (home && join(home, '.claude'))
      if (directory || (force && provider.history)) return catalog.findInDirectory(r.engine, r.remoteId, directory)
    }
    return (await catalog.list()).get(nativeId(r.engine, r.remoteId))
  }
  function nativeRevision(entry) {
    let source = entry.file
    if (source && entry.engine === 'agy') {
      const logs = join(dirname(source), 'brain', entry.remoteId, '.system_generated', 'logs')
      source = ['transcript_full.jsonl', 'transcript.jsonl'].map(name => join(logs, name)).find(existsSync)
    }
    const stat = source && statSync(source, { throwIfNoEntry: false })
    return [entry.updatedAt, source, stat?.size, stat?.mtimeMs].join('|')
  }
  async function mergeNativeContinuation(s, entry, force) {
    const r = s.record
    if (!entry || !r.remoteId || !r.messages.length || nativeSyncBusy(s)) return false
    if (s.nativeSync) return s.nativeSync
    const revision = nativeRevision(entry)
    const web = r.messages
    const length = web.length
    const updatedAt = r.updatedAt
    const account = sessionProfileId(r)
    const check = s.nativeMergeCheck
    if (!force && check?.revision === revision && check.web === web && check.length === length && check.updatedAt === updatedAt) return false
    s.nativeSync = (async () => {
      const rows = await catalog.messages(entry).catch(() => undefined)
      requirePresent(r.id, r)
      if (!rows?.length) {
        s.nativeReadUnavailable = true
        return false
      }
      s.nativeReadUnavailable = false
      const native = compactMessages(rows)
      if (nativeSyncBusy(s) || r.messages !== web || web.length !== length || r.updatedAt !== updatedAt ||
          r.remoteId !== entry.remoteId || sessionProfileId(r) !== account) return false
      const start = r.nativeTailStart ?? length
      let result = compareNativeHistory(web.slice(0, start), native, {
        attachmentPath: attachment => {
          const file = attachmentFilename(attachment)
          return file && join(mediaRoot, r.id, file)
        },
      })
      if (r.nativeTailStart != null && result.status === 'synced') {
        result = compareNativeTail(web.slice(start), result.additions)
      }
      const wasConflict = s.nativeConflict
      s.nativeConflict = result.status === 'conflict'
      if (result.status === 'synced') {
        const next = { ...r, messages: [...web.slice(0, start), ...result.additions], nativeTailStart: start,
          updatedAt: Math.max(updatedAt || 0, entry.updatedAt || 0) }
        save(s, next, true)
        Object.assign(r, next)
        releaseNativeAdapter(s)
      }
      s.nativeMergeCheck = { revision, web: r.messages, length: r.messages.length, updatedAt: r.updatedAt }
      if (Boolean(wasConflict) !== s.nativeConflict || result.status === 'synced') broadcast(s, 'snapshot', snapshot(s))
      return result.status === 'synced'
    })().finally(() => { s.nativeSync = null })
    return s.nativeSync
  }
  async function syncImportedFromEntry(s, entry, force = false) {
    const r = s.record
    const isolatedAgy = r.engine === 'agy' && agyHistoryProfileId(r) !== 'default'
    if (['codex', 'agy'].includes(r.engine) && (!r.imported || r.hasWebTurns || isolatedAgy)) {
      return mergeNativeContinuation(s, entry, force)
    }
    if (entry && r.engine === 'claude' && (!r.imported || r.hasWebTurns)) {
      const readTerminal = engines.get('claude')?.history?.terminalMessages
      const previous = r.claudeTerminalTail
      const updatedAt = r.updatedAt
      const since = previous?.since ?? updatedAt
      const unavailable = () => r.remoteId !== entry.remoteId || s.busy || s.opening || s.forking ||
        s.cancelling || s.switchingAccount || hasPendingTools(s)
      if (!readTerminal || unavailable() || entry.updatedAt <= (previous?.modified ?? updatedAt)) return false
      if (s.nativeSync) return s.nativeSync
      s.nativeSync = (async () => {
        const messages = compactMessages(await readTerminal(entry, since))
        requirePresent(r.id, r)
        if (!messages.length || unavailable() || r.updatedAt !== updatedAt || r.claudeTerminalTail !== previous) return false
        const start = previous?.start ?? r.messages.length
        r.messages = [...r.messages.slice(0, start), ...messages]
        r.claudeTerminalTail = { since, start, modified: entry.updatedAt }
        r.updatedAt = entry.updatedAt
        // The next web prompt must resume the transcript with the terminal turns included.
        releaseNativeAdapter(s)
        save(s)
        return true
      })().finally(() => { s.nativeSync = null })
      return s.nativeSync
    }
    if (!entry || !r.imported || r.hasWebTurns || isolatedAgy ||
        s.busy || s.opening || s.forking || s.cancelling || s.switchingAccount || hasPendingTools(s)) {
      return false
    }
    if (!(entry.updatedAt > (r.sourceModified ?? r.updatedAt ?? 0))) return false
    if (s.nativeSync) return s.nativeSync
    s.nativeSync = (async () => {
      const version = transcriptVersion(entry.engine)
      const [messages, metrics] = await Promise.all([
        catalog.messages(entry).then(compactMessages),
        catalog.metrics(entry),
      ])
      requirePresent(r.id, r)
      if (r.remoteId !== entry.remoteId || r.hasWebTurns || s.busy || s.opening ||
          s.forking || s.cancelling || s.switchingAccount || hasPendingTools(s)) {
        return false
      }
      if (!messages.length && r.messages.length) return false
      r.updatedAt = entry.updatedAt
      r.sourceModified = entry.updatedAt
      r.resumable = entry.resumable
      r.transcriptVersion = version
      if (entry.nativeParent) r.parentId = localIdFor(entry.engine, entry.nativeParent) ?? r.parentId
      if (messages.length) {
        r.messages = messages
        delete r.historyNotice
      }
      if (metrics) {
        r.metrics = metrics
        s.metricsSourceModified = entry.updatedAt
      } else if (s.importViewOnly) {
        r.metrics = {}
      }
      if (!s.importViewOnly) save(s)
      if (['codex', 'agy'].includes(r.engine)) releaseNativeAdapter(s)
      return true
    })().finally(() => { s.nativeSync = null })
    return s.nativeSync
  }
  async function refreshNativeMetadata(s) {
    const {remoteId,parentId}=s.record
    if (!remoteId || parentId) return
    const entry=await nativeEntryFor(s.record)
    if (!entry || s.record.remoteId!==remoteId) return
    const wasArchived=isArchived(s.record)
    syncArchived(s.record,entry)
    const synced=await syncImportedFromEntry(s,entry)
    const titleChanged=entry.nativeTitle ? setNativeTitle(s,entry.nativeTitle,false) : false
    if(synced || wasArchived!==isArchived(s.record) || titleChanged) broadcast(s,'snapshot',snapshot(s))
  }
  function emit(s, type, data) {
    if (type === 'history' && s.record.imported && Array.isArray(data?.messages)) {
      if (data.messages.length && !s.record.messages.length) {
        s.record.messages=compactMessages(data.messages)
        delete s.record.historyNotice
        broadcast(s,'snapshot',snapshot(s))
      }
      return
    }
    if (type === 'usage') {
      if (s.startedAt == null) return
      s.turnHasUsage = true
      const metrics = s.record.metrics ??= {}
      for (const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','contextUsed','contextSize']) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0) metrics[key] = data[key]
      }
      if (data.sessionTokens) {
        const totals = Object.fromEntries(['input','output','cacheRead','reasoning','total']
          .filter(key => Number.isSafeInteger(data.sessionTokens[key]) && data.sessionTokens[key] >= 0)
          .map(key => [key, data.sessionTokens[key]]))
        if (Object.keys(totals).length) metrics.sessionTokens = totals
      }
      broadcast(s,'metrics',metrics)
      return
    }
    if (type === 'agent' && data?.id) {
      const agents = s.record.nativeAgents ??= []
      const id = 'native:' + data.id
      const existing = agents.find(agent => agent.id === id)
      if (existing) Object.assign(existing,data,{id})
      else agents.push({...data,id,kind:'native'})
      broadcast(s,'agents',agentList(s))
      return
    }
    const u = data?.update
    if (type === 'update' && u?.sessionUpdate === 'session_info_update' && Object.hasOwn(u,'title') && !s.record.parentId) {
      setNativeTitle(s,u.title)
    }
    if (type === 'update' && u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      if (!u.content.text) return
      const boundary = !s.lastText || s.afterActivity || (u.messageId && s.lastMessageId !== u.messageId)
      if (boundary) {
        if (s.lastText && !s.lastText.phase) {
          s.lastText.phase = 'commentary'
          publishMessage(s, s.lastText)
        }
        s.lastMessageId = u.messageId
        s.lastText = { role: 'assistant', text: '' }
        if (u.phase === 'commentary' || u.phase === 'final_answer') s.lastText.phase = u.phase
        collectActivity(s, s.lastText)
        s.record.messages.push(s.lastText)
      }
      s.lastText.text += u.content.text
      s.saveTimer ??= setTimeout(() => save(s), 750)
      if (boundary) {
        publishMessage(s, s.lastText, true)
        return
      }
    } else if (type === 'update' && u?.sessionUpdate === 'config_option_update') {
      s.record.options = u.configOptions
      broadcast(s, 'options', u.configOptions)
    } else if (type === 'update' && ['available_commands_update','usage_update'].includes(u?.sessionUpdate)) {
      s.record.capabilities = [...(s.record.capabilities || []).filter(item => item.update.sessionUpdate !== u.sessionUpdate),data]
      s.updates = s.updates.filter(item => item.update.sessionUpdate !== u.sessionUpdate)
      s.updates.push(data)
      if (u.sessionUpdate==='usage_update' && !s.busy && !s.importViewOnly && s.record.messages.length) {
        s.saveTimer ??= setTimeout(() => save(s), 750)
      }
    } else if (type === 'update' && u) {
      const isTool = u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update'
      if (isTool && u.toolCallId && u.status) {
        if (isPendingToolStatus(u.status)) (s.pendingTools ??= new Set()).add(u.toolCallId)
        else s.pendingTools?.delete(u.toolCallId)
        syncTurnWait(s)
      }
      const index = isTool && u.toolCallId
        ? s.updates.findIndex(({ update }) => update?.toolCallId === u.toolCallId) : -1
      const previous = index >= 0 ? s.updates[index].update : undefined
      const stored = isTool ? { update: compactTool({ ...previous, ...u }) } : data
      if (u.sessionUpdate === 'tool_call_update' && u.toolCallId && index < 0) {
        const target = s.record.messages.findLast(message => message.tools?.some(tool => tool?.toolCallId === u.toolCallId))
        if (target) {
          const previous = target.tools.find(tool => tool?.toolCallId === u.toolCallId)
          const tool = compactTool({ ...previous, ...u })
          if (isDeepStrictEqual(tool, previous)) return
          target.tools = target.tools.map(row => row === previous ? tool : row)
          if (Array.isArray(target.steps)) target.steps = target.steps.map(step =>
            step?.kind === 'tool' && step.tool?.toolCallId === u.toolCallId ? { kind: 'tool', tool } : step)
          s.saveTimer ??= setTimeout(() => save(s), 750)
          if (isExecutionProgress(previous, tool)) {
            queueExecutionPreview(s, u.toolCallId, { message: target })
          } else {
            s.executionPreviews?.delete(u.toolCallId)
            publishMessage(s, target)
          }
          if (!s.busy && !hasPendingTools(s)) {
            scheduleRelease(s)
            broadcastGlobalStatus()
          }
          return
        }
      }
      if (hasDisplayActivity(u) && s.lastText && !s.afterActivity) {
        s.afterActivity = true
        if (!s.lastText.phase) {
          s.lastText.phase = 'commentary'
          publishMessage(s, s.lastText)
        }
      }
      if (index < 0) s.updates.push(stored)
      else s.updates[index] = stored
      if (!s.busy && hasDisplayActivity(u)) {
        const activity = finishActivity(s)
        if (activity) {
          s.saveTimer ??= setTimeout(() => save(s), 750)
          publishMessage(s, activity, true)
        }
        if (!hasPendingTools(s)) {
          scheduleRelease(s)
          broadcastGlobalStatus()
        }
        return
      }
      if (isExecutionProgress(previous, stored.update)) {
        queueExecutionPreview(s, u.toolCallId, stored)
      } else {
        if (isTool) s.executionPreviews?.delete(u.toolCallId)
        broadcast(s, type, stored)
      }
      return
    } else if (type === 'permission') {
      s.permissions.set(data.toolCall.toolCallId, data)
      syncTurnWait(s)
      if (s.record.requestId) taskState(s,'waiting')
      broadcastGlobalStatus()
    }
    broadcast(s, type, data)
  }
  function localIdFor(engine, remoteId) {
    if (!remoteId) return undefined
    return [...sessions.values()].find(s=>s.record.engine===engine && s.record.remoteId===remoteId)?.record.id ?? nativeId(engine,remoteId)
  }
  function agentList(s) {
    const children = [...sessions.values()].filter(child => child.record.parentId === s.record.id && child.record.requestId)
    const indexed = new Map((s.indexedAgents || []).map(agent=>[agent.agentId || agent.remoteId,agent]))
    const agents = (s.record.nativeAgents || []).map(agent=>{
      const remoteId = agent.id.replace(/^native:/,'')
      const history = indexed.get(remoteId)
      if (!history) return agent
      indexed.delete(remoteId)
      return {...history,...agent,sessionId:history.sessionId,kind:'native'}
    })
    return [...agents,...indexed.values(),...children.map(({record:r}) => ({
      id:r.id, sessionId:r.id, kind:'parallel', name:r.title, status:r.taskStatus, detail:r.taskDetail,
    }))]
  }
  async function refreshIndexedAgents(s) {
    if (!s.record.remoteId || !catalog.children) return
    if (s.indexPending) return s.indexPending
    s.indexPending=(async()=>{
      const children=await catalog.children(s.record.engine,s.record.remoteId)
      const next=children.map(child=>({
        id:'native:'+(child.agentId || child.remoteId),agentId:child.agentId,remoteId:child.remoteId,sessionId:localIdFor(child.engine,child.remoteId) ?? child.id,
        kind:'native',name:child.title || child.remoteId,status:child.status || 'idle',
      }))
      if(JSON.stringify(next)!==JSON.stringify(s.indexedAgents||[])) {
        s.indexedAgents=next
        broadcast(s,'agents',agentList(s))
      }
    })().finally(()=>{s.indexPending=null})
    return s.indexPending
  }
  function taskState(s,status,detail) {
    s.record.taskStatus=status
    s.record.taskDetail=detail
    save(s)
    const parent=sessions.get(s.record.parentId)
    if(parent) broadcast(parent,'agents',agentList(parent))
  }
  function snapshot(s) {
    const {id, engine, cwd, messages, options} = s.record
    const title=displayTitle(s.record)
    const view=s.adapter ? undefined : s.view
    const updates=Array.isArray(view?.commands)
      ? [...s.updates.filter(item=>item.update?.sessionUpdate!=='available_commands_update'),{update:{sessionUpdate:'available_commands_update',availableCommands:view.commands}}]
      : s.updates
    const waitingForAgyCatalog = engine === 'agy' && !s.adapter && !isArchived(s.record) && s.record.resumable !== false
    const visibleOptions = waitingForAgyCatalog ? (options ?? []).filter(option => !['model','thought_level'].includes(option.category ?? option.id)) : view?.options ?? options
    return { id, engine, title, cwd, messages, nativeConflict:Boolean(s.nativeConflict), options:visibleOptions, account:sessionAccount(s), canFork:canFork(s.record) && !isArchived(s.record), historyNotice:s.record.historyNotice, createdAt:s.record.createdAt, updatedAt:s.record.updatedAt, archived:isArchived(s.record), metrics:s.record.metrics || {}, agents:agentList(s), parentId:s.record.parentId,
      capabilities:{...(view?.capabilities ?? s.record.capabilitiesMedia),readOnly:s.record.resumable===false || isArchived(s.record),parallel:s.record.resumable!==false && !s.record.parentId && messages.length>0,steer:typeof s.adapter?.steer === 'function'},
      busy: s.busy, runStartedAt: s.busy ? (s.turnStartedAt ?? undefined) : undefined, permissions: [...s.permissions.values()], updates, queue:s.record.queue, queuePaused:s.queuePaused }
  }
  function inspectForView(s, definition) {
    if (s.inspecting || s.switchingAccount || !s.record.remoteId) return
    const {remoteId,cwd,profileId}=s.record
    s.inspecting=Promise.resolve().then(()=>definition.inspect({remoteId,cwd,signal:controller.signal,
      savedOptions:s.record.options,...accountLaunch(s.record,definition)})).then(view=>{
      if (view && sessions.get(s.record.id)===s && s.record.profileId===profileId && !s.adapter && !s.busy && !s.switchingAccount && !s.opening && s.clients.size) {
        s.view=view
        broadcast(s,'snapshot',snapshot(s))
      }
    }).catch(()=>{
      // A transcript can still be read if the native metadata service is unavailable.
    }).finally(()=>{s.inspecting=null})
  }
  async function restoreOptions(adapter, options) {
    for (const {id,currentValue} of options ?? []) {
      const option = adapter.options.find(option => option.id === id)
      if (!option || typeof currentValue !== 'string' || option.currentValue === currentValue) continue
      if (option.type === 'select' && Array.isArray(option.options) && !option.options.some(choice =>
        Array.isArray(choice?.options) ? choice.options.some(entry => entry?.value === currentValue) : choice?.value === currentValue)) continue
      await adapter.configure(id,currentValue)
    }
  }
  async function startAdapter(record, definition, launch, emitUpdate, nextProfileId) {
    const retainedHistory=hasSessionHistory(record)
    const newAgy=nextProfileId && record.engine==='agy' && !retainedHistory
    const resumeId=!newAgy && (retainedHistory || definition.resumeEmpty || definition.replayHistory) ? record.remoteId : undefined
    if (retainedHistory && !resumeId) throw reject(409,'The native conversation cannot be resumed with this account')
    const profileId=nextProfileId ?? sessionProfileId(record)
    const separateHistory=resumeId && record.engine==='agy' && agyHistoryProfileId(record)!==profileId
    const savedOptions=record.options
    const adapter=await definition.start({
      forkRecipe:record.forkRecipe,replayHistory:Boolean(record.imported && definition.replayHistory && !record.messages.length),
      ...(nextProfileId ? {switchingAccount:true} : {}),
      ...(separateHistory ? {historyDirectory:agyHistoryDirectory(record,definition),
        runtimeDirectory:join(agyRuntimeRoot(record),'account-'+encodeURIComponent(profileId))} : {}),
      engine:record.engine,cwd:record.cwd,...launch,resumeId,signal:controller.signal,emit:emitUpdate,
    })
    try {
      if ((nextProfileId && !adapter.id) || (resumeId && adapter.id!==resumeId)) throw reject(409,'The selected account could not resume this conversation')
      if (record.remoteId || record.parentId || savedOptions?.length) await restoreOptions(adapter,savedOptions)
      return adapter
    } catch (error) {
      record.options=savedOptions
      await Promise.resolve().then(()=>adapter.close()).catch(()=>{})
      throw error
    }
  }
  function adapterFields(adapter, definition) {
    return {remoteId:adapter.id,options:adapter.options,modelProvider:adapter.modelProvider,
      capabilitiesMedia:adapter.capabilities || {},composerCapabilitiesVersion:definition.composerVersion}
  }
  async function switchAccount(s, profileId) {
    requireWritable(s)
    const r=s.record
    const account=sessionAccount(s)
    const key=changeKey(r)
    if (profileId===account.id) return
    if (!account.choices.some(choice=>choice.id===profileId)) throw reject(409,'This account cannot continue the conversation')
    if (!account.canSwitch) throw reject(409,'The session cannot change accounts right now')
    const definition=engines.get(r.engine)
    const launch=accountLaunch(r,definition,profileId,true)
    s.switchingAccount=profileId
    accountChanges.add(key)
    clearTimeout(s.idleTimer)
    let adapter, adopted=false
    try {
      if (r.engine==='agy') {
        if (agySigningOut.has(profileId) || activeLogin('agy')?.profileId===profileId) {
          throw reject(409,'Finish signing in or out before switching accounts')
        }
        if (profileId!=='default' && definition.authStatus) {
          const auth=await profileAuthStatus(definition,profileId,launch.env)
          if (!auth?.authenticated) throw reject(409,'Sign in to the selected Antigravity account before switching')
        }
      }
      if (s.closing) await s.closing
      if (s.adapter) {
        const previous=s.adapter
        s.adapter=null
        await previous.close()
      }
      const events=[]
      adapter=await startAdapter(r,definition,launch,(type,data)=>{
        if (!adopted) events.push([type,data])
        else if (s.adapter===adapter) emit(s,type,data)
      },profileId)
      requirePresent(r.id,r)
      controller.signal.throwIfAborted()
      if (!isDeepStrictEqual(launch,accountLaunch(r,definition,profileId,true))) {
        throw reject(409,'The selected account changed while opening the conversation')
      }
      const next={...r,...adapterFields(adapter,definition),profileId,capabilities:[],
        ...(r.engine==='agy' && hasSessionHistory(r) ? {agyHistoryProfileId:agyHistoryProfileId(r)} : {})}
      save(s,next,s.importViewOnly)
      Object.assign(r,next)
      s.importViewOnly=false
      s.adapter=adapter
      s.adapterLaunch=launch
      s.view=undefined
      s.updates=[]
      adopted=true
      for (const [type,data] of events) {
        if (data?.update?.sessionUpdate!=='config_option_update') emit(s,type,data)
      }
      events.length=0
    } finally {
      if (adapter && !adopted) await Promise.resolve().then(()=>adapter.close()).catch(()=>{})
      s.switchingAccount=null
      accountChanges.delete(key)
      scheduleRelease(s)
      broadcast(s,'snapshot',snapshot(s))
    }
  }
  async function open(s) {
    requireWritable(s)
    clearTimeout(s.idleTimer)
    if (s.closing) await s.closing
    requireWritable(s)
    if (s.adapter) return s.adapter
    if (!s.opening) {
      s.opening = (async () => {
        const r = s.record
        const definition = engines.get(r.engine)
        if (!definition) throw reject(404,'Engine not configured')
        const launch=accountLaunch(r,definition)
        let adapter, starting=true
        try {
          adapter=await startAdapter(r,definition,launch,(type,data)=>{
            if (starting || s.adapter===adapter) emit(s,type,data)
          })
        } finally { starting=false }
        Object.assign(r,adapterFields(adapter,definition))
        s.adapter = adapter
        s.adapterLaunch=launch
        s.view = undefined
        save(s)
        return adapter
      })().finally(() => { s.opening = null })
    }
    return s.opening
  }
  function prepareTurn(record,text,files) {
    const created = []
    const references = []
    const discard = () => {
      for (const path of created) rmSync(path,{force:true})
    }
    try {
      let directory
      const attachments = files.map(({name,type,mimeType,data}) => {
        const metadata = {name,type,mimeType}
        if (type === 'audio') return metadata
        const bytes = Buffer.from(data,'base64')
        if (type === 'image' && !imageType(bytes)) return metadata
        directory ??= mediaDirectory(record.id,true)
        metadata.previewId = randomUUID()
        const path = join(directory,attachmentFilename(metadata))
        const fd = openSync(path,'wx',0o600)
        created.push(path)
        try { writeFileSync(fd,bytes) } finally { closeSync(fd) }
        if (type === 'file') references.push({name,mimeType,path})
        return metadata
      })
      const prompt = formatFilePrompt(text, references)
      return { prompt, media:files.filter(file => file.type !== 'file'), discard,
        message:{role:'user',text,...(attachments.length ? {attachments} : {})} }
    } catch (error) {
      discard()
      throw error
    }
  }
  function saveUserMessage(s,message,item,steering = false,position = s.record.messages.length) {
    const record = s.record
    const next = {
      ...record,
      messages: [...record.messages.slice(0,position),item ? {...message,queueItemId:item.id} : message,...record.messages.slice(position)],
      title: record.messages.length ? record.title : (message.text.trim() || message.attachments?.[0]?.name || record.engine).slice(0,80),
      updatedAt: Date.now(),
      metrics: record.metrics || {},
      ...(item ? {queue:record.queue.filter(row=>row!==item)} : {}),
      ...(record.imported ? {hasWebTurns:true} : {}),
      ...(record.claudeTerminalTail ? {claudeTerminalTail:undefined} : {}),
      ...(record.nativeTailStart != null ? {nativeTailStart:undefined} : {}),
    }
    // Acknowledged steering already entered the engine, even if local persistence fails.
    if (steering) {
      Object.assign(record,next)
      s.importViewOnly = false
    }
    save(s,next,true)
    Object.assign(record,next)
    s.importViewOnly = false
    if (item) discardQueueFiles(s,item)
    if (!record.queue.length) s.queuePaused = false
  }
  function collectActivity(s, message) {
    const activity = foldTurnActivity(s.updates)
    if (activity.thought) message.thought = activity.thought
    if (activity.plan.length) message.plan = activity.plan
    if (activity.tools.length) message.tools = activity.tools
    if (activity.steps.length) message.steps = activity.steps
    s.updates = capabilityUpdates(s.updates)
    s.afterActivity = false
    return Boolean(message.thought || message.plan || message.tools)
  }
  function finishActivity(s) {
    const message = { role: 'assistant', text: '' }
    if (!collectActivity(s, message)) return
    s.record.messages.push(message)
    return message
  }
  function syncTurnWait(s) {
    if (s.startedAt == null) return
    const waiting = s.permissions.size > 0 || (s.pendingTools?.size ?? 0) > 0
    if (waiting && s.waitStartedAt == null) {
      s.waitStartedAt = performance.now()
    } else if (!waiting && s.waitStartedAt != null) {
      s.waitMs = (s.waitMs || 0) + (performance.now() - s.waitStartedAt)
      s.waitStartedAt = null
    }
  }
  function runTurn(s,a,text,files,item) {
    const prepared = prepareTurn(s.record,text,files)
    try { saveUserMessage(s,prepared.message,item) }
    catch (error) { prepared.discard(); throw error }
    const turn = s.turn = { settling:false }
    s.lastText = null
    s.afterActivity = false
    s.startedAt = performance.now()
    s.turnStartedAt = s.turnStartedAt ?? Date.now()
    s.waitStartedAt = null
    s.waitMs = 0
    s.turnHasUsage = false
    s.unreadDone = false
    if (s.record.requestId) taskState(s,'running')
    s.updates = [...(s.record.capabilities || [])]
    broadcast(s,'snapshot',snapshot(s))
    broadcastGlobalStatus()
    const finish = async (type, result) => {
      turn.settling = true
      if (s.steering) await s.steering.promise.catch(()=>{})
      s.pendingTools?.clear()
      s.permissions.clear()
      syncTurnWait(s)
      const turnMs = performance.now() - s.startedAt
      const genMs = Math.max(1, turnMs - (s.waitMs || 0))
      s.record.metrics.turnMs = turnMs
      if (s.turnHasUsage && s.record.metrics.outputTokens !== undefined) {
        s.record.metrics.tps = Math.round(s.record.metrics.outputTokens / (genMs / 1000) * 10) / 10
      }
      broadcast(s,'metrics',s.record.metrics)
      s.startedAt = null
      s.turnStartedAt = null
      s.record.updatedAt = Date.now()
      if (s.record.requestId) taskState(s,type==='error'?'failed':result?.stopReason==='cancelled'?'cancelled':'completed',
        type==='error'?result.message:s.lastText?.text.slice(0,400))
      s.busy = false
      s.turn = null
      s.permissions.clear()
      finishActivity(s)
      if (!s.clients.size && !isChildSession(s.record)) s.unreadDone = true
      s.record.remoteId = a.id
      s.record.options = a.options
      save(s)
      if (type === 'error') {
        s.queuePaused = Boolean(s.record.queue.length)
        s.adapter = null
        s.closing = Promise.resolve(a.close()).catch(() => {}).finally(() => { s.closing = null })
      }
      broadcast(s,'snapshot',snapshot(s))
      broadcast(s,type,result)
      broadcastGlobalStatus()
      scheduleRelease(s)
      drainQueue(s)
    }
    Promise.resolve().then(() => a.prompt(prepared.prompt,prepared.media))
      .then(result => finish('done',result || {}), err => finish('error',{message:err.message}))
      .catch(error=>queueFailure(s,error))
  }
  function requireWritable(s) {
    requirePresent(s.record.id,s.record)
    if (accountChanges.has(changeKey(s.record))) throw reject(409,'Session account change in progress')
    if (s.record.engine === 'agy' && agySigningOut.has(sessionProfileId(s.record))) {
      throw reject(409, 'This account is signing out')
    }
    if (isArchived(s.record) || archiveChanges.has(changeKey(s.record))) {
      throw reject(409,'Restore the session or finish the archive operation before continuing')
    }
    if (s.record.resumable===false) throw reject(409,'Read-only subagent transcript')
    if (controller.signal.aborted) throw reject(503,'Direct Chat is shutting down')
  }
  function queueFile(s,item,create = false) {
    const directory = mediaDirectory(s.record.id,create)
    if (!directory || !nativeUuid.test(item.id)) throw reject(409,'Queued attachments are unavailable')
    return join(directory,'queued-'+item.id+'.json')
  }
  function discardQueueFiles(s,item) {
    if (!item.attachments?.length) return
    try { rmSync(queueFile(s,item),{force:true}) } catch {}
  }
  function queuedFiles(s,item) {
    if (!item.attachments?.length) return []
    const fd = openSync(queueFile(s,item),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > bodyLimit) throw reject(409,'Queued attachments are unavailable')
      const files = JSON.parse(readFileSync(fd,'utf8'))
      if (!Array.isArray(files)) throw reject(409,'Queued attachments are unavailable')
      return files
    } finally { closeSync(fd) }
  }
  function sendQueuedImage(res,s,itemId,indexParam) {
    const index = Number(indexParam)
    const item = s?.record.queue.find(row=>row.id===itemId)
    const attachment = Number.isSafeInteger(index) && index >= 0 && String(index) === indexParam
      ? item?.attachments?.[index] : undefined
    if (attachment?.type !== 'image') throw reject(404,'Queued image not found')
    let file
    try { file = queuedFiles(s,item)[index] }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw reject(404,'Queued image not found')
    }
    if (file?.type !== attachment.type || file.mimeType !== attachment.mimeType || typeof file.data !== 'string') {
      throw reject(404,'Queued image not found')
    }
    const bytes = Buffer.from(file.data,'base64')
    if (bytes.length > attachmentLimit) throw reject(413,'Attachments exceed 8 MiB')
    const mimeType = imageType(bytes)
    if (!mimeType || mimeType !== attachment.mimeType) throw reject(415,'Unsupported queued image format')
    res.writeHead(200,{
      'Content-Type':mimeType, 'Content-Length':bytes.length,
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    })
    res.end(bytes)
  }
  function replaceQueue(s,queue) {
    save(s,{...s.record,queue},true)
    s.record.queue = queue
    if (!queue.length) s.queuePaused = false
  }
  function queueFailure(s,error) {
    if (s.turn?.settling) {
      s.busy = false
      s.turn = null
    }
    s.queuePaused = Boolean(s.record.queue.length)
    broadcast(s,'snapshot',snapshot(s))
    broadcast(s,'error',{message:error.message})
    scheduleRelease(s)
  }
  async function enqueue(s,text,files,clientRequestId) {
    await engines.get(s.record.engine)?.resolvePrompt?.({text,attachmentCount:files.length})
    requireWritable(s)
    if (s.forking) throw reject(409,'Session is busy')
    const item = {id:randomUUID(),text,...(clientRequestId ? {clientRequestId} : {}),...(files.length ? {
      attachments:files.map(({name,type,mimeType,data})=>({name,type,mimeType,bytes:Buffer.byteLength(data,'base64')})),
    } : {})}
    let payload
    try {
      if (files.length) {
        const fd = openSync(queueFile(s,item,true),'wx',0o600)
        payload = true
        try { writeFileSync(fd,JSON.stringify(files)) } finally { closeSync(fd) }
      }
      replaceQueue(s,[...s.record.queue,item])
    } catch (error) {
      if (payload) discardQueueFiles(s,item)
      throw error
    }
    drainQueue(s)
    broadcast(s,'snapshot',snapshot(s))
  }
  function pendingQueueItem(s,id) {
    const item = s.record.queue.find(row=>row.id===id)
    if (!item) {
      const enteredChat = typeof id === 'string' && s.record.messages.some(message=>message.queueItemId===id)
      throw Object.assign(reject(404,'Queued message is no longer pending'),{code:enteredChat ? 'queue_entered_chat' : 'queue_no_longer_pending'})
    }
    if (s.starting?.item===item || s.steering?.items.has(item)) throw Object.assign(reject(409,'Queued message is being sent'),{code:'queue_sending'})
    return item
  }
  async function editQueueItem(s,item,text) {
    if (item.attachments?.length) throw reject(409,'Only queued messages without attachments can be edited')
    await engines.get(s.record.engine)?.resolvePrompt?.({text,attachmentCount:0,adapter:s.adapter})
    requireWritable(s)
    if (pendingQueueItem(s,item.id)!==item) throw reject(409,'Queued message changed while it was being edited')
    replaceQueue(s,s.record.queue.map(row=>row===item ? {...item,text} : row))
    broadcast(s,'snapshot',snapshot(s))
  }
  async function startPrompt(s,text,files,item) {
    const starting = {item,cancelled:false}
    s.starting = starting
    s.busy = true
    s.turnStartedAt = Date.now()
    try {
      const provider = engines.get(s.record.engine)
      if (!item) await provider?.resolvePrompt?.({text,attachmentCount:files.length})
      const a = await open(s)
      if (item) files = attachmentsFor(queuedFiles(s,item),a.capabilities)
      await provider?.resolvePrompt?.({text,attachmentCount:files.length,adapter:a})
      requireWritable(s)
      if (starting.cancelled) throw reject(409,'Turn was stopped before it started')
      runTurn(s,a,text,files,item)
    } catch (error) {
      s.busy = false
      s.turnStartedAt = null
      scheduleRelease(s)
      throw error
    } finally {
      s.starting = null
    }
  }
  function drainQueue(s) {
    const [item] = s.record.queue
    if (!item || s.queuePaused || s.busy || s.forking || s.cancelling || controller.signal.aborted ||
        isArchived(s.record) || archiveChanges.has(changeKey(s.record))) return
    void startPrompt(s,item.text,[],item).catch(error=>queueFailure(s,error))
  }
  function steer(s,entries,pauseOnFailure = false) {
    const a = s.adapter
    const turn = s.turn
    if (!turn || turn.settling || s.cancelling || typeof a?.steer !== 'function') {
      throw reject(409,'Current turn does not accept steering')
    }
    if (s.steering) throw reject(409,'Steering is in progress')
    const pending = {items:new Set(entries.map(entry=>entry.item).filter(Boolean))}
    s.steering = pending
    pending.promise = Promise.resolve().then(async()=>{
      for (const {text,files,item} of entries) {
        const attachments = item ? attachmentsFor(queuedFiles(s,item),a.capabilities) : files
        const command = await engines.get(s.record.engine)?.resolvePrompt?.({text,attachmentCount:attachments.length,adapter:a})
        requireWritable(s)
        if (s.turn!==turn || turn.settling || pending.cancelled || command) {
          throw reject(409,'Current turn does not accept steering')
        }
        const prepared = prepareTurn(s.record,text,attachments)
        const boundary = () => {
          finishActivity(s)
          s.lastText = null
          s.afterActivity = false
          return s.record.messages.length
        }
        // Without a native echo, keep the dispatch position until ACP acknowledges.
        const dispatch = s.record.engine === 'agy' ? boundary() : undefined
        let recorded = false
        const commit = position => {
          if (recorded) return
          recorded = true
          saveUserMessage(s,prepared.message,item,true,position)
          broadcast(s,'snapshot',snapshot(s))
        }
        try {
          await a.steer(prepared.prompt,prepared.media,() => commit(boundary()))
        } catch (error) {
          if (recorded) continue
          prepared.discard()
          if (item && !error.status) s.queuePaused = true
          throw error
        }
        if (!recorded) commit(dispatch ?? boundary())
      }
    }).catch(error=>{
      if (pauseOnFailure && s.record.queue.some(item=>pending.items.has(item))) s.queuePaused = true
      throw error
    }).finally(()=>{
      s.steering = null
      broadcast(s,'snapshot',snapshot(s))
    })
    return pending.promise
  }
  async function cancelTurn(s) {
    if (s.starting) {
      s.starting.cancelled = true
    } else if (s.record.requestId && s.busy && !s.adapter && s.opening) {
      taskState(s,'cancelled')
    } else if (s.cancelling) {
      await s.cancelling
    } else if (s.turn && !s.turn.settling) {
      if (s.steering) s.steering.cancelled = true
      s.cancelling = Promise.resolve().then(()=>s.adapter?.cancel())
      try { await s.cancelling }
      finally {
        s.cancelling = null
        scheduleRelease(s)
        drainQueue(s)
      }
    }
  }
  async function listRows() {
    const native = await catalog.list()
    const cached = []
    const activeKeys = new Set()
    for (const s of sessions.values()) {
      const r=s.record
      cached.push(r)
      if (!activeSession(s)) continue
      activeKeys.add(changeKey(r))
      if (r.parentId) {
        activeKeys.add(r.parentId)
        const parent=sessions.get(r.parentId)?.record
        if (parent) activeKeys.add(changeKey(parent))
      }
    }
    const knownIds = new Set(cached.map(r=>r.engine+'/'+r.remoteId))
    const entries = [...cached.filter(r=>r.messages.length || r.queue.length || r.imported || r.forkedFrom || r.parentId),
      ...[...native.values()].filter(r=>!knownIds.has(r.engine+'/'+r.remoteId))]
    const rows=[]
    for(const r of entries) {
      const key=changeKey(r)
      if(!engines.has(r.engine) || deleted.has(r.id) || deleted.has(key)) continue
      const indexed = native.get(r.id) || (r.remoteId && native.get(nativeId(r.engine,r.remoteId)))
      // A running adapter and its terminal transcript can have different local IDs.
      if(isChild(r,indexed)) continue
      const provider=await deleteProvider(r,indexed)
      if(deleted.has(r.id) || deleted.has(key)) continue
      const canDelete=Boolean(provider && !deleting.has(key) && !archiveChanges.has(key) &&
        !activeKeys.has(r.id) && !activeKeys.has(key))
      const renaming=renameMode(r,indexed)
      rows.push({id:r.id,engine:r.engine,title:displayTitle(r,indexed),pinned:Boolean(preferences.get(r.id)?.pinnedAt),pinnedAt:preferences.get(r.id)?.pinnedAt,canFork:canFork(r) && !sessions.get(r.id)?.busy,cwd:r.cwd,origin:r.id.startsWith('local-')?'terminal':'web',
        ...(agyForkUnavailable(r) ? {forkUnavailableReason:'agy-acp'} : {}),
        isChild:false, readOnly:r.resumable===false || indexed?.resumable===false,
        actions:{delete:canDelete,rename:renaming!=='unsupported'}, renameMode:renaming,
        archiveMode:archiveMode(r,indexed), canNativeArchive:supportsNativeArchive(r), archived:isArchived(r,indexed), createdAt:r.createdAt ?? indexed?.createdAt,
        updatedAt:Math.max(r.updatedAt || 0,indexed?.updatedAt || 0) || r.createdAt || 0})
    }
    return rows.sort((a,b)=>b.updatedAt-a.updatedAt)
  }
  async function loadMissingMetrics(session, entry) {
    if (!entry || session.busy ||
        session.metricsSourceModified === entry.updatedAt) return
    session.metricsSourceModified=entry.updatedAt
    const version=session.record.updatedAt
    const metrics=await catalog.metrics(entry)
    if (metrics && !session.busy && version===session.record.updatedAt) {
      // Older saved snapshots predate context reporting. Preserve the live counters.
      const current=session.record.metrics || {}
      if (!Object.keys(current).length) { session.record.metrics=metrics; return }
      if (metrics.sessionTokens && !current.sessionTokens) current.sessionTokens = metrics.sessionTokens
      if (['inputTokens','outputTokens'].every(key =>
        current[key]===undefined || metrics[key]===undefined || current[key]===metrics[key])) {
        if (current.contextUsed===undefined && metrics.contextUsed!==undefined) {
          current.contextUsed=metrics.contextUsed
          if (metrics.contextEstimated) current.contextEstimated=true
        }
        for (const key of ['contextSize','reasoningTokens']) {
          if (current[key]===undefined && metrics[key]!==undefined) current[key]=metrics[key]
        }
      }
    }
  }
  async function repairHistory(session, entry) {
    const record = session.record
    if (session.busy || session.opening || !['agy', 'claude', 'codex'].includes(record.engine)) return
    const version = transcriptVersion(record.engine)
    if ((record.transcriptVersion ?? 0) >= version) return
    if (record.engine !== 'agy' && !record.messages.some(message => message.tools?.length ||
        message.steps?.some(step => step?.kind === 'tool'))) return
    const historyProfile = record.engine === 'agy' ? agyHistoryProfileId(record) : undefined
    if (!entry && historyProfile && historyProfile !== 'default' && nativeUuid.test(record.remoteId)) {
      try {
        const directory = agyHistoryDirectory(record, engines.get('agy'))
        entry = { engine: 'agy', remoteId: record.remoteId, file: join(directory, 'conversation_summaries.db') }
      } catch { return }
    }
    if (!entry) return
    session.historyRepair ??= (async () => {
      const native = await catalog.messages(entry).catch(() => [])
      requirePresent(record.id, record)
      if (!native.length || session.busy || session.opening || session.record !== record ||
          record.remoteId !== entry.remoteId || (historyProfile && historyProfile !== agyHistoryProfileId(record))) return
      if (entry.engine === 'codex' && record.imported && record.hasWebTurns && (record.transcriptVersion ?? 0) < 8) {
        restoreImportedCodexToolOrder(record.messages, native)
      }
      if (record.engine === 'agy') restoreAgySteeringOrder(record.messages, compactMessages(native))
      restoreCommandExecutions(record.messages, native, record.engine)
      record.transcriptVersion = version
      save(session)
    })().finally(() => { session.historyRepair = undefined })
    await session.historyRepair
  }
  async function lookup(id, refreshBeforePrompt = false) {
    const existing=sessions.get(id)
    if (existing?.switchingAccount) return existing
    const force = Boolean(refreshBeforePrompt && existing?.record.messages.length &&
      ['codex', 'agy'].includes(existing.record.engine) && !nativeSyncBusy(existing))
    const isolatedAgyHistory = existing?.record.engine === 'agy' && agyHistoryProfileId(existing.record) !== 'default'
    if (!id?.startsWith('local-') || existing?.busy || existing?.adapter || existing?.opening || isolatedAgyHistory) {
      if (existing?.record.remoteId) {
        const r=existing.record
        const entry=await nativeEntryFor(r, force)
        if (!(await syncImportedFromEntry(existing,entry,force))) {
          await repairHistory(existing,entry)
        }
        if (!r.parentId) {
          await loadMissingMetrics(existing,entry)
          requirePresent(id,r)
          syncArchived(r,entry)
          if(entry?.nativeParent) r.parentId=localIdFor(r.engine,entry.nativeParent)
          else if(entry?.nativeTitle) setNativeTitle(existing,entry.nativeTitle)
        }
      }
      return existing
    }
    const entry=existing ? await nativeEntryFor(existing.record, force) : (await catalog.list()).get(id) ?? (await catalog.list(true)).get(id)
    requirePresent(id,entry ?? existing?.record)
    if (!entry) return existing
    const version = transcriptVersion(entry.engine)
    if(existing && (existing.record.hasWebTurns ||
      (existing.record.sourceModified >= entry.updatedAt && existing.record.transcriptVersion === version))) {
      if (!(await syncImportedFromEntry(existing,entry,force))) await repairHistory(existing,entry)
      await loadMissingMetrics(existing,entry)
      requirePresent(id,entry)
      existing.record.parentId=localIdFor(entry.engine,entry.nativeParent) ?? existing.record.parentId
      syncArchived(existing.record,entry)
      existing.record.resumable=entry.resumable
      if(!existing.record.parentId) setNativeTitle(existing,entry.nativeTitle)
      return existing
    }
    const messages=compactMessages(await catalog.messages(entry))
    const metrics=await catalog.metrics(entry)
    requirePresent(id,entry)
    const record={
      ...(metrics ? {metrics} : {}),
      id, remoteId:entry.remoteId, engine:entry.engine, cwd:entry.cwd, title:entry.title, nativeTitle:entry.nativeTitle,
      createdAt:entry.createdAt, archived:entry.archived, resumable:entry.resumable, updatedAt:entry.updatedAt, sourceModified:entry.updatedAt, imported:true,
      transcriptVersion:version,
      ...(entry.modelProvider ? {modelProvider:entry.modelProvider} : {}),
      parentId:localIdFor(entry.engine,entry.nativeParent),
      historyNotice:messages.length ? undefined : '本机索引没有可显示的历史消息。',
    }
    const session=sessions.get(id)
    if(session) {
      if (!session.busy && !session.adapter && !session.opening) {
        if (!messages.length && session.record.messages.length) return session
        if (!metrics && session.importViewOnly && entry.updatedAt > session.record.sourceModified) session.record.metrics={}
        const upgraded = session.record.transcriptVersion !== version
        Object.assign(session.record,record)
        if (messages.length) {
          session.record.messages=messages
          if (upgraded) save(session)
        }
      }
      return session
    }
    const imported=attach({...record,messages,options:[]})
    imported.metricsSourceModified=entry.updatedAt
    imported.importViewOnly=true
    return imported
  }
  async function forkSession(source) {
    requireWritable(source)
    const record = source.record
    const agyForkHelp='Antigravity ACP has not reported fork support. Open the conversation in the Antigravity terminal and run /fork.'
    if (!canFork(record)) throw reject(409,agyForkUnavailable(record) ? agyForkHelp
      : 'This engine cannot fork this session')
    if (activeSession(source)) throw reject(409,'Session is busy')
    source.forking=true
    const id=randomUUID()
    const now=Date.now()
    let media
    let fork
    let adapter
    try {
      const originalMedia=mediaDirectory(record.id)
      if (originalMedia) {
        const filenames=new Set(record.messages.flatMap(message=>message.attachments || []).map(attachmentFilename).filter(Boolean))
        for (const filename of filenames) {
          const original=join(originalMedia,filename)
          const stat=lstatSync(original,{throwIfNoEntry:false})
          if (!stat) continue
          if (!stat.isFile()) throw reject(403,'Attachment storage is not accessible')
          if (!media) {
            const target=join(mediaRoot,id)
            mkdirSync(target,{mode:0o700})
            media=target
          }
          copyFileSync(original,join(media,filename),constants.COPYFILE_EXCL)
        }
      }
      const definition=engines.get(record.engine)
      const events=[]
      const launch=accountLaunch(record,definition)
      const profileId=sessionProfileId(record)
      const historyProfile=record.engine==='agy' ? agyHistoryProfileId(record) : undefined
      const separateHistory=historyProfile && historyProfile!==profileId
      adapter=await definition.fork({
        sourceId:record.remoteId,sourceRecipe:record.forkRecipe,cwd:record.cwd,signal:controller.signal,...launch,
        ...(separateHistory ? {historyDirectory:agyHistoryDirectory(record,definition),
          runtimeDirectory:join(agyRuntimeRoot(record),'account-'+encodeURIComponent(profileId))} : {}),
        emit:(type,data)=>{
          if (!fork) events.push([type,data])
          else if (fork.adapter===adapter) emit(fork,type,data)
        },
      })
      if (!adapter?.id || adapter.id===record.remoteId) throw reject(502,'Engine did not return an independent session')
      await restoreOptions(adapter,record.options || [])
      fork=attach({id,remoteId:adapter.id,engine:record.engine,profileId:record.profileId,modelProvider:adapter.modelProvider,cwd:record.cwd,
        ...(separateHistory ? {agyHistoryProfileId:historyProfile} : {}),
        forkedFrom:record.id,forkRecipe:adapter.forkRecipe,title:forkTitle(record),messages:structuredClone(record.messages),
        options:adapter.options ?? [],capabilitiesMedia:adapter.capabilities ?? {},createdAt:now,updatedAt:now})
      fork.adapter=adapter
      fork.adapterLaunch=launch
      for(const [type,data] of events) emit(fork,type,data)
      save(fork)
      scheduleRelease(fork)
      return id
    } catch(error) {
      sessions.delete(id)
      if (media) rmSync(media,{recursive:true,force:true})
      if(adapter) await Promise.resolve(adapter.close()).catch(()=>{})
      if (record.engine==='agy' && error.code==='AGY_FORK_UNAVAILABLE') {
        record.capabilitiesMedia={...record.capabilitiesMedia,fork:false}
        source.forking=false
        save(source)
        broadcast(source,'snapshot',snapshot(source))
        throw reject(409,agyForkHelp)
      }
      throw error
    } finally { source.forking=false }
  }
  function parallel(s,data) {
    if(s.record.parentId || !s.record.messages.length) throw reject(400,'Open a primary conversation first')
    if (!Array.isArray(data.tasks) || data.tasks.length<1 || data.tasks.length>4) throw reject(400,'Provide one to four tasks')
    const tasks=data.tasks.map(value=>textField(value,'task').trim())
    if(tasks.some(task=>task.length>16000)) throw reject(400,'Task exceeds 16000 characters')
    const siblings=[...sessions.values()].filter(child=>child.record.parentId===s.record.id)
    const requestId = data.requestId === undefined ? randomUUID() : textField(data.requestId,'requestId')
    if (requestId.length>128) throw reject(400,'Invalid request ID')
    if(siblings.some(child=>child.record.requestId===requestId)) return
    if (siblings.filter(child=>activeTask(child.record.taskStatus)).length+tasks.length>4) throw reject(409,'Up to four tasks may run concurrently')
    const children=tasks.map(task=>{
      const child=attach({id:randomUUID(),engine:s.record.engine,profileId:s.record.profileId,cwd:s.record.cwd,title:task.slice(0,80),messages:[],options:structuredClone(s.record.options),parentId:s.record.id,requestId,taskStatus:'queued',createdAt:Date.now(),updatedAt:Date.now()})
      child.busy=true
      save(child)
      return child
    })
    broadcast(s,'agents',agentList(s))
    children.forEach((child,index)=>{
      open(child).then(adapter=>{
        if (child.record.taskStatus==='cancelled') {
          child.busy=false
          broadcast(child,'snapshot',snapshot(child))
          scheduleRelease(child)
        } else runTurn(child,adapter,tasks[index],[])
      }).catch(error=>{
        child.busy=false
        taskState(child,'failed',error.message)
        broadcast(child,'error',{message:error.message})
      })
    })
  }
  async function handle(req, res) {
    const admission = ctx.connection.admit(req)
    const denial = admission.rejection ?? (admission.peer?.principal.kind === 'owner' ? undefined : 403)
    if (denial !== undefined) { res.writeHead(denial); res.end(); return }
    await engines.ready
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path === '/api/direct-chat/engines' && req.method === 'GET') {
      await Promise.all(engines.list()
        .filter(provider => provider.cliInfo && !engineAdmin.get(provider.id)?.checkedAt)
        .map(provider => inspectEngineAdmin(provider)))
      const agy = engines.get('agy')
      if (agy?.authStatus && agy.readOAuthAccount) await profileAuthStatus(agy, 'default').catch(() => {})
      return json(res, 200, {
        engines: engines.list().map(provider => {
          const { id, label, meta, capabilities, updateCli, checkUpdate, cliInfo, logoutCli, loginSpec, loginCommand }=provider
          const admin = engineAdmin.get(id)
          const profiles=engineProfiles(id)
          const { pending: _pending, authProfileId, authenticated, account, authLabel, authIdentity: _authIdentity, loginCommand: activeLoginCommand, ...status } = admin || {}
          if (authProfileId === profiles.defaultProfileId) {
            Object.assign(status, { authenticated, account, authLabel, loginCommand: activeLoginCommand })
          }
          return {
            id, label,
            ...(meta ? { meta } : {}),
            ...(capabilities ? { capabilities } : {}),
            canCheckUpdate: Boolean(checkUpdate || cliInfo),
            canUpdate: Boolean(updateCli),
            canLogout: Boolean(logoutCli),
            canLogin: Boolean(loginSpec),
            canMultiOAuth: Boolean(loginSpec?.multiOAuth),
            ...(loginCommand ? { loginCommand } : {}),
            defaultProfileId:profiles.defaultProfileId,
            profiles:sessionProfiles(provider,profiles).map(item=>{
              const account=sessionProfileIdentity(provider,item)
              return {id:item.id,name:sessionProfileName(provider,item,account),kind:item.kind,...(account ? {account} : {})}
            }),
            ...(admin ? { status } : {}),
          }
        }),
      })
    }
    if (path.startsWith('/api/direct-chat/engines/')) {
      const [engineId, op, arg1, arg2] = path.slice('/api/direct-chat/engines/'.length).split('/')
      if (!engineId || !op) throw reject(404, 'Unknown endpoint')
      const provider = engineId === 'all' ? undefined : engines.get(engineId)
      if (op === 'login') {
        if (engineId === 'all' && arg1 === 'active' && !arg2 && req.method === 'GET') {
          const job = activeLogin()
          return json(res, 200, { login: job ? loginDetails(job) : null })
        }
        if (!provider) throw reject(404, 'Unknown engine')
        if (arg1 === 'start' && !arg2 && req.method === 'POST') {
          return json(res, 200, startEngineLogin(provider, await body(req)))
        }
        if (arg1 && !arg2 && req.method === 'GET') {
          const job = loginJobs.get(arg1)
          if (!job || job.engineId !== engineId) throw reject(404, 'Unknown login session')
          return json(res, 200, loginDetails(job))
        }
        if (arg1 && arg2 === 'code' && req.method === 'POST') {
          const job = loginJobs.get(arg1)
          if (!job || job.engineId !== engineId) throw reject(404, 'Unknown login session')
          const data = await body(req)
          const code = textField(data?.code, 'code').trim()
          if (/[\r\n]/.test(code) || code.length > 8192) throw reject(400, 'Invalid authorization code')
          const awaitingCode = job.status === 'waiting_auth' || (engineId !== 'agy' && job.status === 'waiting_url')
          if (!awaitingCode || !job.needsCode || !job.child.stdin?.writable) {
            throw reject(409, 'This sign-in is no longer waiting for an authorization code')
          }
          if (engineId === 'agy' && /^https?:/i.test(code)) {
            const callback = URL.parse(code)
            const expected = new URL(job.authUrl)
            const redirect = URL.parse(expected.searchParams.get('redirect_uri') || '')
            if (!callback?.searchParams.get('code') ||
                (redirect && (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname)) ||
                (callback.searchParams.has('state') && expected.searchParams.has('state') &&
                  callback.searchParams.get('state') !== expected.searchParams.get('state'))) {
              throw Object.assign(reject(400, 'Paste the final callback URL or code from this sign-in'), { code: 'oauth_callback_invalid' })
            }
          }
          await new Promise((resolve, rejectWrite) => job.child.stdin.write(code + '\n', error => {
            if (error) rejectWrite(reject(409, 'This sign-in is no longer accepting authorization codes'))
            else resolve()
          }))
          return json(res, 200, { ok: true })
        }
        if (arg1 && arg2 === 'cancel' && req.method === 'POST') {
          const job = loginJobs.get(arg1)
          if (job && job.engineId === engineId) {
            if (job.status === 'finishing') throw reject(409, 'Sign-in is already being finalized')
            stopLogin(job, 'cancelled')
          }
          return json(res, 200, { ok: true })
        }
        throw reject(404, 'Unknown endpoint')
      }
      if (arg1 !== undefined) throw reject(404, 'Unknown endpoint')
      if (op === 'check' && req.method === 'POST') {
        if (engineId === 'all') {
          await Promise.allSettled(engines.list().map(p => inspectEngineAdmin(p, { remote: true })))
          return json(res, 200, { ok: true })
        }
        if (!provider) throw reject(404, 'Unknown engine')
        return json(res, 200, { status: await inspectEngineAdmin(provider, { remote: true }) })
      }
      if (op === 'update' && req.method === 'POST') {
        if (!provider) throw reject(404, 'Unknown engine')
        return json(res, 200, { status: await updateEngineAdmin(provider) })
      }
      if (op === 'logout' && req.method === 'POST') {
        if (!provider) throw reject(404, 'Unknown engine')
        if (typeof provider.logoutCli !== 'function') throw reject(400, 'This engine does not support logout')
        const data = await body(req)
        const profileId = typeof data?.profileId === 'string' && data.profileId ? data.profileId : engineProfiles(engineId).defaultProfileId
        const selected = sessionProfiles(provider).find(profile => profile.id === profileId)
        if (!selected) throw reject(404, 'Unknown account')
        if (!['default', 'isolated'].includes(selected.kind)) throw reject(409, 'This account uses configured credentials')
        const bound = [...sessions.values()].filter(s => s.record.engine === engineId &&
          (sessionProfileId(s.record) === profileId || s.switchingAccount === profileId))
        if (bound.some(s => activeSession(s) || s.record.queue.length || hasPendingTools(s))) {
          throw reject(409, 'Account is in use by a session')
        }
        const env = resolveProfileEnv(engineId, profileId)
        if (engineId === 'agy') {
          if (agySigningOut.has(profileId) || activeLogin('agy')?.profileId===profileId) {
            throw reject(409,'The account is already changing')
          }
          agySigningOut.add(profileId)
        }
        try {
          if (engineId === 'agy') {
            const closing = await Promise.allSettled(closeIdleAdapters(engineId, profileId))
            if (closing.some(result => result.status === 'rejected')) {
              throw reject(409, 'AGY could not close the sessions using this account')
            }
          }
          await provider.logoutCli({ signal: controller.signal, env })
          if (engineId === 'agy' && profileId === 'default') {
            defaultAgyAuthPending = undefined
            defaultAgyAuth = { authenticated: false }
          }
          if (engineId !== 'agy') closeIdleAdapters(engineId, profileId)
          accountUsage = createAccountUsageCache()
          if (engineId === 'agy') await engineAdmin.get(engineId)?.pending
          const status = await inspectEngineAdmin(provider, { remote: false })
          broadcastEngineAccountSnapshots(engineId)
          return json(res, 200, { status })
        } finally {
          if (engineId === 'agy') agySigningOut.delete(profileId)
        }
      }
      if (op === 'profiles' && req.method === 'GET') {
        if (!provider) throw reject(404, 'Unknown engine')
        return json(res, 200, { profiles: await listEngineProfilesWithStatus(provider) })
      }
      if (op === 'profiles' && req.method === 'POST') {
        if (!provider) throw reject(404, 'Unknown engine')
        const data = await body(req)
        const action = data?.action
        const all = readProfiles()
        const cur = all[engineId] || { defaultProfileId: 'default', list: [] }
        cur.list = Array.isArray(cur.list) ? [...cur.list] : []
        if (action === 'create') {
          const name = textField(data.name, 'name').trim().slice(0, 60)
          const kind = data.kind === 'env' ? 'env' : data.kind === 'snapshot' ? 'snapshot' : 'isolated'
          if (kind === 'snapshot' && engineId === 'agy') throw reject(409, 'Add an isolated Google OAuth account')
          const profileId = randomUUID().slice(0, 8)
          const item = { id: profileId, name, kind, ...(kind === 'env' && data.env && typeof data.env === 'object' ? { env: data.env } : {}) }
          cur.list.push(item)
          all[engineId] = cur
          writeProfiles(all)
          resolveProfileEnv(engineId, profileId)
        } else if (action === 'setDefault') {
          const profileId = textField(data.profileId, 'profileId')
          const isConfig = (profileId.startsWith('config:') || profileId.startsWith('provider:')) &&
            typeof provider.configProfiles === 'function' &&
            provider.configProfiles().some(p => p.id === profileId)
          if (profileId !== 'default' && !isConfig && !cur.list.some(p => p.id === profileId)) throw reject(404, 'Unknown profile')
          if (engineId === 'agy' && profileId !== 'default' && !cur.list.some(p => p.id === profileId && p.kind === 'isolated')) {
            throw reject(409, 'Choose an isolated AGY account or the native default account')
          }
          cur.defaultProfileId = profileId
          if (cur.overrides?.[profileId]?.disabled) {
            const nextOverride = { ...cur.overrides[profileId] }
            delete nextOverride.disabled
            if (Object.keys(nextOverride).length) cur.overrides[profileId] = nextOverride
            else delete cur.overrides[profileId]
          }
          all[engineId] = cur
          writeProfiles(all)
          await inspectEngineAdmin(provider, { remote: false })
        } else if (action === 'setDisabled') {
          const profileId = textField(data.profileId, 'profileId')
          const isConfig = (profileId.startsWith('config:') || profileId.startsWith('provider:')) &&
            typeof provider.configProfiles === 'function' &&
            provider.configProfiles().some(p => p.id === profileId)
          if (profileId !== 'default' && !isConfig && !cur.list.some(p => p.id === profileId)) throw reject(404, 'Unknown profile')
          cur.overrides = cur.overrides && typeof cur.overrides === 'object' ? { ...cur.overrides } : {}
          const nextOverride = { ...(cur.overrides[profileId] || {}) }
          if (data.disabled) nextOverride.disabled = true
          else delete nextOverride.disabled
          if (Object.keys(nextOverride).length) cur.overrides[profileId] = nextOverride
          else delete cur.overrides[profileId]
          if (data.disabled && cur.defaultProfileId === profileId) {
            const fallback = sessionProfiles(provider, { list: cur.list || [], overrides: cur.overrides }).find(p => p.id !== profileId && !p.disabled)
            if (fallback) cur.defaultProfileId = fallback.id
          }
          all[engineId] = cur
          writeProfiles(all)
          closeIdleAdapters(engineId, profileId)
          await inspectEngineAdmin(provider, { remote: false })
        } else if (action === 'update') {
          const profileId = textField(data.profileId, 'profileId')
          cur.overrides = cur.overrides && typeof cur.overrides === 'object' ? { ...cur.overrides } : {}
          const item = cur.list.find(p => p.id === profileId)
          const renamingOAuth = item?.kind === 'isolated' && data.name !== undefined
          if (item && item.kind === 'env') {
            if (typeof data.name === 'string' && data.name.trim()) item.name = data.name.trim().slice(0, 60)
            if (data.env && typeof data.env === 'object') {
              item.env = { ...(item.env || {}), ...(sanitizeEnvMap(data.env) || {}) }
              for (const [k, v] of Object.entries(data.env)) {
                if (v === '') delete item.env[k]
              }
            }
          } else if (renamingOAuth) {
            item.name = textField(data.name, 'name').trim().slice(0, 60)
            if (engineId === 'agy') item.autoNamed = false
            else delete item.autoNamed
          } else {
            const prev = cur.overrides[profileId] || {}
            const nextEnv = { ...(prev.env || {}) }
            if (data.env && typeof data.env === 'object') {
              for (const [k, v] of Object.entries(data.env)) {
                if (typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue
                if (typeof v === 'string' && v.trim()) nextEnv[k] = v.trim()
                else if (v === '') delete nextEnv[k]
              }
            }
            const nextOverride = {
              ...(prev.disabled ? { disabled: true } : {}),
              ...(Object.keys(nextEnv).length ? { env: nextEnv } : {}),
              ...(typeof data.baseUrl === 'string' && data.baseUrl.trim() ? { baseUrl: data.baseUrl.trim() } : {}),
            }
            if (Object.keys(nextOverride).length) cur.overrides[profileId] = nextOverride
            else delete cur.overrides[profileId]
          }
          all[engineId] = cur
          writeProfiles(all)
          if (!renamingOAuth) {
            closeIdleAdapters(engineId)
            await inspectEngineAdmin(provider, { remote: false })
          }
        } else if (action === 'delete') {
          const profileId = textField(data.profileId, 'profileId')
          if (profileId === 'default') throw reject(400, 'Cannot delete default profile')
          if (!cur.list.some(p => p.id === profileId)) throw reject(404, 'Unknown profile')
          if ([...sessions.values()].some(s => s.record.engine === engineId &&
              (sessionProfileId(s.record) === profileId || s.switchingAccount === profileId) &&
              (activeSession(s) || s.record.queue.length || hasPendingTools(s)))) throw reject(409, 'Account is in use by a session')
          if (engineId === 'agy' && cur.list.some(p => p.id === profileId && p.kind === 'isolated') &&
              [...sessions.values()].some(s => s.record.engine === engineId &&
                (sessionProfileId(s.record) === profileId || agyHistoryProfileId(s.record) === profileId) &&
                hasSessionHistory(s.record))) {
            throw reject(409, 'This AGY account still contains conversation history')
          }
          cur.list = cur.list.filter(p => p.id !== profileId)
          if (cur.defaultProfileId === profileId) cur.defaultProfileId = 'default'
          all[engineId] = cur
          writeProfiles(all)
          const dir = join(store, 'profiles', engineId, profileId)
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
          await inspectEngineAdmin(provider, { remote: false })
        } else {
          throw reject(400, 'Unknown profile action')
        }
        return json(res, 200, { profiles: await listEngineProfilesWithStatus(provider) })
      }
      throw reject(404, 'Unknown endpoint')
    }
    if (path === '/api/direct-chat/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      res.write(': connected\n\n')
      statusClients.add(res)
      res.write('data: ' + JSON.stringify({ sessions: sessionStatusSnapshot() }) + '\n\n')
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000)
      res.on('close', () => { clearInterval(timer); statusClients.delete(res) })
      return
    }
    if (path === '/api/direct-chat/status/ack' && req.method === 'POST') {
      const data = await body(req)
      if (typeof data?.id === 'string' && data.id) {
        const target = sessions.get(data.id)
        if (target?.unreadDone) target.unreadDone = false
      } else {
        for (const item of sessions.values()) item.unreadDone = false
      }
      broadcastGlobalStatus()
      return json(res, 200, { ok: true })
    }
    if (path === '/api/direct-chat/workspaces/archive' && req.method === 'POST') {
      const data = await body(req)
      if (typeof data?.cwd !== 'string') throw reject(400, 'Expected a workspace path')
      return json(res, 200, await archiveWorkspace(data.cwd))
    }
    if (path === '/api/direct-chat/workspaces/git-branches' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd') || ''
      const closed = new AbortController()
      const onClose = () => closed.abort()
      res.once('close', onClose)
      try {
        const signal = AbortSignal.any([controller.signal, closed.signal])
        const info = await gitBranchInfo(cwd, signal)
        if (!res.destroyed) return json(res, 200, info)
      } finally {
        res.off('close', onClose)
      }
      return
    }
    if (path === '/api/direct-chat/workspaces/worktree' && req.method === 'POST') {
      const data = await body(req)
      if (typeof data?.cwd !== 'string' || !data.cwd) throw reject(400, 'Expected a workspace path')
      const from = data.from === undefined || data.from === null ? null : textField(data.from, 'from')
      const closed = new AbortController()
      const onClose = () => closed.abort()
      res.once('close', onClose)
      try {
        const signal = AbortSignal.any([controller.signal, closed.signal])
        const created = await createWorkspaceWorktree(data.cwd, from, signal)
        if (!res.destroyed) return json(res, 201, created)
      } finally {
        res.off('close', onClose)
      }
      return
    }
    if (path !== base && !path.startsWith(base + '/')) throw reject(404, 'Unknown endpoint')
    const [id, action, extra] = path.slice(base.length + 1).split('/')
    if (extra !== undefined) throw reject(404, 'Unknown endpoint')
    if (!id && req.method === 'GET') {
      return json(res,200,{sessions:await listRows()})
    }
    if (!id && req.method === 'POST') {
      const input = await body(req)
      if (!engines.has(input.engine)) throw reject(400, 'Unknown engine')
      const path = input.cwd || homedir()
      if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw reject(400, 'Choose an existing absolute directory')
      const profiles=engineProfiles(input.engine)
      const available=sessionProfiles(engines.get(input.engine),profiles)
      const requestedId=input.profileId===undefined ? profiles.defaultProfileId : textField(input.profileId,'profileId')
      const resolved=available.find(item=>item.id===requestedId && !item.disabled)
      if (!resolved) throw reject(400,'Choose an available account')
      const profileId=resolved.id
      const initialOptions=['model','thought_level','mode']
        .filter(key=>typeof profiles.defaultOptions?.[key]==='string' && profiles.defaultOptions[key])
        .map(key=>({id:key,currentValue:profiles.defaultOptions[key]}))
      const s = attach({ id: randomUUID(), engine: input.engine, profileId, cwd: realpathSync(path), title: input.engine, createdAt:Date.now(), updatedAt:Date.now(), messages: [], options: initialOptions }, input.draft === true)
      try { await open(s) } catch (err) { sessions.delete(s.record.id); throw err }
      scheduleRelease(s)
      return json(res, 201, snapshot(s))
    }
    if (!action && req.method==='DELETE') return json(res,200,await deleteSession(id,await body(req)))
    requirePresent(id)
    if (['archive','rename','pin'].includes(action) && req.method==='POST') {
      const data=await body(req)
      const native=await catalog.list()
      const row=sessions.get(id)?.record ?? native.get(id)
      const entry=row?.remoteId ? native.get(nativeId(row.engine,row.remoteId)) : undefined
      if(row) syncArchived(row,entry)
      if (!row) throw reject(404,'Unknown session')
      requirePresent(id,row)
      const previous=preferences.get(id) || {}
      let result
      if (action==='archive') {
        if (typeof data.archived!=='boolean') throw reject(400,'Expected an archive state')
        result=await changeArchive(row,data.archived,entry)
      } else if(action==='rename') {
        const title=textField(data.title,'title').trim()
        if(title.length>256) throw reject(400,'Title exceeds 256 characters')
        result=await renameSession(row,entry,title,data.mode)
      } else {
        if(typeof data.pinned!=='boolean') throw reject(400,'Expected a pin state')
        if(data.pinned && isArchived(row)) throw reject(409,'Restore the conversation before pinning it')
        const pinnedAt=data.pinned ? previous.pinnedAt || Date.now() : undefined
        storePreferences(id,{...previous,pinnedAt})
        result={pinned:data.pinned,pinnedAt}
      }
      const current=sessions.get(id)
      if(current) broadcast(current,'snapshot',snapshot(current))
      return json(res,200,{id,...result})
    }
    if(action==='attachment' && req.method==='GET') {
      const r=sessions.get(id)?.record
      requirePresent(id,r)
      const {attachment,directory,filename}=storedAttachment(r,url.searchParams.get('key'))
      const preview=await previewFile(directory,filename,{privateRoot:mediaRoot,privateDirectory:directory})
      return json(res,200,{...preview,path:attachment.name})
    }
    if (action==='queue-image' && req.method==='GET') {
      const s = sessions.get(id)
      requirePresent(id,s?.record)
      return sendQueuedImage(res,s,url.searchParams.get('item'),url.searchParams.get('index'))
    }
    if (['file', 'files', 'diff', 'diff-text', 'media', 'document', 'download'].includes(action) &&
        (req.method === 'GET' || (action === 'download' && req.method === 'HEAD'))) {
      const record=sessions.get(id)?.record ?? (await catalog.list()).get(id)
      if(!record) throw reject(404,'Unknown session')
      requirePresent(id,record)
      if (action === 'download') return sendDownload(res, record.cwd, url.searchParams.get('path'), {
        privateRoot: mediaRoot, range: req.headers.range, headersOnly: req.method === 'HEAD',
      })
      if (action === 'diff' || action === 'diff-text') {
        const closed = new AbortController()
        const onClose = () => closed.abort()
        res.once('close', onClose)
        try {
          const signal = AbortSignal.any([controller.signal, closed.signal])
          const scope = url.searchParams.get('scope') ?? 'uncommitted'
          const changes = action === 'diff' ? await workspaceDiff(record.cwd, signal, scope)
            : await workspaceDiffText(record.cwd, signal, scope, url.searchParams.get('path'), url.searchParams.get('digest'))
          if (!res.destroyed) return json(res, 200, changes)
        } catch (error) {
          if (!res.destroyed) throw error
        } finally { res.off('close', onClose) }
        return
      }
      const key = url.searchParams.get('attachment')
      const stored = key !== null && ['media', 'document'].includes(action) ? storedAttachment(record, key) : undefined
      const cwd = stored?.directory ?? record.cwd
      const path = stored?.filename ?? url.searchParams.get('path')
      const artifact = !stored && record.engine === 'agy' && record.agyHistoryProfileId ? agyArtifact(record,path) : undefined
      const requestedPath = artifact?.requestedPath ?? path
      const scope = stored ? { privateRoot: mediaRoot, privateDirectory: stored.directory } : {
        allowedRoots: artifact?.allowedRoots ?? (record.engine === 'agy' && record.profileId && record.profileId !== 'default'
          ? [join(agyDataDirectory(join(store,'profiles','agy',record.profileId)),'brain')]
          : engines.get(record.engine)?.readableRoots?.({ home: homedir(), cwd })),
        privateRoot: mediaRoot,
        privateDirectory: mediaDirectory(record.id),
      }
      if (action === 'files') return json(res, 200, await listWorkspaceDirectory(cwd, requestedPath ?? '', scope))
      if (action === 'document') {
        const closed = new AbortController()
        const onClose = () => closed.abort()
        res.once('close', onClose)
        try {
          const officeKit = ctx.get?.('officeKit') ?? ctx.get?.('officeToPdf')
          await sendDocument(res, cwd, requestedPath, scope, {
            officeKit, sessionId: record.id, range: req.headers.range,
            signal: AbortSignal.any([controller.signal, closed.signal]),
          })
        } catch (error) {
          if (!res.destroyed) throw error
        } finally { res.off('close', onClose) }
        return
      }
      if (action === 'media') {
        const media = await openMediaFile(cwd, requestedPath, scope)
        return sendMedia(res, media, req.headers.range)
      }
      return json(res, 200, await previewFile(cwd, requestedPath, scope))
    }
    if(action==='usage' && req.method==='GET') {
      const session = sessions.get(id)
      const indexed = session ? undefined : (await catalog.list()).get(id)
      const record = session?.record ?? (indexed && {...indexed,imported:true})
      if (!record) throw reject(404,'Unknown session')
      requirePresent(id,record)
      const engine = engines.get(record.engine)
      if (!engine) throw reject(404,'Engine not configured')
      const profileId=sessionProfileId(record)
      const requested=url.searchParams.get('profileId')
      if (session?.switchingAccount || (requested!==null && requested!==profileId)) throw reject(409,'The session account changed')
      const launch=accountLaunch(record,engine,profileId)
      const options = { cwd: record.cwd, signal: controller.signal, ...launch }
      const cache=accountUsage
      const effectiveEnv={...process.env,...launch.env}
      if (excludesSubscriptionQuota(record.engine, launch.modelProvider, effectiveEnv)) {
        return json(res,200,{status:'unavailable',reason:'noSubscriptionQuota',limits:[],observedAt:null,stale:false,refreshing:false,refreshFailed:false})
      }
      const report = await cache(JSON.stringify([record.engine,profileId]), {
        cachedOnly: url.searchParams.get('cached') === '1',
        force: url.searchParams.get('refresh') === '1',
        readLocal: engine.cachedAccountUsage && (() => engine.cachedAccountUsage(options)),
        query: async () => {
          const adapter=session?.adapter?.accountUsage && isDeepStrictEqual(session.adapterLaunch?.env,launch.env) &&
            isDeepStrictEqual(session.adapterLaunch?.extraArgs,launch.extraArgs) ? session.adapter : undefined
          if (adapter) {
            try { return await adapter.accountUsage(options) }
            catch { /* A closed wire can be retried through the engine. */ }
          }
          return engine.accountUsage?.(options)
        },
      })
      requirePresent(id,record)
      if (session?.switchingAccount || sessionProfileId(record)!==profileId || accountUsage!==cache) throw reject(409,'The session account changed')
      return json(res,200,report)
    }
    if (action==='context' && req.method==='GET') {
      const session=sessions.get(id)
      let entry=session ? undefined : (await catalog.list()).get(id) ?? (await catalog.list(true)).get(id)
      const record=session?.record ?? entry
      if (!record) throw reject(404,'Unknown session')
      requirePresent(id,record)
      const live=normalizeContext(await Promise.resolve().then(()=>session?.adapter?.context?.()).catch(()=>undefined))
      if (!live && !entry && record.remoteId) {
        if (record.engine==='agy' && nativeUuid.test(record.remoteId)) {
          const history=agyHistoryDirectory(record,engines.get(record.engine))
          entry={...record,file:join(history,'conversation_summaries.db')}
        } else entry=(await catalog.list()).get(nativeId(record.engine,record.remoteId))
      }
      const stored=live ? undefined : normalizeContext(await catalog.context?.(entry))
      const existing=normalizeContext(session?.updates.findLast(item=>item.update?.sessionUpdate==='usage_update')?.update)
      const metrics=normalizeContext({used:record.metrics?.contextUsed,size:record.metrics?.contextSize,estimated:record.metrics?.contextEstimated})
      requirePresent(id,record)
      const report=live ?? stored ?? existing ?? metrics
      if (!report) return json(res,200,{categories:[]})
      const size=report.size ?? [existing,metrics].find(row=>row?.size && (!report.model || !row.model || report.model===row.model))?.size
      return json(res,200,{...report,size})
    }
    if ((action === 'sync-native' || action === 'native-preview') && req.method === 'POST') {
      const s = sessions.get(id) ?? await lookup(id)
      if (!s) throw reject(404, 'Unknown session')
      const r = s.record
      requirePresent(id, r)
      if (!['agy', 'codex', 'claude'].includes(r.engine)) throw reject(400, 'Unsupported engine')
      if (action === 'sync-native' && nativeSyncBusy(s)) return json(res, 200, { status: 'busy' })
      const account = sessionProfileId(r)
      const entry = await nativeEntryFor(r, true)
      requirePresent(id, r)
      if (!entry || entry.remoteId !== r.remoteId || account !== sessionProfileId(r)) {
        if (action === 'native-preview') throw reject(404, 'Native history unavailable')
        return json(res, 200, { status: 'unavailable' })
      }
      if (action === 'native-preview') {
        const messages = (await catalog.messages(entry)).map(({ role, text, thought, tools }) => ({
          role, text, ...(thought ? { thought } : {}), ...(tools?.length ? { tools: tools.map(({ kind, status }) => ({ kind, status })) } : {}),
        }))
        requirePresent(id, r)
        if (account !== sessionProfileId(r) || entry.remoteId !== r.remoteId) throw reject(409, 'Session changed')
        return json(res, 200, { messages })
      }
      const changed = await syncImportedFromEntry(s, entry, true)
      broadcast(s, 'snapshot', snapshot(s))
      return json(res, 200, { status: nativeSyncBusy(s) ? 'busy' : s.nativeReadUnavailable ? 'unavailable' : s.nativeConflict ? 'conflict' : changed ? 'synced' : 'current' })
    }
    const s = await lookup(id, action === 'prompt' && req.method === 'POST')
    if (!s) throw reject(404, 'Unknown session')
    requirePresent(id,s.record)
    if (action === 'mcp' && req.method === 'GET') {
      const adapter = s.adapter ?? await open(s).catch(() => undefined)
      requirePresent(id, s.record)
      const text = await Promise.resolve().then(() => adapter?.mcpStatus?.()).catch(() => undefined)
      return json(res, 200, typeof text === 'string' && text ? { status: 'available', text } : { status: 'unavailable', text: '' })
    }
    if (action === 'terminal' && (req.method === 'GET' || req.method === 'POST')) {
      requirePresent(id, s.record)
      s.terminals ??= new Map()
      const ensureTerminal = (termId, cols = 80, rows = 24) => {
        let term = s.terminals.get(termId)
        if (term) return term
        const reqDsh = getDshRequire()
        const pty = reqDsh('node-pty')
        const { Terminal } = reqDsh('@xterm/headless')
        const { SerializeAddon } = reqDsh('@xterm/addon-serialize')
        const startCwd = s.record.cwd && existsSync(s.record.cwd) ? s.record.cwd : homedir()
        const shellPath = [process.env.SHELL, '/bin/bash', '/bin/sh'].find(p => typeof p === 'string' && p && existsSync(p)) || '/bin/sh'
        const shellName = basename(shellPath)
        const validCols = Number.isSafeInteger(cols) && cols >= 2 && cols <= 500 ? cols : 80
        const validRows = Number.isSafeInteger(rows) && rows >= 1 && rows <= 200 ? rows : 24
        const headless = new Terminal({ cols: validCols, rows: validRows, scrollback: 1000, allowProposedApi: true })
        const serializer = new SerializeAddon()
        headless.loadAddon(serializer)
        const ptyProcess = pty.spawn(shellPath, [], {
          name: 'xterm-256color',
          cols: validCols,
          rows: validRows,
          cwd: startCwd,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        })
        const clients = new Set()
        const broadcastTerm = frame => {
          const payload = `data: ${JSON.stringify(frame)}\n\n`
          for (const client of clients) client.write(payload)
        }
        term = {
          id: termId,
          ptyProcess,
          headless,
          serializer,
          clients,
          info: {
            id: termId,
            title: shellName,
            cwd: startCwd,
            cols: validCols,
            rows: validRows,
            state: 'running',
            exitCode: null,
          },
          environment: {
            cwd: startCwd,
            maxInputBytes: 65536,
            maxCols: 500,
            maxRows: 200,
            scrollback: 1000,
          },
          dispose() {
            s.terminals?.delete(termId)
            try { ptyProcess.kill() } catch {}
            try { headless.dispose() } catch {}
            for (const client of clients) client.end()
            clients.clear()
          },
        }
        ptyProcess.onData(data => {
          headless.write(data, () => {
            broadcastTerm({ type: 'output', data })
          })
        })
        ptyProcess.onExit(({ exitCode }) => {
          term.info = { ...term.info, state: 'exited', exitCode: typeof exitCode === 'number' ? exitCode : null }
          broadcastTerm({ type: 'state', info: term.info })
        })
        s.terminals.set(termId, term)
        return term
      }

      if (req.method === 'GET') {
        const termId = url.searchParams.get('termId') || 'default'
        const cols = Number(url.searchParams.get('cols')) || 80
        const rows = Number(url.searchParams.get('rows')) || 24
        const term = ensureTerminal(termId, cols, rows)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        term.clients.add(res)
        res.write(`data: ${JSON.stringify({
          type: 'snapshot',
          screen: term.serializer.serialize(),
          info: term.info,
          environment: term.environment,
        })}\n\n`)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000)
        req.on('close', () => {
          clearInterval(heartbeat)
          term.clients.delete(res)
        })
        return
      }

      const payload = await body(req)
      requirePresent(id, s.record)
      const termId = typeof payload?.termId === 'string' && payload.termId ? payload.termId : 'default'
      if (payload?.action === 'close') {
        const term = s.terminals.get(termId)
        if (term) {
          term.dispose()
          scheduleRelease(s)
        }
        return json(res, 200, { closed: true })
      }
      if (payload?.action !== 'write' && payload?.action !== 'resize') throw reject(400, 'Unsupported terminal action')
      const term = s.terminals.get(termId) ?? ensureTerminal(termId, payload?.cols, payload?.rows)
      if (payload?.action === 'write') {
        if (typeof payload.data === 'string' && payload.data && term.info.state === 'running') {
          term.ptyProcess.write(payload.data)
        }
        return json(res, 200, { ok: true })
      }
      if (payload?.action === 'resize') {
        const cols = Number(payload.cols)
        const rows = Number(payload.rows)
        if (Number.isSafeInteger(cols) && cols >= 2 && cols <= 500 &&
            Number.isSafeInteger(rows) && rows >= 1 && rows <= 200 &&
            term.info.state === 'running') {
          term.ptyProcess.resize(cols, rows)
          term.headless.resize(cols, rows)
          term.info = { ...term.info, cols, rows }
        }
        return json(res, 200, { ok: true })
      }
    }
    if(action==='fork' && req.method==='POST') {
      await body(req)
      requirePresent(id,s.record)
      if (archiveChanges.has(changeKey(s.record))) throw reject(409,'Archive change in progress')
      return json(res,201,{id:await forkSession(s)})
    }
    if (action==='account' && req.method==='POST') {
      const {profileId}=await body(req)
      await switchAccount(s,textField(profileId,'profileId'))
      return json(res,200,snapshot(s))
    }
    if (!action && req.method==='GET') await refreshIndexedAgents(s)
    if (!action && req.method === 'GET') {
      requirePresent(id,s.record)
      return json(res, 200, snapshot(s))
    }
    if (action === 'events' && req.method === 'GET') {
      await refreshIndexedAgents(s)
      requirePresent(id,s.record)
      res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', 'X-Accel-Buffering':'no' })
      res.write(': connected\n\n')
      clearTimeout(s.idleTimer)
      s.clients.add(res)
      if (s.unreadDone) {
        s.unreadDone = false
        broadcastGlobalStatus()
      }
      res.write('data: ' + JSON.stringify({type:'snapshot',data:snapshot(s)}) + '\n\n')
      const definition=engines.get(s.record.engine)
      // Opening history should not take a native writer lock.
      if (definition?.inspect && !s.adapter && !s.busy && !s.opening && !isArchived(s.record) && s.record.resumable!==false) {
        inspectForView(s,definition)
      } else if (!definition?.inspect && !(definition?.id === 'agy' && isChildSession(s.record)) && (definition?.id === 'agy' || (s.record.imported && !s.record.messages.length) || (definition?.composerVersion !== undefined && s.record.composerCapabilitiesVersion !== definition.composerVersion)) &&
          !isArchived(s.record) && s.record.resumable!==false && !s.adapter && !s.busy && !archiveChanges.has(changeKey(s.record))) {
        open(s).then(()=>{
          broadcast(s,'snapshot',snapshot(s))
          scheduleRelease(s)
        }).catch(error=>broadcast(s,'error',{message:error.message}))
      }
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000)
      if (!s.indexTimer) s.indexTimer=setInterval(()=>{
        void refreshIndexedAgents(s).catch(()=>{})
        void refreshNativeMetadata(s).catch(()=>{})
      },5000).unref()
      res.on('close', () => {if(s.clients.size===1){clearInterval(s.indexTimer);s.indexTimer=null};clearInterval(timer); s.clients.delete(res); scheduleRelease(s)})
      return
    }
    if (req.method !== 'POST') throw reject(405, 'Use POST')
    const data = await body(req)
    requirePresent(id,s.record)
    if (!['cancel','approve'].includes(action)) requireWritable(s)
    else if (s.record.resumable===false) throw reject(409,'Read-only subagent transcript')
    if (!['cancel','approve','configure','prompt','queue','parallel'].includes(action)) throw reject(404, 'Unknown action')
    if (action === 'configure' && (s.busy || s.forking || s.cancelling)) throw reject(409, 'Session is busy')
    if (action === 'parallel') {
      if (s.record.imported) await open(s)
      requireWritable(s)
      parallel(s,data)
      return json(res,202,snapshot(s))
    }
    if (action === 'approve') {
      if (!s.permissions.has(data.id)) throw reject(409, 'Permission request expired')
      await s.adapter.approve(data.id, data.option)
      s.permissions.delete(data.id)
      syncTurnWait(s)
      if(s.record.requestId && !s.permissions.size) taskState(s,'running')
      broadcast(s,'permission_resolved',{id:data.id})
      broadcastGlobalStatus()
    } else if (action === 'cancel') {
      await cancelTurn(s)
    } else if (action === 'configure') {
      s.busy = true
    s.turnStartedAt = Date.now()
      try {
        const a = await open(s)
        const optId = textField(data.id,'id')
        const optValue = textField(data.value,'value')
        s.record.options = await a.configure(optId, optValue)
        s.record.capabilitiesMedia = a.capabilities || {}
        s.importViewOnly=false
        const configured = s.record.options?.find(item => item.id === optId)
        const prefKey = ['model','thought_level','mode'].includes(optId)
          ? optId
          : (['model','thought_level','mode'].includes(configured?.category) ? configured.category : null)
        if (prefKey) {
          const all = readProfiles()
          const cur = all[s.record.engine] && typeof all[s.record.engine] === 'object' ? { ...all[s.record.engine] } : {}
          cur.defaultOptions = { ...(cur.defaultOptions && typeof cur.defaultOptions === 'object' ? cur.defaultOptions : {}), [prefKey]: optValue }
          all[s.record.engine] = cur
          writeProfiles(all)
        }
        save(s)
        broadcast(s,'options',s.record.options)
      } finally { s.busy = false; broadcast(s,'snapshot',snapshot(s)); scheduleRelease(s); drainQueue(s) }
    } else if (action === 'queue') {
      if (data.action === 'resume') {
        if (s.busy || s.forking || s.cancelling) throw reject(409,'Wait for the current turn to finish')
        s.queuePaused = false
        drainQueue(s)
        broadcast(s,'snapshot',snapshot(s))
        return json(res,202,snapshot(s))
      }
      if (data.action === 'steer-all') {
        const entries = s.record.queue.map(item=>({text:item.text,item}))
        if (entries.length) await steer(s,entries,true)
      } else {
        if (!['remove','edit','steer'].includes(data.action)) throw reject(400,'Unknown queue action')
        const item = pendingQueueItem(s,data.id)
        if (data.action === 'remove') {
          replaceQueue(s,s.record.queue.filter(row=>row!==item))
          discardQueueFiles(s,item)
          broadcast(s,'snapshot',snapshot(s))
        } else if (data.action === 'edit') {
          await editQueueItem(s,item,textField(data.text,'text'))
        } else {
          await steer(s,[{text:item.text,item}])
        }
      }
    } else {
      const {delivery,clientRequestId} = data
      if (delivery!==undefined && !['queue','steer'].includes(delivery)) throw reject(400,'Unknown message delivery mode')
      if (delivery===undefined && (s.busy || s.forking || s.cancelling)) throw reject(409,'Session is busy')
      const files = attachmentsFor(data.attachments,s.view?.capabilities ?? s.record.capabilitiesMedia)
      const text = files.length && data.text === '' ? '' : textField(data.text,'text')
      if (delivery==='queue') {
        if (clientRequestId!==undefined && (typeof clientRequestId!=='string' || clientRequestId.length!==36 || !nativeUuid.test(clientRequestId))) {
          throw reject(400,'clientRequestId must be a UUID')
        }
        await enqueue(s,text,files,clientRequestId)
      } else if (delivery==='steer') await steer(s,[{text,files}])
      else await startPrompt(s,text,files)
      if (delivery!==undefined) return json(res,202,snapshot(s))
      return json(res,202,{accepted:true})
    }
    return json(res,200,snapshot(s))
  }
  ctx.effect(() => {
    const unregister = ctx.webServer.register({kind:'prefix',path:'/api/direct-chat',handler:(req,res) =>
      handle(req,res).catch(err => {
        if (!res.headersSent) {
          const exposeCode = typeof err.code === 'string' && /^[a-z][a-z0-9_]*$/.test(err.code) && err.status >= 400 && err.status < 500
          json(res, err.status || 500, { error: err.message, message: err.message, ...(exposeCode ? { code: err.code } : {}) })
        } else res.end()
      })
    })
    return () => {
      clearTimeout(startupCheckTimer)
      for (const job of loginJobs.values()) {
        stopLogin(job, 'cancelled')
        clearTimeout(job.timer)
      }
      loginJobs.clear()
      unregister()
      controller.abort()
      for (const s of sessions.values()) {
        for (const res of s.clients) res.end()
        if (s.terminals) {
          for (const term of s.terminals.values()) term.dispose()
          s.terminals.clear()
        }
        clearTimeout(s.idleTimer)
        clearTimeout(s.executionPreviewTimer)
        clearInterval(s.indexTimer)
        if (s.saveTimer) save(s)
        s.adapter?.close()
      }
    }
  })
}
