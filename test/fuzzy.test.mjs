import test from 'node:test'
import assert from 'node:assert/strict'
import { matchScore, candidateScore, decide, usableQuery } from '../ui/lib/fuzzy.js'
import { compileCleanRules, applyCleanRules, parseMedia } from '../ui/lib/number.js'

test('匹配度：完全一致 100，前半段约 83，无关标题很低', () => {
  assert.equal(matchScore('测试 标题！', '测试标题'), 100)
  const half = matchScore('新人出道', '新人出道透明美少女')
  assert.ok(half >= 75 && half <= 90, String(half))
  assert.ok(matchScore('温泉旅行', '办公室恋情') < 40)
  assert.equal(matchScore('', 'x'), 0)
})

test('匹配度：全角半角与大小写不影响', () => {
  assert.equal(matchScore('ＡＢＣ　Ｄｅｆ', 'abc def'), 100)
})

test('文件名里写了演员名时，演员 + 标题一起比较', () => {
  const meta = { title: '温泉旅行', actors: ['演员B'] }
  assert.ok(candidateScore('演员B 温泉旅行', meta) > matchScore('演员B 温泉旅行', meta.title))
})

test('采用规则：阈值与领先差距', () => {
  assert.equal(decide([{ score: 90 }, { score: 70 }], 85, 5).accepted, true)
  assert.match(decide([{ score: 80 }], 85, 5).reason, /低于阈值/)
  assert.match(decide([{ score: 90 }, { score: 88 }], 85, 5).reason, /相差不足/)
  assert.equal(usableQuery('ab', 3), false)
})

test('自定义清理规则：文本、正则、替换与错误提示', () => {
  const { rules, errors } = compileCleanRules('# 注释\n@私人收藏\n/\\bhhb\\d*\\b/i\nXYZ => SSIS-\n/(坏/')
  assert.equal(rules.length, 3)
  assert.equal(errors.length, 1)
  assert.equal(applyCleanRules('a@私人收藏 hhb2 XYZ001', rules), 'a SSIS-001')
  assert.equal(parseMedia('XYZ001.mp4', '', { cleanRules: rules }).number, 'SSIS-001')
})

test('宽松候选：空格加两位数不算精确番号', () => {
  const parsed = parseMedia('私人收藏@abc 12 某标题.mp4')
  assert.equal(parsed.number, null)
  assert.deepEqual(parsed.loose, [{ number: 'ABC-012', short: true }])
  assert.equal(parsed.query, '某标题') // "站点@" 前缀被去掉
})
