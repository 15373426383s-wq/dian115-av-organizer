// Hash the exact bencoded info bytes (re-encoding would change the torrent ID).
// Only a bounded .torrent response is read, never the downloaded video.
export function torrentInfoBytes(bytes) {
  let offset = 0, steps = 0, info = null
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end))
  function string() {
    const start = offset
    while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset++
    if (offset === start || bytes[offset] !== 58 || offset - start > 8) throw new Error('种子字符串长度无效')
    const length = Number(text(start, offset++))
    const end = offset + length
    if (end > bytes.length) throw new Error('种子内容不完整')
    const value = { start: offset, end }
    offset = end
    return value
  }
  function value(depth = 0) {
    if (depth > 64 || ++steps > 200000 || offset >= bytes.length) throw new Error('种子结构无效')
    const type = bytes[offset]
    if (type >= 48 && type <= 57) { string(); return }
    offset++
    if (type === 105) {
      const start = offset
      while (offset < bytes.length && bytes[offset] !== 101) offset++
      if (offset - start > 30 || !/^-?\d+$/.test(text(start, offset)) || offset >= bytes.length) throw new Error('种子整数无效')
      offset++; return
    }
    if (type !== 100 && type !== 108) throw new Error('响应不是种子文件')
    while (bytes[offset] !== 101) {
      let key = ''
      if (type === 100) { const part = string(); if (part.end - part.start <= 20) key = text(part.start, part.end) }
      const start = offset
      value(depth + 1)
      if (depth === 0 && key === 'info') {
        if (info || bytes[start] !== 100) throw new Error('种子 info 字段无效')
        info = bytes.slice(start, offset)
      }
    }
    offset++
  }
  if (bytes[0] !== 100) throw new Error('响应不是种子文件')
  value()
  if (!info || offset !== bytes.length) throw new Error('种子 info 缺失或内容无效')
  return info
}
