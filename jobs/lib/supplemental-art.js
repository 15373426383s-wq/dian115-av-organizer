import {parseName,sameNumber} from '../../ui/lib/number.js'
import { runSource } from './engine.js'
const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
export function sameArtworkIdentity(text,meta) {
  const hay=compact(text), number=compact(meta.number)
  const parsed=parseName(String(text || '')), codes=[parsed.number,...(parsed.candidates || [])].filter(Boolean)
  if(codes.length)return codes.some(code=>sameNumber(code,meta.number))
  const title=compact(meta.original_title || meta.title)
  return title.length>=12 && hay.includes(title) && (meta.actors || []).some(actor=>compact(actor).length>=2 && hay.includes(compact(actor)))
}
async function html(env,url){const r=await env.get(url,{max_bytes:4*1024*1024});if(r.status<200 || r.status>=300)throw new Error(`HTTP ${r.status}`);return env.html.load(r.body || '',{baseURL:r.url || url})}
export async function supplementalArtwork(env,meta,settings,log) {
  const config=settings.image_selection || {}, results=[]
  for(const def of (config.supplemental_sources || []).slice(0,8)) {
    try { const result=await runSource(env,def,meta.number);if(result?.poster || result?.cover)results.push({url:result.poster || result.cover,source:def.id,referer:result.source_url}) }
    catch(e){await log(`补充图片来源 ${def.name || def.id}：${e.message || e}`)}
  }
  if(config.amazon) {
    try {
      const base=config.amazon_base || 'https://www.amazon.co.jp'
      const search=await html(env,`${base}/s?k=${encodeURIComponent([meta.number,meta.original_title || meta.title,'DVD'].join(' '))}`)
      const links=[]
      search.find('[data-component-type="s-search-result"]').each(node=>{
        if(!sameArtworkIdentity(node.text(),meta))return
        const href=node.find('h2 a, a.a-link-normal.s-no-outline').first().attr('href')
        if(href)links.push(new URL(href,base).href)
      })
      for(const url of links.slice(0,3)) {
        const page=await html(env,url), title=page.find('#productTitle').text()
        if(!sameArtworkIdentity(title,meta))continue
        const image=page.find('#imgBlkFront, #landingImage').first()
        let choices=[]
        try{choices=Object.entries(JSON.parse(image.attr('data-a-dynamic-image') || '{}')).sort((a,b)=>b[1][0]*b[1][1]-a[1][0]*a[1][1]).map(([u])=>u)}catch{}
        const source=image.attr('data-old-hires') || choices[0] || image.attr('src')
        if(source)results.push({url:new URL(source,url).href,source:'amazon',referer:url})
      }
    }catch(e){await log(`高清海报查询失败：${e.message || e}`)}
    if(config.amazon_strict && !results.some(r=>r.source==='amazon'))throw new Error('没有身份匹配的 Amazon 高清海报')
  }
  return {...meta,artwork_candidates:{...meta.artwork_candidates,poster:[...results,...(meta.artwork_candidates?.poster || [])]}}
}
