// 页面侧的图片处理（裁剪、水印、分辨率）。
// 与 jobs/lib/enrich.js 的 processArtwork 同源实现，只保留页面预览用得到的那一份：
// 宿主把「后台任务可达的文件」判定为后台源码、不作为页面资源下发，
// 页面不能反向 import 后台目录，所以这里自带一份（页面与后台不共享模块）。

export const HOST = '/api/extensions/v3/local.av-organizer'

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
