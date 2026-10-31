// 插件设置的默认值。设置全部在插件页面里管理，不在清单里声明宿主表单。
import { ADVANCED_DEFAULTS } from './advanced.js'
export const DEFAULT_SETTINGS = {
  ...ADVANCED_DEFAULTS,
  mode: "local",
  strm_rule_id: 0,
  dir_template: "{actor}/{number} {title}",
  file_template: "{number}{suffix}",
  chinese_suffix: true,
  uncensored_suffix: true,
  k4_suffix: false,
  fuzzy_enabled: true,
  fuzzy_threshold: 85,
  fuzzy_margin: 5,
  fuzzy_min_chars: 6,
  request_delay_ms: 1500,
  download_images: true,
  min_size_mb: 100,
  stable_seconds: 120,
  max_files_per_run: 50,
  emby_refresh: true,
  takeover_failed: false,
  notify: false,
  action_mode: "organize",
  rename_only_template: "{prefix}/{number}",
  title_max_chars: 60,
  download_extrafanart: false,
  extrafanart_limit: 10,
  cover_cache: true,
  failed_move_after: 0,
  search_sources: "javdb,javbus",
  scrape_mode: "fast",
  max_sources: 6,
  concurrency: 3,
  source_parallel: 4,
  age_confirm: false,
}

export function withDefaults(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) }
}
