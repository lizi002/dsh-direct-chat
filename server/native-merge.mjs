import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export function formatFilePrompt(text, references) {
  return references.length ? `${text ? text + '\n\n' : ''}Attached files (local paths):\n${JSON.stringify(references)}` : text
}

function turns(messages) {
  const result = [{ assistant: [], start: 0 }]
  for (const [index, message] of messages.entries()) {
    if (typeof message?.text !== 'string') return
    if (message.role === 'user') {
      // Native readers omit attachment-only inputs, so a blank prompt cannot anchor a turn.
      if (!message.text.trim()) return
      result.push({ user: message, assistant: [], start: index })
    } else if (message.role === 'assistant') {
      result.at(-1).assistant.push(message)
    } else {
      return
    }
  }
  return result
}

function sameUser(web, native, attachmentPath) {
  if (!web || !native) return web === native
  const files = web.attachments?.filter(attachment => attachment?.type === 'file') ?? []
  if (!files.length) return web.text.trim() === native.text.trim()
  const references = []
  for (const file of files) {
    const { name, mimeType } = file
    if (typeof name !== 'string' || !name || typeof mimeType !== 'string' || !mimeType) return false
    const path = attachmentPath?.(file)
    if (typeof path !== 'string' || !isAbsolute(path)) return false
    references.push({ name, mimeType, path })
  }
  return formatFilePrompt(web.text, references).trim() === native.text.trim()
}

function reply(turn) {
  return turn.assistant.map(message => message.text).filter(text => text.trim())
}

function sameReply(left, right) {
  // Display activity can split a reply into multiple rows in just one transcript.
  return (left.length === right.length && left.every((text, index) => text.trim() === right[index].trim())) ||
    left.join('').trim() === right.join('').trim()
}

function replyPrefix(earlier, later) {
  return (earlier.length <= later.length && earlier.every((text, index) =>
    index === earlier.length - 1 ? later[index].trim().startsWith(text.trim()) : text.trim() === later[index].trim())) ||
    later.join('').trim().startsWith(earlier.join('').trim())
}

function retainsTools(previous, latest) {
  const ids = turn => new Set(turn.assistant.flatMap(message => [
    ...(message.tools ?? []),
    ...(message.steps ?? []).filter(step => step.kind === 'tool').map(step => step.tool),
  ]).map(tool => tool?.toolCallId).filter(Boolean))
  const latestIds = ids(latest)
  return [...ids(previous)].every(id => latestIds.has(id))
}

export function compareNativeHistory(webMessages, nativeMessages, { attachmentPath } = {}) {
  if (!nativeMessages.length) return { status: 'current' }
  const web = turns(webMessages)
  const native = turns(nativeMessages)
  if (!web || !native) return { status: 'conflict' }

  for (let index = 0; index < Math.min(web.length, native.length); index++) {
    if (!sameUser(web[index].user, native[index].user, attachmentPath)) return { status: 'conflict' }
    const savedReply = reply(web[index])
    const nativeReply = reply(native[index])
    if (sameReply(savedReply, nativeReply)) continue
    if (index === native.length - 1 && replyPrefix(nativeReply, savedReply)) return { status: 'current' }
    return { status: 'conflict' }
  }

  if (native.length <= web.length) return { status: 'current' }
  return { status: 'synced', additions: nativeMessages.slice(native[web.length].start) }
}

export function compareNativeTail(previousMessages, nativeMessages) {
  if (!previousMessages.length) return compareNativeHistory(previousMessages, nativeMessages)
  if (!nativeMessages.length) return { status: 'current' }
  if (previousMessages[0]?.role !== 'user' || nativeMessages[0]?.role !== 'user') return { status: 'conflict' }
  const previous = turns(previousMessages)
  const native = turns(nativeMessages)
  if (!previous || !native) return { status: 'conflict' }

  for (let index = 1; index < Math.min(previous.length, native.length); index++) {
    if (previous[index].user.text.trim() !== native[index].user.text.trim()) return { status: 'conflict' }
    const savedReply = reply(previous[index])
    const nativeReply = reply(native[index])
    if (!sameReply(savedReply, nativeReply)) {
      if (index === native.length - 1 && replyPrefix(nativeReply, savedReply)) return { status: 'current' }
      if (index !== previous.length - 1 || !replyPrefix(savedReply, nativeReply)) return { status: 'conflict' }
    }
    if (!retainsTools(previous[index], native[index])) return { status: 'conflict' }
  }

  if (native.length < previous.length || isDeepStrictEqual(previousMessages, nativeMessages)) return { status: 'current' }
  return { status: 'synced', additions: nativeMessages }
}
