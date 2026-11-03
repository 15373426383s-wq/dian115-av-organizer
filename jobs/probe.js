// 插件页"测试匹配"与"来源检测"：走与整理完全相同的识别流程（精确 → 宽松 → 模糊搜索），
// 只联网取数据，不动任何文件，结果直接返回给页面。
//   source：只用这一个来源（来源检测）；source_def：临时测试一份来源规则（来源编辑器）。

import { identify, parseWithSettings } from './lib/identify.js'
import { normalizeSettings } from './lib/plan.js'
import { applyMappings } from './lib/shared/mapping.js'
import { validateSource } from './lib/shared/registry.js'
import { scrapeEnv } from './organize.js'

export async function run(ctx, input = {}) {
  const settings = normalizeSettings(await ctx.settings.get())
  const name = String(input.text || '').trim()
  if (!name) throw new Error('请输入番号或文件名')
  const extraDefs = []
  if (input.source_def) {
    const def = typeof input.source_def === 'string' ? JSON.parse(input.source_def) : input.source_def
    const problem = validateSource(def)
    if (problem) throw new Error(`来源规则无效：${problem}`)
    extraDefs.push({ ...def, custom: true })
    settings.__only_source = def.id
  } else if (input.source) {
    settings.__only_source = String(input.source)
  }
  if (input.no_fuzzy || settings.__only_source) settings.fuzzy_enabled = false
  settings.no_cache = true
  const file = { name: /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.mp4`, path: `/probe/${name}` }
  const logs = []
  const env = await scrapeEnv(ctx, settings, extraDefs)
  const parent = String(input.parent || '')
  const parsed = parseWithSettings(file, parent, settings)
  const result = await identify(env, file, parent, settings, null, { log: message => logs.push(message) })
  return {
    recognition: { cleaned: parsed.cleaned, number: parsed.number, kind: parsed.kind, loose: parsed.loose, query: parsed.query },
    thresholds: { threshold: settings.fuzzy_threshold, margin: settings.fuzzy_margin, min_chars: settings.fuzzy_min_chars },
    ok: result.ok, method: result.method, score: result.score, meta: result.meta ? applyMappings(result.meta, settings) : null,
    reason: result.reason, candidates: result.candidates, scores: result.scores,
    logs,
  }
}
