import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { nativeCatalog } from '../server/native-history.mjs'
import { engine } from '../engines/agy.mjs'
import { writeAgyArchive } from '../engines/agy-archive.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agy-archive-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, '.gemini', 'antigravity-cli')
  const annotations = join(directory, 'annotations')
  await mkdir(annotations, { recursive: true })
  const remoteId = randomUUID()
  const db = new DatabaseSync(join(directory, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,step_count,status)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(remoteId, 'Fixture',
    JSON.stringify([pathToFileURL(home).href]), 2, 'CASCADE_RUN_STATUS_IDLE')
  db.close()
  return { home, directory, annotations, remoteId, file: join(annotations, remoteId + '.pbtxt') }
}

test('writes and reads AGY native archive state without modifying the other annotations', async t => {
  const { home, remoteId, file, annotations } = await fixture(t)
  const originalHome = process.env.HOME
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })
  process.env.HOME = home
  const fields = `title:"contains archived:true and a \\\" quote" tags:"keep" starred:true last_user_view_time:{seconds:12}\n`
  const comment = '# archived:true archival_status_timestamp:{seconds:42}\n'
  writeFileSync(file, comment + fields, { mode: 0o640 })
  const list = () => engine.history.list({ home })
  assert.equal(list()[0].archived, false)
  await engine.setArchived({ remoteId, cwd: home, archived: true })
  const archived = readFileSync(file, 'utf8')
  assert.ok(archived.startsWith(comment + fields))
  assert.match(archived, /\narchived:true\narchival_status_timestamp:\{seconds:\d+ nanos:\d+\}/)
  assert.equal(list()[0].archived, true)
  assert.equal(statSync(file).mode & 0o777, 0o640)
  const before = statSync(file, { bigint: true })
  await engine.setArchived({ remoteId, cwd: home, archived: true })
  assert.equal(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs)
  assert.equal(readFileSync(file, 'utf8'), archived)

  // Replace the native annotations with the single-line form written by AGY.
  const native = 'title:"new title"  archived:true  archival_status_timestamp:{seconds:123 nanos:0}  starred:true'
  writeFileSync(file, native)
  await engine.setArchived({ remoteId, cwd: home, archived: false })
  assert.match(readFileSync(file, 'utf8'), /^title:"new title"  archived:false  archival_status_timestamp:\{seconds:\d+ nanos:\d+\}  starred:true$/)
  assert.equal(list()[0].archived, false)
  assert.deepEqual(await readdir(annotations), [remoteId + '.pbtxt'])
  await assert.rejects(engine.setArchived({ remoteId: randomUUID(), archived: true }), /conversation was not found/)
})

test('renames an AGY conversation in its native annotations without changing archive fields', async t => {
  const { home, remoteId, file } = await fixture(t)
  const originalHome = process.env.HOME
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })
  process.env.HOME = home
  const existing = 'archived:true archival_status_timestamp:{seconds:42} tags:"keep"'
  writeFileSync(file, 'title:"Original" ' + existing)
  const title = '本地名称 "保留引号"'
  await engine.rename({ remoteId, title })
  assert.equal(readFileSync(file, 'utf8'), `title:${JSON.stringify(title)} ${existing}`)
  const [row] = engine.history.list({ home })
  assert.equal(row.title, title)
  assert.equal(row.archived, true)
})

test('creates private native annotations and rejects concurrent and malformed edits', async t => {
  const { directory, annotations, remoteId, file } = await fixture(t)
  writeAgyArchive(directory, remoteId, false)
  assert.deepEqual(await readdir(annotations), [])
  writeAgyArchive(directory, remoteId, true)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  let checks = 0
  const concurrent = 'archived:true title:"changed concurrently"\n'
  const signal = { throwIfAborted() { if (++checks === 2) writeFileSync(file, concurrent) } }
  assert.throws(() => writeAgyArchive(directory, remoteId, false, signal), /changed during archiving/)
  assert.equal(readFileSync(file, 'utf8'), concurrent)
  const malformed = 'title:"unclosed  archived:true'
  writeFileSync(file, malformed)
  assert.throws(() => writeAgyArchive(directory, remoteId, false), /Invalid AGY annotation string/)
  assert.equal(readFileSync(file, 'utf8'), malformed)
  assert.deepEqual(await readdir(annotations), [remoteId + '.pbtxt'])
})

test('scoped native lookup reads the requested AGY history even if the default index contains the same ID', async t => {
  const local = await fixture(t)
  const work = await fixture(t)
  const catalog = nativeCatalog({ registry: { get: () => engine }, home: local.home })
  const db = new DatabaseSync(join(work.directory, 'conversation_summaries.db'))
  try {
    db.prepare('UPDATE conversation_summaries SET conversation_id = ?, title = ?').run(local.remoteId, 'Work-only title')
  } finally { db.close() }
  const privateRow = await catalog.findInDirectory('agy', local.remoteId, work.directory)
  assert.equal(privateRow.nativeTitle, 'Work-only title')
  assert.equal(privateRow.file, join(work.directory, 'conversation_summaries.db'))
  assert.equal((await catalog.findInDirectory('agy', local.remoteId, local.directory)).nativeTitle, 'Fixture')
  assert.equal(await catalog.findInDirectory('agy', local.remoteId, join(work.directory, 'absent')), undefined)
})
