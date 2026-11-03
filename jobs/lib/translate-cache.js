// 翻译结果本地缓存。借鉴 MDC-NGi 的「内置中文标题库」思路：
// 同一个番号、同一段原文只翻译一次，重新刮削、换目录或换模板时直接复用，
// 既不重复消耗宿主 AI 额度，也让重复整理明显更快。
// 缓存键里带上引擎、目标语言、模型、补充要求和原文，任何一项变化都会重新翻译，不会串味。

import { fileKey } from './shared/keys.js'

export const TRANSLATION_CACHE_TTL_MS = 90 * 24 * 3600 * 1000
export const TRANSLATION_CACHE_LIMIT = 600
const INDEX_KEY = 'tr_index'

// 稳定的键排序，保证同样的输入永远得到同样的散列。
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

export function translationCacheEnabled(settings = {}) {
  return settings.translation?.cache !== false && settings.no_cache !== true
}

export function translationCacheKey(meta = {}, fields = {}, settings = {}) {
  const config = settings.translation || {}, options = settings.metadata_options || {}
  return 'tr:' + fileKey(JSON.stringify(stable({
    number: meta.number || '',
    engine: options.translation_engine || 'host',
    language: config.language || '',
    code: config.language_code || '',
    model: config.model || '',
    provider: config.provider_id || '',
    instruction: config.instruction || '',
    fields,
  })))
}

// 缓存值和本次请求的字段形状必须一致，否则当作未命中重新翻译。
function acceptable(values, fields) {
  if (!values || typeof values !== 'object') return false
  return Object.entries(fields).every(([key, value]) => Array.isArray(value)
    ? Array.isArray(values[key]) && values[key].length === value.length && values[key].every(text => typeof text === 'string' && text.trim())
    : typeof values[key] === 'string' && values[key].trim())
}

async function writeEntry(ctx, key, entry) {
  await ctx.storage.set(key, entry).catch(() => {})
  const index = (await ctx.storage.get(INDEX_KEY).catch(() => null)) || []
  const next = [...index.filter(item => item?.key !== key), { key, at: entry.at }]
  const evicted = next.length > TRANSLATION_CACHE_LIMIT ? next.splice(0, next.length - TRANSLATION_CACHE_LIMIT) : []
  await ctx.storage.set(INDEX_KEY, next).catch(() => {})
  for (const item of evicted) await ctx.storage.remove(item.key).catch(() => {})
}

// translate 是真正调用 AI / DeepL / Google 的函数，只在未命中时执行。
export async function translateWithCache(ctx, meta, fields, settings, translate, log = () => {}) {
  if (!Object.keys(fields || {}).length) return { ...(await translate()), cached: false }
  // 没有 KV 能力的环境（例如单测里的精简 ctx）直接透传，保证功能不受影响。
  if (!translationCacheEnabled(settings) || typeof ctx?.storage?.get !== 'function') return { ...(await translate()), cached: false }
  const key = translationCacheKey(meta, fields, settings)
  const hit = await ctx.storage.get(key).catch(() => null)
  if (hit?.values && acceptable(hit.values, fields) && Date.now() - Number(hit.at || 0) < TRANSLATION_CACHE_TTL_MS) {
    await log(`翻译命中本地缓存：${Object.keys(fields).join('、')}`)
    return { values: hit.values, model: hit.model || '本地缓存', cached: true }
  }
  const result = await translate()
  if (acceptable(result?.values, fields)) {
    await writeEntry(ctx, key, { at: Date.now(), values: result.values, model: result.model || '', number: meta.number || '', language: settings.translation?.language || '' })
  }
  return { ...result, cached: false }
}

export async function translationCacheStats(ctx) {
  const index = (await ctx.storage.get(INDEX_KEY).catch(() => null)) || []
  return { entries: index.length, limit: TRANSLATION_CACHE_LIMIT, newest: index.at(-1)?.at || null }
}

export async function clearTranslationCache(ctx) {
  const index = (await ctx.storage.get(INDEX_KEY).catch(() => null)) || []
  for (const item of index) await ctx.storage.remove(item.key).catch(() => {})
  await ctx.storage.remove(INDEX_KEY).catch(() => {})
  return index.length
}
