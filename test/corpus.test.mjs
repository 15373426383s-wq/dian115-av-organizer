// 乱文件名语料库：按真实场景里常见的写法整理。每条 [文件名, 期望番号, 期望标记?, 期望分段?]。
// 期望番号为 null 表示不应认出精确番号（交给宽松候选或模糊匹配）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMedia } from '../ui/lib/number.js'

export const CORPUS = [
  // —— 站点前缀 / 水印 ——
  ['hhd800.com@SSIS-001.mp4', 'SSIS-001'],
  ['bbs2048.org@ipx-177.mp4', 'IPX-177'],
  ['fun2048.com@MIDV-018-C.mp4', 'MIDV-018', { chinese: true }],
  ['zzpp08.com@SSNI-888.mp4', 'SSNI-888'],
  ['第一会所新片@SIS001@ssis-002.mp4', 'SSIS-002'],
  ['@草榴社区@IPX-500.mp4', 'IPX-500'],
  ['[98t.tv]PRED-123.mp4', 'PRED-123'],
  ['[44x.me]ABP-456.mp4', 'ABP-456'],
  ['kpxvs.com-JUL-100.mp4', 'JUL-100'],
  ['www.av9.cc-STARS-321.mp4', 'STARS-321'],
  ['【高清】【中文字幕】SSIS-123.mp4', 'SSIS-123', { chinese: true }],
  ['(原版首发)CAWD-456.mp4', 'CAWD-456'],
  ['[HD]MIDE-789.mkv', 'MIDE-789'],
  ['【更多资源 xxx.com】JUFE-100.mp4', 'JUFE-100'],
  ['rh2048.com@230ORECO-123.mp4', '230ORECO-123'],

  // —— 番号写法 ——
  ['ssis001.mp4', 'SSIS-001'],
  ['SSIS_001.mp4', 'SSIS-001'],
  ['SSIS 001.mp4', 'SSIS-001'],
  ['ssis.001.mp4', 'SSIS-001'],
  ['ＳＳＩＳ－００１.mp4', 'SSIS-001'],
  ['SSIS—001.mp4', 'SSIS-001'],
  ['SSIS-00001.mp4', 'SSIS-001'],
  ['ssis00001.mp4', 'SSIS-001'],
  ['118abp00123.mp4', 'ABP-123'],
  ['1sdde00500.mp4', 'SDDE-500'],
  ['h_1133honb00123.mp4', 'HONB-123'],
  ['h_237nacr00456.mp4', 'NACR-456'],
  ['SSIS001三上悠亚.mp4', 'SSIS-001'],
  ['三上悠亚 SSIS-001 新人.mp4', 'SSIS-001'],
  ['[三上悠亚]SSIS-001.mp4', 'SSIS-001'],
  ['T28-576.mp4', 'T28-576'],
  ['S2M-012.mp4', 'S2M-012'],
  ['R18-123.mp4', 'R18-123'],
  ['3DSVR-0123.mp4', '3DSVR-0123'],
  ['MKBD-S123.mp4', 'MKBD-S123'],
  ['IPX-1234.mp4', 'IPX-1234'],

  // —— 素人 / MGS ——
  ['SIRO-1234.mp4', 'SIRO-1234'],
  ['200GANA-1234.mp4', '200GANA-1234'],
  ['259LUXU-1500.mp4', '259LUXU-1500'],
  ['390JAC-123.mp4', '390JAC-123'],
  ['ARA-456.mp4', 'ARA-456'],
  ['300MIUM-800-C.mp4', '300MIUM-800', { chinese: true }],

  // —— 无码厂牌 ——
  ['Carib-120614-753.mp4', '120614-753'],
  ['caribbeancom-120614-753.mp4', '120614-753'],
  ['Caribbeancom 120614-753 1080p.mp4', '120614-753'],
  ['1pon 120614_001.mp4', '120614_001'],
  ['1Pondo-120614_001.mp4', '120614_001'],
  ['10mu 120614_01.mp4', '120614_01'],
  ['paco-120614_123.mp4', '120614_123'],
  ['heyzo_hd_1234_full.mp4', 'HEYZO-1234'],
  ['HEYZO-1234-FULL.mp4', 'HEYZO-1234'],
  ['n0123 Tokyo Hot.mp4', 'N0123'],
  ['Tokyo-Hot k1234.mp4', 'K1234'],
  ['heydouga 4017-123.mp4', 'HEYDOUGA-4017-123'],

  // —— FC2 ——
  ['FC2PPV-1234567.mp4', 'FC2-PPV-1234567'],
  ['FC2-1234567.mp4', 'FC2-PPV-1234567'],
  ['fc2-ppv-1234567_1.mp4', 'FC2-PPV-1234567', {}, 1],
  ['FC2_PPV_1234567.mp4', 'FC2-PPV-1234567'],
  ['FC2 PPV 1234567.mp4', 'FC2-PPV-1234567'],
  ['fc2ppv 1234567.mp4', 'FC2-PPV-1234567'],
  ['FC2-PPV-1234567 素人妻.mp4', 'FC2-PPV-1234567'],

  // —— 后缀标记 ——
  ['SSIS-001-C.mp4', 'SSIS-001', { chinese: true }],
  ['SSIS-001ch.mp4', 'SSIS-001', { chinese: true }],
  ['SSIS-001-UC.mp4', 'SSIS-001', { uncensored: true, chinese: true }],
  ['SSIS-001-U.mp4', 'SSIS-001', { uncensored: true }],
  ['SSIS-001_uncensored.mp4', 'SSIS-001', { uncensored: true }],
  ['SSIS-001-uncensored-leaked.mp4', 'SSIS-001', { uncensored: true }],
  ['SSIS-001[无码破解].mp4', 'SSIS-001', { uncensored: true }],
  ['SSIS-001-HD.mp4', 'SSIS-001'],
  ['SSIS-001-FHD.mp4', 'SSIS-001'],
  ['SSIS-001-1080P.mp4', 'SSIS-001'],
  ['SSIS-001_60fps.mp4', 'SSIS-001'],
  ['SSIS-001-4K.mp4', 'SSIS-001', { k4: true }],
  ['SSIS-001.2160p.mp4', 'SSIS-001', { k4: true }],
  ['SSIS-001 2.5GB.mp4', 'SSIS-001'],
  ['2021-05-01 SSIS-001.mp4', 'SSIS-001'],
  ['SSIS-001 H265 10bit.mkv', 'SSIS-001'],

  // —— 分段 ——
  ['SSIS-001-CD1.mp4', 'SSIS-001', {}, 1],
  ['SSIS-001cd2.mp4', 'SSIS-001', {}, 2],
  ['SSIS-001-pt1.mp4', 'SSIS-001', {}, 1],
  ['SSIS-001.part2.mp4', 'SSIS-001', {}, 2],
  ['SSIS-001-A.mp4', 'SSIS-001', {}, 1],
  ['SSIS-001-B.mp4', 'SSIS-001', {}, 2],
  ['SSIS-001_1.mp4', 'SSIS-001', {}, 1],
  ['SSIS-001-2.mp4', 'SSIS-001', {}, 2],
  ['SSIS-001 (1).mp4', 'SSIS-001', {}, 1],
  ['SSIS-001-C-cd1.mp4', 'SSIS-001', { chinese: true }, 1],

  // —— 不应认出精确番号 ——
  ['video.1080p.x264.mp4', null],
  ['abc.H265.AAC.mp4', null],
  ['Show.S01E02.1080p.mkv', null],
  ['三上悠亚 新人出道.mp4', null],
  ['DTS-HD MA 5.1.mkv', null],
  ['MP4-1080.mp4', null],
  ['IMG_1234.mp4', null],
  ['DSC-0123.mp4', null],
  ['VID_20230501_123456.mp4', null],
  ['K1234.mp4', null],               // 没有 Tokyo Hot 字样时不认 n/k 编号
  ['X264-1080.mkv', null],
  ['AC3-512.mkv', null],
  ['DDP5.1-ATMOS.mkv', null],
  ['Movie.2019.1080p.mkv', null],
  ['Screen Recording 2023-05-01.mov', null],
  ['RPReplay_Final1234.mp4', null],
]

for (const [name, number, flags = {}, part] of CORPUS) {
  test(`语料：${name}`, () => {
    const parsed = parseMedia(name)
    assert.equal(parsed.number, number, `${name} → ${JSON.stringify({ number: parsed.number, candidates: parsed.candidates, cleaned: parsed.cleaned })}`)
    for (const [key, value] of Object.entries(flags)) assert.equal(parsed.flags[key], value, `${name} 标记 ${key}：${JSON.stringify(parsed.flags)}`)
    if (part !== undefined) assert.equal(parsed.part, part, `${name} 分段`)
  })
}
