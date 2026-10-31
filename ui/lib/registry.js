// 刮削来源注册表：内置预设 + 自定义来源，叠加每个来源的启用、顺序、地址、Cookie、令牌。
// 页面与后台共用，保证设置页看到的就是后台实际使用的来源清单。

import { PRESETS, DEFAULT_ORDER, DEFAULT_ENABLED, numberKind } from './presets.js'

export function parseJSON(text, fallback) {
  if (text && typeof text === 'object') return text
  try { const value = JSON.parse(String(text || '')); return value ?? fallback } catch { return fallback }
}

// 自定义来源：JSON 数组。返回 {defs, errors}；同 id 覆盖内置预设。
export function customSources(settings) {
  const raw = parseJSON(settings.custom_sources, [])
  const defs = [], errors = []
  for (const [index, def] of (Array.isArray(raw) ? raw : []).entries()) {
    const problem = validateSource(def)
    if (problem) errors.push(`自定义来源第 ${index + 1} 个：${problem}`)
    else defs.push({ ...def, custom: true })
  }
  return { defs, errors }
}

export function validateSource(def) {
  if (!def || typeof def !== 'object') return '必须是对象'
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(def.id || '')) return 'id 只能用小写字母、数字、点、横线和下划线'
  if (!def.name) return '缺少 name'
  if (!['html', 'json'].includes(def.type || 'html')) return 'type 只能是 html 或 json'
  if (!def.detail && !def.search) return '至少需要 detail 或 search'
  if (def.detail && def.detail !== 'search' && !def.detail.url) return 'detail.url 不能为空'
  if (!def.fields || !def.fields.title) return 'fields.title 必填'
  if (!Array.isArray(def.kinds) || !def.kinds.length) return 'kinds 至少写一个番号类型'
  return ''
}

export function sourceConfig(settings) {
  const config = parseJSON(settings.source_config, {}) || {}
  // 兼容旧版设置：javbus_base / javdb_base / fc2_base 与两个 Cookie。
  const legacy = { javbus: ['javbus_base', 'javbus_cookie'], javdb: ['javdb_base', 'javdb_cookie'], fc2: ['fc2_base', ''] }
  for (const [id, [baseKey, cookieKey]] of Object.entries(legacy)) {
    const item = { ...(config[id] || {}) }
    if (!item.base && settings[baseKey]) item.base = settings[baseKey]
    if (!item.cookie && cookieKey && settings[cookieKey]) item.cookie = settings[cookieKey]
    if (Object.keys(item).length) config[id] = item
  }
  return config
}

// 有序的来源计划：[{def, enabled, base, cookie, token}]
export function sourcePlan(settings, extraDefs = []) {
  const { defs: custom } = customSources(settings)
  const byId = new Map()
  for (const def of [...PRESETS, ...custom, ...extraDefs]) byId.set(def.id, def)
  const config = sourceConfig(settings)
  const legacyOrder = String(settings.sources || '').split(/[,\s，]+/).filter(Boolean)
  const savedOrder = String(settings.source_order || '').split(/[,\s，]+/).filter(Boolean)
  const order = [...new Set([...(savedOrder.length ? savedOrder : legacyOrder), ...DEFAULT_ORDER, ...custom.map(d => d.id), ...extraDefs.map(d => d.id)])].filter(id => byId.has(id))
  const hasExplicit = Object.values(parseJSON(settings.source_config, {}) || {}).some(item => typeof item?.enabled === 'boolean')
  return order.map(id => {
    const def = byId.get(id)
    const item = config[id] || {}
    const savedBase = String(item.base || def.base || '').replace(/\/+$/, '')
    const base = def.base_aliases?.includes(savedBase) ? def.base : savedBase
    const enabled = typeof item.enabled === 'boolean' ? item.enabled
      : hasExplicit ? false
        : def.custom || extraDefs.includes(def) ? true
          : legacyOrder.length && !savedOrder.length ? legacyOrder.includes(id) || DEFAULT_ENABLED.includes(id)
            : DEFAULT_ENABLED.includes(id)
    return { def: { ...def, ...(item.retry !== undefined ? { retry: Math.min(3,Math.max(0,Number(item.retry) || 0)) } : {}), ...(item.timeout_seconds ? { timeout_seconds: Math.min(120, Math.max(5, Number(item.timeout_seconds))) } : {}), ...(item.proxy ? { proxy: item.proxy } : {}), ...(item.user_agent ? { headers: { ...def.headers, 'User-Agent': item.user_agent } } : {}) }, enabled: enabled && !(def.needs_token && !item.token), base, cookie: item.cookie || '', token: item.token || '' }
  })
}

// 适用于这个番号的已启用来源（按顺序）。
export function sourcesForNumber(settings, parsed, extraDefs = []) {
  const kind = numberKind(parsed.kind, parsed.number)
  const only = settings.__only_source
  const order = settings.category_source_order?.[kind] || (!settings.source_order && kind === 'heyzo' ? ['javbus', 'avsox', 'freejavbt', 'mmtv', 'airav_io', 'javdb', 'heyzo'] : [])
  const rank = item => { const index = order.indexOf(item.def.id); return index < 0 ? 999 : index }
  return sourcePlan(settings, extraDefs).filter(item => (only ? item.def.id === only : item.enabled))
    .filter(item => item.def.kinds.includes(kind) && (!item.def.pattern || new RegExp(item.def.pattern, 'i').test(parsed.number)))
    .sort((a, b) => rank(a) - rank(b))
}

// 可用于关键词模糊搜索的来源：search_sources 指定的优先，其次所有支持搜索的已启用来源。
export function searchPlan(settings) {
  const plan = sourcePlan(settings).filter(item => item.enabled && item.def.search && (item.def.search.method !== 'POST' || item.def.search.read_only))
  const preferred = String(settings.search_sources || 'javdb,javbus').split(/[,\s，]+/).filter(Boolean)
  return [...plan.filter(item => preferred.includes(item.def.id)).sort((a, b) => preferred.indexOf(a.def.id) - preferred.indexOf(b.def.id)), ...plan.filter(item => !preferred.includes(item.def.id))].slice(0, 4)
}

// 字段来源优先：每行“字段: 来源1,来源2”。
export function fieldPriority(settings) {
  const out = {}
  for (const line of String(settings.field_priority || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*[:：=]\s*(.+)$/i)
    if (m) out[m[1].trim()] = m[2].split(/[,\s，]+/).map(s => s.trim()).filter(Boolean)
  }
  return out
}

export function sourceName(id, settings = {}) {
  const def = [...PRESETS, ...customSources(settings).defs].find(item => item.id === id)
  return def?.name || id
}
