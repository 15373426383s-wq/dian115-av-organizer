// 规则驱动的刮削引擎：每个来源是一份声明式规则，站点改版时改规则即可，不需要改代码。
//
// 来源规则（详见 ui/lib/presets.js）：
//   type: 'html' | 'json'
//   steps: [{ url, json?, re?, sel?, attr?, as, required? }]  前置请求取变量；shared_steps 合并并发初始化
//   search: { url, method?, form?, json_body?, headers?, item, link?, number?, title?, json?, vars? }
//   detail: { url, from_search?, method?, json_body?, headers?, page_url? } | 'search'
//   rows: { sel, label, value? }              “标签：值”信息行的位置
//   fields: { 字段: 规则 }                      title、actors、cover 等
//   not_found: 正则                            页面命中时视为没有这部作品
//
// 字段规则：
//   'css' | 'css@attr'                         取文本或属性（@href、@src、@content、@html）
//   { sel, attr, all, label, value, json, jsonld, json_map, re, replace, template, from, split, type }
//   type: date | minutes | seconds | duration(HH:MM:SS) | url | text（默认按字段推断）

const URL_FIELDS = new Set(['cover', 'poster', 'samples', 'source_url', 'trailer'])
const LIST_FIELDS = new Set(['actors', 'genres', 'samples'])

export function numberVars(number, extra = {}) {
  const value = String(number || '').toUpperCase()
  const m = value.match(/^(\d*)([A-Z]+)-?(\d+)$/)
  const prefix = m ? m[2] : ''
  const digits = m ? m[3] : ''
  return {
    number: value,
    number_lower: value.toLowerCase(),
    number_nodash: value.replace(/-/g, ''),
    number_nodash_lower: value.replace(/-/g, '').toLowerCase(),
    prefix,
    prefix_lower: prefix.toLowerCase(),
    digits,
    // DMM 内容编号：小写前缀 + 补零到 5 位（SSIS-001 → ssis00001）
    cid: m ? `${(m[1] || '')}${prefix.toLowerCase()}${digits.padStart(5, '0')}` : value.toLowerCase(),
    fc2_id: (value.match(/(\d{5,8})$/) || [])[1] || '',
    heyzo_id: (value.match(/HEYZO-(\d{4})/) || [])[1] || '',
    date_id: (value.match(/^(\d{6}[-_]\d{2,3})$/) || [])[1] || '',
    date_id_underscore: (value.match(/^(\d{6})[-_](\d{2,3})$/) || []).slice(1).join('_'),
    date_id_dash: (value.match(/^(\d{6})[-_](\d{2,3})$/) || []).slice(1).join('-'),
    // 日期编号 MMDDYY → 20YY-MM-DD（加勒比、一本道系）
    date_iso: (value.match(/^(\d{2})(\d{2})(\d{2})[-_]\d{2,3}$/) || []).slice(1).reduce((_, __, i, [m, d, y]) => `20${y}-${m}-${d}`, ''),
    ...extra,
  }
}

// 地址模板：普通变量做 URL 编码；本身就是网址的值（如 {base}）原样放入。raw 用于请求头。
export function fillTemplate(template, vars, raw = false) {
  return String(template || '').replace(/\{([a-z_0-9]+)\}/g, (whole, key) => {
    if (vars[key] === undefined) return whole
    const value = String(vars[key])
    return raw || /^https?:\/\//i.test(value) ? value : encodeURIComponent(value)
  })
}

function absolute(url, base) {
  if (!url) return ''
  try { return new URL(String(url).startsWith('//') ? 'https:' + url : url, base).href } catch { return '' }
}

export function jsonPath(data, path) {
  if (!path) return data
  const parts = String(path).split('.').filter(Boolean)
  let values = [data]
  for (const raw of parts) {
    const many = raw.endsWith('[]')
    const indexMatch = raw.match(/^(.*)\[(\d+)\]$/)
    const key = many ? raw.slice(0, -2) : indexMatch ? indexMatch[1] : raw
    const next = []
    for (const value of values) {
      if (value === null || value === undefined) continue
      let item = key ? value[key] : value
      if (indexMatch) item = Array.isArray(item) ? item[Number(indexMatch[2])] : undefined
      if (many && Array.isArray(item)) next.push(...item)
      else if (item !== undefined) next.push(item)
    }
    values = next
  }
  return values.length <= 1 ? values[0] : values
}

function normalizeSpec(spec) {
  if (typeof spec === 'string') {
    const at = spec.lastIndexOf('@')
    return at > 0 && !spec.slice(at).includes(' ') ? { sel: spec.slice(0, at), attr: spec.slice(at + 1) } : { sel: spec }
  }
  return spec || {}
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()

function postProcess(field, raw, spec, ctx) {
  let values = (Array.isArray(raw) ? raw : [raw]).map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : clean(v))).filter(Boolean)
  if (spec.split) values = values.flatMap(v => v.split(new RegExp(spec.split)).map(clean)).filter(Boolean)
  if (spec.re) {
    const re = new RegExp(spec.re, 'i')
    values = values.map(v => { const m = v.match(re); return m ? clean(m[1] ?? m[0]) : '' }).filter(Boolean)
  }
  for (const [from, to] of spec.replace || []) values = values.map(v => v.replace(new RegExp(from, 'g'), to))
  const type = spec.type || (field === 'release_date' ? 'date' : field === 'runtime' ? 'minutes' : URL_FIELDS.has(field) ? 'url' : 'text')
  if (type === 'date') values = values.map(v => normalizeDate(v, spec.timezone_offset)).filter(Boolean)
  if (type === 'minutes') values = values.map(normalizeRuntime).filter(Boolean)
  if (type === 'seconds') values = values.map(v => Math.round((Number(String(v).replace(/[^\d.]/g, '')) || 0) / 60)).filter(Boolean)
  if (type === 'duration') values = values.map(normalizeRuntime).filter(Boolean)
  if (type === 'url') values = values.map(v => absolute(v, ctx.pageURL)).filter(Boolean)
  // 标量字段带 all 时取遍全部匹配节点，再取第一个通过 re 过滤的值。
  const list = LIST_FIELDS.has(field)
  if (list) return [...new Set(values)]
  return values[0] ?? (['minutes', 'seconds', 'duration'].includes(type) ? 0 : '')
}

// 站点混用分钟和 HH:MM:SS；不能把 01:42:30 当作 1 分钟。
export function normalizeRuntime(value) {
  const text = clean(value)
  const clock = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/)
  if (clock) {
    const [, first, second, third] = clock
    if (Number(second) >= 60 || (third !== undefined && Number(third) >= 60)) return 0
    return Math.round(third === undefined ? Number(first) + Number(second) / 60 : Number(first) * 60 + Number(second) + Number(third) / 60)
  }
  if (text.includes(':')) return 0
  const iso = text.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (iso) return Math.round(Number(iso[1] || 0) * 60 + Number(iso[2] || 0) + Number(iso[3] || 0) / 60)
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:時間|小时|小時|hours?|hrs?)/i)
  if (hours) return Math.round(Number(hours[1]) * 60 + Number(text.match(/(\d+(?:\.\d+)?)\s*(?:分|minutes?|mins?)/i)?.[1] || 0))
  return Number(text.match(/(\d+(?:\.\d+)?)/)?.[1] || 0)
}

export function normalizeDate(value, timezoneOffset) {
  let text = String(value || '')
  // API 的发行时间是 UTC 瞬间；按来源所在时区取日期，避免日本午夜变成前一天。
  if (Number.isFinite(timezoneOffset) && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const timestamp = Date.parse(text)
    if (Number.isFinite(timestamp)) text = new Date(timestamp + timezoneOffset * 60000).toISOString()
  }
  let m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

// 取值：选择器 / 标签行 / JSON 路径 / JSON-LD / 模板 / 由其他字段派生。
function extract(field, specRaw, page, ctx, result) {
  const spec = normalizeSpec(specRaw)
  if (spec.json_map) {
    const items = jsonPath(page.json, spec.json_map.items)
    return Object.fromEntries((Array.isArray(items) ? items : items ? [items] : []).map(item => [
      clean(jsonPath(item, spec.json_map.key)), absolute(jsonPath(item, spec.json_map.value), ctx.pageURL),
    ]).filter(([key, value]) => key && /^https?:\/\//i.test(value)))
  }
  if (spec.template) return postProcess(field, fillTemplate(spec.template, ctx.vars, true), { ...spec, type: spec.type || (URL_FIELDS.has(field) ? 'url' : 'text') }, ctx)
  if (spec.from) {
    const base = result[spec.from]
    if (!base) return LIST_FIELDS.has(field) ? [] : ''
    return postProcess(field, base, spec, ctx)
  }
  if (spec.json !== undefined) return postProcess(field, jsonPath(page.json, spec.json), spec, ctx)
  if (spec.jsonld !== undefined) return postProcess(field, jsonPath(page.jsonld, spec.jsonld), spec, ctx)
  if (!page.$) return LIST_FIELDS.has(field) ? [] : ''
  let scope = page.$
  if (spec.label) {
    const row = findRow(page, ctx.source.rows, spec.label)
    if (!row) return LIST_FIELDS.has(field) ? [] : ''
    if (!spec.value && !spec.sel) {
      const labelText = rowLabel(row, ctx.source.rows)
      return postProcess(field, clean(row.text()).slice(labelText.length).replace(/^[\s:：]+/, ''), spec, ctx)
    }
    scope = row
  }
  const sel = spec.value || spec.sel
  const nodes = sel ? scope.find(sel) : scope
  const all = LIST_FIELDS.has(field) || spec.all
  const read = node => {
    if (spec.skip_if_next && node.next(spec.skip_if_next).length) return ''
    if (!spec.attr || spec.attr === 'text') return node.text()
    if (spec.attr === 'html') return node.html()
    return node.attr(spec.attr) || ''
  }
  const values = all ? nodes.map(read) : (nodes.length ? [read(nodes.first())] : [])
  return postProcess(field, values, spec, ctx)
}

function findRow(page, rows, labelPattern) {
  if (!rows || !page.$) return null
  const re = new RegExp(labelPattern, 'i')
  let found = null
  page.$.find(rows.sel).each(row => {
    if (found) return false
    const label = rowLabel(row, rows)
    if (label && re.test(label)) found = row
  })
  return found
}

function rowLabel(row, rows) {
  return rows.label_text ? (clean(row.text()).match(/^([^:：]{1,20})[:：]/)?.[1] || '') : clean(row.find(rows.label).first().text())
}

function templateData(value, vars) {
  if (typeof value === 'string') return fillTemplate(value, vars, true)
  if (Array.isArray(value)) return value.map(v => templateData(v, vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templateData(v, vars)]))
  return value
}

export function isChallengePage(response) {
  const body = response.body || ''
  const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
  return /^(just a moment|attention required|checking your browser)/i.test(title.trim()) || /<form[^>]+id=["']challenge-form["']/i.test(body) || (response.status === 403 && /cloudflare|cf-ray|cf-chl-/i.test(body))
}

// 默认请求头：不少站点（例如 JavBus）在缺少 Accept-Language 时会把请求当成机器人，
// 直接 302 到 driver-verify 答题页；浏览器一定会带这两个头，所以默认补上。
// 来源规则或调用方显式给出的同名头优先级更高。
const DEFAULT_LANGUAGE = 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7'
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

async function request(env, source, url, options = {}) {
  // JSON 接口不写 Accept，避免个别接口按 Accept 协商内容类型。
  const defaults = { 'Accept-Language': DEFAULT_LANGUAGE, ...((source.type || 'html') === 'json' ? {} : { Accept: HTML_ACCEPT }) }
  const headers = Object.fromEntries(Object.entries({ ...defaults, ...source.headers, ...options.headers }).map(([k, v]) => [k, [fillTemplate(v, options.vars || {}, true)]]))
  if (options.referer !== false) headers.Referer = [options.referer || new URL(url).origin + '/']
  const init = { headers, ...(source.retry !== undefined ? { retry: source.retry } : {}), ...(source.timeout_seconds ? { timeout_seconds: source.timeout_seconds } : {}), ...(source.proxy ? { proxy: source.proxy } : {}) }
  if (options.method) init.method = options.method
  if (options.form) init.form = Object.fromEntries(Object.entries(options.form).map(([k, v]) => [k, fillTemplate(v, options.vars || {}, true)]))
  if (options.json_body !== undefined) init.json = templateData(options.json_body, options.vars || {})
  if (env.throttle) await env.throttle(source.id)
  const response = await env.get(url, init)
  // 年龄确认后可能继续出现人工问答，不能反复提交年龄表单或代答验证题。
  if (/\/doc\/driver-verify\b/i.test(response.url || '') && /name=["']userAnswers\[/i.test(response.body || '')) {
    throw new Error(`${source.name} 仍要求人工答题验证，请在浏览器完成后通过 CookieCloud 或来源 Cookie 导入验证状态`)
  }
  // JavBus 的 existmag 只是磁力筛选。只有用户已开启年龄确认时，才提交站点实际的确认表单。
  if (source.age_form && env.ageConfirm && !options.age_submitted) {
    const finalURL = new URL(response.url || url)
    if (finalURL.origin === new URL(url).origin && new RegExp(source.age_form.path).test(finalURL.pathname)) {
      const page = env.html.load(response.body || '', { baseURL: finalURL.href })
      const form = page.find(source.age_form.selector).first()
      const action = absolute(form.attr('action') || finalURL.href, finalURL.href)
      if (form.length && action && new URL(action).origin === finalURL.origin && String(form.attr('method')).toLowerCase() === 'post') {
        return request(env, source, action, { ...options, method: 'POST', json_body: undefined, form: source.age_form.form, referer: finalURL.href, age_submitted: true })
      }
    }
  }
  if (response.status === 404 || response.status === 410) return { response, missing: true }
  if (/driver-verify|age[_-]?check|\/login\b|\/signin\b/i.test(response.url || '') && !/\.json/.test(url)) {
    throw new Error(`${source.name} 需要年龄验证或登录：请在设置里开启“年龄确认”，或用 CookieCloud / Cookie 导入浏览器登录状态`)
  }
  // 同一地址直接显示年龄确认页（如 MGStage 的“成人認証”）时，按页面标题识别。
  const pageTitle = ((response.body || '').match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
  if (/成人認証|年齢認証|年齢確認|age verification|are you 18/i.test(pageTitle)) {
    throw new Error(`${source.name} 需要年龄验证或登录：请在设置里开启“年龄确认”，或用 CookieCloud / Cookie 导入浏览器登录状态`)
  }
  if (/メンテナンス|maintenance/i.test(pageTitle) && response.status >= 400) throw new Error(`${source.name} 站点维护中，暂时无法访问`)
  if (isChallengePage(response)) throw new Error(`${source.name} 返回了防护验证页面，请导入浏览器 Cookie 或更换网络`)
  if (/禁止了你的網路所在國家|prohibited in the country|not available in your (country|region)/i.test(response.body || '')) {
    throw new Error(`${source.name} 不允许当前网络所在地区访问，请配置代理（宿主代理域名或插件刮削代理）`)
  }
  if (response.status >= 400) throw new Error(`${source.name} 返回 HTTP ${response.status}`)
  return { response, missing: false }
}

function loadPage(env, source, response) {
  const body = response.body || ''
  const page = { url: response.url, body }
  if (source.type === 'json') {
    try { page.json = JSON.parse(body) } catch { throw new Error(`${source.name} 返回的不是 JSON`) }
    if (source.response_code && jsonPath(page.json, source.response_code.path) !== source.response_code.ok) throw new Error(`${source.name} 数据接口返回错误（${jsonPath(page.json, source.response_code.path) ?? '缺少状态码'}）`)
    const errors = source.json_errors && jsonPath(page.json, source.json_errors)
    if (errors && (!Array.isArray(errors) || errors.length)) throw new Error(`${source.name} 数据接口返回错误，请检查来源访问状态或更新规则`)
    return page
  }
  page.$ = env.html.load(body, { baseURL: response.url })
  if (source.next_data) {
    const raw = page.$.find(source.next_data).first().text()
    try { page.json = JSON.parse(raw) } catch { page.json = null }
  }
  const ld = page.$.find('script[type="application/ld+json"]').map(node => node.text())
  const objects = []
  const collect = data => { if (Array.isArray(data)) data.forEach(collect); else if (data && typeof data === 'object') { objects.push(data); if (data['@graph']) collect(data['@graph']) } }
  for (const text of ld) { try { collect(JSON.parse(text)) } catch { /* 下一个 */ } }
  page.jsonld = objects.find(data => [data['@type']].flat().some(t => /^(Movie|VideoObject|Product)$/i.test(t))) || objects[0]
  return page
}

async function prepareSteps(env, source, vars) {
  if (!source.shared_steps) return prepareStepsOnce(env, source, vars)
  // 同站并发首次访问共用一次初始化，避免不同 CSRF 会话互相覆盖 Cookie。
  // 仅合并正在进行的请求；下一次刮削重新读取，避免长期复用过期令牌。
  const pending = env.sourceSteps ||= new Map()
  const key = JSON.stringify([source.id, vars.base, source.steps, source.headers])
  if (!pending.has(key)) {
    const prepared = { ...vars }
    pending.set(key, prepareStepsOnce(env, source, prepared).then(ok => ok ? Object.fromEntries((source.steps || []).map(step => [step.as, prepared[step.as]])) : null).finally(() => pending.delete(key)))
  }
  const values = await pending.get(key)
  if (!values) return false
  Object.assign(vars, values)
  return true
}

async function prepareStepsOnce(env, source, vars) {
  for (const step of source.steps || []) {
    const { response, missing } = await request(env, source, fillTemplate(step.url, vars), { ...step, vars })
    if (missing) return false
    let value = ''
    if (step.json !== undefined) { try { value = jsonPath(JSON.parse(response.body), step.json) } catch { value = '' } }
    else if (step.sel) value = env.html.load(response.body || '', { baseURL: response.url }).find(step.sel).first().attr(step.attr || 'content')
    else if (step.re) value = ((response.body || '').match(new RegExp(step.re, 'i')) || [])[1] || ''
    if (!value) { if (step.required) throw new Error(`${source.name} 前置页面缺少 ${step.as}，可能需要更新来源规则`); return false }
    vars[step.as] = Array.isArray(value) ? value[0] : value
    await env.pause()
  }
  return true
}

// 跑一个来源：返回 meta 或 null（没有这部作品）。网络、验证、解析错误抛出。
export async function runSource(env, source, number, options = {}) {
  if (source.needs_token && !options.vars?.token) throw new Error(`${source.name} 需要先在来源设置里填写令牌`)
  if (source.requires_age && !env.ageConfirm) throw new Error(`${source.name} 需要年龄验证：请先在设置里开启“年龄确认”`)
  const vars = numberVars(number, { base: env.base(source.id, source.base), ...(options.vars || {}) })
  if (source.manual_url) {
    if (source.detail?.page_pattern) {
      const manual = new URL(source.manual_url)
      if (manual.origin !== new URL(source.detail.page_base || vars.base).origin) throw new Error('详情地址与所选来源站点不一致')
      const match = manual.pathname.match(new RegExp(source.detail.page_pattern))
      if (!match) throw new Error('详情地址格式与所选来源不符')
      for (const [i, key] of (source.detail.page_vars || []).entries()) vars[key] = match[i + 1]
      for (const [key, query] of Object.entries(source.detail.page_query || {})) {
        const value = manual.searchParams.get(query)
        if (!value) throw new Error('详情地址缺少作品编号')
        vars[key] = value
      }
      source = { ...source, detail: { ...source.detail, from_search: false, page_url: source.manual_url } }
    } else source = { ...source, steps: [], detail: { url: source.manual_url } }
  }
  if (!await prepareSteps(env, source, vars)) return null
  let detailURL = ''
  if (source.detail === 'search' || source.detail?.from_search || (source.search && !source.detail)) {
    const items = await runSearch(env, source, number, { vars, exact: true, prepared: true })
    const hit = items.find(item => item.number && sameCode(item.number, number))
    if (!hit?.url) {
      // 结果列表不显示番号时（search.verify_detail），逐个打开前几条结果，在详情页核对番号。
      if (!source.search.verify_detail) return null
      for (const item of items.filter(i => i.url).slice(0, source.search.verify_limit || 3)) {
        const candidate = { ...vars, ...item.vars }
        const url = source.detail?.from_search ? fillTemplate(source.detail.url, candidate) : item.url
        const meta = await parseDetail(env, source, url, candidate, number)
        if (meta) return meta
      }
      return null
    }
    Object.assign(vars, hit.vars || {})
    detailURL = source.detail?.from_search ? fillTemplate(source.detail.url, vars) : hit.url
  } else {
    detailURL = fillTemplate(source.detail.url, vars)
  }
  return parseDetail(env, source, detailURL, vars, number)
}

async function parseDetail(env, source, detailURL, vars, number) {
  const detail = typeof source.detail === 'object' ? source.detail : {}
  const { response, missing } = await request(env, source, detailURL, { ...detail, vars })
  if (missing) return null
  if (source.not_found && new RegExp(source.not_found, 'i').test(response.body || '')) return null
  const page = loadPage(env, source, response)
  if (detail.missing_json && jsonPath(page.json, detail.missing_json) === null) return null
  const pageURL = detail.page_url ? fillTemplate(detail.page_url, vars) : response.url || detailURL
  const ctx = { source, vars, pageURL }
  const meta = { actors: [], genres: [], samples: [], source: source.id, source_url: pageURL }
  // 先取不依赖其他字段的，再取 from 派生字段（如由封面推出竖版海报）。
  const entries = Object.entries(source.fields || {})
  for (const [field, spec] of entries.filter(([, s]) => !normalizeSpec(s).from)) meta[field] = extract(field, spec, page, ctx, meta)
  for (const [field, spec] of entries.filter(([, s]) => normalizeSpec(s).from)) {
    const value = extract(field, spec, page, ctx, meta)
    if (value && (!Array.isArray(value) || value.length)) meta[field] = value
  }
  // xxx_fallback：主字段取不到时的备选规则。
  for (const key of Object.keys(meta)) {
    if (!key.endsWith('_fallback')) continue
    const field = key.slice(0, -'_fallback'.length)
    if (!meta[field] || (Array.isArray(meta[field]) && !meta[field].length)) meta[field] = meta[key]
    delete meta[key]
  }
  if (!meta.number && source.require_number) throw new Error(`${source.name} 详情页未返回可核验的番号，页面可能变更或请求被拦截`)
  if (!meta.number) meta.number = vars.number
  if (!sameCode(meta.number, number)) return null
  meta.number = vars.number
  if (meta.title && source.strip_number_from_title !== false) {
    meta.title = meta.title.replace(new RegExp('^\\s*' + vars.number.replace(/[-_]/g, '[-_ ]?') + '\\s*', 'i'), '').trim() || meta.title
  }
  if (!meta.original_title) meta.original_title = meta.title
  if (!meta.title) return null
  return meta
}

export async function runSearch(env, source, keyword, options = {}) {
  if (!source.search) return []
  if (source.needs_token && !options.vars?.token) throw new Error(`${source.name} 需要先在来源设置里填写令牌`)
  if (source.requires_age && !env.ageConfirm) throw new Error(`${source.name} 需要年龄验证：请先在设置里开启“年龄确认”`)
  const vars = { ...numberVars(keyword, { base: env.base(source.id, source.base) }), ...options.vars, keyword }
  if (!options.prepared && !await prepareSteps(env, source, vars)) return []
  const spec = source.search
  if (options.exact && spec.exact_keyword) vars.keyword = fillTemplate(spec.exact_keyword, vars, true)
  const url = fillTemplate(spec.url, vars)
  const { response, missing } = await request(env, source, url, { ...spec, vars })
  if (missing) return []
  // 番号搜索常直接跳到详情页：此时把当前页当作唯一结果。
  if (spec.direct && new RegExp(spec.direct, 'i').test(response.url || '')) return [{ number: keyword, url: response.url, title: '' }]
  const page = loadPage(env, { ...source, type: spec.json !== undefined ? 'json' : source.type === 'json' ? 'json' : 'html' }, response)
  const ctx = { source, vars, pageURL: response.url || url }
  if (page.json !== undefined && spec.json !== undefined) {
    const list = jsonPath(page.json, spec.json)
    return (Array.isArray(list) ? list : list ? [list] : []).map(item => ({
      number: clean(jsonPath(item, spec.number_json || 'number')),
      title: clean(jsonPath(item, spec.title_json || 'title')),
      url: spec.link_template ? fillTemplate(spec.link_template, { ...vars, ...flat(item) }) : absolute(jsonPath(item, spec.link_json || 'url'), ctx.pageURL),
      ...(spec.vars ? { vars: Object.fromEntries(Object.entries(spec.vars).map(([key, path]) => [key, jsonPath(item, path)])) } : {}),
    })).filter(item => item.number)
  }
  const out = []
  page.$.find(spec.item).each(node => {
    const read = (s, attr) => {
      if (!s) return ''
      const n = normalizeSpec(s)
      const target = n.sel === '.' || !n.sel ? node : node.find(n.sel).first()
      const value = clean((n.attr || attr) && (n.attr || attr) !== 'text' ? target.attr(n.attr || attr) : target.text())
      if (!n.re) return value
      const m = value.match(new RegExp(n.re, 'i'))
      return m ? clean(m[1] ?? m[0]) : ''
    }
    const number = read(spec.number)
    let title = read(spec.title)
    if (title && number && spec.title_strip_number !== false) title = title.replace(number, '').trim()
    const link = spec.link ? absolute(read(spec.link, 'href'), ctx.pageURL) : absolute(node.attr('href'), ctx.pageURL)
    if (number || link) out.push({ number, title, url: link })
  })
  return out
}

function flat(item) {
  return Object.fromEntries(Object.entries(item || {}).filter(([, v]) => typeof v !== 'object'))
}

// 宽松比较两个番号：忽略大小写、分隔符与前导零（站点写法各不相同）。
export function sameCode(a, b) {
  const norm = value => {
    const v = String(value || '').toUpperCase().replace(/[\s_]/g, '-').replace(/^FC2-?PPV-?/, 'FC2-')
    const m = v.match(/^(\d*)([A-Z]+)-?0*(\d+)$/)
    return m ? `${m[1]}${m[2]}-${m[3]}` : v.replace(/-/g, '')
  }
  return Boolean(a) && Boolean(b) && norm(a) === norm(b)
}
