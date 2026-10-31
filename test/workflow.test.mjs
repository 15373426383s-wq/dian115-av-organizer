import test from 'node:test'
import assert from 'node:assert/strict'
import {renderText,evaluateCondition} from '../ui/lib/templates.js'
import {parseName} from '../ui/lib/number.js'
import {enrichFileContext} from '../jobs/lib/file-context.js'
import {prepareArtwork} from '../jobs/lib/artwork.js'
import {findActor,gfriendsCandidates,databaseActor} from '../jobs/lib/actor-providers.js'
import {sendWebhooks} from '../jobs/lib/enrich.js'
import {editMetadata,translateFields} from '../jobs/lib/metadata.js'
import {cleanupCandidates} from '../jobs/lib/cleanup.js'
import {planFile,normalizeSettings,resolveDestination} from '../jobs/lib/plan.js'
import {sameArtworkIdentity} from '../jobs/lib/supplemental-art.js'
import {run} from '../jobs/organize.js'
const log=async()=>{}
test('template loops, macros, sets and index expressions have bounded work',()=>{
  assert.equal(renderText('{% set x = ["A","B"] %}{% for actor in x %}{{loop.index}}:{{actor}};{% endfor %}'),'1:A;2:B;')
  assert.equal(renderText('{% macro f(n) %}{{n|lower}}{% endmacro %}{{f("ABC")}}'),'abc')
  assert.equal(renderText('{% for x in range(3) %}{{x}}{% endfor %}'),'012')
  assert.equal(evaluateCondition('status == "success" and metadata.number == "ABC-123"',{status:'success',metadata:{number:'ABC-123'}}),true)
  assert.throws(()=>renderText('{% for x in range(10000000) %}x{% endfor %}'),/限制|1000/)
  assert.throws(()=>renderText('{{ "a" * 10000000 }}'),/过长/)
  assert.throws(()=>renderText('{% macro f() %}{{f()}}{% endmacro %}{{f()}}'),/限制|stack/i)
  assert.throws(()=>renderText('{{ obj.constructor }}',{obj:{}}),/内部/)
  assert.throws(()=>renderText('{{ "x" | indent(width=1000000000) }}'),/限制/)
  assert.equal(renderText('{{ ([1,2] * 2) | tojson }}'),'[1,2,1,2]')
})
test('FC2 extras and sibling C disambiguation do not change a lone subtitle suffix',()=>{
  const make=name=>({name,path:'/in/'+name})
  const c=make('ABC-123-C.mp4')
  assert.equal(enrichFileContext(parseName(c.name),c,[make('ABC-123-A.mp4')]).part,3)
  assert.equal(enrichFileContext(parseName(c.name),c,[]).flags.chinese,true)
  assert.ok(enrichFileContext(parseName('FC2-PPV-123456-SP2.mp4'),make('FC2-PPV-123456-SP2.mp4')).extra)
  assert.equal(enrichFileContext(parseName(c.name),{...c,path:'/无码破解/'+c.name}).flags.cracked,true)
})
test('artwork falls back on corrupt preferred source, deduplicates downloads and chooses real quality',async()=>{
  const downloads=[],sizes=new Map(),ctx={api:{post:async(_,r)=>r.inspect?sizes.get(r.source):{}}}
  const env={get:async(url,r)=>{downloads.push(url);sizes.set(r.save_to,{width:url.endsWith('large')?2000:500,height:1500});return {status:url.endsWith('bad')?403:200,size:url.endsWith('large')?200000:30000,sha256:'good'}}}
  const meta={number:'ABC-123',artwork_candidates:{cover:[{url:'https://test/bad'},{url:'https://test/small'},{url:'https://test/large'}]}}
  const settings=normalizeSettings({image_selection:{strategy:'resolution'},image_options:{thumb:true}})
  const result=await prepareArtwork(ctx,env,meta,{flags:{}},settings,'staging/a',log)
  assert.equal(result.poster.url,'https://test/large');assert.equal(downloads.length,3);assert.equal(Object.keys(result).length,3)
})
test('a valid image header with corrupt pixels falls back during processing and is not retried for other targets',async()=>{
  const downloaded=new Map(),processed=[],logs=[]
  const ctx={api:{post:async(_,r)=>{
    if(r.inspect)return {width:1500,height:2250}
    const url=downloaded.get(r.source);processed.push(url)
    if(url.endsWith('/broken'))throw new Error('invalid compressed pixels')
    return {image:{width:1200,height:1800}}
  }}}
  const env={get:async(url,r)=>{downloaded.set(r.save_to,url);return {status:200,size:1000}}}
  const settings=normalizeSettings({image_options:{thumb:true}})
  const result=await prepareArtwork(ctx,env,{artwork_candidates:{cover:[{url:'https://test/broken'},{url:'https://test/good'}]}},{flags:{}},settings,'staging/b',s=>logs.push(s))
  assert.deepEqual(Object.keys(result).sort(),['fanart','poster','thumb'])
  assert.ok(Object.values(result).every(item=>item.url==='https://test/good'))
  assert.equal(processed.filter(url=>url.endsWith('/broken')).length,1)
  assert.equal(downloaded.size,2)
  assert.equal(logs.length,1)
})
test('actors merge missing fields while rejecting ambiguous identities and aliases are exact',async()=>{
  const ctx={http:{request:async r=>({status:200,body:JSON.stringify(r.url.includes('/bio')?{name:'Alias',overview:'Biography'}:r.url.includes('/wrong')?{name:'Alias 2',image:'https://bad/image'}:{name:'Primary',image:'https://good/image'})})}}
  const result=await findActor(ctx,'Primary',[{url:'https://test/bio'},{url:'https://test/wrong'},{url:'https://test/image'}],{aliases:{Primary:['Alias']}})
  assert.equal(result.overview,'Biography');assert.equal(result.image,'https://good/image')
  const index={Content:{'1-Studio':{'Primary.jpg':'Primary.jpg?t=123','Other.jpg':'Other.jpg'},'2-Studio':{'Alias.jpg':'AI-Fix-Alias.jpg'}}}
  assert.equal(gfriendsCandidates(index,['Alias'])[0].image,'https://raw.githubusercontent.com/gfriends/gfriends/master/Content/2-Studio/Alias.jpg')
})
test('SQLite actor lookup follows exact alias to canonical info using structured filters',async()=>{
  const calls=[],ctx={files:{call:async()=>true},api:{post:async(_,r)=>{calls.push(r);return {items:r.table==='Names'?[{Alias:'Alias',Name:'Canonical'}]:[{Name:'Canonical',Birthday:'2000-01-01',Height:160,Href:'https://example.test/profile'}]}}}}
  const result=await databaseActor(ctx,['Alias'],{path:'actor.db'})
  assert.deepEqual(calls[0].equals,{Alias:'Alias'});assert.deepEqual(calls[1].equals,{Name:'Canonical'});assert.match(result.overview,/160/)
})
test('webhooks apply conditions, JSON escaping and URL encoding without rewriting literals',async()=>{
  const requests=[],errors=[],ctx={http:{request:async r=>{requests.push(r);return {status:200}}}}
  await sendWebhooks(ctx,{webhooks:[{url:'https://test/hook?q={{title}}',condition:'status == "success"',body:'{"title":{{title | tojson}}}'},{url:'https://test/no',condition:'status == "failure"'}]},{status:'success',title:'A "B" / C'},s=>errors.push(s))
  assert.equal(errors.length,0);assert.equal(requests.length,1);assert.match(requests[0].url,/%22B%22%20%2F/);assert.equal(JSON.parse(requests[0].body).title,'A "B" / C')
})
test('translation adapters retain array fields and require complete responses',async()=>{
  const ctx={http:{request:async()=>({status:200,body:'{"translations":[{"text":"标题"},{"text":"演员"}]}'})}}
  const r=await translateFields(ctx,{number:'ABC-123'},{title:'Title',actors:['Actor']},{metadata_options:{translation_engine:'deepl'},translation:{}})
  assert.deepEqual(r.values,{title:'标题',actors:['演员']})
  await assert.rejects(translateFields(ctx,{}, {title:'Title'},{metadata_options:{translation_engine:'deepl'},translation:{}}),/缺少/)
  assert.throws(()=>editMetadata({number:'ABC-123'},{number:'ABC-999'}),/不一致/)
})
test('source cleanup protects subtitles, young/unknown age and files outside inbox',()=>{
  const files=['small.mp4','keep.srt','delete.txt'].map(name=>({name,path:'/in/'+name,size:1,modified:'2020-01-01'}))
  files.push({name:'bad.txt',path:'/elsewhere/bad.txt',size:1,modified:'2020-01-01'},{name:'new.txt',path:'/in/new.txt',size:1})
  const settings=normalizeSettings({inbox:'/in',cleanup_source:{enabled:true,small:true,unknown_extension:true}})
  assert.deepEqual(cleanupCandidates(files,settings).map(f=>f.name),['small.mp4','delete.txt'])
})
test('naming respects character limit, custom part labels and prefixless artwork',()=>{
  const settings=normalizeSettings({inbox:'/in',local_target:'/out',dir_template:'{number} {title}',naming:{folder_max_chars:14,image_prefix:false,part_template:'-{part_letter}'}})
  const plan=planFile({name:'ABC-123-CD2.mp4',path:'/in/ABC-123-CD2.mp4'},{number:'ABC-123',part:2,flags:{}},{number:'ABC-123',title:'abcdefghijklmnopqrst'},settings,resolveDestination(settings))
  assert.equal(plan.posterName,'poster.jpg');assert.equal(plan.base,'ABC-123-B');assert.ok(plan.relativeDir.length<=14)
  assert.equal(sameArtworkIdentity('Not ABC-1234',{number:'ABC-123'}),false)
})
test('existing NFO and manual metadata can organize without a scraper request',async()=>{
  const kv=new Map(),ops=[],file={name:'ABC-123.mp4',path:'/in/ABC-123.mp4',size:100,modified:'2020-01-01'}
  const ctx={settings:{get:async()=>({inbox:'/in',local_target:'/out',action_mode:'from_nfo',min_size_mb:0,stable_seconds:0,download_images:false,emby_refresh:false})},storage:{get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,structuredClone(v)),remove:async k=>kv.delete(k)},files:{call:async r=>{ops.push(r);return r.operation==='walk'?[file]:r.operation==='exists'?false:{}}},api:{post:async(path)=>{assert.match(path,/media\/nfo$/);return {number:'ABC-123',title:'Existing',actors:['Actor']}}},http:{cookies:async()=>{},request:async()=>{throw new Error('unexpected scrape')}},task:{id:'test',update:log,log,checkpoint:log},sleep:log}
  const result=await run(ctx);assert.equal(result.success,1);assert.ok(ops.find(r=>r.operation==='move' && r.path===file.path));assert.equal(kv.get('history')[0].method,'nfo')
})

test('configuration export redacts credentials including serialized source configuration',async()=>{
 const {configExport}=await import('../ui/views/config-tools.js')
 const exported=configExport({source_config:'{"source":{"cookie":"secret","token":"token","base":"https://example.test"}}',metadata_options:{translation_key:'key'},inbox:'/in'})
 const text=JSON.stringify(exported);assert.doesNotMatch(text,/secret|\\"token\\":\\"token|"key"/);assert.match(text,/example.test/)
 assert.deepEqual(configExport({inbox:'/in',dir_template:'{number}'},'naming').settings,{dir_template:'{number}'})
})
test('per-file 预算只在检查点拦截，不动宿主对象', async () => {
  const { fileDeadline } = await import('../jobs/lib/deadline.js')
  let now = 0, calls = 0
  const ctx = { api: {}, http: {}, files: { call: async () => { calls++; return 'written' } } }
  const budget = fileDeadline(ctx, { get: async () => ({ status: 200 }) }, 1, () => now)
  // 未到点：正常调用，且 ctx 未被替换
  assert.equal(budget.ctx, ctx)
  assert.equal(await budget.ctx.files.call({ operation: 'move' }), 'written')
  now = 2000
  // 到点：检查点拒绝继续，调用方不会再去动文件
  assert.throws(() => budget.check(), /超过/)
  assert.equal(calls, 1)
})
