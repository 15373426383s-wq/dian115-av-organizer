import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMedia, sameNumber, normalizeNumber } from '../ui/lib/number.js'
import { extractNumbers } from '../ui/lib/subscriptions.js'
import { messyNameCases, caseDifferences } from './messy-name-cases.mjs'

const cases = messyNameCases()
for (const category of new Set(cases.map(row => row.category))) {
  const group = cases.filter(row => row.category === category)
  test(`合成文件名：${category}（${group.length} 条）`, () => {
    const failed = group.map(row => ({ row, diff: caseDifferences(row, parseMedia(row.name, row.parent)) })).filter(item => item.diff.length)
    assert.equal(failed.length, 0, failed.slice(0, 15).map(item => `${item.row.name}: ${item.diff.join('；')}`).join('\n'))
  })
}

test('相邻番号、数字增加与字母替换不能混成同一作品', () => {
  for (const value of ['SSIS-010', 'SSIS-100', 'SSIS-0010', 'SSNI-001', 'SSIS-00100']) assert.equal(sameNumber(value, 'SSIS-001'), false, value)
  assert.equal(sameNumber('FC2-PPV-12929360', 'FC2-PPV-1292936'), false)
})

test('点号番号规范化与清理后的标题线索', () => {
  assert.equal(normalizeNumber('ipx.177'), 'IPX-177')
  assert.equal(parseMedia('[SSIS - 001][UC][4K].mkv').query, '')
  assert.equal(parseMedia('SSIS-001-8K.mp4').part, 0)
  assert.equal(parseMedia('SSIS-001-CHS-CD2.mp4').query, '')
})

test('消息识别保留全部不同番号，不把编码信息变成订阅', () => {
  assert.deepEqual(extractNumbers('av SSIS-001@IPX-177'), ['SSIS-001', 'IPX-177'])
  assert.deepEqual(extractNumbers('av hhd800.com@SSIS-001-C 1080p x264 AAC'), ['SSIS-001'])
  assert.deepEqual(extractNumbers('av Movie.2024.1080p.mkv'), [])
  assert.deepEqual(extractNumbers('av HEYZO-2000 Tokyo-Hot n1234'), ['HEYZO-2000', 'N1234'])
})
