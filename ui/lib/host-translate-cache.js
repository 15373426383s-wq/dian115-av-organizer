// 页面侧的翻译缓存统计与清理。
// 与 jobs/lib/translate-cache.js 同源实现，只保留页面要用的两个函数：
// 宿主把「后台任务可达的文件」判定为后台源码、不作为页面资源下发，
// 页面不能反向 import 后台目录，所以这里自带一份（页面与后台不共享模块）。
// 两边读写的是同一个插件 KV（ctx.storage），所以页面清理的就是后台那份缓存。

export const TRANSLATION_CACHE_LIMIT = 600
const INDEX_KEY = 'tr_index'

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
