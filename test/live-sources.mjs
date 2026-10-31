// 真实站点检测（开发用，需要联网，不在 npm test 中运行）：
//   JSDOM_DIR=<装了 jsdom 的目录> node test/live-sources.mjs [来源id...]
//   LIVE_NUMBERS=SSIS-001,IPX-177 可指定样本；LIVE_REPORT=/absolute/report.json 导出结果。
// 用规则引擎逐个跑预设来源，报告能否取到番号、标题、演员、封面。
// 只发普通请求：不带年龄确认 Cookie，不绕过任何验证；被年龄验证或地区限制挡住的来源如实报告。
import { PRESETS } from '../ui/lib/presets.js'
import { runSource, runSearch } from '../jobs/lib/engine.js'

import { SOURCE_SAMPLES } from './source-samples.mjs'
import { env, trace } from './live-http.mjs'

const only = process.argv.slice(2)
const suppliedSamples = String(process.env.LIVE_NUMBERS || '').split(',').map(value => value.trim()).filter(Boolean)
const reports = []
for (const def of PRESETS.filter(d => !only.length || only.includes(d.id))) {
  const numbers = suppliedSamples.length ? suppliedSamples : SOURCE_SAMPLES[def.id] || ['SSIS-001']
  for (const number of numbers) {
    const started = Date.now()
    try {
      const meta = await runSource(env, def, number, { vars: { token: process.env.TPDB_TOKEN || '' } })
      const ms = Date.now() - started
      reports.push({ number, source: def.id, ok: Boolean(meta), returnedNumber: meta?.number, hasTitle: Boolean(meta?.title), actorCount: meta?.actors?.length || 0, hasCover: Boolean(meta?.cover), date: meta?.release_date, runtime: meta?.runtime, url: meta?.source_url, ms })
      if (!meta) { console.log(`－ ${def.id.padEnd(15)} ${number.padEnd(14)} 未找到 (${ms}ms)\n    ${trace.slice(-3).join('\n    ')}`); continue }
      const missing = ['title', 'cover', 'release_date'].filter(f => !meta[f])
      console.log(`${missing.length ? '△' : '✓'} ${def.id.padEnd(15)} ${number.padEnd(14)} ${meta.number} | 标题 ${meta.title ? '有' : '无'} | 演员 ${meta.actors?.length || 0} | 封面 ${meta.cover ? '有' : '无'} | 日期 ${meta.release_date || '无'}${missing.length ? ' | 缺 ' + missing.join(',') : ''} (${ms}ms)`)
    } catch (error) {
      reports.push({ number, source: def.id, ok: false, error: String(error.message || error), ms: Date.now() - started })
      console.log(`✗ ${def.id.padEnd(15)} ${number.padEnd(14)} ${String(error.message || error).slice(0, 140)}`)
    }
  }
  if (def.search && !def.search.method && process.env.SEARCH) {
    try { const items = await runSearch(env, def, process.env.SEARCH); console.log(`  搜索 ${process.env.SEARCH}: ${items.length} 条 ${items.slice(0, 2).map(i => i.number).join(',')}`) } catch (e) { console.log(`  搜索失败 ${e.message}`) }
  }
}
if (process.env.LIVE_REPORT) {
  await (await import('node:fs/promises')).writeFile(process.env.LIVE_REPORT, JSON.stringify({ samples: reports }, null, 2), { flag: 'wx' })
}
