// Small, independent adapters. Public indexes are fetched on demand; no portrait
// collection or identity dataset is bundled.
import { jsonPath } from './engine.js'
import { fileKey } from '../../ui/lib/keys.js'
const HOST = '/api/extensions/v3/local.av-organizer'
export const exactActorName = (a,b) => String(a || '').normalize('NFKC').trim().toLowerCase() === String(b || '').normalize('NFKC').trim().toLowerCase()
const web = value => /^https?:\/\//i.test(String(value || '')) ? String(value) : ''
const list = value => Array.isArray(value) ? value : value == null ? [] : [value]
const contexts = new WeakMap()
const TTL = 7 * 86400000
async function fetchJSON(ctx, url, source = {}) {
  const response = await ctx.http.request({ url, headers: source.headers || {}, timeout_seconds: 30, max_bytes: 16*1024*1024, ...(source.proxy ? {proxy: source.proxy} : {}) })
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
  return JSON.parse(response.body || '{}')
}
export function gfriendsCandidates(tree, names, base = 'https://raw.githubusercontent.com/gfriends/gfriends/master/', aiFix = false) {
  const matches = []
  for (const [folder, files] of Object.entries(tree.Content || {})) for (const [filename, target] of Object.entries(files || {})) {
    if (!names.some(n => exactActorName(filename.replace(/\.(?:jpe?g|png|webp)$/i, ''), n))) continue
    const raw = String(target), [image, query = ''] = raw.split('?')
    // Filetree entries are paths, never executable URLs or traversal paths.
    if (/[\\/]/.test(image) || image === '..' || /[\\/]/.test(folder)) continue
    const name = aiFix ? image : image.replace(/^AI-Fix-/, '')
    matches.push({ image: `${base.replace(/\/$/, '')}/Content/${encodeURIComponent(folder)}/${encodeURIComponent(name)}${query ? '?' + query : ''}`, source: 'gfriends', rank: parseInt(folder,10) || 0 })
  }
  return matches.sort((a,b) => a.rank-b.rank)
}
async function gfriends(ctx, names, source) {
  const base = source.base || 'https://raw.githubusercontent.com/gfriends/gfriends/master/'
  const key = 'actor-index:' + fileKey(base), old = await ctx.storage?.get?.(key)
  let tree = old?.tree
  if (!tree || Date.now() - old.at > (Number(source.cache_days) || 7)*86400000) {
    try { tree = await fetchJSON(ctx, base.replace(/\/$/,'') + '/Filetree.json', source); await ctx.storage?.set?.(key,{at:Date.now(),tree}) }
    catch(e) { if (!tree) throw e; await ctx.task?.log?.('头像索引暂不可用，使用已有缓存') }
  }
  const candidates = gfriendsCandidates(tree, names, base, source.ai_fix)
  return candidates.length ? { image: candidates[0].image, images: candidates.map(v => v.image) } : null
}
export async function databaseActor(ctx, names, source) {
  source={url:'https://github.com/mdc-ng/mdc-ng/releases/download/actress_db/Actress-20231123.db',...source}
  const path = source.path || 'actors/reference.db'
  if (!await ctx.files.call({operation:'exists',path})) {
    if (!web(source.url)) throw new Error('演员数据库不存在，请上传或配置下载地址')
    const temp = path + '.download'
    try {
      const response = await ctx.http.request({url:source.url,save_to:temp,timeout_seconds:120,max_bytes:64*1024*1024,headers:source.headers || {}})
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
      await ctx.api.post(`${HOST}/data/sqlite`,{source:temp}) // validate before publishing cache
      await ctx.files.call({operation:'move',path:temp,destination:path,overwrite:true})
    } finally { await ctx.files.call({operation:'remove',path:temp}).catch(()=>{}) }
  }
  const query = (table, equals, columns) => ctx.api.post(`${HOST}/data/sqlite`,{source:path,table,equals,columns,limit:20})
  // Actress database schema: Names.Alias -> Info.Name. Other SQLite datasets
  // can supply table/column mappings without adding another runtime.
  if (source.table) {
    for (const name of names) {
      const r = await query(source.table,{[source.name_column || 'name']:name})
      const row = r.items?.find(row => names.some(n=>exactActorName(row[source.name_column || 'name'],n)))
      if (row) return {name:row[source.name_column || 'name'], overview:String(row[source.overview_column || 'overview'] || ''), image:web(row[source.image_column || 'image'])}
    }
    return null
  }
  let canonical = ''
  for (const name of names) {
    const aliases = await query('Names',{Alias:name},['Alias','Name','Roma'])
    if (aliases.items?.length === 1) { canonical = aliases.items[0].Name; break }
    const direct = await query('Info',{Name:name},['Name'])
    if (direct.items?.length === 1) { canonical = direct.items[0].Name; break }
  }
  if (!canonical) return null
  const r = await query('Info',{Name:canonical}), row = r.items?.[0]
  if (!row) return null
  if(r.items.length!==1)throw new Error('演员资料库主姓名存在多条记录，需要指定明确资料来源')
  const fields = [['Roma','罗马名'],['Birthday','生日'],['Height','身高'],['Bust','胸围'],['Waist','腰围'],['Hip','臀围'],['Cup','罩杯'],['Birthplace','出生地'],['CareerPeriod','活动时期'],['OfficialSite','官方网站']]
  return {name:canonical, aliases:[canonical,row.Roma].filter(Boolean), overview:fields.filter(([k])=>row[k]).map(([k,label])=>`${label}：${row[k]}`).join('\n'), profile_url:web(row.Href), birthday:row.Birthday}
}
async function wiki(ctx,names,source) {
  const language = /^[a-z-]{2,12}$/.test(source.language || '') ? source.language : 'ja'
  for (const name of names) {
    const endpoint = source.base || `https://${language}.wikipedia.org/w/api.php`
    const data = await fetchJSON(ctx, `${endpoint}?action=query&format=json&redirects=1&prop=extracts%7Cpageimages%7Cpageprops&explaintext=1&exintro=1&pithumbsize=1000&titles=${encodeURIComponent(name)}`, source)
    const accepted = new Set(names.map(n=>n.normalize('NFKC').toLowerCase()))
    for (const redirect of data.query?.redirects || []) if (accepted.has(String(redirect.from).normalize('NFKC').toLowerCase())) accepted.add(String(redirect.to).normalize('NFKC').toLowerCase())
    const page = Object.values(data.query?.pages || {}).find(p=>!('missing' in p) && !Object.hasOwn(p.pageprops || {},'disambiguation') && accepted.has(String(p.title).normalize('NFKC').toLowerCase()))
    if (page && /AV女優|女優|女优|actress|pornographic actor|成人演员/i.test(page.extract || '')) return {name:page.title,overview:page.extract,image:web(page.thumbnail?.source)}
  }
  return null
}
async function htmlActor(ctx,names,source,known) {
  const url = web(source.url?.replaceAll('{name}',encodeURIComponent(names[0])) || known?.profile_url)
  if (!url) return null
  const response = await ctx.http.request({url,headers:source.headers || {},timeout_seconds:30,max_bytes:2*1024*1024})
  if (response.status < 200 || response.status >= 300) return null
  const $ = ctx.html.load(response.body || '',{baseURL:response.url || url})
  const identity = $.find(source.name_selector || 'h1').first().text().trim()
  if (!names.some(n=>exactActorName(n,identity))) return null
  const overview = $.find(source.overview_selector || 'meta[name="description"]').first()
  const image = $.find(source.image_selector || 'meta[property="og:image"]').first()
  const src = image.attr(source.image_attribute || 'content') || image.attr('src') || ''
  return {name:identity,overview:overview.attr('content') || overview.text(),image:src ? web(new URL(src,url).href) : '',headers:{Referer:[url]}}
}
async function jsonActor(ctx,names,source) {
  if(!contexts.has(ctx))contexts.set(ctx,new Map())
  const indexes=contexts.get(ctx)
  for (const name of names) {
    const url=source.url.replaceAll('{name}',encodeURIComponent(name)),key='actor-json-index:'+fileKey(JSON.stringify([url,source.headers || {}]))
    let data
    if(source.url.includes('{name}'))data=await fetchJSON(ctx,url,source)
    else {
      if(!indexes.has(key))indexes.set(key,(async()=>{const old=await ctx.storage?.get?.(key);if(old && Date.now()-old.at<86400000)return old.value;const value=await fetchJSON(ctx,url,source);await ctx.storage?.set?.(key,{at:Date.now(),value});return value})().catch(e=>{indexes.delete(key);throw e}))
      data=await indexes.get(key)
    }
    const candidates = list(source.items_path ? jsonPath(data,source.items_path) : data)
    const hits = candidates.filter(row=>names.some(n=>exactActorName(jsonPath(row,source.name_path || 'name'),n)))
    if (hits.length !== 1) continue // Ambiguity must not overwrite a person's portrait.
    const row = hits[0]
    return {name:jsonPath(row,source.name_path || 'name'),overview:jsonPath(row,source.overview_path || 'overview') || '',image:web(jsonPath(row,source.image_path || 'image')),headers:source.image_headers || {}}
  }
  return null
}
export async function findActor(ctx,name,sources,options = {}) {
  const aliases = options.aliases?.[name], names = [...new Set([name,...list(aliases)].map(String).filter(Boolean))]
  const configured = sources.filter(s=>s.enabled !== false && (s.url || s.type || s.path))
  const cacheKey = 'actor:' + fileKey(JSON.stringify([name,configured,options.aliases || {}]))
  const cached = await ctx.storage?.get?.(cacheKey)
  if (!options.no_cache && cached?.value && Date.now()-cached.at<TTL) return cached.value
  const merged = {name,overview:'',image:'',images:[],sources:[],field_sources:{}}
  for (const source of configured) {
    try {
      const type = source.type || 'json'
      const value = type === 'sqlite' ? await databaseActor(ctx,names,source) : type === 'gfriends' ? await gfriends(ctx,names,source) : type === 'wiki' ? await wiki(ctx,names,source) : ['html','minnano','graphis'].includes(type) ? await htmlActor(ctx,names,source,merged) : await jsonActor(ctx,names,source)
      if (!value) continue
      for (const alias of value.aliases || []) if (!names.some(n=>exactActorName(n,alias))) names.push(alias)
      for (const field of ['overview','image','profile_url','birthday']) if (!merged[field] && value[field]) { merged[field]=value[field]; merged.field_sources[field]=source.name || type; if(field==='image') merged.headers=value.headers || {} }
      merged.images.push(...list(value.images || value.image).filter(Boolean)); merged.sources.push(source.name || type)
    } catch(e) { await ctx.task?.log?.(`演员资料来源 ${source.name || source.type || 'JSON'} 失败：${e.message || e}`) }
  }
  if (!merged.overview && !merged.image) return null
  merged.images=[...new Set(merged.images)]; merged.aliases=names
  await ctx.storage?.set?.(cacheKey,{at:Date.now(),value:merged})
  return merged
}
