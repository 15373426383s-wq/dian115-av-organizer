import {accountSelector, accountQuery, accountKey} from './shared/accounts.js'
import { extractNumbers } from './shared/subscriptions.js'
import { sameNumber } from './shared/number.js'
import { torrentInfoBytes } from './torrent.js'

const atPath = (value, path) => String(path || '').split('.').filter(Boolean).reduce((v, key) => v?.[key], value)
const replaceValues = (value, variables, encode = false) => {
  if (typeof value === 'string') return value.replace(/\{(number|since|until|cursor|page|limit)\}/g, (_, key) => encode ? encodeURIComponent(variables[key] ?? '') : String(variables[key] ?? ''))
  if (Array.isArray(value)) return value.map(v => replaceValues(v, variables, encode))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceValues(v, variables, encode)]))
  return value
}
const httpURL = value => /^https?:\/\//i.test(String(value || ''))

export function ed2kLink(value) {
  const match = String(value || '').trim().match(/^ed2k:\/\/\|file\|([^|\r\n]+)\|([0-9]+)\|([a-f0-9]{32})\|(?:[^\r\n]*\|)?\/$/i)
  if (!match || !/[1-9]/.test(match[2])) return null
  let name = match[1]
  try { name = decodeURIComponent(name) } catch { /* retain original name */ }
  const size = match[2].replace(/^0+(?=\d)/, '')
  return { name, hash: match[3].toLowerCase(), size,
    url: `ed2k://|file|${match[1]}|${size}|${match[3].toLowerCase()}|/` }
}

export const candidateIdentity = candidate => candidate.link_type === 'ed2k'
  ? `ed2k:${candidate.resource_hash}:${candidate.file_size}`
  : candidate.info_hash || `${candidate.source_id}:${candidate.resource_id || candidate.download_url}`
export const pendingIdentity = candidate => `${candidate.target}:${candidateIdentity(candidate)}`

export function infoHash(value) {
  const raw = String(value || '').trim()
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase()
  const hash = raw.match(/(?:xt=urn:btih:)([a-f0-9]{40})(?:&|$)/i)?.[1]
  if (hash) return hash.toLowerCase()
  const base32 = raw.match(/(?:xt=urn:btih:)([a-z2-7]{32})(?:&|$)/i)?.[1]
  if (!base32) return ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, buffer = 0, hex = ''
  for (const ch of base32.toUpperCase()) {
    buffer = (buffer << 5) | alphabet.indexOf(ch); bits += 5
    if (bits >= 8) { bits -= 8; hex += ((buffer >>> bits) & 255).toString(16).padStart(2, '0') }
  }
  return hex
}

export async function prepareCandidate(ctx, candidate) {
  const ed2k = ed2kLink(candidate.download_url)
  if (ed2k) {
    if (candidate.target !== '115') throw new Error('ED2K 资源需要提交给 115')
    return { ...candidate, link_type: 'ed2k', resource_hash: ed2k.hash, file_size: ed2k.size, info_hash: '', download_url: ed2k.url }
  }
  if (candidate.target !== '115') return candidate
  if (candidate.info_hash) return { ...candidate, download_url: `magnet:?xt=urn:btih:${candidate.info_hash}` }
  if (!httpURL(candidate.download_url)) return candidate
  // The offline URL API does not promise that an HTTP .torrent will be expanded.
  // Convert the actual torrent into a magnet before submitting to 115.
  let response
  try {
    response = await ctx.http.request({ url: candidate.download_url, response_type: 'base64',
      max_bytes: 4 * 1024 * 1024, timeout_seconds: 45, session: `subscription-${candidate.source_id}` })
    if (response.status !== 200 || !response.body_base64) throw new Error('torrent response')
    const hash = ctx.crypto.sha1(torrentInfoBytes(ctx.codec.base64Decode(response.body_base64)))
    return { ...candidate, info_hash: hash, download_url: `magnet:?xt=urn:btih:${hash}` }
  } catch { throw new Error('无法读取有效的种子文件；请提供可访问的种子 URL、磁力或 info_hash') }
}

export function exactCandidate(row, number) {
  if (row.number) return sameNumber(row.number, number)
  return extractNumbers(`${row.title || ''} ${row.sub_title || ''}`).some(n => sameNumber(n, number))
}

function normalizeCandidate(row, number, source) {
  const ed2k = ed2kLink(row.ed2k || row.magnet || row.download_url)
  if (ed2k && !String(row.title || '').trim()) row = { ...row, title: ed2k.name }
  if (!exactCandidate(row, number)) return null
  if (ed2k) return { source_id: source.id, source_name: source.name || source.id, target: '115', site_id: 0,
    title: String(row.title || number), number, download_url: ed2k.url, info_hash: '', link_type: 'ed2k',
    resource_hash: ed2k.hash, file_size: ed2k.size, resource_id: String(row.id || ''), seeders: 0 }
  const hash = infoHash(row.info_hash) || infoHash(row.magnet || row.download_url)
  let url = String(row.magnet || row.download_url || '')
  if (!httpURL(url) && !infoHash(url)) {
    if (!hash) return null
    url = `magnet:?xt=urn:btih:${hash}`
  }
  return { source_id: source.id, source_name: source.name || source.id, target: source.target,
    site_id: Number(row.site_id) || 0, title: String(row.title || number), number,
    download_url: url, info_hash: hash, resource_id: String(row.id || row.torrent_id || ''), seeders: Number(row.seeders) || 0 }
}

async function searchDatabase(ctx, source, number, window) {
  const variables = { number, ...window, limit: 100 }
  const request = { url: replaceValues(source.url, variables, true), method: source.method || 'GET',
    headers: source.headers || {}, response_type: 'json', timeout_seconds: 45, max_bytes: 4 * 1024 * 1024,
    session: `subscription-${source.id}`, cache_seconds: 0 }
  if (request.method === 'POST') request.json = replaceValues(source.body || { number: '{number}' }, variables)
  let response
  try { response = await ctx.http.request(request) } catch { throw new Error('查询连接失败或超时') }
  if (response.status < 200 || response.status >= 300) throw new Error(`查询 HTTP ${response.status}`)
  let data
  try { data = response.data ?? JSON.parse(response.body) } catch { throw new Error('查询响应不是 JSON') }
  const rows = atPath(data, source.results_path ?? 'items')
  if (!Array.isArray(rows)) throw new Error('查询结果字段不是数组，请检查 results_path')
  if (rows.length > 1000) throw new Error('查询结果超过 1000 条，请启用分页接口')
  const fields = { number: 'number', title: 'title', magnet: 'magnet', ed2k: 'ed2k', download_url: 'torrent_url', info_hash: 'info_hash', id: 'id', seeders: 'seeders', ...(source.fields || {}) }
  const candidates = rows.filter(row => row && typeof row === 'object').map(row => {
    const mapped = Object.fromEntries(Object.entries(fields).map(([key, path]) => [key, atPath(row, path)]))
    return normalizeCandidate(mapped, number, source)
  }).filter(Boolean)
  if (!source.incremental) return { candidates, complete: true }
  const complete = atPath(data, source.complete_path || 'complete')
  const cursor = atPath(data, source.cursor_path || 'next_cursor')
  if (typeof complete !== 'boolean' || (!complete && (typeof cursor !== 'string' || !cursor || cursor === window.cursor)))
    throw new Error('增量接口必须返回 complete 和可推进的 next_cursor')
  return { candidates, complete, cursor }
}

const epoch = '1970-01-01T00:00:00Z'
const wholeStamp = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z')
const overlap = (baseline, seconds) => baseline ? new Date(Math.max(0, Date.parse(baseline) - seconds * 1000)).toISOString().replace('.000Z', 'Z') : epoch

export function subscriptionSources(config) {
  const sources = config.sources.filter(s => s.enabled !== false).map(s => ({ ...s, key: `db:${s.id}` }))
  if (config.cache_enabled) sources.unshift({ id: 'host-cache', key: 'cache:offline', name: '磁力 / ED2K 缓存', target: '115', cache: true })
  if (config.mteam_enabled) for (const id of config.mteam_site_ids)
    sources.push({ id: `host-mteam-${id}`, key: `pt:${id}`, name: `馒头（${id}）`, target: 'downloader', site_id: id, pt: true })
  return sources
}

export async function searchSubscriptions(ctx, config, number, item = {}) {
  const sources = subscriptionSources(config)
  const result = await Promise.all(sources.map(async source => {
    const signature = ctx.crypto.sha256(JSON.stringify(source))
    const previous = item.source_state?.[source.key]
    const saved = previous?.signature === signature ? previous : {}
    const incremental = Boolean(source.cache || source.pt || source.incremental)
    const window = saved.window || { since: overlap(saved.baseline_at, source.pt ? 120 : 60), until: '', page: 1, cursor: '' }
    const record = { source: source.key, signature, name: source.name || source.id, candidates: [],
      state: { ...saved, signature, name: source.name || source.id, mode: incremental ? 'incremental' : 'full' } }
    try {
      // Bound retained work; no baseline moves while its candidates await use.
      if ((item.pending_candidates || []).filter(c => c.poll_key === source.key && c.poll_signature === signature).length >= 100)
        return { ...record, skipped: true }
      let page, until = window.until
      if (source.cache) {
        const query = Object.entries({ keyword: number, since: window.since, until, cursor_time: window.cursor_time || '', cursor_id: window.cursor_id || '', limit: 100 })
          .filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
        const response = await ctx.api.get(`/api/cache/magnet/changes?${query}`)
        if (!Array.isArray(response.items) || typeof response.complete !== 'boolean') throw new Error('缓存增量响应异常，请更新主程序')
        page = { complete: response.complete, cursor_time: response.cursor_time, cursor_id: response.cursor_id,
          candidates: response.items.map(row => normalizeCandidate({ ...row, title: `${row.title || ''} ${row.file_name || ''}`, magnet: row.magnet_link }, number, source)).filter(Boolean) }
        until = response.until
        if (!page.complete && (!Number.isSafeInteger(page.cursor_id) || page.cursor_id <= 0 || !Number.isFinite(Date.parse(page.cursor_time)) ||
          Date.parse(page.cursor_time) < Date.parse(window.since) || Date.parse(page.cursor_time) >= Date.parse(until) ||
          (window.cursor_time && (Date.parse(page.cursor_time) < Date.parse(window.cursor_time) || (page.cursor_time === window.cursor_time && page.cursor_id <= window.cursor_id)))))
          throw new Error('缓存增量游标没有推进')
      } else if (source.pt) {
        const response = await ctx.api.post('/api/pt/search', {
          keyword: number, site_ids: [source.site_id], page: window.page, page_size: 100, max_pages: 1,
          search_name_limit: 1, stop_when_found: false, mteam_mode: 'adult', incremental: true,
          published_after: window.since, ...(until ? { published_before: until } : {}),
        })
        const data = response.data, meta = data?.window
        if (response.code !== 'ok' || !Array.isArray(data?.torrents) || data.errors?.length || typeof meta?.complete !== 'boolean')
          throw new Error('PT 增量响应异常')
        if (!meta.complete && meta.next_page !== window.page + 1) throw new Error('PT 翻页没有推进')
        if (window.page_signature && meta.page_signature === window.page_signature) throw new Error('PT 返回重复页')
        page = { complete: meta.complete, page: meta.next_page, page_signature: meta.page_signature,
          candidates: data.torrents.filter(row => Number(row.site_id) === source.site_id).map(row => normalizeCandidate(row, number, source)).filter(Boolean) }
        until = meta.until
      } else {
        until ||= wholeStamp()
        page = await searchDatabase(ctx, source, number, { ...window, until })
      }
      if (incremental && (!Number.isFinite(Date.parse(until)) || Date.parse(until) < Date.parse(window.since) || (window.until && Date.parse(until) !== Date.parse(window.until))))
        throw new Error('增量查询时间窗口异常')
      const next = { ...record.state, checked_at: new Date().toISOString(), error: '' }
      if (incremental && page.complete) { next.baseline_at = until; delete next.window }
      else if (incremental) next.window = { ...window, until, page: page.page || window.page + 1,
        cursor: page.cursor, cursor_time: page.cursor_time, cursor_id: page.cursor_id, page_signature: page.page_signature }
      return { ...record, state: next, candidates: page.candidates.sort((a, b) => b.seeders - a.seeders)
        .map(c => ({ ...c, poll_key: source.key, poll_signature: signature })) }
    } catch (error) {
      // Host errors/remote bodies may contain credentials or signed URLs.
      const message = source.pt ? '馒头增量搜索失败，请检查主程序站点状态；基线保留' : source.cache ? '缓存增量查询失败，请检查主程序版本及缓存状态；基线保留' : error.message
      return { ...record, error: message, state: { ...record.state, error: message, checked_at: new Date().toISOString() } }
    }
  }))
  return { sources: result, candidates: result.flatMap(r => r.candidates),
    errors: result.filter(r => r.error).map(r => `${r.name}：${r.error}`), source_count: sources.length }
}

export async function submitCandidate(ctx, config, candidate) {
  if (candidate.target === '115') {
    const account = accountSelector(config.account)
    const result = await ctx.api.post('/api/115/offline/add', { urls: [candidate.download_url], account, ...(config.save_cid ? { save_cid: config.save_cid } : {}) })
    if (result.success !== true || result.accepted !== 1) throw new Error('115 未确认接收')
    if (account.id && result.account && accountKey(account) !== accountKey(result.account)) throw new Error('115 返回账号与提交目标不一致，请核对离线任务')
    if (config.save_cid && result.save_cid != null && String(result.save_cid) !== config.save_cid) throw new Error('115 返回目录与提交目标不一致，请核对离线任务')
    return { accepted: true, target: '115', save_cid: result.save_cid, account: result.account || account }
  }
  const response = await ctx.api.post('/api/pt/download', {
    site_id: candidate.site_id, site_name: candidate.source_name, title: candidate.title,
    download_url: candidate.download_url, info_hash: candidate.info_hash, downloader: config.downloader || '',
  })
  if (response.code !== 'ok' || response.data?.success !== true || response.data?.state_uncertain) throw new Error('下载器未确认接收')
  return { accepted: true, target: 'downloader', download_id: response.data.download_id, downloader: response.data.downloader,
    already_existed: Boolean(response.data.already_existed) }
}

export async function verifyReceipt(ctx, receipt) {
  const hash = receipt.candidate.info_hash
  if (!hash) return false
  if (receipt.candidate.target === '115') {
    const account = accountSelector(receipt.result?.account || receipt.account)
    const cid = receipt.result?.save_cid || receipt.save_cid
    for (let page = 1; page <= 100; page++) {
      const result = await ctx.api.get(`/api/115/offline/tasks?${accountQuery(account)}&status=all&page=${page}&page_size=100`)
      if (account.id && result.account && accountKey(account) !== accountKey(result.account)) return false
      const item = result.items?.find(item => String(item.info_hash).toLowerCase() === hash)
      if (item) return !['failed', 'move_failed', 'unknown'].includes(item.status) && (!cid || String(item.target_cid) === String(cid))
      if (page >= result.page_count || !result.items?.length) break
    }
  }
  // The host active-download endpoint only lists its current default downloader.
  // It cannot prove the identity of an earlier/custom target after config changes.
  // Such results require an explicit user check in the subscription page.
  return false
}
