import { parseName, toHalfWidth } from './number.js'
import {accountSelector} from './accounts.js'

export const SUBSCRIPTION_CONFIG = 'subscription_config'
export const SUBSCRIPTION_STATE = 'subscription_state'
export const SUBSCRIPTION_DEFAULTS = {
  enabled: true, interval_minutes: 60, concurrency: 3, batch_size: 50,
  sources: [], cache_enabled: true, mteam_enabled: false, mteam_site_ids: [], downloader: '', save_cid: '', account: {mode:'main'}, save_cid_name: '',
}
export const subscriptionURL = `/api/extensions/v3/local.av-organizer/storage/${SUBSCRIPTION_STATE}`

export function extractNumbers(text, message = false) {
  let value = toHalfWidth(String(text || '')).trim()
  if (message) {
    if (!/^(?:av\s+|\/av(?:@\w+)?\s+)/i.test(value)) return []
    value = value.replace(/^(?:av\s+|\/av(?:@\w+)?\s+)/i, '')
  }
  // Append an extension so the filename parser does not drop a final dotted number.
  const parsed = [value, ...value.split(/[\s,，;；、]+/)].map(part => parseName(`${part}.mp4`))
  return [...new Set(parsed.flatMap(item => [...item.candidates, ...item.loose.map(candidate => candidate.number)]))]
}

export function subscriptionConfig(saved = {}) {
  const value = { ...SUBSCRIPTION_DEFAULTS, ...(saved || {}) }
  value.interval_minutes = Math.max(1, Math.min(10080, Number(value.interval_minutes) || 60))
  value.concurrency = Math.max(1, Math.min(8, Math.floor(Number(value.concurrency) || 3)))
  value.batch_size = Math.max(1, Math.min(100, Math.floor(Number(value.batch_size) || 50)))
  value.sources = Array.isArray(value.sources) ? value.sources : []
  value.account = accountSelector(value.account)
  value.save_cid = String(value.save_cid ?? '').trim()
  value.mteam_site_ids = [...new Set((value.mteam_site_ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
  return value
}

export function validateSubscriptionConfig(config) {
  const account = accountSelector(config.account)
  if (config.save_cid && !/^\d+$/.test(config.save_cid)) throw new Error('请重新选择 115 保存目录')
  if (account.mode === 'backup' && !config.save_cid) throw new Error('备用账号需要选择保存目录')
  if (config.sources.length > 10) throw new Error('最多配置 10 个数据库查询源')
  const ids = new Set()
  for (const source of config.sources) {
    if (!/^[a-z0-9-]{1,40}$/.test(source.id || '') || ids.has(source.id)) throw new Error('查询源 id 必须是唯一的小写字母、数字或连字符')
    ids.add(source.id)
    const url = new URL(String(source.url || '').replaceAll('{number}', 'SSIS-001'))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('查询源地址必须是 HTTP(S)，认证请使用 headers')
    if (!['GET', 'POST'].includes(source.method || 'GET')) throw new Error('查询方法仅支持 GET 或 POST')
    if (!['115', 'downloader'].includes(source.target)) throw new Error('查询源 target 必须为 115 或 downloader')
    if (source.headers && (typeof source.headers !== 'object' || Array.isArray(source.headers))) throw new Error('headers 必须是对象')
    if (source.incremental) {
      const template = `${source.url} ${source.method === 'POST' ? JSON.stringify(source.body || {}) : ''}`
      if (!['{since}', '{until}', '{cursor}'].every(token => template.includes(token)))
        throw new Error('增量查询源必须传入 {since}、{until} 和 {cursor}')
    }
  }
  if (config.mteam_enabled && !config.mteam_site_ids.length) throw new Error('请先选择已在主程序配置的馒头站点')
  return config
}

export const emptySubscriptions = () => ({ items: {}, receipts: {} })

// All writers (message jobs, schedule, page controls) use the same revision CAS.
// A JS module lock would not protect separate host VMs.
export async function changeSubscriptions(ctx, mutate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const snapshot = await ctx.api.get(subscriptionURL)
    const state = snapshot.value || emptySubscriptions()
    const result = mutate(state)
    try {
      await ctx.api.put(subscriptionURL, { value: state, expected_revision: snapshot.revision || 0 })
      return result
    } catch (error) {
      if (Number(error.status || error.response?.status) !== 409) throw error
      const ms = 10 + Math.floor(Math.random() * 40)
      if (ctx.sleep) await ctx.sleep(ms)
      else await new Promise(resolve => setTimeout(resolve, ms))
    }
  }
  throw new Error('订阅状态正在被其他任务更新，请稍后重试')
}

export async function readSubscriptions(ctx) {
  return (await ctx.api.get(subscriptionURL)).value || emptySubscriptions()
}

export const SUBSCRIPTION_LABELS = {
  waiting: '等待资源', searching: '搜索中', submitting: '提交中', submitted: '已提交', attention: '需要核对',
}
