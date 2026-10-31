import { SUBSCRIPTION_CONFIG, subscriptionConfig, validateSubscriptionConfig, extractNumbers, changeSubscriptions, readSubscriptions } from '../ui/lib/subscriptions.js'
import { searchSubscriptions, prepareCandidate, submitCandidate, verifyReceipt, candidateIdentity, pendingIdentity } from './lib/subscription-sources.js'
import { mapPool } from './lib/pool.js'
import {accountSelector} from '../ui/lib/accounts.js'

const stamp = () => new Date().toISOString()
const activeReceipt = receipt => receipt && ['submitting', 'attention'].includes(receipt.status)

async function receiptKey(ctx, candidate, config) {
  const identity = candidateIdentity(candidate)
  const account = accountSelector(config.account)
  const destination = candidate.target === '115' ? (account.id || account.mode !== 'main' ? [account.mode,account.id,config.save_cid] : config.save_cid) : config.downloader
  return ctx.crypto.sha256(JSON.stringify([candidate.target, destination, identity]))
}

function dropPending(item, candidate) {
  item.pending_candidates = (item.pending_candidates || []).filter(c => pendingIdentity(c) !== pendingIdentity(candidate))
}

export async function addSubscriptions(ctx, numbers) {
  if (numbers.length > 100) throw new Error('单次最多添加 100 个番号，请分批发送')
  return changeSubscriptions(ctx, state => {
    let added = 0
    for (const number of numbers) {
      if (state.items[number]) continue
      state.items[number] = { number, enabled: true, status: 'waiting', created_at: stamp(), next_at: stamp(), attempts: 0, lease: null }
      added++
    }
    return added
  })
}

async function finish(ctx, number, patch) {
  return changeSubscriptions(ctx, state => {
    const item = state.items[number]
    if (item?.lease !== ctx.task.id) return
    Object.assign(item, patch, { lease: null, updated_at: stamp() })
  })
}

async function processNumber(ctx, config, number, force) {
  const claimed = await changeSubscriptions(ctx, state => {
    const item = state.items[number]
    if (!item?.enabled || item.lease || ['submitted', 'attention', 'submitting'].includes(item.status)) return false
    if (!force && Date.parse(item.next_at || 0) > Date.now()) return false
    Object.assign(item, { lease: ctx.task.id, status: 'searching', last_search_at: stamp(), attempts: item.attempts + 1 })
    return item
  })
  if (!claimed) return { number, skipped: true }
  let hasMutation = false
  const nextAt = () => new Date(Date.now() + config.interval_minutes * 60000).toISOString()
  try {
    const result = await searchSubscriptions(ctx, config, number, claimed)
    const candidates = await changeSubscriptions(ctx, state => {
      const item = state.items[number]
      if (item?.lease !== ctx.task.id) return []
      const active = new Map(result.sources.map(s => [s.source, s.signature]))
      const queue = (item.pending_candidates || []).filter(c => active.get(c.poll_key) === c.poll_signature)
      const known = new Set(queue.map(pendingIdentity))
      for (const candidate of result.candidates) {
        const id = pendingIdentity(candidate)
        if (!known.has(id)) { queue.push(candidate); known.add(id) }
      }
      // Candidates and source progress are one durable write: advancing even an
      // empty window is safe; interrupting or submitting only one result loses none.
      Object.assign(item, { pending_candidates: queue, source_state: Object.fromEntries(result.sources.map(s => [s.source, s.state])),
        found: queue.length, errors: result.errors, next_at: nextAt() })
      return queue
    })
    for (const rawCandidate of candidates) {
      let candidate
      try { candidate = await prepareCandidate(ctx, rawCandidate) } catch {
        await changeSubscriptions(ctx, state => {
          if (state.items[number]?.lease === ctx.task.id) state.items[number].errors.push(`${rawCandidate.source_id}：无法读取有效种子，请检查种子地址是否可直接访问`)
        })
        continue
      }
      let key = await receiptKey(ctx, candidate, config)
      const decision = await changeSubscriptions(ctx, state => {
        const item = state.items[number]
        if (!item?.enabled || item.lease !== ctx.task.id) return 'stopped'
        // 1.0/1.1 used a single M-Team source ID. Retain the exact older
        // receipt (including uncertain outcomes) when upgrading per-site scans.
        if (!state.receipts[key] && candidate.source_id.startsWith('host-mteam-') && !candidate.info_hash) {
          const legacy = Object.entries(state.receipts).find(([, r]) => r.candidate?.source_id === 'host-mteam' &&
            r.candidate.site_id === candidate.site_id && r.candidate.target === candidate.target && r.downloader === config.downloader &&
            (r.candidate.resource_id || r.candidate.download_url) === (candidate.resource_id || candidate.download_url))
          if (legacy) key = legacy[0]
        }
        const receipt = state.receipts[key]
        if (receipt?.status === 'submitted') {
          dropPending(item, rawCandidate)
          if (item.continue_search) return 'seen'
          Object.assign(item, { status: 'submitted', receipt_key: key, submitted_at: receipt.at, lease: null })
          return 'existing'
        }
        if (activeReceipt(receipt)) {
          Object.assign(item, { status: 'attention', receipt_key: key, lease: null, note: '同一种子已有提交结果待核对' })
          return 'attention'
        }
        state.receipts[key] = { candidate, status: 'submitting', task_id: ctx.task.id, at: stamp(),
          downloader: config.downloader, save_cid: config.save_cid, account: accountSelector(config.account) }
        Object.assign(item, { status: 'submitting', receipt_key: key })
        return 'submit'
      })
      if (decision === 'stopped') break
      if (decision === 'seen') continue
      if (decision !== 'submit') return { number, status: decision }
      hasMutation = true
      // Durable intent is saved before the external call. A timeout never permits resubmission.
      let receiptResult
      try { receiptResult = await submitCandidate(ctx, config, candidate) } catch {
        await changeSubscriptions(ctx, state => {
          state.receipts[key].status = 'attention'
          const item = state.items[number]
          if (item?.lease === ctx.task.id) Object.assign(item, { status: 'attention', lease: null,
            note: '提交结果未确认；请先核对 115 或下载器，勿直接重复提交' })
        })
        return { number, status: 'attention' }
      }
      await changeSubscriptions(ctx, state => {
        Object.assign(state.receipts[key], { status: 'submitted', result: receiptResult, at: stamp() })
        const item = state.items[number]
        if (item?.lease === ctx.task.id) Object.assign(item, { status: 'submitted', lease: null, submitted_at: stamp(), note: '' })
        if (item) dropPending(item, rawCandidate)
        for (const dependent of Object.values(state.items)) {
          if (dependent.receipt_key === key && dependent.status === 'attention' && !dependent.lease)
            Object.assign(dependent, { status: 'submitted', submitted_at: stamp(), note: '同一种子的提交已确认' })
        }
      })
      return { number, status: 'submitted' }
    }
    await finish(ctx, number, { status: 'waiting', next_at: nextAt(),
      note: result.source_count ? (result.errors.length ? '部分查询失败，下次从保留的进度继续' : result.sources.some(s => s.state.window) ? '本页已处理，下次从保存的分页进度继续' : '本次无可提交的新资源，下次从时间基线继续') : '已添加订阅；请启用缓存或配置数据库查询源、馒头站点' })
    return { number, status: 'waiting' }
  } catch (error) {
    // If intent was saved, leave its lease/receipt for recovery. Never lose an uncertain write.
    if (hasMutation) throw error
    await finish(ctx, number, { status: 'waiting', next_at: nextAt(), note: '搜索未完成，下次重试；请检查查询源配置' })
    return { number, status: 'waiting', failed: true }
  }
}

export async function run(ctx, input = {}) {
  const message = Object.prototype.hasOwnProperty.call(input, 'text') && !input.manual
  const numbers = input.text ? extractNumbers(input.text, message) : []
  if (input.text && !numbers.length) return { added: 0, note: '没有识别出番号；格式：av SSIS-001 MIDV-100' }
  // Persist first, including when there are no sources or a source is broken.
  const added = numbers.length ? await addSubscriptions(ctx, numbers) : 0
  await ctx.task.checkpoint({ stage: 'processing' })
  const config = subscriptionConfig(await ctx.storage.get(SUBSCRIPTION_CONFIG))
  if (!config.enabled) return { added, note: '订阅已保存，自动搜索当前已暂停' }
  validateSubscriptionConfig(config)
  const state = await readSubscriptions(ctx)
  const selected = numbers.length ? numbers : Object.values(state.items)
    .filter(item => item.enabled && !item.lease && item.status === 'waiting' && (input.force || Date.parse(item.next_at || 0) <= Date.now()))
    .sort((a, b) => String(a.next_at).localeCompare(String(b.next_at))).slice(0, config.batch_size).map(item => item.number)
  await ctx.task.update({ stage: 'subscription-search', message: `订阅搜索 ${selected.length} 个番号`, total: selected.length, done: 0, failed: 0 })
  let done = 0
  // Settle every worker before returning, even if a storage call fails mid-submit.
  const results = await mapPool(selected, config.concurrency, async number => {
    try {
      const result = await processNumber(ctx, config, number, numbers.length > 0 || input.force)
      done++
      await ctx.task.update({ done, message: `${number} · ${done}/${selected.length}` })
      return result
    } catch {
      return { number, status: 'interrupted' }
    }
  })
  if (results.some(result => result.status === 'interrupted')) throw new Error('订阅任务中断，请使用“核对并继续”检查结果')
  const result = { added, results }
  await ctx.task.checkpoint({ stage: 'complete', result })
  return result
}

export async function recover(ctx, checkpoint) {
  if (checkpoint?.stage === 'complete') return { action: 'complete', result: checkpoint.result }
  const snapshot = await readSubscriptions(ctx)
  let attention = false
  for (const item of Object.values(snapshot.items).filter(item => item.lease === ctx.task.id)) {
    const receipt = snapshot.receipts[item.receipt_key]
    if (receipt && receipt.task_id === ctx.task.id) {
      let confirmed = receipt.status === 'submitted'
      if (!confirmed) {
        try { confirmed = await verifyReceipt(ctx, receipt) } catch { /* keep uncertain */ }
      }
      await changeSubscriptions(ctx, state => {
        state.receipts[item.receipt_key].status = confirmed ? 'submitted' : 'attention'
        const current = state.items[item.number]
        if (current?.lease !== ctx.task.id) return
        Object.assign(current, { lease: null, status: confirmed ? 'submitted' : 'attention',
          note: confirmed ? '已核对提交结果' : '未能确认远端结果，请人工核对后处理' })
        if (confirmed) for (const dependent of Object.values(state.items)) {
          if (dependent.receipt_key === item.receipt_key && dependent.status === 'attention' && !dependent.lease)
            Object.assign(dependent, { status: 'submitted', note: '同一种子的提交已核对' })
        }
      })
      attention ||= !confirmed
    } else {
      await finish(ctx, item.number, { status: 'waiting', next_at: stamp(), note: '搜索中断，等待重新搜索' })
    }
  }
  // Uncertain subscriptions stay blocked individually; unrelated subscriptions can continue.
  return { action: 'resume', result: { attention } }
}
