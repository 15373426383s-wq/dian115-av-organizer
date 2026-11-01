// 目录模板、文件名清理与路径拼接。纯函数，页面与后台共用。

import { renderText } from './templates.js'
const encoder = new TextEncoder()

export const DEFAULT_DIR_TEMPLATE = '{actor}/{number} - {title}'
export const DEFAULT_FILE_TEMPLATE = '{number}{suffix}'

// Linux 文件名只禁止 "/" 和 NUL；按项目约定把 "/" 投影成全角 "／"，
// 同时把会让 SMB/Windows 客户端出错的字符换成全角，去掉首尾空格和点。
export function sanitizeComponent(value, maxBytes = 200) {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\//g, '／').replace(/\\/g, '＼')
    .replace(/:/g, '：').replace(/\*/g, '＊').replace(/\?/g, '？')
    .replace(/"/g, '＂').replace(/</g, '＜').replace(/>/g, '＞').replace(/\|/g, '｜')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return truncateBytes(text, maxBytes)
}

export function truncateBytes(text, maxBytes) {
  if (encoder.encode(text).length <= maxBytes) return text
  let out = ''
  for (const ch of text) {
    if (encoder.encode(out + ch).length > maxBytes) break
    out += ch
  }
  return out.trim()
}

export function templateVariables(meta, parsed, options = {}) {
  const actors = (meta?.actors || []).filter(Boolean)
  const maxActors = Number(options.maxActors || 3)
  const date = String(meta?.release_date || '')
  const number = meta?.number || parsed?.number || ''
  const maxTitle = Number(options.titleMaxChars || 0)
  let title = String(meta?.title || '')
  if (maxTitle > 0 && [...title].length > maxTitle) title = [...title].slice(0, maxTitle).join('').trim()
  return {
    number,
    prefix: (number.match(/^[A-Z0-9]+?(?=-)/i) || [number])[0],
    title,
    original_title: meta?.original_title || meta?.title || '',
    actor: actors.length === 0 ? (options.unknownActor || '未知演员') : actors.length > maxActors ? (options.manyActors || '多人') : actors[0],
    actors: actors.length === 0 ? (options.unknownActor || '未知演员') : actors.slice(0, maxActors).join(options.actorSeparator || ','),
    studio: meta?.studio || options.unknown || '未知',
    label: meta?.label || meta?.studio || options.unknown || '未知',
    series: meta?.series || options.unknown || '未知',
    director: meta?.director || options.unknown || '未知',
    year: date.slice(0, 4) || options.unknown || '未知',
    date: date || options.unknown || '未知',
    suffix: parsed?.suffix || '',
    first_actor: actors[0] || '', actor_list: actors, originaltitle: meta?.original_title || meta?.title || '',
    release: date, publisher: meta?.label || '', runtime: meta?.runtime || '',
    publish_number: meta?.publish_number || number, serial_number: number.match(/\d+$/)?.[0] || '',
    series_name: meta?.series || '', first_letter: number[0] || '', category: meta?.category || options.categoryLabels?.[parsed?.category] || parsed?.category || parsed?.kind || '',
    filename: options.filename || '', source_filename: options.filename || '', source_path: options.sourcePath || '',
    subtitle: parsed?.flags?.chinese ? '中文字幕' : '', mosaic: parsed?.flags?.uncensored ? '无码' : '有码',
    resolution: meta?.resolution || parsed?.resolution || (parsed?.flags?.k4 ? '4K' : ''), part: parsed?.part || '', part_letter: parsed?.part ? String.fromCharCode(64+Math.min(26,parsed.part)) : '',
    leaked: Boolean(parsed?.flags?.leaked), cracked: Boolean(parsed?.flags?.cracked), chinese: Boolean(parsed?.flags?.chinese),
    movie_type: parsed?.category || parsed?.kind || '',
  }
}

// 渲染模板；每个变量值单独清理，模板里的 "/" 才是目录分隔。
export function renderTemplate(template, vars, options = {}) {
  const parts = renderText(template, vars, value => sanitizeComponent(value, options.valueBytes || 160))
    .split('/').map(segment => sanitizeComponent(segment, options.segmentBytes || 200)).filter(Boolean)
  return parts
}

export function joinPath(...parts) {
  const cleaned = parts.filter(part => part !== undefined && part !== null && String(part) !== '').map(String)
  if (cleaned.length === 0) return ''
  let head = cleaned[0]
  const isCd2 = head.startsWith('cd2:')
  if (isCd2) head = head.slice(4) || '/'
  const joined = [head.replace(/\/+$/, ''), ...cleaned.slice(1).map(p => p.replace(/^\/+|\/+$/g, ''))].filter(Boolean).join('/')
  const normalized = joined.startsWith('/') ? joined : '/' + joined
  return isCd2 ? 'cd2:' + normalized : normalized
}

export function dirname(path) {
  const value = String(path || '')
  const prefix = value.startsWith('cd2:') ? 'cd2:' : ''
  const body = prefix ? value.slice(4) : value
  const index = body.replace(/\/+$/, '').lastIndexOf('/')
  return prefix + (index <= 0 ? '/' : body.slice(0, index))
}

export function basename(path) {
  const value = String(path || '').replace(/\/+$/, '')
  return value.slice(value.lastIndexOf('/') + 1)
}

export function isCd2Path(path) {
  return String(path || '').startsWith('cd2:')
}

export function cd2Internal(path) {
  return isCd2Path(path) ? (path.slice(4) || '/') : path
}

// target 是否位于 root 之内（同为 cd2 或同为本地）。
export function isWithin(root, target) {
  const a = String(root || '').replace(/\/+$/, ''), b = String(target || '')
  if (!a) return false
  return b === a || b.startsWith(a + '/')
}
