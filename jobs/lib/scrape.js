// 多来源刮削与合并：
//   快速模式：按顺序查询，资料齐全（标题、封面，有码还要演员）就停止；
//   完整模式：查询所有适用来源（最多 max_sources 个），再按字段优先级合并。
// 任何来源返回的番号都必须与查询一致（引擎内核对）。

import { sameNumber } from './shared/number.js'
import { fieldPriority } from './shared/registry.js'
import { sourcesForNumber, runPlanItem } from './sources.js'
import { mapPool } from './pool.js'
import { fileKey } from './shared/keys.js'

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000
const SCALAR_FIELDS = ['number', 'title', 'original_title', 'plot', 'release_date', 'runtime', 'studio', 'label', 'series', 'director', 'cover', 'poster', 'trailer', 'rating', 'votes', 'actor_photos', 'source_url']
const LIST_FIELDS = ['actors', 'genres', 'samples']

// 只保存配置指纹；Cookie、令牌和带认证的代理地址不写入缓存记录。
// 双 32 位散列只用于缓存失效判断，不作为认证或密码散列。
function fingerprint(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v
  return fileKey(JSON.stringify(stable(value)))
}

function scrapePolicy(env, parsed, settings) {
  return fingerprint({ version: 2, kind: parsed.kind, plan: sourcesForNumber(settings, parsed, env.extraDefs || []),
    priority: settings.field_priority || '', blocked: settings.field_blocklist || {}, required: settings.required_fields || [],
    mode: settings.scrape_mode || 'fast', limit: settings.max_sources || 6, parallel: settings.source_parallel || 4, age: settings.age_confirm,
    proxy: settings.proxy, cookies: settings.cookiecloud_domains, render: settings.flaresolverr_endpoint })
}

function complete(meta, parsed, settings = {}) {
  if (!meta?.title || !meta?.cover) return false
  if ((settings.required_fields || []).some(key => !meta[key] || (Array.isArray(meta[key]) && !meta[key].length))) return false
  return ['fc2', 'uncensored-date', 'heyzo', 'tokyohot', 'heydouga'].includes(parsed.kind) || (meta.actors || []).length > 0
}

// 字段级合并：有优先级配置的字段按配置的来源顺序取第一个有值的，其余按查询顺序；标签合并去重。
export function mergeMeta(results, priority = {}, blocklist = {}) {
  const merged = { actors: [], genres: [], samples: [], artwork_candidates: {}, source_variants: [], sources: [], source_urls: {} }
  const ordered = field => {
    const prefer = priority[field] || []
    return [...results.filter(r => prefer.includes(r.source)).sort((a, b) => prefer.indexOf(a.source) - prefer.indexOf(b.source)), ...results.filter(r => !prefer.includes(r.source))].filter(r => !(blocklist[field] || []).includes(r.source))
  }
  for (const meta of results) {
    merged.sources.push(meta.source)
    if (meta.source_url) merged.source_urls[meta.source] = meta.source_url
  }
  for (const field of SCALAR_FIELDS) {
    const hit = ordered(field).find(meta => meta[field])
    if (hit) merged[field] = hit[field]
  }
  for (const field of ['actors', 'samples']) {
    const hit = ordered(field).find(meta => meta[field]?.length)
    if (hit) merged[field] = [...hit[field]]
  }
  const genres = priority.genres ? ordered('genres').slice(0, 1) : ordered('genres')
  merged.genres = [...new Set(genres.flatMap(meta => meta.genres || []))]
  merged.field_sources = Object.fromEntries([...SCALAR_FIELDS, ...LIST_FIELDS]
    .map(field => [field, (ordered(field).find(m => (Array.isArray(m[field]) ? m[field].length : m[field])) || {}).source])
    .filter(([, value]) => value))
  for (const field of ['cover','poster']) merged.artwork_candidates[field] = ordered(field).flatMap(m => m[field] ? [{url:m[field],source:m.source,referer:m.source_url || ''}] : [])
  merged.source_variants = results.map(({source,source_url,title,plot,actors,cover,poster,release_date,studio})=>({source,source_url,title,plot:String(plot || '').slice(0,4000),actors,cover,poster,release_date,studio}))
  merged.source = merged.sources[0]
  return merged
}

// 同一次运行里同一个番号只刮削一次（例如 CD1、CD2 并发处理时）。
export function scrape(env, parsed, settings, cache) {
  const policy = scrapePolicy(env, parsed, settings)
  if (!env.scrapes) return scrapeOnce(env, parsed, settings, cache, policy)
  const key = `${parsed.number}|${policy}|${settings.no_cache ? 1 : 0}|${settings.source_url || ""}|${settings.source_id || ""}`
  if (!env.scrapes.has(key)) env.scrapes.set(key, scrapeOnce(env, parsed, settings, cache, policy).then(result => {
    if (!complete(result.meta, parsed, settings)) env.scrapes.delete(key)
    return result
  }).catch(error => { env.scrapes.delete(key); throw error }))
  return env.scrapes.get(key)
}

async function scrapeOnce(env, parsed, settings, cache, policy) {
  const number = parsed.number
  if (cache && !settings.source_url) {
    const cached = await cache.get(number)
    if (cached && !settings.no_cache && cached.policy === policy && Date.now() - cached.at < CACHE_TTL_MS && sameNumber(cached.meta?.number, number) && complete(cached.meta, parsed, settings)) {
      return { meta: cached.meta, errors: [], cached: true }
    }
  }
  let plan = sourcesForNumber(settings, parsed, env.extraDefs || [])
  if (settings.source_url) {
    if (!/^https?:\/\//i.test(settings.source_url)) throw new Error('来源地址必须为 HTTP(S)')
    plan=plan.filter(i=>i.def.id===settings.source_id)
    if(plan.length!==1) throw new Error('指定详情地址时必须选择已启用的来源')
    plan=plan.map(i=>({...i,def:{...i.def,require_number:true,manual_url:settings.source_url}}))
  }
  if (plan.length === 0) return { meta: null, errors: ['没有适用于该番号类型的已启用来源，请在设置里启用对应来源'] }
  const full = settings.scrape_mode === 'full'
  const limit = full ? Math.max(1, Number(settings.max_sources) || 6) : plan.length
  // 来源并发查询：完整模式一次查完；快速模式按批查询，资料齐全就停止。结果保持来源顺序。
  const parallel = Math.max(1, Number(settings.source_parallel) || 4)
  const queue = plan.slice(0, limit)
  const results = [], errors = []
  const query = async item => {
    try {
      const meta = await runPlanItem(env, item, number)
      if (!meta) errors.push(`${item.def.name}：未找到 ${number}`)
      return meta
    } catch (error) {
      errors.push(`${item.def.name}：${error.message || error}`)
      return null
    }
  }
  for (let start = 0; start < queue.length; start += full ? queue.length : parallel) {
    const wave = queue.slice(start, full ? queue.length : start + parallel)
    for (const meta of await mapPool(wave, parallel, query)) if (meta) results.push(meta)
    if (!full && results.length && complete(mergeMeta(results, fieldPriority(settings), settings.field_blocklist || {}), parsed, settings)) break
  }
  if (results.length === 0) return { meta: null, errors }
  const meta = mergeMeta(results, fieldPriority(settings), settings.field_blocklist || {})
  if (!meta.title) return { meta: null, errors: [...errors, '来源没有返回标题'] }
  meta.source_errors = errors
  if (cache && !settings.source_url && complete(meta, parsed, settings)) await cache.set(number, { at: Date.now(), meta, policy })
  return { meta, errors }
}
