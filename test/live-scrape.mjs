// 真实番号 → 合成文件名 → 插件 identify → 多来源合并 → NFO；仅写指定的本地报告。
// JSDOM_DIR=... LIVE_REPORT=/tmp/report.json node test/live-scrape.mjs
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {identify} from '../jobs/lib/identify.js'
import {normalizeSettings} from '../jobs/lib/plan.js'
import {buildNFO} from '../ui/lib/nfo.js'
import {env} from './live-http.mjs'
const cases=[
  ['HEYZO-1048','heyzo-1048.mp4','2016-01-02'],
  ['HEYZO-1048','[site.test]heyzo_1048_乱名[2160P][中字]-CD2.mkv','2016-01-02'],
  ['HEYZO-2000','HEYZO.2000-1080p.mp4','2019-05-26'],
  ['SSIS-001','www.example.com@SSIS-001_4K-UC.mp4'],
  ['FC2-PPV-1292936','FC2-PPV-1292936 [1080P].mkv'],
]
const report={at:new Date().toISOString(),mode:'fast',samples:[]}
const settings=normalizeSettings({request_delay_ms:1500,source_parallel:4,no_cache:true})
for(const [number,name,date] of cases){
  const started=Date.now(),logs=[]
  try{
    const result=await identify(env,{name,path:'/synthetic/'+name},'',settings,null,{log:s=>logs.push(s)})
    assert.equal(result.ok,true,result.reason);assert.equal(result.meta.number,number);assert.ok(result.meta.title);assert.ok(result.meta.cover)
    if(date)assert.equal(result.meta.release_date,date)
    if(number==='HEYZO-1048')assert.ok(result.meta.actors.includes('波多野結衣'))
    const nfo=buildNFO(result.meta,{config:settings.nfo});assert.ok(nfo.includes(number))
    report.samples.push({number,name,ok:true,method:result.method,hasTitle:!!result.meta.title,hasCover:!!result.meta.cover,actorCount:result.meta.actors.length,hasActorPhoto:Object.keys(result.meta.actor_photos||{}).length>0,date:result.meta.release_date,sources:result.meta.sources,sourceUrls:result.meta.source_urls,nfo:true,ms:Date.now()-started,errors:logs})
    console.log(JSON.stringify({...report.samples.at(-1),errors:undefined,sourceUrls:undefined}))
  }catch(e){report.samples.push({number,name,ok:false,error:e.message,ms:Date.now()-started,errors:logs});console.log(JSON.stringify(report.samples.at(-1)));process.exitCode=1}
}
if(process.env.LIVE_REPORT)await writeFile(process.env.LIVE_REPORT,JSON.stringify(report,null,2),{flag:'wx'})
