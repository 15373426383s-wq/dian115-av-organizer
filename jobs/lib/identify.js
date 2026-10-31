// 统一识别流程，全部自动：
//   1. 精确番号：严格规则认出唯一番号 → 刮削（番号必须完全一致）。
//   2. 宽松候选：认出多个番号，或只有宽松写法（ssis001hhb、abc 12）→ 逐个刮削确认存在，
//      再按标题线索的匹配度挑选；两位数编号必须达到阈值。
//   3. 关键词模糊搜索：完全没有番号 → 用清理后的标题线索搜索站点，按匹配度挑选。
// 第 2、3 步只在"第一名 ≥ 阈值且领先第二名 ≥ 差距"时自动采用，否则留在待确认并写明匹配度。

import { parseMedia, parseName, normalizeNumber, compileCleanRules } from '../../ui/lib/number.js'
import { candidateScore, matchScore, usableQuery, decide } from '../../ui/lib/fuzzy.js'
import { scrape } from './scrape.js'
import { searchPlan, searchPlanItem } from './sources.js'

const MAX_LOOSE_CANDIDATES = 4
const MAX_SEARCH_RESULTS = 10

export function kindOf(number) {
  return parseName(number).kind || (/^FC2-/i.test(number) ? 'fc2' : 'standard')
}

export function parseWithSettings(file, parentName, settings) {
  const { rules } = compileCleanRules(settings.clean_rules)
  return parseMedia(file.name, parentName, { cleanRules: rules })
}

// 返回 {ok:true, parsed, meta, method, score} 或 {ok:false, reason, candidates, number}
export async function identify(env, file, parentName, settings, cache, options = {}) {
  const log = options.log || (() => {})
  const parsed = parseWithSettings(file, parentName, settings)

  if (options.manualNumber) {
    parsed.number = normalizeNumber(options.manualNumber)
    parsed.kind = kindOf(parsed.number)
  }

  // 1. 精确番号
  if (parsed.number) {
    const { meta, errors } = await scrape(env, parsed, settings, cache)
    errors.forEach(error => log(`${parsed.number} ${error}`))
    if (meta) return { ok: true, parsed, meta, method: options.manualNumber ? 'manual' : 'exact', score: 100 }
    return { ok: false, reason: `刮削失败：${errors.join('；') || '所有来源都没有结果'}`, candidates: [parsed.number], number: parsed.number }
  }

  if (!settings.fuzzy_enabled) {
    return { ok: false, reason: parsed.reason || '没有认出番号（模糊匹配已关闭）', candidates: parsed.candidates }
  }
  const threshold = settings.fuzzy_threshold, margin = settings.fuzzy_margin
  const hasQuery = usableQuery(parsed.query, settings.fuzzy_min_chars)

  // 2. 宽松候选：先确认番号在站点上真实存在，再比较标题线索。
  const loose = parsed.candidates.length > 1
    ? parsed.candidates.map(number => ({ number, short: false }))
    : parsed.loose
  if (loose.length) {
    // 各候选并发核对，结果保持候选顺序。
    const checked = await Promise.all(loose.slice(0, MAX_LOOSE_CANDIDATES).map(async candidate => {
      const attempt = { ...parsed, number: candidate.number, kind: kindOf(candidate.number) }
      const { meta, errors } = await scrape(env, attempt, settings, cache)
      errors.forEach(error => log(`${candidate.number} ${error}`))
      return meta ? { number: candidate.number, short: candidate.short, meta, parsed: attempt, score: hasQuery ? candidateScore(parsed.query, meta) : 0 } : null
    }))
    const verified = checked.filter(Boolean)
    // 两位数编号太容易撞上无关作品：必须有足够的标题线索并达到阈值。
    const usable = verified.filter(item => !item.short || (hasQuery && item.score >= threshold))
    if (usable.length === 1) {
      const item = usable[0]
      // 文件名里有成段标题文字却与该番号的标题对不上，说明番号可能认错了。
      if (!hasQuery || item.score >= threshold) return { ok: true, parsed: item.parsed, meta: item.meta, method: 'loose', score: hasQuery ? item.score : null }
      return pending(`宽松番号 ${item.number} 存在，但标题匹配度 ${item.score} 低于阈值 ${threshold}`, usable)
    }
    if (usable.length > 1) {
      if (!hasQuery) return pending('宽松番号候选有多个，且文件名里没有可比较的标题文字', usable)
      const decision = decide(usable, threshold, margin)
      if (decision.accepted) return { ok: true, parsed: decision.best.parsed, meta: decision.best.meta, method: 'loose', score: decision.best.score }
      return pending(`宽松番号候选无法确定：${decision.reason}`, usable)
    }
    if (!hasQuery) {
      return { ok: false, reason: `宽松候选 ${loose.map(item => item.number).join('、')} 都未通过核对`, candidates: loose.map(item => item.number) }
    }
    // 候选都不成立时继续尝试关键词搜索。
  }

  // 3. 关键词模糊搜索
  if (!hasQuery) {
    return { ok: false, reason: `${parsed.reason || '没有认出番号'}，可用于模糊搜索的文字不足 ${settings.fuzzy_min_chars} 个字符`, candidates: parsed.candidates }
  }
  const results = await searchAll(env, parsed.query, settings, log)
  if (results.length === 0) return { ok: false, reason: `模糊搜索「${parsed.query}」没有结果`, candidates: [] }
  const scored = results.map(item => ({ ...item, score: matchScore(parsed.query, item.title) }))
  const decision = decide(scored, threshold, margin)
  if (!decision.accepted) return pending(`模糊搜索「${parsed.query}」：${decision.reason}`, scored)

  const attempt = { ...parsed, number: normalizeNumber(decision.best.number), kind: kindOf(normalizeNumber(decision.best.number)) }
  const { meta, errors } = await scrape(env, attempt, settings, cache)
  errors.forEach(error => log(`${attempt.number} ${error}`))
  if (!meta) return { ok: false, reason: `模糊搜索命中 ${attempt.number}（匹配度 ${decision.best.score}），但刮削详情失败：${errors.join('；')}`, candidates: [attempt.number] }
  // 详情里有演员，可能让匹配度更高；但不能因为详情标题不同而低于阈值。
  const finalScore = Math.max(decision.best.score, candidateScore(parsed.query, meta))
  return { ok: true, parsed: attempt, meta, method: 'fuzzy', score: finalScore }
}

async function searchAll(env, query, settings, log) {
  // 各搜索来源并发查询；合并时按来源顺序去重。
  const plans = searchPlan(settings)
  const lists = await Promise.all(plans.map(plan => searchPlanItem(env, plan, query).catch(error => {
    log(`${plan.def.name} 搜索失败：${error.message || error}`)
    return []
  })))
  const seen = new Map()
  lists.forEach((items, index) => {
    for (const item of items.slice(0, MAX_SEARCH_RESULTS)) {
      if (!item.number) continue
      const number = normalizeNumber(item.number)
      if (!seen.has(number)) seen.set(number, { number, title: item.title, source: plans[index].def.id })
    }
  })
  return [...seen.values()]
}

function pending(reason, scored) {
  const ranked = [...scored].sort((a, b) => b.score - a.score).slice(0, 5)
  return {
    ok: false,
    reason,
    candidates: ranked.map(item => item.number),
    scores: ranked.map(item => ({ number: item.number, title: item.meta?.title || item.title || '', score: item.score })),
  }
}
