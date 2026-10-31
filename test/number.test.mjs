import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMedia, parseName, sameNumber, numberSuffix } from '../ui/lib/number.js'

const cases = [
  ['hhd800.com@SSIS-001.mp4', 'SSIS-001'],
  ['SSIS001-C.mkv', 'SSIS-001', { chinese: true }],
  ['[Thz.la]ipx-177.mp4', 'IPX-177'],
  ['ipx177ch.mp4', 'IPX-177', { chinese: true }],
  ['www.98T.la@MIDV-018-CD1.mp4', 'MIDV-018', {}, 1],
  ['FC2-PPV-1234567.mp4', 'FC2-PPV-1234567'],
  ['fc2ppv_3012345-1.mp4', 'FC2-PPV-3012345', {}, 1],
  ['FC2 1234567.mp4', 'FC2-PPV-1234567'],
  ['HEYZO-1234.mp4', 'HEYZO-1234'],
  ['heydouga-4017-123.mp4', 'HEYDOUGA-4017-123'],
  ['Carib-010120-001.mp4', '010120-001'],
  ['1pondo_010120_001.mp4', '010120_001'],
  ['300MIUM-123.mp4', '300MIUM-123'],
  ['259LUXU-1234-C.mp4', '259LUXU-1234', { chinese: true }],
  ['ABP-123-UC.mkv', 'ABP-123', { uncensored: true, chinese: true }],
  ['SSNI-00123.mp4', 'SSNI-123'],
  ['PRED-200 4K.mp4', 'PRED-200', { k4: true }],
  ['Tokyo-Hot n1234.mp4', 'N1234'],
  ['【中文字幕】JUL-321 标题.mp4', 'JUL-321', { chinese: true }],
  ['SSIS-001 [1080p] [x265].mkv', 'SSIS-001'],
  ['MIDE-500.2160p.WEB-DL.H265.AAC.mp4', 'MIDE-500', { k4: true }],
]

for (const [name, number, flags = {}, part = 0] of cases) {
  test(`识别 ${name}`, () => {
    const parsed = parseMedia(name)
    assert.equal(parsed.number, number, JSON.stringify(parsed))
    for (const [key, value] of Object.entries(flags)) assert.equal(parsed.flags[key], value, `${key} ${JSON.stringify(parsed.flags)}`)
    assert.equal(parsed.part, part)
  })
}

for (const name of ['video.1080p.x264.mp4', 'abc.H265.AAC.mp4', '2023-05-01 something.mp4', 'Show.S01E02.mkv', 'MP4-1080.mp4', 'DTS-HD.mkv']) {
  test(`不误认 ${name}`, () => {
    const parsed = parseMedia(name)
    assert.equal(parsed.number, null, JSON.stringify(parsed))
    assert.ok(parsed.reason)
  })
}

test('多个番号时不猜，交给人工确认', () => {
  const parsed = parseMedia('ABC-123 DEF-456.mp4')
  assert.equal(parsed.number, null)
  assert.deepEqual(parsed.candidates, ['ABC-123', 'DEF-456'])
  assert.match(parsed.reason, /多个番号/)
})

test('文件名认不出时用上一级目录名', () => {
  const parsed = parseMedia('video.mp4', 'SSIS-001 某标题')
  assert.equal(parsed.number, 'SSIS-001')
  assert.equal(parsed.from, 'directory')
})

test('番号严格比对', () => {
  assert.ok(sameNumber('ssis001', 'SSIS-001'))
  assert.ok(sameNumber('SSIS-00001', 'SSIS-001'))
  assert.ok(!sameNumber('SSIS-001', 'SSIS-010'))
  assert.ok(!sameNumber('SSIS-001', 'SSNI-001'))
  assert.ok(sameNumber('FC2-1234567', 'FC2-PPV-1234567'))
})

test('文件名标记', () => {
  assert.equal(numberSuffix({ chinese: true }, 0), '-C')
  assert.equal(numberSuffix({ chinese: true, uncensored: true }, 2), '-UC-cd2')
  assert.equal(numberSuffix({ k4: true }, 0, { k4: true }), '-4K')
  assert.equal(numberSuffix({ chinese: true }, 0, { chinese: false }), '')
  assert.equal(parseName('MIDV-018-CD1').part, 1)
})
