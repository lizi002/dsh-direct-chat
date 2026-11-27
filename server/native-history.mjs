import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { createZstdDecompress } from 'node:zlib'

export const nativeUuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function asMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value
  }
  if (typeof value !== 'string') return undefined
  const time = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/(\.\d{3})\d+/, '$1')
  const withoutZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(time)
  const milliseconds = Date.parse(withoutZone ? time + 'Z' : time)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined
}

export function openNativeDatabase(file) {
  return existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : undefined
}

export async function* transcriptLines(path) {
  const source = createReadStream(path)
  const input = path.endsWith('.zst') ? source.pipe(createZstdDecompress()) : source
  if (input !== source) source.on('error', error => input.destroy(error))
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      let value
      try { value = JSON.parse(line) } catch { continue }
      if (value && typeof value === 'object') yield value
    }
  } finally {
    reader.close()
    input.destroy()
    source.destroy()
  }
}

export function transcriptFiles(dir, depth = 0) {
  if (!existsSync(dir)) return []
  const paths = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) paths.push(...transcriptFiles(path, depth - 1))
    if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) paths.push(path)
  }
  return paths
}

export function lastModified(file) {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs
}

export async function latestTimestamp(file, matches = () => true) {
  if (file.endsWith('.zst')) {
    let latest
    for await (const entry of transcriptLines(file)) {
      if (matches(entry)) latest = asMillis(entry.timestamp) ?? latest
    }
    return latest
  }
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 128 * 1024)
    const start = size - length
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, start)
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n')
    if (start > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry
      try { entry = JSON.parse(lines[i]) } catch { continue }
      if (entry && matches(entry)) {
        const timestamp = asMillis(entry.timestamp)
        if (timestamp) return timestamp
      }
    }
  } finally { await handle.close() }
}

export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type))
    .map(block => block.text).filter(Boolean).join('\n')
}

export function nativeId(engine, remoteId) {
  return 'local-' + createHash('sha256').update(engine + '/' + remoteId).digest('hex').slice(0, 32)
}

function descriptor(definition, row) {
  const { remoteId, cwd, nativeParent } = row ?? {}
  if (typeof remoteId !== 'string' || !remoteId || typeof cwd !== 'string' || !isAbsolute(cwd)) return
  let directory = cwd
  try { directory = realpathSync(cwd) } catch {}
  const engine = definition.id
  const nativeTitle = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim().slice(0, 256) || undefined : undefined
  const title = nativeTitle ?? definition.label
  const createdAt = asMillis(row.createdAt)
  const updatedAt = asMillis(row.updatedAt) ?? createdAt ?? 0
  const parent = typeof nativeParent === 'string' && nativeParent && nativeParent !== remoteId ? nativeParent : undefined
  return {
    ...row, id: nativeId(engine, remoteId), engine, remoteId, title, nativeTitle, cwd: directory, createdAt, updatedAt,
    nativeParent: parent, parentId: parent ? nativeId(engine, parent) : undefined,
  }
}

// Only metadata is cached. The engine reads transcript content when a conversation opens.
export function nativeCatalog({ registry, home = homedir(), ...directories }) {
  const cache = new Map()

  function entries(definition, refresh) {
    if (!definition?.history) return Promise.resolve([])
    const id = definition.id
    let state = cache.get(id)
    if (state?.definition !== definition) {
      state = { definition, entries: [], expires: 0 }
      cache.set(id, state)
    }
    if (!refresh && Date.now() < state.expires) return Promise.resolve(state.entries)
    state.pending ??= Promise.resolve().then(async () => {
      try {
        const rows = await definition.history.list({ home, directory: directories[id] })
        state.entries = rows.map(row => descriptor(definition, row)).filter(Boolean)
      } catch {
        // An unavailable local CLI index leaves its last readable metadata intact.
      }
      state.expires = Date.now() + 5_000
      return state.entries
    }).finally(() => { state.pending = undefined })
    return state.pending
  }

  return {
    async findInDirectory(engine, remoteId, directory) {
      const definition = registry.get(engine)
      if (!definition?.history) return
      const rows = await definition.history.list({ home, directory, remoteId })
      const row = rows.find(value => value.remoteId === remoteId)
      if (row) return descriptor(definition, row)
    },
    async refreshEngine(id) {
      await registry.ready
      await cache.get(id)?.pending
      await entries(registry.get(id), true)
    },
    async list(refresh = false) {
      await registry.ready
      const sources = await Promise.all(registry.list().map(definition => entries(definition, refresh)))
      return new Map(sources.flat().map(entry => [entry.id, entry]))
    },
    async children(engine, remoteId, refresh = false) {
      await registry.ready
      const definition = registry.get(engine)
      const values = await entries(definition, refresh)
      return values.filter(entry => entry.nativeParent === remoteId)
    },
    async messages(entry) {
      await registry.ready
      const definition = registry.get(entry.engine)
      return definition?.history ? definition.history.messages(entry) : []
    },
    async metrics(entry) {
      await registry.ready
      try { return await registry.get(entry.engine)?.history?.metrics?.(entry) }
      catch { return undefined }
    },
    async context(entry) {
      if (!entry) return
      await registry.ready
      try { return await registry.get(entry.engine)?.history?.context?.(entry) }
      catch { return undefined }
    },
  }
}
