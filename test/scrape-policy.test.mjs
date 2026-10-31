import test from 'node:test'
import assert from 'node:assert/strict'
import {scrape} from '../jobs/lib/scrape.js'
import {sourcesForNumber,sourcePlan} from '../ui/lib/registry.js'
import {prepareSourceCookies} from '../jobs/lib/sources.js'
import {scrapeEnv} from '../jobs/organize.js'
import {normalizeSettings} from '../jobs/lib/plan.js'
const parsed={number:'HEYZO-1048',kind:'heyzo'}
const def=id=>({id,name:id,custom:true,base:'https://'+id+'.test',type:'json',kinds:['heyzo'],detail:{url:'{base}/{number}'},fields:{number:{json:'number'},title:{json:'title'},cover:{json:'cover'},plot:{json:'plot'}}})
const make=()=>{
  const values=new Map(),calls=[]
  const cache={get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)}
  const env={base:(id,base)=>base,pause:async()=>{},scrapes:new Map(),extraDefs:[def('first'),def('second')],get:async(url)=>{calls.push(url);return {status:200,url,body:JSON.stringify({number:'HEYZO-1048',title:url.includes('first')?'First':'Second',cover:'https://images.test/cover.jpg'})}}}
  const settings={source_config:{first:{enabled:true},second:{enabled:false}}}
  return {env,cache,values,calls,settings}
}
test('刮削结果只在来源定义、配置及要求一致时复用缓存',async()=>{
  const {env,cache,calls,settings}=make()
  await scrape(env,parsed,settings,cache); env.scrapes.clear()
  assert.equal((await scrape(env,parsed,settings,cache)).cached,true);assert.equal(calls.length,1)
  const result=await scrape(env,parsed,{...settings,source_config:{first:{enabled:false},second:{enabled:true}}},cache)
  assert.equal(result.meta.title,'Second');assert.equal(calls.length,2)
})
test('自定义规则、镜像和认证变化都会使旧缓存失效，缓存不含凭据原文',async()=>{
  const {env,cache,calls,settings,values}=make()
  await scrape(env,parsed,settings,cache);env.scrapes.clear()
  env.extraDefs[0]={...env.extraDefs[0],fields:{...env.extraDefs[0].fields,plot:{template:'New rule'}}}
  assert.equal((await scrape(env,parsed,settings,cache)).meta.plot,'New rule')
  const next={...settings,source_config:{first:{enabled:true,base:'https://mirror.test',cookie:'secret_cookie=abc',token:'secret_token'}}}
  await scrape(env,parsed,next,cache)
  assert.equal(calls.length,3);assert.match(calls[2],/mirror.test/)
  assert.ok(!JSON.stringify([...values.values()]).includes('secret_'))
})
test('新增必需字段或切换完整模式时重新刮削',async()=>{
  const {env,cache,calls,settings}=make();await scrape(env,parsed,settings,cache)
  await scrape(env,parsed,{...settings,required_fields:['plot']},cache)
  assert.equal(calls.length,2)
  await scrape(env,parsed,{...settings,scrape_mode:'full'},cache);assert.equal(calls.length,3)
})
test('过期、旧格式和不完整缓存不挡住修复后的来源',async()=>{
  for(const at of [Date.now(),0]){
    const {env,cache,values,calls,settings}=make()
    values.set(parsed.number,{at,policy:'["",{},""]',meta:{number:parsed.number,title:'Old',cover:'https://images.test/a.jpg'}})
    assert.equal((await scrape(env,parsed,settings,cache)).meta.title,'First');assert.equal(calls.length,1)
    const cached=values.get(parsed.number);cached.meta.cover='';env.scrapes.clear()
    await scrape(env,parsed,settings,cache);assert.equal(calls.length,2)
  }
})
test('并发同号只查一次，失败不永久占据本批去重记录',async()=>{
  const {env,cache,calls,settings}=make()
  const result=await Promise.all([scrape(env,parsed,settings,cache),scrape(env,parsed,settings,cache)])
  assert.equal(calls.length,1);assert.equal(result[0].meta.title,result[1].meta.title)
  env.scrapes.clear();env.get=async()=>({status:503,body:'',url:'https://first.test'})
  const options={...settings,no_cache:true}
  assert.equal((await scrape(env,parsed,options,cache)).meta,null);assert.equal(env.scrapes.size,0)
  env.get=async url=>({status:200,url,body:JSON.stringify({number:parsed.number,title:'Recovered',cover:'https://images.test/a.jpg'})})
  assert.equal((await scrape(env,parsed,options,cache)).meta.title,'Recovered')
})
test('标题有值但缺封面的结果不进入七天缓存',async()=>{
  const {env,cache,values,settings}=make()
  env.get=async url=>({status:200,url,body:JSON.stringify({number:parsed.number,title:'Partial'})})
  assert.equal((await scrape(env,parsed,settings,cache)).meta.title,'Partial')
  assert.equal(values.size,0);assert.equal(env.scrapes.size,0)
})
test('快速模式当前波次失败后继续备用来源，并保留来源禁用选择',async()=>{
  const {env,cache,settings,calls}=make();settings.source_parallel=1;settings.source_config.second.enabled=true
  const original=env.get;env.get=async url=>url.includes('first')?{status:403,url,body:'Forbidden'}:original(url)
  const result=await scrape(env,parsed,settings,cache)
  assert.equal(result.meta.title,'Second');assert.equal(result.errors.length,1);assert.equal(calls.length,1)
  const ids=sourcesForNumber({},parsed).map(i=>i.def.id)
  for(const id of ['avsox','freejavbt','mmtv','airav_io'])assert.ok(ids.includes(id))
  assert.deepEqual(sourcesForNumber({source_config:{javbus:{enabled:true},avsox:{enabled:false}}},parsed).map(i=>i.def.id),['javbus'])
  assert.equal(sourcesForNumber({source_order:'mmtv,javbus,avsox'},parsed)[0].def.id,'mmtv')
  assert.equal(sourcesForNumber({source_order:'mmtv,javbus,avsox',category_source_order:{heyzo:['avsox']}},parsed)[0].def.id,'avsox')
})
test('单来源检测可准备停用来源 Cookie，用户 Cookie 优先于默认年龄值',async()=>{
  const calls=[]
  await prepareSourceCookies({http:{cookies:async x=>calls.push(x)}},{age_confirm:true,__only_source:'javdb',source_config:{javdb:{enabled:false,cookie:'over18=custom; session=user'}}},'scrape')
  assert.equal(calls.length,1);assert.equal(calls[0].cookie,'over18=custom; session=user')
})
test('来源 Cookie 与单来源检测支持临时规则',async()=>{
  const calls=[]
  await prepareSourceCookies({http:{cookies:async x=>calls.push(x)}},{age_confirm:true,__only_source:'extra',source_config:{extra:{enabled:false}}},'scrape',()=>{},[{...def('extra'),age_cookie:'accepted=yes'}])
  assert.equal(calls[0].url,'https://extra.test');assert.equal(calls[0].cookie,'accepted=yes')
})
test('宿主 HTTP 复用 JSON、会话、代理；正常页面不误调用渲染',async()=>{
  const calls=[],render=[]
  let response={status:200,body:'<html><script src="https://static.cloudflareinsights.com/beacon.min.js"></script></html>'}
  const ctx={html:{},sleep:async()=>{},http:{cookies:async()=>{},request:async o=>{calls.push(o);return response},render:async o=>{render.push(o);return {status:200,body:'Rendered'}}}}
  const e=await scrapeEnv(ctx,normalizeSettings({flaresolverr_endpoint:'http://render.test',proxy:'http://proxy.test',age_confirm:true,source_config:{javbus:{enabled:true}}}))
  await e.get('https://site.test',{method:'POST',json:[1,'cn']});assert.equal(render.length,0);assert.deepEqual(calls[0].json,[1,'cn']);assert.equal(calls[0].session,'scrape');assert.equal(calls[0].proxy,'http://proxy.test');assert.equal(e.ageConfirm,true)
  response={status:200,body:'<title>Just a moment...</title>'};await e.get('https://site.test');assert.equal(render.length,1)
})
