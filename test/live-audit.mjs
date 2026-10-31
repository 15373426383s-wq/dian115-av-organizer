// 全来源联网审计。仅取元数据和封面；不提交下载、整理或账号变更。
// LIVE_AGE_CONFIRM=1 仅在用户已明确同意年龄确认时使用。
// JSDOM_DIR=... LIVE_AUDIT_DIR=/tmp/audit node test/live-audit.mjs [来源...]
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {PRESETS} from '../ui/lib/presets.js'
import {runSource,sameCode} from '../jobs/lib/engine.js'
import {mapPool} from '../jobs/lib/pool.js'
import {createLiveEnv} from './live-http.mjs'
import {SOURCE_SAMPLES} from './source-samples.mjs'
const root=resolve(process.env.LIVE_AUDIT_DIR || '/tmp/av-source-audit-'+Date.now())
await mkdir(root,{recursive:true});await mkdir(root+'/responses',{recursive:true});await mkdir(root+'/images',{recursive:true})
const ageConfirmed=process.env.LIVE_AGE_CONFIRM==='1',only=process.argv.slice(2)
function classify(error){const s=String(error);return /填写令牌|HTTP 401/.test(s)?'auth':/人工答题/.test(s)?'human_verification':/年龄验证/.test(s)?'gated':/地区/.test(s)?'region':/防护验证/.test(s)?'protected':/维护|HTTP 5\d\d/.test(s)?'down':/fetch failed|timeout|timed out|aborted/i.test(s)?'network':'error'}
const sources=await mapPool(PRESETS.filter(s=>!only.length||only.includes(s.id)),3,async def=>{
  const env=createLiveEnv({onResponse:async(r,url)=>{
    const name=def.id+'-'+createHash('sha256').update(url).digest('hex').slice(0,16)
    await writeFile(root+'/responses/'+name+'.txt',r.body)
  }});env.ageConfirm=ageConfirmed
  if(ageConfirmed)for(const part of String(def.age_cookie||'').split(';').filter(Boolean))await env.setCookie(def.base,part.trim())
  const samples=[]
  for(const number of SOURCE_SAMPLES[def.id]||['SSIS-001']){
    const start=Date.now(),traceStart=env.trace.length
    try{
      const meta=await runSource(env,def,number,{vars:{token:process.env.TPDB_TOKEN||''}})
      if(!meta){samples.push({number,status:'not_found',ms:Date.now()-start,requests:env.trace.slice(traceStart)});continue}
      const missing=['title','cover','release_date'].filter(k=>!meta[k])
      if(!sameCode(meta.number,number))missing.push('number')
      const row={number,returnedNumber:meta.number,status:missing.length?'partial':'metadata',missing,hasTitle:!!meta.title,hasCover:!!meta.cover,hasPlot:!!meta.plot,actors:meta.actors?.length||0,actorPhotos:Object.keys(meta.actor_photos||{}).length,date:meta.release_date,runtime:meta.runtime||0,url:meta.source_url,ms:Date.now()-start,requests:env.trace.slice(traceStart)}
      if(meta.cover){
        try{
          const response=await env.requestBytes(meta.cover,{headers:{Referer:[meta.source_url]},max_bytes:32*1024*1024})
          const file=`images/${def.id}-${number.toLowerCase()}.bin`
          row.image={status:response.status,contentType:response.headers['content-type'],bytes:response.bytes.length,url:response.url}
          if(response.status>=200&&response.status<300){await writeFile(root+'/'+file,response.bytes);row.image.file=file}else row.image.error=`HTTP ${response.status}`
        }catch(e){row.image={error:e.message}}
      }
      samples.push(row)
    }catch(e){samples.push({number,status:classify(e.message),error:e.message,ms:Date.now()-start,requests:env.trace.slice(traceStart)})}
  }
  const result={source:def.id,name:def.name,samples}
  await writeFile(root+'/'+def.id+'.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({source:def.id,samples:samples.map(s=>({number:s.number,status:s.status,runtime:s.runtime,actors:s.actors,cover:s.image?.status,error:s.error||s.image?.error,missing:s.missing}))}))
  return result
})
const report={at:new Date().toISOString(),ageConfirmed,sources}
await writeFile(root+'/report.json',JSON.stringify(report,null,2));console.log('Report: '+root+'/report.json')
