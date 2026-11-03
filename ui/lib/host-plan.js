// 页面侧的设置归一化与目标位置解析。
// 与 jobs/lib/plan.js 保持同源实现，但只保留页面要用的两个纯函数：
// 宿主把「后台任务可达的文件」判定为后台源码、不作为页面资源下发，
// 页面不能反向 import 后台目录，所以这里自带一份（页面与后台不共享模块）。

import { advancedSettings } from './advanced.js'
import { DEFAULT_DIR_TEMPLATE, DEFAULT_FILE_TEMPLATE, isCd2Path, isWithin } from './naming.js'

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
