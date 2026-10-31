// 导出可复查的合成文件名、预期和实际结果；不创建或操作媒体文件。
// node test/filename-audit.mjs /absolute/path/filename-report.json
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseMedia } from '../ui/lib/number.js'
import { SAMPLES, messyNameCases, caseDifferences } from './messy-name-cases.mjs'

const rows = messyNameCases().map(row => {
  const result = parseMedia(row.name, row.parent)
  const differences = caseDifferences(row, result)
  return { ...row, actual: { number: result.number, flags: result.flags, part: result.part, candidates: result.candidates }, passed: !differences.length, differences }
})
const categories = Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
  const items = rows.filter(row => row.category === category)
  return [category, { total: items.length, passed: items.filter(row => row.passed).length }]
}))
const summary = { total: rows.length, passed: rows.filter(row => row.passed).length, failed: rows.filter(row => !row.passed).length, categories }
const output = process.argv[2]
if (output) {
  const path = resolve(output)
  await writeFile(path, JSON.stringify({ scope: '合成文件名识别；不是实际媒体文件整理或站点可用性证明', samples: SAMPLES, summary, cases: rows }, null, 2), { flag: 'wx' })
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const csv = [['分类', '合成文件名', '父目录', '期望番号', '实际番号', '期望分段', '实际分段', '通过', '差异'], ...rows.map(row => [row.category, row.name, row.parent, row.expected.number, row.actual.number, row.expected.part, row.actual.part, row.passed, row.differences.join('；')])]
  await writeFile(path.replace(/\.json$/i, '') + '.csv', '\ufeff' + csv.map(row => row.map(quote).join(',')).join('\r\n'), { flag: 'wx' })
}
console.log(JSON.stringify(summary, null, 2))
if (summary.failed) process.exitCode = 1
