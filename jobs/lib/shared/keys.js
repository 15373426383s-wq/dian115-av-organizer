// 页面与后台共用的文件控制键。页面写入（指定番号、忽略），后台只读取和清理，
// 避免两边同时改写同一个状态键。不依赖 crypto.subtle（局域网 http 页面没有安全上下文）。

export function fileKey(path) {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (const ch of String(path || '')) {
    const code = ch.codePointAt(0)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + 0x9e37), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export const manualKey = path => 'manual:' + fileKey(path)
export const ignoreKey = path => 'ignore:' + fileKey(path)
