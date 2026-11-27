import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { applyEvent, projectActivity } from '../ui/chat-state.mjs'

test('authenticated sessions persist replies, serialize prompts and restore the engine session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'direct-chat-test-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    await rm(dir, {recursive:true,force:true})
  })
  await mkdir(join(dir, 'server'))
  await writeFile(join(dir,'server','native-history.mjs'), `
    let title, archived, historyRows=[], context, indexedEntry
    const rowsByFile = new Map()
    export const setRows=rows=>{historyRows=rows}
    export const setRowsForFile=(file,rows)=>{if(rows)rowsByFile.set(file,rows);else rowsByFile.delete(file)}
    export const setContext=report=>{context=report}
    export const setIndexedEntry=entry=>{indexedEntry=entry}
    export function setArchived(input){if(input.remoteId!=='remote-session')throw Error('wrong remote session'); archived=input.archived}
    export const setTitle=value=>{title=value}
    export {openNativeDatabase} from ${JSON.stringify(new URL('../server/native-history.mjs', import.meta.url).href)}
    export const nativeUuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    export function nativeId(engine, remoteId){return 'local-'+engine+'-'+remoteId}
    export function nativeCatalog(){return {findInDirectory:async(engine,remoteId,directory)=>({engine,remoteId,file:directory+"/conversation_summaries.db",updatedAt:250}),messages:async entry=>rowsByFile.get(entry?.file)??historyRows,metrics:async()=>undefined,context:async entry=>entry?.remoteId==='remote-session' ? context : undefined,refreshEngine:async()=>{},list:async()=>{
      const id=nativeId('agy','remote-session')
      const entries=new Map(title || archived!==undefined ? [[id,{id,engine:'agy',remoteId:'remote-session',title,nativeTitle:title,archived,updatedAt:100}]]:[])
      if (indexedEntry) entries.set(indexedEntry.id,indexedEntry)
      return entries
    }}}
  `)
  await copyFile(new URL('../server/account-usage-cache.mjs',import.meta.url),join(dir,'server','account-usage-cache.mjs'))
  await mkdir(join(dir, 'engines'))
  await copyFile(new URL('../engines/cli-admin.mjs', import.meta.url), join(dir, 'engines', 'cli-admin.mjs'))
  await copyFile(new URL('../index.mjs',import.meta.url), join(dir,'index.mjs'))
  await copyFile(new URL('../server/codex-commands.mjs',import.meta.url), join(dir,'server','codex-commands.mjs'))
  await copyFile(new URL('../server/workspace-diff.mjs',import.meta.url), join(dir,'server','workspace-diff.mjs'))
  await copyFile(new URL('../server/native-merge.mjs',import.meta.url), join(dir,'server','native-merge.mjs'))
  await copyFile(new URL('../server/workspace-worktree.mjs',import.meta.url), join(dir,'server','workspace-worktree.mjs'))
  await copyFile(new URL('../server/workspace-file.mjs',import.meta.url), join(dir,'server','workspace-file.mjs'))
  await copyFile(new URL('../server/agy-session-history.mjs',import.meta.url),join(dir,'server','agy-session-history.mjs'))
  await copyFile(new URL('../server/tool-activity.mjs',import.meta.url), join(dir,'server','tool-activity.mjs'))
  await writeFile(join(dir,'registry.mjs'), `
    import {startAgy} from './server/agy.mjs'
    import {parseCodexCommand} from './server/codex-commands.mjs'
    import {setArchived,setTitle} from './server/native-history.mjs'
    import agy from ${JSON.stringify(new URL('../engines/agy.mjs',import.meta.url).href)}
    export let readAttempts=0, resumeAttempts=0
    export const starts=[]
    let archiveFn=setArchived
    let renameFn=({title})=>setTitle(title)
    export const archiveImplementation=fn=>{archiveFn=fn}
    export const renameImplementation=fn=>{renameFn=fn}
    export const createEngineRegistry=()=>({
      ready:Promise.resolve(),has:id=>['agy','codex'].includes(id),list:()=>[{id:'agy',label:'AGY'},{id:'codex',label:'Codex'},
        {id:'missing',label:'Missing CLI',cliInfo:async()=>{throw Object.assign(Error('not found'),{code:'ENOENT'})}}],
      get:id=>({id,start:async args=>{
        starts.push({resumeId:args.resumeId,replayHistory:args.replayHistory})
        if(args.resumeId==='held-thread'){resumeAttempts++; throw Object.assign(Error('Codex session is in use'),{status:409})}
        return startAgy(args)
      },inspect:id==='codex'?async()=>{readAttempts++;return {commands:[{name:'review'}],options:[],capabilities:{image:true}}}:undefined,
        composerVersion:id==='agy'?agy.composerVersion:undefined,
        resolvePrompt:id==='codex'?({text,attachmentCount,adapter})=>{
          let cmd; try{cmd=parseCodexCommand(text,attachmentCount)}catch(e){throw Object.assign(Error(e.message),{status:400})}
          if(cmd?.name==='goal'&&adapter&&!adapter.capabilities?.goal) throw Object.assign(Error('Codex goals are disabled for this conversation'),{status:409})
          return cmd
        }:undefined,
        setArchived:archiveFn,rename:renameFn,replayHistory:true,
        accountUsage:()=>({limits:[{label:'5h limit',poolId:'default',poolLabel:' Main pool ',windowLabel:' 5h ',usedPercent:20,resetsAt:1_800_000_000_000,secret:'Fixture private data'}],credential:'Fixture private data'}),
        fork:args=>startAgy({...args,resumeId:"independent-id"})})
    })
  `)
  await writeFile(join(dir,'server','agy.mjs'), `
    export async function startAgy({resumeId,replayHistory,emit}){
      let finish
      if(replayHistory && resumeId==='unindexed-agy')emit('history',{messages:[{role:'assistant',text:'replayed answer'}]})
      const options=resumeId==='indexed-agy'?[
        {id:'model',category:'model',type:'select',currentValue:'flash',options:[{name:'Gemini',options:[{value:'flash',name:'Flash'},{value:'pro',name:'Pro'}]}]},
        {id:'thought_level',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'}]},
      ]:[]
      return {id:resumeId||'remote-session',options,capabilities:{image:true},
        context:()=>({used:12,size:128,estimated:true,categories:[{name:'Prompt',tokens:12,secret:'Fixture private data'}],token:'Fixture private data'}),
        async configure(id,value){
          if(resumeId==='indexed-agy'){
            const option=options.find(item=>item.id===id)
            if(!option?.options.flatMap(choice=>choice.options??[choice]).some(choice=>choice.value===value)) throw Error('Invalid chat configuration')
            option.currentValue=value
          }
          return options
        },close(){}, cancel(){finish?.({stopReason:'cancelled'})},
        prompt(text){
          emit('usage',{inputTokens:80,outputTokens:18,cacheReadTokens:0,sessionTokens:{total:980,input:800,output:180,privateField:'omit'}})
          emit('agent',{id:'native-worker',name:'Worker',status:'completed'})
          if (text==='tool only') {
            const update=fields=>emit('update',{update:fields})
            update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Inspect the test fixture'}})
            update({sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read',kind:'read',status:'in_progress',
              locations:[{path:'example.txt',line:2,_meta:{fixture:'Private location metadata'}}],rawInput:{fixture:'Private tool argument'}})
            update({sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed'})
            return Promise.resolve({stopReason:'end_turn'})
          }
          if (text==='stream command') {
            const command='fixture command'
            const update=fields=>emit('update',{update:{toolCallId:'command',...fields}})
            update({sessionUpdate:'tool_call',title:'Run fixture',kind:'execute',status:'in_progress',execution:{command}})
            emit('update',{update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Following activity'}}})
            for (let i=0;i<20;i++) {
              update({sessionUpdate:'tool_call_update',execution:{command,output:String(i),env:{FIXTURE:'private data'}}})
            }
            return new Promise(resolve=>{
              finish=()=>{
                update({sessionUpdate:'tool_call_update',status:'failed',execution:{command,output:'final result',exitCode:3}})
                resolve({stopReason:'cancelled'})
              }
            })
          }
          if (text==='ordered progress') {
            const update=(sessionUpdate, fields)=>emit('update',{update:{sessionUpdate,...fields}})
            const chunk=(text, extra)=>update('agent_message_chunk',{content:{type:'text',text},...extra})
            update('tool_call',{toolCallId:'first',title:'Read',status:'in_progress'})
            chunk('I will ')
            chunk('inspect.')
            update('tool_call_update',{toolCallId:'first',status:'completed'})
            update('plan',{entries:[{content:'Inspect files',status:'pending'}]})
            update('tool_call_update',{toolCallId:'second',title:'Check',status:'completed'})
            update('plan',{entries:[{content:'Inspect files',status:'completed'}]})
            chunk('Done.',{phase:'final_answer'})
            update('tool_call',{toolCallId:'third',title:'Save',status:'in_progress'})
            update('tool_call_update',{toolCallId:'third',status:'completed'})
            return Promise.resolve({stopReason:'end_turn'})
          }
          emit('update',{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:(resumeId?'resumed ':'new ')+text}}})
          if(text==='two') emit('update',{update:{sessionUpdate:'session_info_update',title:'Native live title'}})
          return new Promise(resolve=>{finish=resolve})
        }
      }
    }`)
  const {apply} = await import(pathToFileURL(join(dir,'index.mjs')))
  function mount() {
    let handler, dispose
    apply({effect(fn){dispose=fn()},connection:{admit(req){return req.headers.cookie ? {peer:{principal:{kind:'owner'}}} : {rejection:401}}},
      webServer:{register(route){handler=route.handler;return ()=>{}}}})
    return {dispose,async call(method,suffix='',data,authenticated=true) {
      const req=Readable.from(data?[Buffer.from(JSON.stringify(data))]:[])
      Object.assign(req,{url:suffix.startsWith('/api/') ? suffix : '/api/direct-chat/sessions'+suffix,method,headers:{'content-type':'application/json',cookie:authenticated?'auth':''}})
      const res=Object.assign(new EventEmitter(),{chunks:[],writeHead(status){this.status=status},write(str){this.chunks.push(str)},end(str){this.data=str&&JSON.parse(str)}})
      await handler(req,res)
      return res
    }}
  }
  const app=mount()
  t.after(()=>app.dispose())
  assert.equal((await app.call('POST','',{engine:'agy'},false)).status,401)
  const catalog = await app.call('GET', '/api/direct-chat/engines')
  assert.equal(catalog.data.engines.find(engine => engine.id === 'missing').status.installed, false)
  const create=await app.call('POST','',{engine:'agy',cwd:dir})
  assert.equal(create.status,201)
  assert.deepEqual((await app.call('GET')).data.sessions,[])
  const path='/'+create.data.id
  assert.equal((await app.call('POST',path+'/terminal',{action:'unknown'})).status,400)
  assert.equal((await app.call('POST',path+'/prompt',{text:'one'})).status,202)
  assert.equal((await app.call('POST',path+'/prompt',{text:'duplicate'})).status,409)
  assert.equal((await app.call('POST',path+'/fork',{})).status,409)
  assert.equal((await app.call('GET')).data.sessions[0].id,create.data.id)
  const stream=await app.call('GET',path+'/events')
  t.after(()=>stream.emit('close'))
  const initial=JSON.parse(stream.chunks.find(s=>s.startsWith('data:')).slice(6))
  assert.equal(initial.data.messages[1].text,'new one')
  assert.equal(initial.data.busy,true)
  assert.equal((await app.call('POST',path+'/cancel',{})).status,200)
  const finished=(await app.call('GET',path)).data
  assert.deepEqual(finished.metrics.sessionTokens,{total:980,input:800,output:180})
  assert.equal(finished.metrics.outputTokens,18)
  assert.equal(finished.metrics.inputTokens,80)
  assert.equal(finished.metrics.cacheReadTokens,0)
  assert.ok(finished.metrics.turnMs>0)
  assert.equal(finished.metrics.tps,Math.round(18/(finished.metrics.turnMs/1000)*10)/10)
  assert.equal(finished.agents[0].status,'completed')
  assert.equal(finished.title,'one')
  const native = await import(pathToFileURL(join(dir,'server','native-history.mjs')))
  native.setTitle('Renamed in the CLI')
  assert.deepEqual((await app.call('GET')).data.sessions.map(({id,title})=>[id,title]),[[create.data.id,'Renamed in the CLI']])
  assert.equal((await app.call('GET',path)).data.title,'Renamed in the CLI')
  native.setTitle(undefined)
  const batch={tasks:['audit one','audit two'],requestId:'single-submit'}
  const dispatched=await app.call('POST',path+'/parallel',batch)
  assert.equal(dispatched.status,202)
  const children=dispatched.data.agents.filter(task=>task.sessionId)
  assert.equal(children.length,2)
  assert.deepEqual((await app.call('GET')).data.sessions.map(row=>row.id),[create.data.id])
  const row=(await app.call('GET')).data.sessions[0]
  assert.ok(row.createdAt>0 && row.updatedAt>=row.createdAt)
  assert.equal(row.archiveMode,'native')
  assert.equal((await app.call('POST',path+'/archive',{archived:true})).status,409)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal((await app.call('POST',path+'/parallel',batch)).data.agents.length,3)
  for(const task of children) {
    const childPath='/'+task.sessionId
    const child=(await app.call('GET',childPath)).data
    assert.equal(child.cwd,dir)
    assert.equal(child.busy,true)
    assert.equal(child.parentId,create.data.id)
    assert.equal((await app.call('POST',childPath+'/parallel',batch)).status,400)
  }
  for(const task of children) await app.call('POST','/'+task.sessionId+'/cancel',{})
  assert.deepEqual((await app.call('GET',path)).data.agents.filter(a=>a.sessionId).map(a=>a.status),['cancelled','cancelled'])
  const registry=await import(pathToFileURL(join(dir,'registry.mjs')))
  registry.archiveImplementation(undefined)
  assert.equal((await app.call('GET')).data.sessions[0].archiveMode,'unsupported')
  assert.equal((await app.call('POST',path+'/archive',{archived:true})).status,409)
  registry.archiveImplementation(async()=>{throw Error('CLI unavailable')})
  assert.equal((await app.call('POST',path+'/archive',{archived:true})).status,500)
  assert.equal((await app.call('GET')).data.sessions[0].archived,false)
  registry.archiveImplementation(native.setArchived)
  assert.equal((await app.call('POST',path+'/archive',{archived:true})).data.archived,true)
  assert.equal((await app.call('GET')).data.sessions[0].archived,true)
  assert.equal((await app.call('POST',path+'/pin',{pinned:true})).status,409)
  assert.equal((await app.call('POST',path+'/fork',{})).status,409)
  assert.equal((await app.call('POST',path+'/archive',{archived:'yes'})).status,400)
  native.setArchived({remoteId:'remote-session',archived:false})
  assert.equal((await app.call('GET')).data.sessions[0].archived,false)
  native.setArchived({remoteId:'remote-session',archived:true})
  assert.equal((await app.call('POST',path+'/prompt',{text:'archived session'})).status,409)
  stream.emit('close')
  app.dispose()
  const reopened=mount()
  t.after(()=>reopened.dispose())
  assert.equal((await reopened.call('GET',path)).data.messages.length,2)
  assert.equal((await reopened.call('GET')).data.sessions[0].archived,true)
  assert.equal((await reopened.call('POST',path+'/archive',{archived:false})).status,200)
  await writeFile(join(dir,'example.txt'),'one\ntwo\n')
  const preview=await reopened.call('GET',path+'/file?path=example.txt')
  assert.equal(preview.data.text,'one\ntwo\n')
  assert.equal((await reopened.call('GET',path+'/file?path=../outside')).status,403)
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9UvxXt8AAAAASUVORK5CYII='
  await reopened.call('POST',path+'/prompt',{text:'two',attachments:[{name:'dot.png',type:'image',mimeType:'image/png',data}]})
  const picture=(await reopened.call('GET',path)).data.messages.at(-2).attachments[0]
  const attachment='/attachment?key='+picture.previewId
  assert.equal((await reopened.call('GET',path+attachment)).data.data,data)
  assert.equal((await reopened.call('GET','/'+children[0].sessionId+attachment)).status,404)
  assert.equal((await reopened.call('GET',path)).data.messages.at(-1).text,'resumed two')
  assert.equal((await reopened.call('GET',path)).data.title,'Native live title')
  assert.equal((await reopened.call('GET')).data.sessions[0].title,'Native live title')
  await reopened.call('POST',path+'/cancel',{})
  assert.equal((await reopened.call('POST',path+'/prompt',{text:'tool only'})).status,202)
  const toolOnly = (await reopened.call('GET',path)).data.messages.at(-1)
  const tool = {sessionUpdate:'tool_call_update',toolCallId:'read-1',title:'Read',kind:'read',status:'completed',
    locations:[{path:'example.txt',line:2}]}
  assert.deepEqual(toolOnly,{
    role:'assistant',text:'',thought:'Inspect the test fixture',
    tools:[tool],
    steps:[{kind:'thought',text:'Inspect the test fixture'},{kind:'tool',tool}],
  })
  const progressStream = await reopened.call('GET', path+'/events')
  t.after(()=>progressStream.emit('close'))
  assert.equal((await reopened.call('POST', path+'/prompt', {text:'ordered progress'})).status, 202)
  const progressStep = step => step.kind === 'tool' ? step.tool.toolCallId+' '+step.tool.status
    : step.kind === 'plan' ? 'plan '+step.entries[0].status : step.text
  const progressRows = feed => [...feed.messages.slice(feed.messages.findLastIndex(message => message.role === 'user') + 1)
    .flatMap(message => [...(message.steps ?? []).map(progressStep), ...(message.text ? [message.text] : [])]),
    ...projectActivity(feed.updates).steps.map(progressStep)]
  const live = []
  let feed
  for (const frame of progressStream.chunks.filter(frame => frame.startsWith('data:'))) {
    feed = applyEvent(feed, JSON.parse(frame.slice(6)))
    live.push(progressRows(feed))
  }
  assert.ok(live.some(rows => JSON.stringify(rows) === JSON.stringify(['first in_progress','I will inspect.'])))
  assert.ok(live.some(rows => JSON.stringify(rows) === JSON.stringify(['first completed','I will inspect.','plan pending','second completed'])))
  const ordered = ['first completed','I will inspect.','plan completed','second completed','Done.','third completed']
  assert.deepEqual(progressRows(feed),ordered)
  assert.deepEqual(progressRows((await reopened.call('GET', path)).data),ordered)
  progressStream.emit('close')
  assert.equal((await reopened.call('POST',path+'/rename',{title:'  '})).status,400)
  assert.equal((await reopened.call('POST',path+'/pin',{pinned:'yes'})).status,400)
  await reopened.call('POST',path+'/rename',{title:'My session（2）'})
  await reopened.call('POST',path+'/pin',{pinned:true})
  assert.equal((await reopened.call('GET',path)).data.canFork,true)
  const forked=await reopened.call('POST',path+'/fork',{})
  assert.equal(forked.status,201)
  const forkPath='/'+forked.data.id
  const view=(await reopened.call('GET',forkPath)).data
  assert.equal(view.title,'My session（3）')
  assert.equal(view.parentId,undefined)
  assert.deepEqual(view.messages,(await reopened.call('GET',path)).data.messages)
  assert.equal((await reopened.call('GET',forkPath+attachment)).data.data,data)
  reopened.dispose()
  const restored=mount()
  t.after(()=>restored.dispose())
  const original=(await restored.call('GET')).data.sessions.find(item=>item.id===create.data.id)
  assert.equal(original.title,'My session（2）')
  assert.ok(original.pinned && original.pinnedAt && original.canFork)
  await restored.call('POST',forkPath+'/prompt',{text:'fork only'})
  assert.equal((await restored.call('GET',path)).data.messages.length,view.messages.length)
  assert.equal((await restored.call('GET',forkPath)).data.messages.length,view.messages.length+2)
  await restored.call('POST',forkPath+'/cancel',{})
  await restored.call('POST',path+'/pin',{pinned:false})
  assert.equal((await restored.call('GET')).data.sessions.find(item=>item.id===original.id).pinned,false)
  restored.dispose()
  registry.archiveImplementation(undefined)
  const preferences=join(dir,'direct-chat','workspace-state','preferences.json')
  await writeFile(preferences,JSON.stringify([[create.data.id,{archived:true}]]))
  registry.archiveImplementation(native.setArchived)
  const conversion=mount()
  const legacyRow=(await conversion.call('GET')).data.sessions.find(row=>row.id===create.data.id)
  assert.equal(legacyRow.archiveMode,'legacy')
  assert.equal(legacyRow.canNativeArchive,true)
  assert.equal((await conversion.call('POST',path+'/archive',{archived:true})).status,200)
  assert.equal((await conversion.call('GET')).data.sessions.find(row=>row.id===create.data.id).archiveMode,'native')
  native.setArchived({remoteId:'remote-session',archived:false})
  assert.equal((await conversion.call('GET')).data.sessions.find(row=>row.id===create.data.id).archived,false)
  conversion.dispose()
  await writeFile(preferences,JSON.stringify([[create.data.id,{archived:true}]]))
  registry.archiveImplementation(undefined)
  const legacy=mount()
  t.after(()=>legacy.dispose())
  assert.equal((await legacy.call('GET')).data.sessions.find(row=>row.id===create.data.id).archiveMode,'legacy')
  assert.equal((await legacy.call('POST',path+'/archive',{archived:false})).status,200)
  const available=(await legacy.call('GET')).data.sessions.find(row=>row.id===create.data.id)
  assert.equal(available.archived,false)
  assert.equal(available.archiveMode,'unsupported')

  await t.test('rejects malformed Codex commands before recording and serializes accepted commands', async t => {
    const created=await legacy.call('POST','',{engine:'codex',cwd:dir,draft:true})
    assert.equal(created.status,201)
    const path='/'+created.data.id
    const send=text=>legacy.call('POST',path+'/prompt',{text})
    assert.equal((await send('/review base')).status,400)
    assert.equal((await send('/compact unexpected')).status,400)
    assert.deepEqual((await legacy.call('GET',path)).data.messages,[])
    const stream=await legacy.call('GET',path+'/events')
    t.after(()=>stream.emit('close'))
    assert.equal((await send('/compact')).status,202)
    assert.equal((await legacy.call('GET',path)).data.busy,true)
    assert.equal((await send('/review')).status,409)
    assert.equal((await legacy.call('POST',path+'/cancel',{})).status,200)
    const settled=(await legacy.call('GET',path)).data
    assert.equal(settled.busy,false)
    assert.deepEqual(settled.messages.filter(message=>message.role==='user').map(message=>message.text),['/compact'])
    const frames=stream.chunks.filter(frame=>frame.startsWith('data: ')).map(frame=>JSON.parse(frame.slice(6)))
    assert.ok(frames.some(frame=>frame.type==='done' && frame.data.stopReason==='cancelled'))
  })

  await t.test('opening an existing Codex transcript only inspects; the first write attempts resume', async t => {
    const id='held-web-test'
    const messages=[{role:'user',text:'saved message'}]
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId:'held-thread',engine:'codex',cwd:dir,title:'Existing',messages,options:[]}))
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const stream=await viewer.call('GET','/'+id+'/events')
    t.after(()=>stream.emit('close'))
    await new Promise(done=>setImmediate(done))
    const frames=stream.chunks.filter(frame=>frame.startsWith('data: ')).map(frame=>JSON.parse(frame.slice(6)))
    assert.ok(frames.every(frame=>frame.type==='snapshot'))
    assert.deepEqual(frames[0].data.messages,messages)
    assert.deepEqual(frames.at(-1).data.updates.at(-1).update.availableCommands,[{name:'review'}])
    assert.equal(frames.at(-1).data.capabilities.image,true)
    assert.equal(registry.readAttempts,1)
    assert.equal(registry.resumeAttempts,0)
    assert.equal((await viewer.call('POST','/'+id+'/prompt',{text:'continue'})).status,409)
    assert.equal(registry.resumeAttempts,1)
    assert.deepEqual((await viewer.call('GET','/'+id)).data.messages,messages)
  })

  await t.test('loads AGY model choices when an imported transcript already has indexed messages', async t => {
    const remoteId='indexed-agy'
    const id=native.nativeId('agy',remoteId)
    const messages=[{role:'user',text:'indexed question'},{role:'assistant',text:'indexed answer'}]
    native.setIndexedEntry({id,engine:'agy',remoteId,cwd:dir,updatedAt:100})
    native.setRows(messages)
    t.after(()=>{native.setIndexedEntry(undefined);native.setRows([])})
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const stream=await viewer.call('GET','/'+id+'/events')
    t.after(()=>stream.emit('close'))
    await new Promise(done=>setImmediate(done))
    const snapshots=stream.chunks.filter(frame=>frame.startsWith('data: '))
      .map(frame=>JSON.parse(frame.slice(6))).filter(frame=>frame.type==='snapshot')
    assert.deepEqual(snapshots[0].data.messages,messages)
    assert.deepEqual(snapshots.at(-1).data.options[0]?.options[0].options.map(choice=>choice.value),['flash','pro'])
    assert.deepEqual(snapshots.at(-1).data.messages,messages)
    assert.deepEqual(registry.starts.at(-1),{resumeId:remoteId,replayHistory:false})
  })

  await t.test('replays the native AGY transcript when indexed history is empty', async t => {
    const remoteId='unindexed-agy'
    const id=native.nativeId('agy',remoteId)
    native.setIndexedEntry({id,engine:'agy',remoteId,cwd:dir,updatedAt:100})
    t.after(()=>native.setIndexedEntry(undefined))
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const stream=await viewer.call('GET','/'+id+'/events')
    t.after(()=>stream.emit('close'))
    await new Promise(done=>setImmediate(done))
    assert.deepEqual(registry.starts.at(-1),{resumeId:remoteId,replayHistory:true})
    const snapshot=JSON.parse(stream.chunks.at(-1).slice(6))
    assert.deepEqual(snapshot.data.messages,[{role:'assistant',text:'replayed answer'}])
  })

  await t.test('resumes with supported saved options when a previous option value has been removed', async t => {
    const id='saved-agy-options'
    const messages=[{role:'user',text:'saved question'}]
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId:'indexed-agy',engine:'agy',cwd:dir,messages,options:[
      {id:'model',currentValue:'pro'},
      {id:'thought_level',currentValue:'retired-effort'},
      {id:'retired-option',currentValue:'enabled'},
    ]}))
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const stream=await viewer.call('GET','/'+id+'/events')
    t.after(()=>stream.emit('close'))
    await new Promise(done=>setImmediate(done))
    const resumed=(await viewer.call('GET','/'+id)).data
    assert.deepEqual(resumed.messages,messages)
    assert.deepEqual(resumed.options.map(({id,currentValue})=>[id,currentValue]),[['model','pro'],['thought_level','low']])
  })

  await t.test('rebuilds a stale AGY import even when the native timestamp is unchanged', async t => {
    const id=native.nativeId('agy','remote-session')
    const saved=[{role:'assistant',text:'cached replay'}]
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId:'remote-session',engine:'agy',cwd:dir,
      imported:true,sourceModified:100,transcriptVersion:3,messages:saved,options:[]}))
    native.setTitle('AGY history')
    const viewer=mount()
    t.after(()=>viewer.dispose())
    assert.deepEqual((await viewer.call('GET','/'+id)).data.messages,saved)
    const rows=[{role:'user',text:'question'},{role:'assistant',text:'answer'}]
    native.setRows(rows)
    assert.deepEqual((await viewer.call('GET','/'+id)).data.messages,rows)
    native.setTitle(undefined)
  })

  await t.test('preserves web turns saved after a terminal import', async t => {
    const id=native.nativeId('agy','remote-session')
    const messages=[{role:'user',text:'web question',attachments:[{name:'notes.png',previewId:'fixture'}]}]
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId:'remote-session',engine:'agy',cwd:dir,
      imported:true,sourceModified:100,updatedAt:200,transcriptVersion:4,messages,options:[]}))
    native.setTitle('AGY history')
    native.setRows([{role:'user',text:'raw native transcript'}])
    const viewer=mount()
    t.after(()=>viewer.dispose())
    assert.deepEqual((await viewer.call('GET','/'+id)).data.messages,messages)
    native.setTitle(undefined)
  })

  await t.test('moves imported Codex tools after commentary on open and reload without replacing web turns', async t => {
    const remoteId='indexed-codex'
    const id=native.nativeId('codex',remoteId)
    const tools=Array.from({length:5},(_,i)=>({toolCallId:'read-'+i,title:'Read '+i,kind:'read',status:'completed'}))
    const enriched=tools.map((tool,i)=>i===0 ? {...tool,execution:{command:'cat fixture.txt',output:'fixture result',exitCode:0}} : tool)
    const steps=tools.map(tool=>({kind:'tool',tool}))
    const enrichedSteps=enriched.map(tool=>({kind:'tool',tool}))
    const firstTool={toolCallId:'first',title:'Before progress',kind:'read',status:'completed'}
    const firstStep={kind:'tool',tool:firstTool}
    const question={role:'user',text:'Inspect'}
    const progress={role:'assistant',text:'Checking',phase:'commentary',tools:[firstTool],steps:[firstStep]}
    const final={role:'assistant',text:'Done',phase:'final_answer'}
    const webTurn={role:'user',text:'Follow up',attachments:[{name:'notes.png',previewId:'fixture'}]}
    const webReply={role:'assistant',text:'Web reply'}
    const saved=[question,{...progress,tools:[firstTool,...tools],steps:[firstStep,...steps]},{role:'assistant',text:'Done'},webTurn,webReply]
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId,engine:'codex',cwd:dir,
      imported:true,hasWebTurns:true,sourceModified:100,updatedAt:200,transcriptVersion:5,messages:saved,options:[]}))
    native.setIndexedEntry({id,engine:'codex',remoteId,updatedAt:250})
    native.setRows([question,progress,{...final,tools:enriched,steps:enrichedSteps}, {role:'user',text:'Other native turn'}])
    t.after(()=>native.setIndexedEntry(undefined))
    const expected=[question,progress,{role:'assistant',text:'Done',tools:enriched,steps:enrichedSteps},webTurn,webReply]
    const viewer=mount()
    t.after(()=>viewer.dispose())
    assert.deepEqual((await viewer.call('GET','/'+id)).data.messages,expected)
    viewer.dispose()
    const reloaded=mount()
    t.after(()=>reloaded.dispose())
    const stream=await reloaded.call('GET','/'+id+'/events')
    t.after(()=>stream.emit('close'))
    const snapshot=JSON.parse(stream.chunks.find(frame=>frame.startsWith('data:')).slice(6))
    assert.deepEqual(snapshot.data.messages,expected)
  })

  await t.test('coalesces live command output and persists the final snapshot at the original activity position', async t => {
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const created=await viewer.call('POST','',{engine:'agy',cwd:dir})
    const path='/'+created.data.id
    const stream=await viewer.call('GET',path+'/events')
    t.after(()=>stream.emit('close'))
    assert.equal((await viewer.call('POST',path+'/prompt',{text:'stream command'})).status,202)
    const opening=(await viewer.call('GET',path)).data
    assert.deepEqual(opening.updates.map(({update})=>[update.sessionUpdate,update.execution?.output]), [
      ['tool_call_update','19'],
      ['agent_thought_chunk',undefined],
    ])
    await new Promise(resolve=>setTimeout(resolve,75))
    const executionFrames=stream.chunks.filter(frame=>frame.startsWith('data:')).map(frame=>JSON.parse(frame.slice(6)))
      .filter(frame=>frame.type==='update' && frame.data.update.toolCallId==='command')
    assert.deepEqual(executionFrames.map(({data})=>data.update.execution.output),[undefined,'19'])
    assert.equal(JSON.stringify(executionFrames).includes('private data'),false)
    assert.equal((await viewer.call('POST',path+'/cancel',{})).status,200)
    const completed=(await viewer.call('GET',path)).data.messages.at(-1)
    assert.deepEqual(completed.tools[0].execution,{command:'fixture command',output:'final result',exitCode:3})
    assert.deepEqual(completed.steps.map(step=>step.kind),['tool','thought'])
    assert.deepEqual(completed.steps[0].tool,completed.tools[0])
    viewer.dispose()
    const reloaded=mount()
    t.after(()=>reloaded.dispose())
    assert.deepEqual((await reloaded.call('GET',path)).data.messages.at(-1),completed)
  })

  await t.test('repairs a switched Antigravity cache from its original isolated account and a unique command', async t => {
    const profileId='fixture-isolated'
    const remoteId='11111111-1111-1111-1111-111111111111'
    const id='22222222-2222-2222-2222-222222222222'
    const file=join(dir,'direct-chat','profiles','agy',profileId,'.gemini','antigravity-cli','conversation_summaries.db')
    const question={role:'user',text:'Run both fixtures'}
    const tool=(toolCallId,title)=>({sessionUpdate:'tool_call_update',toolCallId,title,kind:'execute',status:'completed'})
    const savedTools=[tool('call_1','echo fixture'),tool('call_2','echo repeated'),tool('call_3','echo repeated')]
    const messages=[question,{role:'assistant',text:'Done',tools:savedTools,steps:savedTools.map(tool=>({kind:'tool',tool}))}]
    const result=(toolCallId,command,output)=>({toolCallId,title:'Run command',kind:'execute',status:'completed',
      execution:{command,output,exitCode:0}})
    const profilesFile=join(dir,'direct-chat','profiles.json')
    await writeFile(profilesFile,JSON.stringify({agy:{list:[{id:profileId,kind:'isolated',name:'Fixture'}]}}))
    await writeFile(join(dir,'direct-chat',id+'.json'),JSON.stringify({id,remoteId,engine:'agy',cwd:dir,
      profileId:'default',agyHistoryProfileId:profileId,updatedAt:200,messages,options:[]}))
    native.setIndexedEntry({id:native.nativeId('agy',remoteId),engine:'agy',remoteId,file:'default-index',updatedAt:250})
    native.setRowsForFile('default-index',[question,{role:'assistant',text:'Done',tools:[result('tool-0','echo fixture','Wrong account')]}])
    native.setRowsForFile(file,[question,{role:'assistant',text:'Done',tools:[
      result('tool-0','echo fixture','Isolated history result'),
      result('tool-1','echo repeated','Ambiguous result'),
    ]}])
    t.after(async ()=>{
      native.setIndexedEntry(undefined)
      native.setRowsForFile(file,undefined)
      native.setRowsForFile('default-index',undefined)
      await rm(profilesFile,{force:true})
    })
    const viewer=mount()
    t.after(()=>viewer.dispose())
    const assistant=(await viewer.call('GET','/'+id)).data.messages.at(-1)
    assert.deepEqual(assistant.tools.map(tool=>tool.execution),[
      {command:'echo fixture',output:'Isolated history result',exitCode:0},undefined,undefined,
    ])
    assert.deepEqual(assistant.steps.map(step=>step.tool),assistant.tools)
  })

  await t.test('native rename preserves overrides on failure, clears title on success, and filters diagnostic payloads', async t => {
    await writeFile(preferences,JSON.stringify([[create.data.id,{title:'Legacy display title',pinnedAt:123}]]))
    const admin=mount()
    t.after(()=>admin.dispose())
    assert.equal((await admin.call('GET',path)).data.title,'Legacy display title')
    registry.renameImplementation(()=>{throw new Error('Fixture native rename failed')})
    assert.equal((await admin.call('POST',path+'/rename',{title:'Native updated title'})).status,500)
    assert.equal((await admin.call('GET',path)).data.title,'Legacy display title')
    registry.renameImplementation(({title})=>native.setTitle(title))
    assert.deepEqual((await admin.call('POST',path+'/rename',{title:'Native updated title'})).data,{id:create.data.id,title:'Native updated title'})
    const renamed=(await admin.call('GET')).data.sessions.find(row=>row.id===create.data.id)
    assert.equal(renamed.renameMode,'native')
    assert.equal(renamed.title,'Native updated title')
    assert.equal(renamed.pinnedAt,123)
    const usageReport=(await admin.call('GET',path+'/usage')).data
    assert.ok(usageReport.observedAt>0)
    assert.deepEqual(usageReport,{observedAt:usageReport.observedAt,stale:false,refreshing:false,refreshFailed:false,status:'available',limits:[
      {label:'5h limit',poolId:'default',poolLabel:'Main pool',windowLabel:'5h',usedPercent:20,resetsAt:1_800_000_000_000},
    ]})
    assert.equal((await admin.call('GET',path+'/usage',undefined,false)).status,401)
    assert.deepEqual((await admin.call('GET',path+'/context')).data,{categories:[]})
    native.setContext({source:'lastRequest',model:'  Fixture model ',used:24,requestTokens:{input:20,output:4,reasoning:-1,internal:999},categories:[
      {name:'  ',tokens:0}, {name:'Invalid',tokens:-1},
    ]})
    const coldReport={source:'lastRequest',model:'Fixture model',used:24,categories:[],requestTokens:{input:20,output:4}}
    assert.deepEqual((await admin.call('GET',path+'/context')).data,coldReport)
    assert.deepEqual((await admin.call('GET','/'+native.nativeId('agy','remote-session')+'/context')).data,coldReport)
    assert.equal((await admin.call('GET',path+'/context',undefined,false)).status,401)
    assert.equal((await admin.call('POST',path+'/configure',{id:'model',value:'model'})).status,200)
    assert.deepEqual((await admin.call('GET',path+'/context')).data,{used:12,size:128,estimated:true,categories:[{name:'Prompt',tokens:12}]})
    registry.renameImplementation(undefined)
    assert.equal((await admin.call('POST',path+'/rename',{title:'Should not be used',mode:'local'})).status,409)
    assert.equal((await admin.call('GET',path)).data.title,'Native updated title')
  })
})
