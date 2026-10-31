import { WORKFLOW_DEFAULTS, workflowSettings } from './workflow-options.js'
export const ADVANCED_DEFAULTS = {
  ...WORKFLOW_DEFAULTS,
  directories: [], transfer_mode: 'move', metadata_target: '', delete_empty: false,
  extensions: '', filename_blacklist: '', scan_depth: 8, watch_interval: 30,
  max_actors: 3, title_template: '{number} {title}', image_template: '{basename}',
  category_rules: [], resolution_mode: 'filename', required_fields: [], required_images: [],
  image_options: { poster: true, thumb: false, fanart: true, crop: 'right', ratio: 2 / 3, quality: 92, max_width: 1200, crop_by_kind: {} },
  watermark: { enabled: false, pack_id: '', targets: ['poster'], scale: .18, corner: 'top-left', direction: 'stack', gap: 8, x: 8, y: 8, rules: [] },
  translation: { enabled: false, fields: ['title', 'plot'], language: '简体中文', instruction: '', provider_id: '', model: '', required: false },
  nfo: { fields: {}, set: 'series', tagline: '', rating: '', country: '', mpaa: '', extra_tags: ['subtitle', 'mosaic'], extra_genres: [] },
  download_trailer: false, trailer_timeout: 120, subtitle_library: '', webhooks: [],
  request_timeout: 30, source_retry: 0, field_blocklist: {}, category_source_order: {}, flaresolverr_endpoint: '', watch_realtime: true,
  actor_sources: [], actors_enabled: false, actor_refresh: 'missing',
}
export function advancedSettings(value = {}) {
  const out = { ...ADVANCED_DEFAULTS, ...workflowSettings(value) }
  for (const key of ['image_options', 'watermark', 'translation', 'nfo']) out[key] = { ...ADVANCED_DEFAULTS[key], ...(value[key] || {}) }
  for (const key of ['directories', 'category_rules', 'required_fields', 'required_images', 'webhooks', 'actor_sources']) out[key] = Array.isArray(out[key]) ? out[key] : []
  out.transfer_mode = ['move', 'copy', 'hardlink', 'symlink'].includes(out.transfer_mode) ? out.transfer_mode : 'move'
  out.max_actors = Math.min(50, Math.max(1, Number(out.max_actors) || 3))
  out.scan_depth = Math.min(30, Math.max(1, Number(out.scan_depth) || 8))
  out.request_timeout = Math.min(120, Math.max(5, Number(out.request_timeout) || 30))
  out.source_retry = Math.min(3, Math.max(0, Number(out.source_retry) || 0))
  return out
}
export function directoryConfigs(raw, input = {}) {
  const overrides = input.overrides && typeof input.overrides === 'object' ? input.overrides : {}
  const directories = (raw.directories || []).filter(d => d.enabled !== false && d.path)
  if (!directories.length && raw.inbox) directories.push({ id: 'inbox', path: raw.inbox })
  const selected = input.directory_id ? directories.filter(d => d.id === input.directory_id) : directories
  if (input.directory_id && !selected.length) throw new Error('任务指定的监听目录不存在或已停用')
  if (input.paths?.length) return [{ ...mergeSettings(raw, overrides), inbox: input.scan_root || raw.inbox || '/', scan_paths: input.paths.map(String), directory_id: 'manual' }]
  if (!selected.length) throw new Error('请先设置至少一个收件目录')
  return selected.map(d => ({ ...mergeSettings(mergeSettings(raw, d.overrides || {}), overrides), inbox: d.path, directory_id: d.id }))
}
export function mergeSettings(base, patch) {
  const out = { ...base, ...patch }
  for (const key of ['image_options', 'watermark', 'translation', 'nfo', 'category_source_order', 'field_blocklist', 'cleanup_source','naming','metadata_options','image_selection','actor_options']) {
    if (!patch[key]) continue
    out[key] = { ...(base[key] || {}), ...patch[key] }
    for (const nested of ['fields', 'crop_by_kind', 'prefix_values', 'suffix_values', 'category_labels']) if (patch[key][nested]) out[key][nested] = { ...(base[key]?.[nested] || {}), ...patch[key][nested] }
  }
  return out
}
export function validateAdvanced(settings) {
  const errors = []
  for (const rule of settings.category_rules || []) { try { new RegExp(rule.pattern, 'i') } catch { errors.push(`分类正则无效：${rule.pattern}`) } }
  for (const hook of settings.webhooks || []) { if (hook.enabled !== false && !/^https?:\/\//i.test(hook.url || '')) errors.push('Webhook 地址必须为 HTTP(S)') }
  if (!['filename', 'probe', 'probe_first'].includes(settings.resolution_mode || 'filename')) errors.push('分辨率模式无效')
  const ids = new Set(), paths = new Set()
  for (const d of settings.directories || []) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(d.id || '') || ids.has(d.id)) errors.push('监听目录 ID 必须唯一且只含小写字母、数字、点或短横线')
    if (!/^(\/|cd2:\/)/.test(d.path || '') || paths.has(d.path)) errors.push('监听目录路径必须有效且不能重复')
    ids.add(d.id); paths.add(d.path)
  }
  return errors
}
