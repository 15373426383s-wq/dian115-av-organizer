import { templateVariables } from './shared/naming.js'
import { translateFields, applyDictionary, editMetadata } from './metadata.js'
import { translateWithCache } from './translate-cache.js'
import { renderText, evaluateCondition } from './shared/templates.js'
export const HOST = '/api/extensions/v3/local.av-organizer'

export async function enrichMetadata(ctx, source, parsed, file, settings, log) {
  const meta = await applyDictionary(ctx, editMetadata(source, settings.manual_metadata), settings)
  if (settings.metadata_options?.trim_plot && meta.plot) meta.plot = meta.plot.replace(/\r\n/g, "\n").replace(/\n[ \t]*\n+/g,"\n").trim()
  const filenameResolution = /(?:^|[^a-z0-9])(8k|4320p|4k|2160p|1080p|720p)(?![a-z0-9])/i.exec(file.name)?.[1]?.toUpperCase()?.replace('2160P', '4K').replace('4320P', '8K') || ''
  parsed.flags = { ...parsed.flags, leaked: parsed.flags?.leaked || /流出|leaked?/i.test(file.name), cracked: parsed.flags?.cracked || /无码破解|無碼破解|破解版|cracked/i.test(file.name) }
  meta.resolution = filenameResolution
  if (settings.resolution_mode !== 'filename' && !(settings.resolution_filename_first && filenameResolution)) {
    try {
      const profile = await ctx.api.post(`${HOST}/media/probe`, { path: file.path, ...(file.sha1 ? { sha1: file.sha1 } : {}) })
      if (!(profile.width > 0 && profile.height > 0)) throw new Error('FFP 未返回有效的视频尺寸')
      meta.media = profile
      meta.resolution = profile.width >= 7000 ? '8K' : profile.width >= 3800 ? '4K' : profile.height >= 1000 ? '1080P' : profile.height >= 700 ? '720P' : `${profile.height}P`
      if (!meta.runtime && profile.duration) meta.runtime = Math.round(profile.duration / 60)
      parsed.flags = { ...parsed.flags, k4: profile.width >= 3800 }
      await log(`真实分辨率 ${profile.width} × ${profile.height}，${meta.resolution}`)
    } catch (e) {
      if (settings.resolution_mode === 'probe') throw e
      await log(`FFP 不可用，采用文件名分辨率：${e.message || e}`)
    }
  }
  const config = settings.translation || {}
  if (config.enabled) {
    const fields = Object.fromEntries((config.fields || ['title', 'plot']).filter(k => ['title', 'plot', 'series', 'studio', 'genres', 'actors'].includes(k) && meta[k]?.length).map(k => [k, meta[k]]))
    if (Object.keys(fields).length) {
      try {
        // 先在本地翻译缓存里找：同一番号同一原文不再重复消耗 AI 额度。
        const r = await translateWithCache(ctx, meta, fields, settings, () => translateFields(ctx,meta,fields,settings), log)
        const output = r.values
        for (const [key, value] of Object.entries(fields)) {
          if (Array.isArray(value) ? !Array.isArray(output[key]) || !output[key].every(v => typeof v === 'string') : typeof output[key] !== 'string' || !output[key].trim()) throw new Error(`AI 返回的 ${key} 格式不正确`)
        }
        meta.original_title ||= meta.title; meta.original_plot ||= meta.plot
        Object.assign(meta, Object.fromEntries(Object.keys(fields).map(k => [k, output[k]])))
        meta.translation_model = r.model
        if (!r.cached) await log(`已翻译 ${Object.keys(fields).join('、')}`)
      } catch (e) { if (config.required) throw e; await log(`翻译失败，保留原文：${e.message || e}`) }
    }
  }
  for (const key of (settings.metadata_options?.strict_on_source_error && !source.source_errors?.length ? [] : settings.required_fields || [])) if (!meta[key] || (Array.isArray(meta[key]) && !meta[key].length)) throw new Error(`必需元数据缺失：${key}`)
  meta.display_title = renderText(settings.title_template || '{number} {title}', templateVariables(meta, parsed, { filename: file.name, sourcePath: file.path, maxActors: settings.max_actors }))
  return meta
}

export async function processArtwork(ctx, input, output, target, meta, parsed, settings, log) {
  const config = settings.image_options || {}, wm = settings.watermark || {}
  const crop = target === 'poster' ? (config.crop_by_kind?.[parsed.category] || config.crop_by_kind?.[parsed.kind] || (meta.poster && meta.poster !== meta.cover && !config.crop_poster ? 'center' : config.crop || 'right')) : 'none'
  const ratio = Number(config.ratio) || 2 / 3
  const maxWidth = Math.max(0, Number(config.max_width ?? 1200) || 0)
  let originalPromise
  const inspectOriginal = () => originalPromise ||= ctx.api.post(`${HOST}/media/image`, { source: input, inspect: true })
  const targetWidth = original => Math.max(1, Math.floor(Math.min(original.width, crop !== 'none' ? original.height * ratio : original.width, maxWidth || Infinity)))
  const overlays = []
  if (wm.enabled && (wm.targets || ['poster']).includes(target)) {
    let rules = (wm.rules || []).filter(r => r.source && (r.when === 'always' || !r.when || Boolean(parsed.flags?.[r.when]) || r.when === meta.resolution))
    if (!rules.length && !(wm.rules || []).length) {
      const text = [parsed.flags?.chinese ? '中文字幕' : '', parsed.flags?.uncensored ? '无码' : '有码', meta.resolution || ''].filter(Boolean).join(' ')
      const matches = await ctx.api.post('/api/resource-badges/match', { pack_id: wm.pack_id || '', texts: [text] })
      rules = (matches.results?.[0]?.badges || []).filter(b => b.icon_url).slice(0, 8).map(b => ({ source: b.icon_url }))
    }
    // Inspect badges to stack by their actual aspect ratio, after cropping/resizing.
    const width = targetWidth(await inspectOriginal())
    const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
    const start = Math.max(0, corners.indexOf(wm.corner || 'top-left')); let offset = 0
    for (const [i, rule] of rules.slice(0, 24).entries()) {
      const scale = Number(rule.scale || wm.scale) || .18
      const badge = await ctx.api.post(`${HOST}/media/image`, { source: rule.source, inspect: true })
      const corner = rule.corner || (wm.direction === 'clockwise' ? corners[(start + i) % 4] : wm.direction === 'counterclockwise' ? corners[(start - i % 4 + 4) % 4] : corners[start])
      overlays.push({ source: rule.source, scale, corner, x: (Number(rule.x ?? wm.x) || 0) + (wm.direction === 'horizontal' && !rule.corner ? offset : 0), y: (Number(rule.y ?? wm.y) || 0) + (wm.direction === 'stack' && !rule.corner ? offset : 0), opacity: rule.opacity ?? 1 })
      offset += Math.round(wm.direction === 'horizontal' ? width * scale : width * scale * badge.height / badge.width) + (Number(wm.gap) || 0)
    }
  }
  let outputWidth = maxWidth
  if (outputWidth) {
    outputWidth = targetWidth(await inspectOriginal())
  }
  const result = await ctx.api.post(`${HOST}/media/image`, { source: input, destination: output, crop, ratio: Number(config.ratio) || 2 / 3, width: outputWidth, quality: Number(config.quality) || 92, format: 'jpeg', overlays })
  if (crop === 'face') await log(`人脸裁剪：${result.image?.faces || 0} 张脸，实际采用 ${result.image?.crop_applied}`)
  return output
}

export async function sendWebhooks(ctx, settings, payload, log) {
  const vars = {...payload, job:payload, metadata:payload.metadata || {}}
  for (const hook of (settings.webhooks || []).filter(h => h.enabled !== false && (!h.events?.length || h.events.includes(payload.status)))) {
    try {
      if (hook.categories?.length && !hook.categories.includes(payload.category)) continue
      if (hook.condition && !evaluateCondition(hook.condition,vars)) continue
      const url=renderText(hook.url,vars,encodeURIComponent)
      if (!/^https?:\/\//i.test(url)) throw new Error('Webhook 地址无效')
      const method=String(hook.method || 'POST').toUpperCase()
      if (!['GET','POST'].includes(method)) throw new Error('Webhook 只支持 GET / POST')
      const body=hook.body ? renderText(typeof hook.body==='string'?hook.body:JSON.stringify(hook.body),vars) : JSON.stringify({event:'av.organize',...payload})
      if(method==='POST' && hook.json !== false) JSON.parse(body)
      const headers=Object.fromEntries(Object.entries(hook.headers || {}).map(([k,v])=>[k,(Array.isArray(v)?v:[v]).map(text=>renderText(text,vars))]))
      const response = await ctx.http.request({method,url,headers:{...(method==='POST' && hook.json!==false?{'Content-Type':['application/json']}:{}),...headers},...(method==='POST'?{body}:{}),...(hook.proxy?{proxy:hook.proxy}:{}),timeout_seconds:Math.min(120,Math.max(5,Number(hook.timeout) || 20))})
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    } catch (e) { await log(`Webhook 发送失败：${e.message || e}`) }
  }
}
