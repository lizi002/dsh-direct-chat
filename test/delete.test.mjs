import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { nativeId } from '../server/native-history.mjs'

test('confirmed native deletion serializes changes and clears only the verified thread and aliases', async t => {
  const temp=await mkdtemp(join(tmpdir(),'dchat-delete-'))
  const store=join(temp,'direct-chat')
  const savedHome=process.env.DSH_HOME
  process.env.DSH_HOME=temp
  t.after(async()=>{
    if(savedHome===undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME=savedHome
    await rm(temp,{recursive:true,force:true})
  })
  const root=record('codex')
  const alias={...root,id:randomUUID()}
  const child=record('codex',root.id)
  const retained=record('codex',root.id)
  const parallel=record('codex',root.id)
  const unsupported=record('claude')
  const unsafe={...record('codex'),remoteId:'session-name'}
  const rootLocal=nativeId('codex',root.remoteId)
  const childLocal=nativeId('codex',child.remoteId)

  function record(engine,parentId) {
    const id=randomUUID()
    return {id,engine,parentId,remoteId:randomUUID(),cwd:temp,title:id,messages:[{role:'user',text:'fixture'}],options:[]}
  }
  function indexed(r,nativeParent) {
    return {...r,id:nativeId(r.engine,r.remoteId),parentId:undefined,nativeParent}
  }
  const nativeRows=[indexed(root),indexed(child,root.remoteId),indexed(retained,root.remoteId),indexed(unsupported)]
  await mkdir(join(store,'workspace-state'),{recursive:true})
  for(const item of [root,alias,child,retained,parallel,unsupported,unsafe]) {
    await writeFile(join(store,item.id+'.json'),JSON.stringify(item))
    await mkdir(join(store,'media',item.id),{recursive:true})
    await writeFile(join(store,'media',item.id,'copy'),'fixture')
  }
  const prefs=join(store,'workspace-state','preferences.json')
  const archive=join(store,'workspace-state','archive.json')
  await writeFile(prefs,JSON.stringify([[root.id,{title:'Primary'}],[alias.id,{title:'Alias'}],[parallel.id,{title:'Independent'}]]))
  await writeFile(archive,JSON.stringify([[root.id,false],[parallel.id,false]]))
  await mkdir(join(temp, 'engines'))
  await mkdir(join(temp, 'server'))
  await Promise.all([
    'index.mjs', 'engines/cli-admin.mjs',
    'server/agy-session-history.mjs', 'server/account-usage-cache.mjs', 'server/tool-activity.mjs',
    'server/workspace-file.mjs', 'server/workspace-worktree.mjs', 'server/native-merge.mjs', 'server/workspace-diff.mjs', 'server/codex-commands.mjs',
  ].map(name=>copyFile(new URL('../'+name,import.meta.url),join(temp,name))))
  await writeFile(join(temp,'server','native-history.mjs'), `
    export { nativeId, nativeUuid, openNativeDatabase } from ${JSON.stringify(new URL('../server/native-history.mjs',import.meta.url).href)}
    export const entries=new Map(${JSON.stringify(nativeRows.map(row=>[row.id,row]))})
    export const nativeCatalog=()=>({
      async list(){return new Map(entries)},async refreshEngine(){},
      async children(engine,id){return [...entries.values()].filter(row=>row.engine===engine&&row.nativeParent===id)},
      async metrics(){},async messages(entry){return entry.messages},
    })
  `)
  await writeFile(join(temp,'registry.mjs'), `
    export let remove, invocation, settleTurn
    export const onRemove=fn=>{remove=fn}
    async function start({resumeId}) {
      return {id:resumeId, options:[], async close(){}, prompt(){
        const result=Promise.withResolvers();settleTurn=result.resolve;return result.promise
      }}
    }
    const codex={id:'codex',label:'Codex',start,
      supportsDelete:async()=>true, deleteSession(input){invocation=input;return remove(input)}}
    const claude={id:'claude',label:'Claude Code',start}
    const engines=new Map([[codex.id,codex],[claude.id,claude]])
    export const createEngineRegistry=()=>({ready:Promise.resolve(),has:id=>engines.has(id),get:id=>engines.get(id),list:()=>[...engines.values()]})
  `)
  const {apply}=await import(pathToFileURL(join(temp,'index.mjs')))
  const registry=await import(pathToFileURL(join(temp,'registry.mjs')))
  const {entries}=await import(pathToFileURL(join(temp,'server','native-history.mjs')))
  const {call,dispose}=mount(apply)
  t.after(dispose)
  const path='/'+root.id
  const remove=(id,body={confirmId:id},authenticated=true)=>call('DELETE','/'+id,body,authenticated)
  const rows=async()=> (await call('GET')).data.sessions
  assert.equal((await rows()).find(row=>row.id===root.id).actions.delete,true)
  assert.equal((await rows()).find(row=>row.id===unsafe.id).actions.delete,false)
  assert.equal((await rows()).find(row=>row.id===unsupported.id).actions.delete,false)
  assert.equal((await remove(root.id,{confirmId:alias.id})).status,400)
  assert.equal((await remove('not-a-session')).status,400)
  assert.equal((await remove(randomUUID())).status,404)
  assert.equal((await remove(root.id,undefined,false)).status,401)
  assert.equal((await remove(child.id)).status,409)
  assert.equal((await remove(unsupported.id)).status,409)
  assert.equal(registry.invocation,undefined)

  assert.equal((await call('POST','/'+parallel.id+'/prompt',{text:'pending'})).status,202)
  assert.equal((await remove(root.id)).status,409)
  registry.settleTurn({stopReason:'cancelled'})
  await new Promise(resolve=>setImmediate(resolve))

  registry.onRemove(()=>{throw Error('Native deletion failed')})
  assert.equal((await remove(root.id)).status,500)
  await access(join(store,root.id+'.json'))
  await access(join(store,'media',alias.id,'copy'))
  assert.ok((await rows()).some(row=>row.id===root.id))

  const started=Promise.withResolvers()
  const finish=Promise.withResolvers()
  registry.onRemove(async input=>{
    assert.equal(input.remoteId,root.remoteId)
    started.resolve()
    await finish.promise
    entries.delete(rootLocal)
    entries.delete(childLocal)
  })
  const deletion=remove(alias.id)
  await started.promise
  assert.equal((await remove(root.id)).status,409)
  assert.equal((await call('POST',path+'/prompt',{text:'pending'})).status,409)
  assert.equal((await call('POST',path+'/rename',{title:'pending'})).status,409)
  assert.equal((await call('GET','/'+rootLocal)).status,409)
  assert.equal((await call('POST','/'+parallel.id+'/prompt',{text:'pending'})).status,409)
  finish.resolve()
  const result=await deletion
  assert.equal(result.status,200)
  const removed=[root.id,alias.id,rootLocal,child.id,childLocal]
  assert.deepEqual(new Set(result.data.deletedIds),new Set(removed))
  for (const id of removed) {
    assert.equal((await call('GET','/'+id)).status,404)
    await assert.rejects(access(join(store,id+'.json')),{code:'ENOENT'})
    await assert.rejects(access(join(store,'media',id)),{code:'ENOENT'})
  }
  assert.deepEqual((await remove(alias.id)).data,result.data)
  for(const keep of [parallel,retained,unsupported,unsafe]) await access(join(store,keep.id+'.json'))
  assert.deepEqual(JSON.parse(await readFile(prefs,'utf8')),[[parallel.id,{title:'Independent'}]])
  assert.deepEqual(JSON.parse(await readFile(archive,'utf8')),[[parallel.id,false]])
})

function mount(apply) {
  let dispatch,dispose
  apply({
    effect(fn){dispose=fn()},
    connection:{admit(req){return req.headers.cookie ? {peer:{principal:{kind:'owner'}}} : {rejection:401}}},
    webServer:{register(route){dispatch=route.handler;return ()=>{}}},
  })
  return {dispose,async call(method,suffix='',body,authenticated=true) {
    const req=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{
      url:'/api/direct-chat/sessions'+suffix,method,headers:{'content-type':'application/json',cookie:authenticated?'auth':''},
    })
    const res=Object.assign(new EventEmitter(),{
      writeHead(status){this.status=status},write(){},end(str){this.data=str&&JSON.parse(str)},
    })
    await dispatch(req,res)
    return res
  }}
}
