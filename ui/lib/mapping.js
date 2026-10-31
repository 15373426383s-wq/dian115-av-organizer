// 演员名、标签映射。
// 每行一条：原值 => 新值；新值留空表示删除该值。# 开头为注释。

export function parseMapping(text) {
  const map = new Map()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=>')
    if (index < 0) continue
    const from = line.slice(0, index).trim()
    if (from) map.set(from.toLowerCase(), line.slice(index + 2).trim())
  }
  return map
}

export function mapValues(values, map) {
  const out = []
  for (const value of values || []) {
    const key = String(value).trim().toLowerCase()
    const next = map.has(key) ? map.get(key) : String(value).trim()
    if (next && !out.includes(next)) out.push(next)
  }
  return out
}

export function applyMappings(meta, settings) {
  if (!meta) return meta
  const actors = parseMapping(settings.actor_map)
  const tags = parseMapping(settings.tag_map)
  return {
    ...meta,
    actors: actors.size ? mapValues(meta.actors, actors) : meta.actors,
    genres: tags.size ? mapValues(meta.genres, tags) : meta.genres,
  }
}
