export const WORKFLOW_DEFAULTS = {
  file_timeout:600, overwrite_video: false, overwrite_images: true, nfo_enabled: true, reuse_existing_artwork: false,
  cleanup_source: { enabled: false, small: false, unknown_extension: false, blacklisted: false, protect_extensions: 'srt,ass,ssa,vtt,sub,idx,sup,nfo,jpg,jpeg,png,webp', quarantine: '' },
  naming: { folder_max_chars: 0, image_prefix: true, actor_separator: ',', many_actors: '多人', suffix_template: '', part_template: '-CD{part}', subtitle_rename: false, category_labels: {}, prefix_values: {}, suffix_values: {} },
  metadata_options: { strict_on_source_error: false, trim_plot: true, title_dictionary: '', dictionary_language: 'zh', translation_engine: 'host', translation_url: '', translation_key: '' },
  image_selection: { strategy: 'priority', prefer_crop_quality: false, minimum_width: 120, minimum_height: 120, reject_hashes: [], supplemental_sources: [], amazon: false, amazon_strict: false },
  manual_metadata: {}, source_url: '', source_id: '', fc2_extras: true, custom_cracked_keywords: '',
  resolution_filename_first: false, fc2_extras_folder: 'extras', sample_layout: 'extrafanart',
  actor_options: { info: true, images: true, overwrite_info: false, overwrite_images: false, language: 'ja', providers: [], aliases: {}, recent_days: 0 },
}
export function workflowSettings(value) {
  const out = { ...WORKFLOW_DEFAULTS, ...value }
  for (const key of ['cleanup_source','naming','metadata_options','image_selection','actor_options']) out[key] = { ...WORKFLOW_DEFAULTS[key], ...(value[key] || {}) }
  return out
}
