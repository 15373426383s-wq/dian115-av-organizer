import { HOST } from './lib/enrich.js'
import { fileKey } from './lib/shared/keys.js'

import { findActor } from './lib/actor-providers.js'
import { advancedSettings } from './lib/shared/advanced.js'
export { findActor, exactActorName } from './lib/actor-providers.js'
export async function run(ctx, input = {}) {
  const settings = advancedSettings(await ctx.settings.get())
  const options = settings.actor_options
  const sources = [...(settings.actor_sources || []), ...(options.providers || []).map(type => ({type,language:options.language}))]
  if (!input.manual && !settings.actors_enabled) return { skipped: true }
  const proxy = settings.actor_proxy_id ? `proxy_id=${encodeURIComponent(settings.actor_proxy_id)}&` : ''
  const query = `?${proxy}type=Person&limit=50&sort_by=name${settings.actor_library_id ? '&library_id=' + encodeURIComponent(settings.actor_library_id) : ''}`
  let offset = Number(input.offset ?? await ctx.storage.get('actors_offset') ?? 0)
  const result = await ctx.api.get(`/api/plugin-host/emby/items${query}&offset=${offset}`)
  const items = Array.isArray(result.items) ? result.items : []
  const records = (await ctx.storage.get('actors_history')) || []
  const summary = { success: 0, failed: 0, skipped: 0, submitted: 0, total: items.length }
  for (const item of items) {
    if(options.recent_days>0 && item.date_created && Date.parse(item.date_created)<Date.now()-Number(options.recent_days)*86400000){summary.skipped++;continue}
    const missing = settings.actor_refresh !== 'all'
    const replaceInfo = options.overwrite_info || !missing
    const replaceImage = options.overwrite_images || !missing
    const needsInfo = options.info && (replaceInfo || !item.overview)
    const needsImage = options.images && (replaceImage || !item.has_primary_image)
    if (!needsInfo && !needsImage) { summary.skipped++; continue }
    const record = { id: item.id, name: item.name, at: new Date().toISOString(), status: 'pending' }
    const imagePath = `actors/${fileKey(String(item.proxy_id) + ':' + item.id)}.jpg`
    try {
      await ctx.task.update({ message: `演员：${item.name}`, total: items.length, done: summary.success + summary.skipped + summary.submitted, failed: summary.failed })
      const suffix = proxy ? '?' + proxy.slice(0, -1) : ''
      if (!sources.some(source => source.enabled !== false && (source.url || source.type || source.path))) {
        // 宿主接受 Default / FullRefresh / None；简介和头像独立补缺。
        await ctx.api.post(`/api/emby-control/items/${encodeURIComponent(item.id)}/refresh${suffix}`, {
          recursive: false,
          metadata_refresh_mode: !needsInfo ? 'None' : replaceInfo ? 'FullRefresh' : 'Default',
          image_refresh_mode: !needsImage ? 'None' : replaceImage ? 'FullRefresh' : 'Default',
          replace_all_metadata: Boolean(needsInfo && replaceInfo),
          replace_all_images: Boolean(needsImage && replaceImage),
        })
        record.status = 'submitted'; record.overview = '已请求 Emby 使用其已配置的演员资料提供商刷新'; summary.submitted++
        records.unshift(record); records.splice(500); await ctx.storage.set('actors_history', records); continue
      }
      const source = await findActor(ctx, item.name, sources, {...options,no_cache:input.no_cache})
      if (!source) throw new Error('配置的演员资料源没有精确命中；请补充来源或别名映射')
      await ctx.task.checkpoint({ actor_id: item.id, offset })
      if (needsInfo && source.overview) await ctx.api.put(`/api/emby-control/items/${encodeURIComponent(item.id)}/metadata${suffix}`, { overview: source.overview })
      if (needsImage && source.image) {
        let lastError, uploaded = false
        for (const url of source.images?.length ? source.images : [source.image]) {
          try {
            const response = await ctx.http.request({url,save_to:imagePath,headers:source.headers || {},timeout_seconds:45,max_bytes:32*1024*1024})
            if (response.status < 200 || response.status >= 300) throw new Error(`头像 HTTP ${response.status}`)
            const size = await ctx.api.post(`${HOST}/media/image`,{source:imagePath,inspect:true})
            if (size.width < 100 || size.height < 100) throw new Error('头像尺寸过小')
            await ctx.api.post(`${HOST}/media/emby-image${suffix}`,{item_id:item.id,source:imagePath})
            uploaded = true; break
          } catch(e) { lastError=e }
        }
        if (!uploaded) throw lastError || new Error('没有可用头像')
        record.image = imagePath
      }
      record.status = 'success'; record.sources = source.sources; record.field_sources = source.field_sources; record.overview = source.overview; summary.success++
    } catch (e) { record.status = 'failed'; record.error = e.message || String(e); summary.failed++; await ctx.task.log(`${item.name}：${record.error}`) }
    records.unshift(record); records.splice(500)
    await ctx.storage.set('actors_history', records)
  }
  offset = offset + items.length >= Number(result.total || 0) || !items.length ? 0 : offset + items.length
  await ctx.storage.set('actors_offset', offset)
  await ctx.task.update({ message: `演员同步：成功 ${summary.success}，已请求刷新 ${summary.submitted}，失败 ${summary.failed}，跳过 ${summary.skipped}`, total: items.length, done: summary.success + summary.skipped + summary.submitted, failed: summary.failed, progress: 100 })
  return { ...summary, next_offset: offset }
}
// Metadata/image replacement is idempotent; a retry starts this page afresh.
export async function recover() { return { action: 'resume' } }
