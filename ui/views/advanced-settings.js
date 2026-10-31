import {sourceRules,NUMBER_KINDS} from '../source-controls.js'
import {pathControl, embyControls, aiControls, hostSelect, hostResource} from '../host-controls.js'
import {renderConfigTools} from './config-tools.js'
import { advancedSettings } from '../lib/advanced.js'
import { HOST, processArtwork } from '../../jobs/lib/enrich.js'

export function renderAdvancedSettings(ui, ctx, draft, set) {
  const { el, field, button, switchInput } = ui
  const errors = new Map(), jsonEditors = new Map()
  for (const [key, value] of Object.entries(advancedSettings(draft))) if (draft[key] === undefined) draft[key] = value
  const card = (title, ...children) => {
    const content = [], toggles = []
    const flush = () => { if (toggles.length) content.push(toggles.length > 1 ? el('div', { class: 'avo-toggle-grid' }, ...toggles) : toggles[0]); toggles.length = 0 }
    for (const child of children.flat()) {
      if (child?.classList?.contains('avo-switch')) toggles.push(child)
      else { flush(); content.push(child) }
    }
    flush()
    return el('section', { class: 'avo-card avo-section', 'data-section': title, 'data-icon': 'settings' }, el('div', { class: 'avo-card-head' }, el('h2', {}, title)), ...content)
  }
  const NFO_LABELS={title:'标题',originaltitle:'原标题',sorttitle:'排序标题',num:'番号',uniqueid:'唯一编号',plot:'简介',outline:'摘要',premiered:'首映日期',releasedate:'发行日期',year:'年份',runtime:'时长',studio:'制作商',label:'发行商',director:'导演',set:'合集',genre:'类型',tag:'标签',actor:'演员',thumb:'海报',fanart:'背景图',website:'资料网址',trailer:'预告片',fileinfo:'媒体参数'}
  const get = path => path.split('.').reduce((v, k) => v?.[k], draft)
  const put = (path, value) => { const [key, child] = path.split('.'); set(key, child ? { ...draft[key], [child]: value } : value); const editor = jsonEditors.get(path); if (editor && editor !== ui.doc.activeElement) editor.value = JSON.stringify(value, null, 2) }
  const text = (path, label, type = 'text', hint = '') => {
    const node = el('input', { class: 'avo-input', type, value: get(path) ?? '' })
    node.addEventListener('input', () => put(path, type === 'number' ? Number(node.value) : node.value))
    return field(label, node, hint)
  }
  const pathField = (path,label,only) => field(label,pathControl(ui,ctx,{value:get(path)||'',title:label,only,onChange:value=>put(path,value)}))
  const toggle = (path, label) => switchInput(label, Boolean(get(path)), value => put(path, value))
  const select = (path, label, choices) => {
    const node = el('select', { class: 'avo-select' }, ...choices.map(([value, name]) => el('option', { value, selected: String(get(path)) === value }, name)))
    const saved=get(path)
    if(saved!==undefined&&!choices.some(([value])=>value===String(saved)))node.append(el('option',{value:String(saved),selected:true},`已保存：${saved}`))
    node.addEventListener('change', () => put(path, node.value)); return field(label, node)
  }
  const multi = (path, label, choices) => field(label, el('div', { class: 'avo-row', style: { flexWrap: 'wrap' } }, ...choices.map(([value, name]) => switchInput(name, (get(path) || []).includes(value), yes => put(path, yes ? [...new Set([...(get(path) || []), value])] : (get(path) || []).filter(v => v !== value))))))
  const json = (path, label, hint) => {
    const node = el('textarea', { class: 'avo-textarea', value: JSON.stringify(get(path) || (path.includes('rules') ? [] : {}), null, 2), rows: 4 })
    const error = el('div', { class: 'error' })
    jsonEditors.set(path, node)
    node.addEventListener('input', () => { try { const value = JSON.parse(node.value); put(path, value); errors.delete(path); error.textContent = '' } catch { errors.set(path, `${label} JSON 格式不正确`); error.textContent = errors.get(path) } })
    return el('details', { class: 'avo-advanced-field' }, el('summary', {}, label, el('span', { class: 'avo-hint' }, '高级')), field(label, el('div', {}, node, error), hint))
  }
  const grid = (...nodes) => el('div', { class: 'avo-fields' }, ...nodes)
  const directories = el('div', { class: 'avo-stack' })
  const drawDirectories = () => {
    const rows = draft.directories || []
    const update = (index, patch) => { const next = draft.directories.map((row, i) => i === index ? { ...row, ...patch } : row); set('directories', next) }
    directories.replaceChildren(...rows.map((row, index) => {
      const path = pathControl(ui,ctx,{value:row.path||'',title:'选择收件目录',clearable:false,onChange:path=>update(index,{path})})
      const override=(key,value)=>{const overrides={...draft.directories[index].overrides};value===''?delete overrides[key]:overrides[key]=value;update(index,{overrides});advanced.value=JSON.stringify(overrides,null,2)}
      const target = pathControl(ui,ctx,{value:row.overrides?.local_target||'',title:'选择整理目标',only:'local',placeholder:'继承全局整理目标',onChange:value=>override('local_target',value)})
      const mode=el('select',{class:'avo-select'},...[["","继承全局模式"],["local","纯本地"],["strm","CD2 + STRM"]].map(([value,label])=>el('option',{value,selected:(row.overrides?.mode||'')===value},label)))
      mode.addEventListener('change',()=>override('mode',mode.value))
      const rule=hostSelect(ui,{label:'本目录 STRM 规则',value:row.overrides?.strm_rule_id||'',empty:'继承全局规则',load:async force=>(await hostResource(ctx,'/api/rules',force)).map(r=>({value:r.id,label:r.name||'未命名规则'})),onChange:value=>override('strm_rule_id',value?Number(value):'')})
      const advanced = el('textarea', { class: 'avo-textarea', value: JSON.stringify(row.overrides || {}, null, 2), rows: 3 })
      advanced.addEventListener('change', () => { try { const value=JSON.parse(advanced.value);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();update(index,{overrides:value});errors.delete(row.id);drawDirectories() } catch { errors.set(row.id, `${row.id} 的独立配置 JSON 无效`) } })
      return el('div', { class: 'avo-card avo-stack' }, el('div', { class: 'avo-row between' }, switchInput(`目录 ${index + 1}`, row.enabled !== false, enabled => update(index, { enabled })), button('移除', { size: 'sm', kind: 'danger', onClick: () => { set('directories', rows.filter((_, i) => i !== index)); errors.delete(row.id); drawDirectories() } })), grid(field('收件目录', path), field('整理目标', target),field('存储模式',mode),field('STRM 规则',rule.root)), el('details', {}, el('summary', {}, '独立配置（覆盖全局同名设置）'), advanced))
    }))
  }
  drawDirectories()
  const folders = card('多目录与文件', el('p', { class: 'avo-hint' }, '列表为空时沿用基本设置中的单个收件目录。每个目录可覆盖命名、图片、翻译等全局设置。'), directories,
    button('添加目录', { icon: 'plus', onClick: () => { set('directories', [...draft.directories, { id: `dir-${Date.now().toString(36)}`, path: '', enabled: true, overrides: {} }]); drawDirectories() } }),
    grid(select('transfer_mode', '视频整理方式', [['move', '移动'], ['copy', '复制'], ['hardlink', '硬链接（本地同一文件系统）'], ['symlink', '软链接（本地）']]), pathField('metadata_target', '独立资料目录','local'), text('extensions', '视频扩展名白名单', 'text', '逗号分隔，留空使用内置列表'), text('scan_depth', '扫描深度', 'number'), text('watch_interval', '监听兜底轮询（秒）', 'number')),
    toggle('watch_realtime', '本地实时监听（关闭后仅按间隔轮询）'), toggle('delete_empty', '整理成功后删除空的本地源目录'), pathField('subtitle_library', '本地字幕库','local'), text('filename_blacklist', '文件名排除词（可在独立配置中按行填写）'))
  const images = card('图片与水印',
    toggle('overwrite_images','覆盖已有图片'),toggle('reuse_existing_artwork','优先保留目标目录已有图片'),toggle('image_selection.prefer_crop_quality','封面裁剪质量更高时优先采用'),
    grid(select('image_selection.strategy','图片候选选择',[['priority','按来源优先级，失败回退'],['size','实际文件大小'],['resolution','实际像素尺寸']]),text('image_selection.minimum_width','最小宽度','number'),text('image_selection.minimum_height','最小高度','number')),
    toggle('image_selection.amazon','尝试 Amazon 高清海报'),toggle('image_selection.amazon_strict','找不到 Amazon 海报时停止整理'),
    json('image_selection.reject_hashes','排除的占位图片 SHA256','仅匹配下载后的实际摘要'),json('image_selection.supplemental_sources','补充海报来源规则','与刮削来源相同的 search/detail/fields 声明，可配置 Tenhow 等来源'),
    el('div', { class: 'avo-row' }, toggle('image_options.poster', '海报'), toggle('image_options.thumb', '缩略图'), toggle('image_options.fanart', '背景图'), toggle('download_trailer', '下载预告片')),
    grid(select('image_options.crop', '海报裁剪', [['right', '靠右'], ['center', '居中'], ['left', '靠左'], ['face', '人脸优先（未检测到则靠右）'], ['none', '不裁剪']]), select('image_options.ratio', '海报宽高比', [['0.6666666666666666', '2:3'], ['0.7066666666666667', '2.12:3']]), text('image_options.quality', '图片质量', 'number'), text('image_options.max_width', '图片最大宽度（0 保持原尺寸）', 'number'), select('sample_layout','剧照保存方式',[['extrafanart','标准 extrafanart 图片目录'],['extras','兼容 extras（图片文件使用 .mp4 后缀，不是视频）']]),text('image_template', '图片名称模板', 'text', '{basename} 代表视频基础名'), text('trailer_timeout', '预告片下载超时（秒）', 'number')),
    el('p', { class: 'avo-hint' }, '默认最大宽度 1200 像素，大图缩小后再加水印，小图不放大；填 0 保持原尺寸。'),
    toggle('image_options.crop_poster', '独立竖版海报也执行裁剪'), json('image_options.crop_by_kind', '按番号类型覆盖裁剪', '例如 {"fc2":"face","uncensored-date":"center"}'),
    el('details', { class: 'avo-setting-group', open: Boolean(draft.watermark.enabled) }, el('summary', {}, '水印与标记', el('span', { class: 'avo-hint' }, '图片标记与样式')),
    el('div', { class: 'avo-stack' }, toggle('watermark.enabled', '添加水印'), multi('watermark.targets', '添加到', [['poster', '海报'], ['thumb', '缩略图'], ['fanart', '背景图']]),
    grid(text('watermark.scale', '水印宽度占图片比例', 'number'), text('watermark.gap', '叠放间距', 'number'), text('watermark.x', '横向边距', 'number'), text('watermark.y', '纵向边距', 'number'), select('watermark.corner', '起始位置', [['top-left', '左上'], ['top-right', '右上'], ['bottom-left', '左下'], ['bottom-right', '右下']]), select('watermark.direction', '排列方向', [['stack', '纵向叠放'], ['horizontal','横向叠放'], ['clockwise', '顺时针四角'], ['counterclockwise', '逆时针四角']])),
    badgePicker(), json('watermark.rules', '水印规则', '空列表自动匹配主程序当前图片标记；when 可为 always、chinese、uncensored、4K、8K。source 可为图片标记地址或上传的插件图片路径。每条可设 corner、scale、x、y、opacity。'))),
    el('details', { class: 'avo-setting-group' }, el('summary', {}, '图片处理预览'), preview()))
  const naming = card('命名与资料文件',
    toggle('nfo_enabled','生成 NFO'), toggle('naming.image_prefix','图片名称添加视频名称前缀'), toggle('naming.subtitle_rename','中文字幕统一命名为 .chs'),
    grid(text('naming.folder_max_chars','目录最大字符数（先缩短标题，0 不限制）','number'),text('naming.actor_separator','演员分隔符'),text('naming.many_actors','多人作品名称'),text('naming.part_template','分段后缀模板'),text('naming.suffix_template','自定义完整后缀（留空使用默认）')),
    json('naming.category_labels','影片分类名称','censored、uncensored、amateur、fc2、cn、western、anime'),
    json('naming.prefix_values','前缀名称映射','字幕、马赛克、分辨率名称或 subtitle/mosaic/resolution 对应文字；在模板中使用 subtitle_prefix 等'),
    json('naming.suffix_values','后缀名称映射','在后缀模板中使用 subtitle_suffix、mosaic_suffix、resolution_suffix'),
    el('p', { class: 'avo-hint' }, '支持 {number} 和 {{ number | lower }}；支持条件、循环、宏、set、列表和字典，及 default、replace、truncate、split、join 等过滤器；计算量受限，不读取外部模板文件。'),
    grid(text('title_template', 'NFO 标题模板'), text('max_actors', '命名最多演员数', 'number'), select('resolution_mode', '分辨率获取', [['filename', '文件名'], ['probe_first', '优先 FFP，失败采用文件名'], ['probe', '必须使用真实 FFP']])),
    json('category_rules', '分类与目录规则（按顺序首条命中）', '[{"match":"number","pattern":"^FC2-","category":"FC2","template":"{category}/{number}"}]'),
    aiTemplate(),
    field('影片资料字段', el('div', { class: 'avo-row', style: { flexWrap: 'wrap' } }, ...['title', 'originaltitle', 'sorttitle', 'num', 'uniqueid', 'plot', 'outline', 'premiered', 'releasedate', 'year', 'runtime', 'studio', 'label', 'director', 'set', 'genre', 'tag', 'actor', 'thumb', 'fanart', 'website', 'trailer', 'fileinfo'].map(name => switchInput(NFO_LABELS[name] || name, draft.nfo.fields?.[name] !== false, yes => put('nfo.fields', { ...draft.nfo.fields, [name]: yes }))))),
    grid(select('nfo.set', '合集', [['series', '系列'], ['actor', '首位演员'], ['prefix', '番号前缀'], ['none', '不生成']]), text('nfo.tagline', '标语'), text('nfo.country', '国家'), text('nfo.mpaa', '分级'), text('nfo.rating', '评分')),
    multi('nfo.extra_tags', '附加标签', [['actors', '演员'], ['resolution', '分辨率'], ['subtitle', '字幕'], ['mosaic', '马赛克'], ['series', '系列'], ['studio', '制作商'], ['publisher', '发行商'], ['prefix', '前缀']]),
    json('nfo.extra_genres', '附加类型', '支持 actors、resolution、subtitle、mosaic、series、studio、publisher、prefix 或自定义文本'))
  const translation = card('翻译与完整性',
    grid(select('metadata_options.translation_engine','翻译引擎',[['host','宿主 AI'],['google','Google Cloud Translation'],['deepl','DeepL'],['deeplx','自建 DeepLX']]),text('metadata_options.translation_url','翻译服务地址（宿主 AI 无需填写）'),text('metadata_options.translation_key','翻译服务密钥','password'),select('translation.language_code','外部翻译目标语言',[['','跟随目标语言'],['ZH','中文'],['JA','日语'],['EN','英语'],['KO','韩语']]),select('metadata_options.dictionary_language','字典语言',[['','默认'],['zh','简体中文'],['zh-TW','繁体中文'],['ja','日语'],['en','英语']]),text('metadata_options.title_dictionary','标题字典地址或插件内 JSON 路径')),
    toggle('metadata_options.trim_plot','简介合并多余空行'),toggle('metadata_options.strict_on_source_error','仅有来源失败时检查必需元数据'),toggle('resolution_filename_first','文件名有分辨率时免去 FFP 探测'),toggle('nfo.original_plot','保留原始简介字段'), toggle('translation.enabled', '翻译元数据'),
    grid(select('translation.language','目标语言',[['简体中文','简体中文'],['繁體中文','繁体中文'],['日本語','日语'],['English','英语'],['한국어','韩语']]),...aiControls(ui,ctx,{provider:draft.translation.provider_id,model:draft.translation.model,onProvider:value=>put('translation.provider_id',value),onModel:value=>put('translation.model',value)}),text('translation.instruction', '补充翻译要求')),
    multi('translation.fields', '翻译字段', [['title', '标题'], ['plot', '简介'], ['series', '系列'], ['genres', '类型'], ['actors', '演员']]), toggle('translation.required', '翻译失败时暂停该文件整理'),
    multi('required_fields', '必需元数据', [['title', '标题'], ['actors', '演员'], ['plot', '简介'], ['release_date', '日期'], ['studio', '制作商']]),
    multi('required_images', '必需图片', [['poster', '海报'], ['thumb', '缩略图'], ['fanart', '背景图']]),
    grid(text('request_timeout', '来源请求超时（秒）', 'number'), text('source_retry', '来源失败重试（0–3）', 'number'), text('flaresolverr_endpoint', 'FlareSolverr 地址（可选）')), field('字段禁用来源',sourceRules(ui,draft,{value:draft.field_blocklist,ordered:false,onChange:value=>set('field_blocklist',value)})),
    field('按番号类型优先来源',sourceRules(ui,draft,{value:draft.category_source_order,keys:NUMBER_KINDS,onChange:value=>set('category_source_order',value)})),
    json('webhooks', '整理结果 Webhook', '[{"enabled":true,"url":"https://example.com/hook","events":["success","failure"]}]'))
  if (draft.actor_refresh === 'all') { draft.actor_options = {...draft.actor_options,overwrite_info:true,overwrite_images:true}; draft.actor_refresh = 'missing' }
  const actors = card('演员资料', toggle('actors_enabled', '定期同步 Emby 演员资料'), grid(...embyControls(ui,ctx,{instance:draft.actor_proxy_id,library:draft.actor_library_id,onInstance:value=>set('actor_proxy_id',value),onLibrary:value=>set('actor_library_id',value)})),
    multi('actor_options.providers','内置资料提供商',[['sqlite','演员资料库（首次按需下载）'],['wiki','Wikipedia'],['gfriends','Gfriends 头像索引']]),
    toggle('actor_options.info','同步简介'),toggle('actor_options.images','同步头像'),toggle('actor_options.overwrite_info','覆盖已有简介'),toggle('actor_options.overwrite_images','覆盖已有头像'),
    text('actor_options.recent_days','只处理最近入库的演员（天，0 不限）','number'),
    json('actor_options.aliases','演员别名（用于精确匹配）','{"当前姓名":["旧艺名","罗马名"]}'),
    json('actor_sources', '演员数据源', '[{"name":"我的资料库","url":"https://example.com/actors?name={name}","name_path":"name","overview_path":"biography","image_path":"image","headers":{}}]；按演员名精确核对，逐字段合并各来源；支持 json、sqlite、wiki、gfriends、html 类型。HTML 必须精确核对姓名，可设置 name_selector、overview_selector、image_selector、image_attribute。'))
  const workflow = card('整理策略',toggle('overwrite_video','覆盖同名视频和字幕（链接模式不覆盖）'),toggle('fc2_extras','FC2 特典归入主影片 extras'),text('file_timeout','单文件处理时限（秒，0 不限）','number'),text('custom_cracked_keywords','自定义破解关键词（逗号分隔，匹配完整路径）'),
    toggle('cleanup_source.enabled','启用源目录清理（移入独立清理目录）'),pathField('cleanup_source.quarantine','清理目录（收件目录之外）'),toggle('cleanup_source.small','清理小视频'),toggle('cleanup_source.unknown_extension','清理不在扩展名白名单的文件'),toggle('cleanup_source.blacklisted','清理命中排除词的文件'),text('cleanup_source.protect_extensions','保留扩展名（优先于清理规则）'))
  return { cards: [folders, workflow, images, naming, translation, actors, renderConfigTools(ui,draft,set)], errors: () => [...errors.values()] }

  function badgePicker() {
    const results = el('select', { class: 'avo-select' }), filter = el('input', { class: 'avo-input', placeholder: '搜索图片标记名称' })
    let catalog = []
    const draw = () => results.replaceChildren(...catalog.filter(b => b.name.toLowerCase().includes(filter.value.toLowerCase())).slice(0, 150).map(b => el('option', { value: b.asset_url }, b.name)))
    filter.addEventListener('input', draw)
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' })
    file.addEventListener('change', async () => { try { if (!file.files?.[0]) return; const name = `watermarks/${Date.now()}.img`; await ctx.files.upload(name, file.files[0]); put('watermark.rules', [...(draft.watermark.rules || []), { source: name, when: 'always' }]); ui.toast('自定义水印已上传；保存设置后生效', 'success') } catch (e) { ui.toast(e.message, 'error') } })
    return field('水印图片', el('div', { class: 'avo-stack' }, button('读取图片标记', { onClick: async () => { const data = await ctx.api.get(`${HOST}/media/badges`); catalog = (data.packs || []).flatMap(p => p.badges.map(b => ({ ...b, name: `${p.name} / ${b.name}` }))); draw() } }), filter, results, button('添加所选标记', { onClick: () => { if (!results.value) throw new Error('先选择一张图片标记'); put('watermark.rules', [...(draft.watermark.rules || []), { source: results.value, when: 'always' }]); ui.toast('已添加水印规则，保存后生效', 'success') } }), field('或上传自定义水印', file)))
  }
  function preview() {
    const input = el('input', { type: 'file', accept: 'image/*' }), image = el('img', { alt: '海报处理预览', style: { maxWidth: '240px', display: 'none', borderRadius: '8px' } })
    return field('图片处理预览', el('div', { class: 'avo-stack' }, input, button('预览当前裁剪和水印', { onClick: async () => {
      if (!input.files?.[0]) throw new Error('先选择一张预览图片')
      await ctx.files.upload('preview/input', input.files[0])
      await processArtwork(ctx, 'preview/input', 'preview/output.jpg', 'poster', { resolution: '4K' }, { kind: 'standard', flags: { chinese: true } }, advancedSettings(draft), () => Promise.resolve())
      image.src = ctx.files.downloadURL('preview/output.jpg', { inline: true }) + `&v=${Date.now()}`; image.style.display = 'block'
    } }), image))
  }
  function aiTemplate() {
    const prompt = el('input', { class: 'avo-input', placeholder: '例如：按演员/年份分目录，文件名用番号和分辨率' }), result = el('pre', { class: 'avo-hint', style: { whiteSpace: 'pre-wrap' } })
    return field('AI 生成命名模板', el('div', { class: 'avo-stack' }, prompt, button('生成并填入模板', { onClick: async () => {
      if (!prompt.value.trim()) throw new Error('请输入命名要求')
      const reply = await ctx.api.post(`${HOST}/ai/complete`, { system: 'Generate media naming templates. Return only JSON with dir_template and file_template. Use {number},{title},{actor},{actors},{year},{series},{studio},{resolution},{suffix},{category}. Only / in dir_template separates directories. No file extension.', prompt: prompt.value, max_tokens: 800 })
      const parsed = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      if (typeof parsed.dir_template !== 'string' || typeof parsed.file_template !== 'string') throw new Error('AI 模板格式错误')
      set('dir_template', parsed.dir_template); set('file_template', parsed.file_template); result.textContent = `目录：${parsed.dir_template}\n文件：${parsed.file_template}\n保存设置后生效`
    } }), result))
  }
}
