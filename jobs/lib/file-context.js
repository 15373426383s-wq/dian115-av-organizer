import { parseName, splitExtension, sameNumber } from './shared/number.js'

// Interpret file relationships separately from the identifier parser.
export function enrichFileContext(parsed, file, siblings = [], settings = {}) {
  const result = { ...parsed, flags: { ...parsed.flags } }, name = splitExtension(file.name).stem
  const path = file.path || file.name
  const extra = /^FC2-/i.test(result.number || '') && name.match(/(?:^|[\s_.-])(?:SP|特典|おまけ|bonus|extra)(?:[\s_.-]*(\d+))?(?=$|[\s_.-])/i)
  if (settings.fc2_extras !== false && extra) { result.extra = { type: 'bonus', index: Number(extra[1] || 1) }; result.part = 0 }
  // A/B/C beside one another are parts; a lone -C keeps the subtitle meaning.
  if (/(?:^|[-_. ])C$/i.test(name) && !/中字|中文|chs|cht|zh[-_]?(?:cn|tw)/i.test(name)) {
    const peers = siblings.filter(s => s.path !== file.path && sameNumber(parseName(s.name).number || '', result.number || ''))
    if (peers.some(s => /(?:^|[-_. ])[AB](?:\.[^.]+)?$/i.test(s.name))) { result.part = 3; result.flags.chinese = false }
  }
  const words = String(settings.custom_cracked_keywords || '').split(/[\n,，]/).map(s => s.trim()).filter(Boolean)
  result.flags.cracked = /无码破解|無碼破解|cracked|破解/i.test(path) || words.some(s => path.toLowerCase().includes(s.toLowerCase()))
  result.flags.leaked = /流出|leaked?/i.test(path)
  if (result.flags.cracked || result.flags.leaked) result.flags.uncensored = true
  result.category = /^FC2-/i.test(result.number || '') ? 'fc2' : ['carib','pondo','musume','heyzo','tokyohot','heydouga','uncensored-date'].includes(result.kind) ? 'uncensored' : result.kind === 'prefixed' ? 'amateur' : 'censored'
  if (/^(?:MD[A-Z]*|MSD|SWAG|91CM|91MS|XK|TM|TZ|PMX|MMZ)-?\d/i.test(result.number || '')) result.category = 'cn'
  if (/\b(?:RJ|VJ)\d{5,}\b/i.test(name)) result.category = 'anime'
  if (/\b[a-z][a-z.-]+[ ._-](?:20)?\d{2}[ ._-]\d{2}[ ._-]\d{2}\b/i.test(name) && !result.number) result.category = 'western'
  return result
}
