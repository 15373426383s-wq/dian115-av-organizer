// 作品编号已用公开资料页核对；HEYZO-2000 于 1.2.3 通过三个来源联网核对。
// 周围的描述、广告、文件名均为合成测试数据。
// 不读取用户目录，不创建媒体文件。来源核对结果见 docs/filename-validation.md。
export const SAMPLES = [
  { number: 'SSIS-001', label: 'SSIS-001', group: 'standard' },
  { number: 'IPX-177', label: 'IPX-177', group: 'standard' },
  { number: 'ABP-001', label: 'ABP-001', group: 'standard' },
  { number: 'MIDE-500', label: 'MIDE-500', group: 'standard' },
  { number: '259LUXU-1000', label: '259LUXU-1000', group: 'prefixed' },
  { number: 'HEYZO-2000', label: 'HEYZO-2000', group: 'heyzo' },
  { number: '123120_001', label: '1pondo 123120_001', group: 'date' },
  { number: '010120-001', label: 'Carib 010120-001', group: 'date' },
  { number: 'FC2-PPV-1292936', label: 'FC2-PPV-1292936', group: 'fc2' },
  { number: 'N1234', label: 'Tokyo-Hot n1234', group: 'tokyohot' },
]

const fullWidth = text => text.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, '　')
const expected = (number, flags = {}, part = 0) => ({ number, flags: { chinese: false, uncensored: false, k4: false, ...flags }, part })
export function messyNameCases() {
  const rows = []
  const add = (category, name, number, flags, part, parent = '') => rows.push({ category, name, parent, expected: expected(number, flags, part) })
  const prefixes = ['', 'hhd800.com@', '第一会所@SIS001@', '[98t.tv] ', '【收藏备份】', '★★新作合集★ ', 'bbs2048.org@', '【官网 example.com】 ']
  const variants = [
    ['', {}, 0], ['-C', { chinese: true }, 0], ['-UC', { chinese: true, uncensored: true }, 0],
    ['-U', { uncensored: true }, 0], [' 中文字幕', { chinese: true }, 0],
    ['-4K', { k4: true }, 0], ['.2160p.H265.10bit', { k4: true }, 0],
    ['-CD1', {}, 1], ['.part2', {}, 2], ['-C-cd2', { chinese: true }, 2],
    ['-UC-4K-CD2', { chinese: true, uncensored: true, k4: true }, 2],
    ['_60fps_1080p_x264_AAC', {}, 0],
  ]
  for (const sample of SAMPLES) {
    for (const [pi, prefix] of prefixes.entries()) for (const [vi, [suffix, flags, part]] of variants.entries()) {
      for (const ext of ['mp4', 'MKV', 'strm']) {
        const label = (pi + vi) % 2 ? sample.label.toLowerCase() : sample.label
        add('组合噪音', `${prefix}${label}${suffix}.${ext}`, sample.number, flags, part)
      }
    }
    add('全角字符', `${fullWidth(sample.label)}【中文字幕】.mp4`, sample.number, { chinese: true })
    add('不可见字符', `${sample.label.replace(/(?=[A-Za-z0-9])/g, '\u200b')}.mp4`, sample.number)
    add('括号标记', `${sample.label}[C][4K]-CD2.mp4`, sample.number, { chinese: true, k4: true }, 2)
    add('组合标记', `${sample.label}-U-C.mp4`, sample.number, { chinese: true, uncensored: true })
    add('字幕缩写', `${sample.label}.chs.mkv`, sample.number, { chinese: true })
    add('分段前标签', `${sample.label}-4K-1.mp4`, sample.number, { k4: true }, 1)
    add('分段前标签', `${sample.label}-UC-8K-2.mp4`, sample.number, { chinese: true, uncensored: true }, 2)
    add('父目录回退', 'video-CD2.mp4', sample.number, {}, 2, sample.label)
  }
  add('FC2分隔符', 'FC2.PPV.1292936.mp4', 'FC2-PPV-1292936')
  add('FC2分隔符', '【FC2 . PPV . 1292936】[UC].mkv', 'FC2-PPV-1292936', { chinese: true, uncensored: true })
  for (const number of ['1048', '2000']) for (const separator of ['.', ' . ', '__', ' - ', ' ']) {
    add('HEYZO分隔符', `【heyzo${separator}${number}】[C][4K]-CD2.mkv`, `HEYZO-${number}`, { chinese: true, k4: true }, 2)
    add('HEYZO目录点号', 'video.mp4', `HEYZO-${number}`, {}, 0, `HEYZO${separator}${number}`)
  }
  for (const sample of SAMPLES.filter(s => s.group === 'standard')) {
    const [prefix, digits] = sample.number.split('-')
    for (const separator of ['_', '.', ' ', ' - ', '__', '—', '−', '－']) {
      add('分隔符', `${prefix}${separator}${digits}-C.mp4`, sample.number, { chinese: true })
    }
    add('DMM内容编号', `h_123${prefix.toLowerCase()}${digits.padStart(5, '0')}.mp4`, sample.number)
    add('目录点号', 'video.mp4', sample.number, {}, 0, `${prefix}.${digits}`)
  }
  for (const name of [
    '视频合集.mp4', '无码精选.1080p.mp4', '【中文字幕】合集.mp4', 'video.x264.1080p.AAC.mp4',
    'Show.S01E02.1080p.mkv', 'Movie.2024.2160p.mkv', 'IMG_1234.MOV', 'VID_20240501_123456.mp4',
    'DSC-0123.mp4', 'Screen Recording 2024-05-01.mov', 'hhd800.com@无番号文件.mp4',
    'fun2048.com@每日更新.mp4', '【bbs2048.org】收藏.mp4',
    'SSIS-001 IPX-177 合集.mp4', 'SSIS-001@IPX-177.mp4',
    'SSIS-001;IPX-177.mp4', 'SSIS-001/复制/IPX-177.mp4',
  ]) {
    // 两个不同番号与纯噪音都不能自动确定作品。
    rows.push({ category: '拒绝误认', name, parent: '', expected: { number: null } })
  }
  return rows
}

export function caseDifferences(row, parsed) {
  const differences = []
  if (parsed.number !== row.expected.number) differences.push(`番号 ${parsed.number} ≠ ${row.expected.number}`)
  for (const [key, value] of Object.entries(row.expected.flags || {})) if (parsed.flags[key] !== value) differences.push(`${key} ${parsed.flags[key]} ≠ ${value}`)
  if (row.expected.part !== undefined && parsed.part !== row.expected.part) differences.push(`分段 ${parsed.part} ≠ ${row.expected.part}`)
  return differences
}
