import {renderText} from './templates.js'
import {templateVariables} from './naming.js'
// Kodi / Emby 电影 NFO。番号写入 uniqueid 与 num，便于重新刮削和去重。

export function escapeXML(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function tag(name, value, indent = '  ') {
  if (value === undefined || value === null || value === '') return ''
  return `${indent}<${name}>${escapeXML(value)}</${name}>\n`
}

export function buildNFO(meta, options = {}) {
  const config = options.config || {}, fields = config.fields || {}
  const enabled = name => fields[name] !== false
  const emit = (name, value) => enabled(name) ? tag(name, value) : ''
  const title = options.title || meta.display_title || [meta.number, meta.title].filter(Boolean).join(' ')
  const date = meta.release_date || ''
  const tags = [...new Set([...(meta.tags || []), ...(options.extraTags || [])])]
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n'
  xml += emit('title', title)
  xml += emit('originaltitle', meta.original_title || meta.title)
  xml += emit('sorttitle', meta.number)
  xml += emit('num', meta.number)
  if (enabled('uniqueid')) xml += `  <uniqueid type="num" default="true">${escapeXML(meta.number)}</uniqueid>\n`
  xml += emit('plot', meta.plot)
  if(config.original_plot)xml += emit('originalplot',meta.original_plot || meta.plot)
  if(meta.translation_model)xml += emit('translatedby',meta.translation_model)
  xml += emit('outline', config.original_plot ? meta.original_plot || meta.plot : meta.plot)
  if (date) {
    xml += emit('release', date)
    xml += emit('premiered', date)
    xml += emit('releasedate', date)
    xml += emit('year', date.slice(0, 4))
  }
  if (meta.runtime) xml += emit('runtime', meta.runtime)
  xml += emit('studio', meta.studio)
  xml += emit('label', meta.label)
  xml += emit('maker', meta.studio)
  xml += emit('publisher', meta.label)
  xml += emit('director', meta.director)
  const set = config.set === 'actor' ? meta.actors?.[0] : config.set === 'prefix' ? meta.number?.split('-')[0] : config.set === 'none' ? '' : meta.series
  if (set && enabled('set')) xml += `  <set>\n${tag('name', set, '    ')}  </set>\n`
  for (const genre of new Set([...(meta.genres || []), ...(options.extraGenres || [])])) xml += emit('genre', genre)
  for (const value of tags) xml += emit('tag', value)
  for (const [index, actor] of (enabled('actor') ? meta.actors || [] : []).entries()) {
    xml += `  <actor>\n${tag('name', actor, '    ')}${tag('type', 'Actor', '    ')}${tag('order', index, '    ')}${tag('thumb', meta.actor_photos?.[actor], '    ')}  </actor>\n`
  }
  if (options.poster) xml += emit('thumb', options.poster)
  if (options.fanart && enabled('fanart')) xml += `  <fanart>\n${tag('thumb', options.fanart, '    ')}  </fanart>\n`
  if (meta.source_url) xml += emit('website', meta.source_url)
  xml += emit('trailer', options.trailer || meta.trailer)
  for (const key of ['country', 'mpaa', 'rating', 'criticrating', 'userrating', 'votes', 'tagline', 'customrating']) xml += emit(key, key === 'tagline' ? renderText(config[key] || meta[key] || '',templateVariables(meta,{})) : (config[key] !== '' && config[key] != null ? config[key] : meta[key]))
  if (meta.media && enabled('fileinfo')) xml += `  <fileinfo><streamdetails><video>${tag('codec', meta.media.video_codec, '')}${tag('width', meta.media.width, '')}${tag('height', meta.media.height, '')}${tag('durationinseconds', Math.round(meta.media.duration || 0), '')}</video></streamdetails></fileinfo>\n`
  xml += '</movie>\n'
  return xml
}
