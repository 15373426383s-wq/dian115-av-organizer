import { processArtwork, HOST } from './enrich.js'
// Candidates retain provenance and download independently: a broken preferred
// source must not prevent a verified alternate source from supplying artwork.
export async function prepareArtwork(ctx, env, meta, parsed, settings, staging, log, onProgress) {
  const config=settings.image_selection || {}, byURL=new Map(), rejected=new Set(), options=settings.image_options || {}
  const candidates=field=>[...(meta.artwork_candidates?.[field] || []),...(meta[field]?[{url:meta[field],referer:meta.source_url || ''}]:[])].filter((v,i,a)=>/^https?:\/\//i.test(v.url || '') && a.findIndex(x=>x.url===v.url)===i).slice(0,16)
  async function get(item) {
    if(rejected.has(item.url))return null
    if(byURL.has(item.url))return byURL.get(item.url)
    const work=(async()=>{
      const path=`${staging}/raw-${byURL.size}`
      try {
        await onProgress?.('图片')
        const response=await env.get(item.url,{save_to:path,headers:item.referer?{Referer:[item.referer]}:{},max_bytes:32*1024*1024})
        if(response.status<200 || response.status>=300)throw new Error(`HTTP ${response.status}`)
        if ((config.reject_hashes || []).some(h=>String(h).toLowerCase()===String(response.sha256 || '').toLowerCase())) throw new Error('占位图片已过滤')
        const info=await ctx.api.post(`${HOST}/media/image`,{source:path,inspect:true})
        if(info.width<(Number(config.minimum_width)||120) || info.height<(Number(config.minimum_height)||120))throw new Error('图片尺寸过小')
        return {path,url:item.url,...info,bytes:Number(response.size)||0}
      }catch(e){await log(`图片候选失败：${e.message || e}`);return null}
    })()
    byURL.set(item.url,work);return work
  }
  async function choose(items){
    const found=[]
    for(const item of items){const value=await get(item);if(value){found.push(value);if(config.strategy!=='size' && config.strategy!=='resolution')return value}}
    return found.sort((a,b)=>config.strategy==='size'?b.bytes-a.bytes:b.width*b.height-a.width*a.height)[0] || null
  }
  const cover=await choose(candidates('cover')), poster=options.poster===false?null:await choose(candidates('poster'))
  const chosen={fanart:cover || poster,thumb:cover || poster,poster:poster || cover}
  if(config.prefer_crop_quality && cover && poster && Math.min(cover.width,cover.height*(Number(options.ratio)||2/3))*cover.height > poster.width*poster.height)chosen.poster=cover
  const result={}
  for(const target of ['fanart','poster','thumb']) {
    if(options[target]===false || (target==='thumb' && !options.thumb) || !chosen[target])continue
    const alternatives=target==='poster'?[...candidates('poster'),...candidates('cover')]:[...candidates('cover'),...candidates('poster')]
    const posterURLs=new Set(candidates('poster').map(item=>item.url))
    let value=rejected.has(chosen[target].url)?await choose(alternatives):chosen[target]
    while(value){
      try {
        const artMeta={...meta,poster:target==='poster' && posterURLs.has(value.url)?value.url:'',cover:cover?.url || ''}
        const path=await processArtwork(ctx,value.path,`${staging}/processed-${target}.jpg`,target,artMeta,parsed,settings,log)
        result[target]={path,url:value.url};break
      }catch(e){
        // Header inspection is cheap and does not validate the compressed pixels.
        // A decode failure must still try the next source, including cached candidates.
        rejected.add(value.url);await log(`${target} 图片处理失败，尝试其他候选：${e.message || e}`)
        value=await choose(alternatives)
      }
    }
  }
  return result
}
