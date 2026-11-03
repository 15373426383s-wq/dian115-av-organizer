// 模糊匹配度：0–100。页面与后台共用。
//
// 文件名里的标题线索（query）与站点标题比较：
//   相似比  = 2 × 公共子序列长度 ÷ (query 长度 + 标题长度)   —— 两者整体有多像
//   覆盖率  = 公共子序列长度 ÷ query 长度                     —— 文件名里的字有多少出现在标题里
//   匹配度  = (相似比 + 覆盖率) ÷ 2 × 100
// 文件名是完整标题时为 100；是标题的前半段时约 83；无关标题通常低于 40。

import { toHalfWidth } from './number.js'

export function normalizeForMatch(value) {
  return toHalfWidth(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function lcsLength(a, b) {
  const left = [...a].slice(0, 300), right = [...b].slice(0, 300)
  if (!left.length || !right.length) return 0
  let prev = new Array(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i++) {
    const curr = new Array(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j++) {
      curr[j] = left[i - 1] === right[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    prev = curr
  }
  return prev[right.length]
}

export function matchScore(query, title) {
  const q = normalizeForMatch(query), t = normalizeForMatch(title)
  if (!q || !t) return 0
  if (q === t) return 100
  const common = lcsLength(q, t)
  const ratio = (2 * common) / ([...q].length + [...t].length)
  const coverage = common / [...q].length
  return Math.round(((ratio + coverage) / 2) * 100)
}

// 候选的匹配度：标题单独比较，以及"演员 + 标题"一起比较（文件名常写演员名），取较高者。
export function candidateScore(query, meta) {
  const title = meta?.title || ''
  const actors = (meta?.actors || []).join('')
  return Math.max(matchScore(query, title), actors ? matchScore(query, actors + title) : 0, actors ? matchScore(query, title + actors) : 0)
}

export function usableQuery(query, minChars) {
  return [...normalizeForMatch(query)].length >= Math.max(1, Number(minChars) || 1)
}

// 自动采用规则：第一名 ≥ 阈值，且领先第二名至少 margin 分。返回 {accepted, best, runnerUp, reason}。
export function decide(scored, threshold, margin) {
  const ranked = [...scored].sort((a, b) => b.score - a.score)
  const best = ranked[0], runnerUp = ranked[1]
  if (!best) return { accepted: false, reason: '没有可比较的候选' }
  if (best.score < threshold) return { accepted: false, best, runnerUp, reason: `最高匹配度 ${best.score} 低于阈值 ${threshold}` }
  if (runnerUp && best.score - runnerUp.score < margin) {
    return { accepted: false, best, runnerUp, reason: `前两名匹配度 ${best.score} / ${runnerUp.score} 相差不足 ${margin}` }
  }
  return { accepted: true, best, runnerUp }
}
