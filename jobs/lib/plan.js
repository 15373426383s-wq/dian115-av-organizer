// 设置归一化、目标位置解析与单个文件的整理计划。不做任何 IO，便于测试。

import { DEFAULT_DIR_TEMPLATE, DEFAULT_FILE_TEMPLATE, joinPath, renderTemplate, templateVariables, isWithin, isCd2Path, basename, dirname, sanitizeComponent } from './shared/naming.js'
import { numberSuffix, splitExtension } from './shared/number.js'
import { renderText } from './shared/templates.js'
import { advancedSettings } from './shared/advanced.js'

export function normalizeSettings(raw = {}) {
  const value = { ...raw }
  const bool = (key, fallback) => (value[key] === undefined || value[key] === null || value[key] === '' ? fallback : value[key] === true || value[key] === 'true')
  const num = (key, fallback) => (Number.isFinite(Number(value[key])) && value[key] !== '' && value[key] !== null ? Number(value[key]) : fallback)
  return {
    ...advancedSettings(value),
    mode: value.mode === 'strm' ? 'strm' : 'local',
    inbox: String(value.inbox || '').trim().replace(/\/+$/, ''),
    local_target: String(value.local_target || '').trim().replace(/\/+$/, ''),
    strm_rule_id: num('strm_rule_id', 0),
    dir_template: String(value.dir_template || DEFAULT_DIR_TEMPLATE),
    file_template: String(value.file_template || DEFAULT_FILE_TEMPLATE),
    sources: String(value.sources || 'javbus,javdb,fc2'),
    javbus_base: String(value.javbus_base || '').trim().replace(/\/+$/, ''),
    javdb_base: String(value.javdb_base || '').trim().replace(/\/+$/, ''),
    fc2_base: String(value.fc2_base || '').trim().replace(/\/+$/, ''),
    javbus_cookie: String(value.javbus_cookie || ''),
    javdb_cookie: String(value.javdb_cookie || ''),
    cookiecloud_domains: String(value.cookiecloud_domains || '').split(/[,\s，]+/).map(s => s.trim()).filter(Boolean),
    proxy: String(value.proxy || '').trim(),
    request_delay_ms: Math.max(0, num('request_delay_ms', 1500)),
    min_size_mb: Math.max(0, num('min_size_mb', 100)),
    stable_seconds: Math.max(0, num('stable_seconds', 120)),
    max_files_per_run: Math.max(1, num('max_files_per_run', 50)),
    chinese_suffix: bool('chinese_suffix', true),
    uncensored_suffix: bool('uncensored_suffix', true),
    k4_suffix: bool('k4_suffix', false),
    download_images: bool('download_images', true),
    emby_refresh: bool('emby_refresh', true),
    takeover_failed: bool('takeover_failed', false),
    notify: bool('notify', false),
    clean_rules: String(value.clean_rules || ''),
    fuzzy_enabled: bool('fuzzy_enabled', true),
    fuzzy_threshold: Math.min(100, Math.max(0, num('fuzzy_threshold', 85))),
    fuzzy_margin: Math.min(100, Math.max(0, num('fuzzy_margin', 5))),
    fuzzy_min_chars: Math.max(1, num('fuzzy_min_chars', 6)),
    search_sources: String(value.search_sources || 'javdb,javbus'),
    // 工作模式：organize 刮削并整理；rename_only 只整理不刮削；in_place 原地刮削不移动。
    action_mode: ['rename_only', 'in_place', 'from_nfo'].includes(value.action_mode) ? value.action_mode : 'organize',
    rename_only_template: String(value.rename_only_template || '{prefix}/{number}'),
    title_max_chars: Math.max(0, num('title_max_chars', 60)),
    download_extrafanart: bool('download_extrafanart', false),
    extrafanart_limit: Math.min(50, Math.max(0, num('extrafanart_limit', 10))),
    actor_map: String(value.actor_map || ''),
    tag_map: String(value.tag_map || ''),
    failed_folder: String(value.failed_folder || '').trim().replace(/\/+$/, ''),
    failed_move_after: Math.max(0, num('failed_move_after', 0)),
    cover_cache: bool('cover_cache', true),
    // 刮削来源（注册表在 ui/lib/registry.js 解析）
    source_order: String(value.source_order || ''),
    source_config: value.source_config || '',
    custom_sources: value.custom_sources || '',
    age_confirm: bool('age_confirm', false),
    scrape_mode: value.scrape_mode === 'full' ? 'full' : 'fast',
    max_sources: Math.min(12, Math.max(1, num('max_sources', 6))),
    concurrency: Math.min(20, Math.max(1, num('concurrency', 3))),
    source_parallel: Math.min(8, Math.max(1, num('source_parallel', 4))),
    field_priority: String(value.field_priority || ''),
  }
}

// 计算视频根目录和元数据根目录。rules 是 GET /api/rules 的结果（STRM 模式需要）。
export function resolveDestination(settings, rules = []) {
  if (!settings.inbox) throw new Error('请先在设置里填写收件目录')
  if (!settings.inbox.startsWith('/') && !isCd2Path(settings.inbox)) throw new Error('收件目录必须是 Linux 绝对路径或 cd2:/ 路径')
  if (settings.failed_folder && (isWithin(settings.inbox, settings.failed_folder))) throw new Error('失败目录不能放在收件目录里，否则会被再次扫描')
  // 原地刮削：视频不动，元数据写在视频旁边。
  if (settings.action_mode === 'in_place') return { mode: 'in_place', videoRoot: '', metaRoot: '', rule: null, warnings: [] }
  if (settings.mode === 'local') {
    if (!settings.local_target.startsWith('/')) throw new Error('纯本地模式需要填写本地整理目标（Linux 绝对路径）')
    if (!settings.scan_paths?.length && (isWithin(settings.inbox, settings.local_target) || isWithin(settings.local_target, settings.inbox))) {
      throw new Error('整理目标与收件目录不能互相包含，否则整理过的文件会被再次扫描')
    }
    const metaRoot = settings.metadata_target || settings.local_target
    if (!metaRoot.startsWith('/') || (!settings.scan_paths?.length && settings.metadata_target && (isWithin(settings.inbox, metaRoot) || isWithin(metaRoot, settings.inbox)))) throw new Error('元数据目录必须为本地绝对路径且不能与收件目录互相包含')
    return { mode: 'local', videoRoot: settings.local_target, metaRoot, rule: null, warnings: [] }
  }
  const list = Array.isArray(rules) ? rules : (rules?.rules || rules?.items || [])
  const rule = list.find(item => Number(item?.id) === settings.strm_rule_id)
  if (!rule) throw new Error(`没有找到 ID 为 ${settings.strm_rule_id} 的 STRM 规则，请在插件页选择`)
  const source = String(rule.source_path || '').replace(/\/+$/, '')
  const output = String(rule.output_path || '').replace(/\/+$/, '')
  if (!source || !output.startsWith('/')) throw new Error(`STRM 规则「${rule.name || rule.id}」缺少源目录或输出目录`)
  const videoRoot = 'cd2:' + (source.startsWith('/') ? source : '/' + source)
  if (isWithin(settings.inbox, videoRoot) || isWithin(videoRoot, settings.inbox)) {
    throw new Error('收件目录不能和 STRM 规则的源目录互相包含，否则整理过的文件会被再次扫描')
  }
  const warnings = []
  if (rule.generate_strm === false) warnings.push(`STRM 规则「${rule.name}」没有开启生成 STRM`)
  if (rule.enabled === false) warnings.push(`STRM 规则「${rule.name}」已停用`)
  if (String(rule.meta_sync || '') === 'cloud_overwrite') warnings.push(`STRM 规则「${rule.name}」的元数据同步是"云端覆盖"，云盘上的同名元数据会覆盖插件写在本地的 NFO`)
  const realtime = String(rule.sync_mode || '').split(',').map(s => s.trim()).includes('realtime')
  return { mode: 'strm', videoRoot, metaRoot: output, rule: { id: rule.id, name: rule.name, realtime }, warnings }
}

// 单个视频的整理计划：目标视频路径、元数据目录、元数据文件名。
export function planFile(file, parsed, meta, settings, destination) {
  const { ext, stem } = splitExtension(file.name)
  const suffix = numberSuffix(parsed.flags, 0, {
    chinese: settings.chinese_suffix, uncensored: settings.uncensored_suffix, k4: settings.k4_suffix,
  })
  const vars = templateVariables(meta, { ...parsed, suffix }, { titleMaxChars: settings.title_max_chars, maxActors: settings.max_actors, filename: file.name, sourcePath: file.path, actorSeparator: settings.naming?.actor_separator, manyActors: settings.naming?.many_actors, categoryLabels: settings.naming?.category_labels })
  if (parsed.part) vars.suffix += renderText(settings.naming?.part_template || '-CD{part}', vars)
  for (const [key, label] of Object.entries({subtitle:vars.subtitle,mosaic:vars.mosaic,resolution:vars.resolution})) {
    vars[key+'_prefix'] = settings.naming?.prefix_values?.[label] || settings.naming?.prefix_values?.[key] || ''
    vars[key+'_suffix'] = settings.naming?.suffix_values?.[label] || settings.naming?.suffix_values?.[key] || ''
  }
  if(settings.naming?.suffix_template)vars.suffix=renderText(settings.naming.suffix_template,vars)
  if (destination.mode === 'in_place') {
    // 元数据与视频同名放在原目录；视频不改名不移动。
    const dir = dirname(file.path)
    return {
      base: stem, videoDir: dir, videoTarget: file.path, metaDir: dir, inPlace: true,
      nfoName: `${stem}.nfo`, posterName: settings.naming?.image_prefix === false ? 'poster.jpg' : `${stem}-poster.jpg`, fanartName: settings.naming?.image_prefix === false ? 'fanart.jpg' : `${stem}-fanart.jpg`, thumbName: settings.naming?.image_prefix === false ? 'thumb.jpg' : `${stem}-thumb.jpg`,
      subtitleDir: dir, relativeDir: '',
    }
  }
  const category = (settings.category_rules || []).find(rule => new RegExp(rule.pattern, 'i').test(rule.match === 'number' ? meta.number : file.path))
  if (category?.category) vars.category = category.category
  const template = category?.template || (settings.action_mode === 'rename_only' ? settings.rename_only_template : settings.dir_template)
  let dirParts = renderTemplate(template, vars)
  const maxChars=Math.max(0,Number(settings.naming?.folder_max_chars)||0)
  if(maxChars){
    while(dirParts.some(p=>[...p].length>maxChars) && vars.title){vars.title=[...vars.title].slice(0,-1).join('');dirParts=renderTemplate(template,vars)}
    dirParts=dirParts.map(p=>[...p].slice(0,maxChars).join(''))
  }
  const base = renderTemplate(settings.file_template.replace(/\//g, ' '), vars)[0] || sanitizeComponent(meta.number + suffix)
  const videoDir = joinPath(destination.videoRoot, ...dirParts)
  const metaDir = joinPath(destination.metaRoot, ...dirParts)
  const imageBase = renderTemplate(settings.image_template || '{basename}', { ...vars, basename: base }).join(' ') || base
  return {
    base,
    videoDir,
    videoTarget: joinPath(videoDir, `${base}.${ext}`),
    metaDir,
    nfoName: `${base}.nfo`,
    posterName: settings.naming?.image_prefix === false ? 'poster.jpg' : `${imageBase}-poster.jpg`,
    fanartName: settings.naming?.image_prefix === false ? 'fanart.jpg' : `${imageBase}-fanart.jpg`,
    thumbName: settings.naming?.image_prefix === false ? 'thumb.jpg' : `${imageBase}-thumb.jpg`,
    // STRM 模式下字幕放在本地元数据目录（与 .strm 同目录），纯本地模式跟视频同目录。
    subtitleDir: destination.mode === 'strm' ? metaDir : videoDir,
    relativeDir: dirParts.join('/'),
  }
}

// 同目录下与视频同名开头的字幕：SSIS-001.zh.srt → {base}.zh.srt
export function subtitleTargets(videoName, siblings, plan, settings = {}) {
  const videoStem = splitExtension(videoName).stem
  const out = []
  for (const sibling of siblings) {
    const { stem, ext } = splitExtension(sibling.name)
    if (!['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'].includes(ext)) continue
    if (stem !== videoStem && !stem.startsWith(videoStem + '.')) continue
    let tail = stem.slice(videoStem.length)
    if(settings.naming?.subtitle_rename && !/\.(en|eng|ja|jpn)(?:\.|$)/i.test(tail))tail='.chs'
    out.push({ source: sibling.path, target: joinPath(plan.subtitleDir, `${plan.base}${tail}.${ext}`) })
  }
  return out
}

export function parentNameFor(path, inbox) {
  const parent = dirname(path)
  if (parent.replace(/\/+$/, '') === String(inbox).replace(/\/+$/, '')) return ''
  return basename(parent)
}
