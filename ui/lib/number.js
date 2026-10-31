// 番号识别：只从文件名 / 目录名推断，宁可交给人工确认也不猜。
// 纯函数，页面与后台共用。

export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi', 'wmv', 'mov', 'm4v', 'ts', 'm2ts', 'flv', 'rmvb', 'iso', 'mpg', 'mpeg', 'webm', 'strm']
export const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup']

// 看起来像番号、实际是技术标记或常见词的字母前缀。
const PREFIX_BLACKLIST = new Set([
  'MP', 'AAC', 'AC', 'DTS', 'HDR', 'SDR', 'WEB', 'BD', 'CD', 'DVD', 'FHD', 'UHD', 'HD', 'SD', 'HEVC', 'AVC', 'X', 'H', 'XVID', 'DIVX',
  'PART', 'PT', 'CH', 'S', 'E', 'SE', 'EP', 'VOL', 'DISC', 'DISK', 'FPS', 'BIT', 'KBPS', 'MBPS', 'TOP', 'NO', 'VR', 'AV', 'HHB', 'DDP', 'TRUEHD',
  'ATMOS', 'FLAC', 'OPUS', 'MKV', 'MP4', 'AVI', 'RMVB', 'WMV', 'ISO', 'TS', 'GB', 'MB', 'KB', 'P', 'I', 'K', 'BLURAY', 'REMUX', 'HQ',
  // 相机、手机、录屏默认文件名
  'IMG', 'DSC', 'DSCF', 'DSCN', 'VID', 'MOV', 'MVI', 'PXL', 'GOPR', 'GH', 'DJI', 'CIMG', 'SCREEN', 'RPReplay'.toUpperCase(), 'WP', 'FULL',
])

// 前缀里带数字的番号（T28、S2M、R18、3DSVR）要排除这些技术写法。
const ALNUM_PREFIX_BLACKLIST = new Set(['MP4', 'MP3', 'MP2', 'AC3', 'M4V', 'M2TS', 'H264', 'H265', 'X264', 'X265', 'HDR10', 'DDP5', 'DTS5', 'AAC2', 'AAC5', '3GP', '4K', '8K', '5K', 'H26', 'X26'])

const NOISE_PATTERNS = [
  /^\s*(?:[\w-]+\.)+(?:com|net|org|cc|tv|xyz|me|top|vip|club|info|la|co|io|fun|live|link|site|one|app)\s*[@\-_]+/i, // hhd800.com@ / www.xxx.com-
  /(?:www\.)?(?:[\w-]+\.)+(?:com|net|org|cc|tv|xyz|me|top|vip|club|info|la|co|io|fun|live|link|site|one|app)\b/gi,
  /\b(?:2160|1080|720|480|360)[pi]\b/gi,
  /\b(?:[xh]\.?26[45]|hevc|avc|xvid|divx|10bit|8bit|hdr10?|dolby|atmos|aac\d?(?:\.\d)?|ac3|dts(?:-?hd)?|flac|web-?dl|webrip|bluray|bdrip|remux|hdtv|uhd|fhd)\b/gi,
  /\b\d+(?:\.\d+)?\s?(?:gb|mb|kb)\b/gi,
  /\b(?:19|20)\d{2}[-.](?:0[1-9]|1[0-2])[-.](?:0[1-9]|[12]\d|3[01])\b/g, // 2023-05-01 这类日期，避免被当成番号
]

export function toHalfWidth(value) {
  return String(value || '').replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
}

export function splitExtension(name) {
  const value = String(name || '')
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return { stem: value, ext: '' }
  const ext = value.slice(dot + 1).toLowerCase()
  // SSIS.001 也可能是目录名或直接输入的番号，纯数字不是文件扩展名。
  if (!/^[a-z0-9]{1,5}$/.test(ext) || !/[a-z]/.test(ext)) return { stem: value, ext: '' }
  return { stem: value.slice(0, dot), ext }
}

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.includes(splitExtension(name).ext)
}

export function isSubtitleFile(name) {
  return SUBTITLE_EXTENSIONS.includes(splitExtension(name).ext)
}

export function normalizeDashes(value) {
  return String(value || '').replace(/[\u2010-\u2015\u2212\uFE58\uFE63]/g, '-')
}

export function cleanNoise(stem) {
  let value = normalizeDashes(toHalfWidth(stem))
  for (const pattern of NOISE_PATTERNS) value = value.replace(pattern, ' ')
  // 只剥离开头的广告段。两个作品用 @ 连接时必须保留两者，不能擅选最后一个。
  if (value.includes('@')) {
    const parts = value.split('@')
    while (parts.length > 1) {
      const head = cleanBrackets(parts[0]).trim()
      if (/^SIS[-_ ]?001$/i.test(head) || !looksLikeNumberToken(head)) parts.shift()
      else break
    }
    value = parts.join(' ')
  }
  // 方括号里只要不是番号，就当作站点/发布组/说明去掉。
  value = cleanBrackets(value)
  return value.replace(/\s+/g, ' ').trim()
}

function cleanBrackets(value) {
  return String(value).replace(/[\[【(（]([^\]】)）]*)[\]】)）]/g, (whole, inner) => (looksLikeNumberToken(inner) ? ` ${inner} ` : ' '))
}

function looksLikeNumberToken(value) {
  // 方括号里只要含有番号样式（允许空格、点分隔），就保留内容交给后续识别。
  return findNumbers(String(value)).length > 0 || findLooseNumbers(String(value)).length > 0
}

function normalizeDigits(digits) {
  const trimmed = String(Number.parseInt(digits, 10))
  return trimmed.length >= 3 ? trimmed : trimmed.padStart(3, '0')
}

// 按从严到宽的顺序匹配。每条规则返回 {number, kind, index, end}。
const RULES = [
  {
    kind: 'fc2',
    pattern: /FC2[-_ .]*(?:PPV[-_ .]*)?(\d{5,8})(?!\d)/gi,
    build: m => `FC2-PPV-${m[1]}`,
  },
  {
    kind: 'heyzo',
    pattern: /HEYZO[-_ .]*(?:HD[-_ .]*)?(\d{4})(?!\d)/gi,
    build: m => `HEYZO-${m[1]}`,
  },
  {
    kind: 'heydouga',
    pattern: /HEYDOUGA[-_ ]*(\d{4})[-_ ]*(\d{3,6})(?!\d)/gi,
    build: m => `HEYDOUGA-${m[1]}-${m[2]}`,
  },
  {
    // Tokyo-Hot：n1234 / k1234，名称里必须出现 Tokyo Hot 字样（前后都可以）。
    kind: 'tokyohot',
    pattern: /(?<![A-Z\d])([NK])[-_]?(\d{4})(?!\d)/gi,
    build: m => `${m[1].toUpperCase()}${m[2]}`,
    accept: (m, value) => /TOKYO[-_ ]?HOT/i.test(value),
  },
  {
    // 加勒比 MMDDYY-NNN、一本道 MMDDYY_NNN、10musume / pacopacomama 等日期编号。
    kind: 'uncensored-date',
    pattern: /(?<![\dA-Z])((?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{2})([-_])(\d{2,3})(?![\dA-Z])/gi,
    build: m => `${m[1]}${m[2]}${m[3]}`,
  },
  {
    // DMM 内容编号：118abp00123、1sdde00500、h_1133honb00123 → ABP-123。
    // 特征是字母后紧跟补零到 5 位的数字（00123），前面的数字和 h_ 是厂商代码。
    kind: 'dmm',
    pattern: /(?<![A-Z\d])(?:H_)?\d{0,4}([A-Z]{2,6})(00\d{3})(?!\d)/gi,
    build: m => `${m[1].toUpperCase()}-${normalizeDigits(m[2])}`,
    accept: m => !PREFIX_BLACKLIST.has(m[1].toUpperCase()),
  },
  {
    // 前缀里带数字：T28-576、S2M-012、R18-123、3DSVR-0123。必须用 "-" 分隔。
    kind: 'alnum',
    pattern: /(?<![A-Z\d])((?:[A-Z]{1,3}\d{1,2}[A-Z]{0,3})|(?:\d{1,2}[A-Z]{2,5}))-(\d{3,4})(?!\d)/gi,
    build: m => `${m[1].toUpperCase()}-${m[2]}`,
    accept: m => !ALNUM_PREFIX_BLACKLIST.has(m[1].toUpperCase()) && !/^\d{3}/.test(m[1]),
  },
  {
    // 编号里带字母：MKBD-S123、MKD-S45。
    kind: 'lettered',
    pattern: /(?<![A-Z\d])([A-Z]{2,6})-(S)(\d{2,3})(?!\d)/gi,
    build: m => `${m[1].toUpperCase()}-S${m[3]}`,
    accept: m => !PREFIX_BLACKLIST.has(m[1].toUpperCase()),
  },
  {
    // 素人系列带数字前缀：300MIUM-123、259LUXU-1234、SIRO-1234 走下一条。
    kind: 'prefixed',
    pattern: /(?<![\dA-Z])(\d{3})([A-Z]{2,6})[-_ ]?(\d{3,5})(?!\d)/gi,
    build: m => `${m[1]}${m[2].toUpperCase()}-${normalizeDigits(m[3])}`,
    accept: m => !PREFIX_BLACKLIST.has(m[2].toUpperCase()),
  },
  {
    kind: 'standard',
    pattern: /(?<![A-Z\d])([A-Z]{2,6})([\s._-]{0,3})(\d{2,5})(?!\d)/gi,
    build: m => `${m[1].toUpperCase()}-${normalizeDigits(m[3])}`,
    // 没有分隔符的 ABC123 只在数字 ≥3 位时接受，避免 H264 / MP4 一类误判。
    // 两位数编号只在用 "-" 分隔时接受（ABC-12），其余写法交给宽松候选核对。
    // 不用 "-" 分隔时更严格：前缀必须全大写或全小写（Movie.2019、Final1234 是普通单词），
    // 数字也不能像年份。
    accept: m => {
      if (PREFIX_BLACKLIST.has(m[1].toUpperCase()) || /^\d+$/.test(m[1])) return false
      if (m[3].length < 3) return m[2].includes('-')
      if (m[2].includes('-')) return true
      const caseConsistent = m[1] === m[1].toUpperCase() || m[1] === m[1].toLowerCase()
      return caseConsistent && !/^(?:19|20)\d{2}$/.test(m[3])
    },
  },
]

function findNumbers(value) {
  const found = []
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(value))) {
      if (rule.accept && !rule.accept(m, value)) continue
      const start = m.index, end = m.index + m[0].length
      // 已被更严格规则占用的区间不再重复识别（例如 FC2-PPV-1234567 里的 PPV-1234567）。
      if (found.some(item => start < item.end && end > item.start)) continue
      found.push({ number: rule.build(m), kind: rule.kind, start, end })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

function detectFlags(stem, match, raw = stem) {
  const tail = match ? stem.slice(match.end) : stem
  // 关键词在原始名称上找：清理噪音时会去掉【中文字幕】、2160p 这类标记。
  const whole = toHalfWidth(raw)
  const flags = { chinese: false, uncensored: false, k4: false }
  if (/(?:^|[-_ .])(?:C|CH|CHS|CHT|UC)(?![A-Z\d])/i.test(tail) || /[\[【(（]\s*(?:C|CH|CHS|CHT|UC)\s*[\]】)）]/i.test(whole) || /中文字幕|中字|字幕版|chinese/i.test(whole)) flags.chinese = true
  if (/(?:^|[-_ .])(?:UC|U)(?![A-Z\d])/i.test(tail) || /[\[【(（]\s*(?:UC|U)\s*[\]】)）]/i.test(whole) || /无码破解|無碼破解|破解版|uncensored|leak(?:ed)?/i.test(whole)) flags.uncensored = true
  if (/(?<![A-Z\d])4K(?![A-Z\d])|2160p/i.test(whole)) flags.k4 = true
  return flags
}

// 分段：CD1 / pt1 / part2 / disc1（可紧贴番号）；番号后紧跟的 -A/-B、_1/-2；末尾的 (1)。
// -C 按惯例表示中文字幕，不当作第 3 段。
function detectPart(stem, cleaned = '', match = null) {
  const value = toHalfWidth(stem)
  const m = value.match(/(?<![A-Z])(?:CD|PT|PART|DISC|DISK)[-_ .]?(\d{1,2})(?![A-Z\d])/i)
  if (m) return Number(m[1])
  if (match) {
    // 清晰度和字幕标签可以在分段之前，但标签中的 4K/8K 不是第 4/8 段。
    const tail = cleaned.slice(match.end).replace(/^(?:[-_ .]+(?:CHS|CHT|CH|UC|C|U|4K|8K))+(?=[-_ .]|$)/i, '')
    const letter = tail.match(/^[-_]([ABD-F])(?![A-Z\d])/i)
    if (letter) return letter[1].toUpperCase().charCodeAt(0) - 64
    const digit = tail.match(/^(?:[-_]C)?[-_]([1-9])(?![A-Z\d.])/i)
    if (digit) return Number(digit[1])
  }
  const paren = value.match(/[(（]([1-9])[)）]\s*$/)
  if (paren) return Number(paren[1])
  return 0
}

// ---------- 自定义清理 ----------
// 每行一条规则，# 开头为注释：
//   文本            去掉该文本（不区分大小写）
//   /正则/标志      去掉匹配内容
//   原文 => 替换    或  /正则/标志 => 替换（替换里可用 $1 等分组）
export function compileCleanRules(text) {
  const rules = [], errors = []
  for (const [index, rawLine] of String(text || '').split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const arrow = line.indexOf('=>')
    const left = (arrow >= 0 ? line.slice(0, arrow) : line).trim()
    const replace = arrow >= 0 ? line.slice(arrow + 2).trim() : ' '
    try {
      const regex = left.match(/^\/(.+)\/([a-z]*)$/)
      const pattern = regex
        ? new RegExp(regex[1], regex[2].includes('g') ? regex[2] : regex[2] + 'g')
        : new RegExp(left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      if (!left) throw new Error('规则为空')
      rules.push({ pattern, replace, line: index + 1 })
    } catch (error) {
      errors.push(`第 ${index + 1} 行「${line}」无效：${error.message}`)
    }
  }
  return { rules, errors }
}

export function applyCleanRules(value, rules) {
  let out = String(value || '')
  for (const rule of rules || []) {
    rule.pattern.lastIndex = 0
    out = out.replace(rule.pattern, rule.replace)
  }
  return out.replace(/\s+/g, ' ').trim()
}

// ---------- 宽松番号候选 ----------
// 严格规则认不出时使用：不要求单词边界（ssis001hhb、【ssis 001】），允许两位数编号。
// 宽松候选必须由刮削来源确认番号存在才会被采用。
const LOOSE_PATTERN = /([A-Z]{2,6})[\s\-_.]{0,2}(\d{2,5})(?!\d)/gi

function findLooseNumbers(value) {
  const out = []
  LOOSE_PATTERN.lastIndex = 0
  let m
  while ((m = LOOSE_PATTERN.exec(value))) {
    const prefix = m[1].toUpperCase()
    if (PREFIX_BLACKLIST.has(prefix)) continue
    if (m[1] !== prefix && m[1] !== m[1].toLowerCase()) continue
    if (/^(?:19|20)\d{2}$/.test(m[2])) continue
    const number = `${prefix}-${normalizeDigits(m[2])}`
    if (!out.some(item => item.number === number)) out.push({ number, short: m[2].length < 3 })
  }
  return out
}

// 去掉番号、标记后剩下的文字，作为模糊匹配的标题线索。
export function residualText(cleaned, numbers = []) {
  let text = String(cleaned || '')
  for (const number of numbers) {
    const [prefix, digits] = String(number).split(/-(?=\d+$)/)
    if (prefix && digits) text = text.replace(new RegExp(prefix.replace(/[-]/g, '[-_ .]?') + '[\\s\\-_.]{0,3}0*' + Number(digits), 'ig'), ' ')
    else text = text.replace(new RegExp(String(number).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')
  }
  text = text.replace(/(?<![A-Z\d])(?:C|CH|CHS|CHT|UC|U|4K|8K|CD\d|PT\d|PART\d)(?![A-Z\d])/gi, ' ')
  text = text.replace(/中文字幕|中字|无码破解|無碼破解|破解版/g, ' ')
  return text.replace(/[\[\]【】()（）{}「」『』_.\-+@#&!！?？,，、。·~～|]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// 解析单个名称（文件名或目录名）。options.cleanRules 为 compileCleanRules 的 rules。
export function parseName(name, options = {}) {
  const { stem } = splitExtension(name)
  const custom = applyCleanRules(toHalfWidth(stem), options.cleanRules)
  const cleaned = cleanNoise(custom)
  const numbers = findNumbers(cleaned)
  const distinct = [...new Set(numbers.map(item => item.number))]
  const primary = numbers[0] || null
  const loose = distinct.length === 0 ? findLooseNumbers(cleaned) : []
  return {
    input: String(name || ''),
    cleaned,
    number: distinct.length === 1 ? primary.number : null,
    kind: distinct.length === 1 ? primary.kind : null,
    candidates: distinct,
    loose,
    query: residualText(cleaned, distinct.length ? distinct : loose.map(item => item.number)),
    flags: detectFlags(cleaned, primary, custom),
    part: detectPart(custom, cleaned, primary),
  }
}

// 先认文件名，认不出再认上一级目录名。返回 {number, ...} 或 {number:null, reason}。
// 没认出时仍带回 loose（宽松候选）与 query（标题线索），交给模糊匹配。
export function parseMedia(fileName, parentName = '', options = {}) {
  const file = parseName(fileName, options)
  if (file.number) return { ...file, from: 'file' }
  if (file.candidates.length > 1) {
    return { ...file, from: 'file', reason: `文件名里认出多个番号：${file.candidates.join('、')}` }
  }
  if (parentName) {
    const parent = parseName(parentName, options)
    if (parent.number) {
      return { ...parent, input: file.input, flags: mergeFlags(file.flags, parent.flags), part: file.part || parent.part, from: 'directory' }
    }
    if (parent.candidates.length > 1) {
      return { ...file, from: 'directory', candidates: parent.candidates, reason: `目录名里认出多个番号：${parent.candidates.join('、')}` }
    }
    if (file.loose.length === 0 && parent.loose.length) {
      return { ...file, loose: parent.loose, query: file.query || parent.query, from: 'none', reason: '文件名和目录名里都没有认出番号' }
    }
    if (!file.query && parent.query) return { ...file, query: parent.query, from: 'none', reason: '文件名和目录名里都没有认出番号' }
  }
  return { ...file, from: 'none', reason: '文件名和目录名里都没有认出番号' }
}

function mergeFlags(a, b) {
  return { chinese: a.chinese || b.chinese, uncensored: a.uncensored || b.uncensored, k4: a.k4 || b.k4 }
}

// 用户手填或站点返回的番号统一成同一写法，用于严格比对。
export function normalizeNumber(value) {
  const parsed = parseName(String(value || '').trim())
  if (parsed.number) return parsed.number
  return String(value || '').trim().toUpperCase().replace(/[_\s]+/g, '-')
}

export function sameNumber(a, b) {
  const left = normalizeNumber(a), right = normalizeNumber(b)
  return Boolean(left) && left === right
}

export function numberSuffix(flags, part, options = {}) {
  let suffix = ''
  if (flags?.uncensored && options.uncensored !== false) suffix += '-UC'
  else if (flags?.chinese && options.chinese !== false) suffix += '-C'
  if (flags?.k4 && options.k4) suffix += '-4K'
  if (part > 0) suffix += `-cd${part}`
  return suffix
}
