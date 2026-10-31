import {pathControl,hostSelect,hostResource} from '../host-controls.js'
// 设置：分组表单、路径浏览器、STRM 规则选择、命名模板实时预览、来源排序。
import { compileCleanRules, numberSuffix } from '../lib/number.js'
import { templateVariables, renderTemplate, DEFAULT_DIR_TEMPLATE, DEFAULT_FILE_TEMPLATE } from '../lib/naming.js'
import { parseMapping } from '../lib/mapping.js'
import { enableWatch } from './overview.js'
import { renderSourcesCard } from './sources.js'
import { renderAdvancedSettings } from './advanced-settings.js'
import { validateAdvanced, directoryConfigs } from '../lib/advanced.js'
import { normalizeSettings, resolveDestination } from '../../jobs/lib/plan.js'

const SAMPLE = {
  meta: { number: 'SSIS-001', title: '新人NO.1STYLE 示例标题 完整版', actors: ['演员甲', '演员乙'], studio: 'S1 NO.1 STYLE', label: 'S1', series: '新人', director: '导演', release_date: '2021-02-19' },
  parsed: { number: 'SSIS-001', flags: { chinese: true, uncensored: false, k4: false }, part: 0 },
}

export function renderSettings(ui, store, ctx, app, view = {}) {
  const { el, icon, button, field, switchInput } = ui
  const original = structuredClone(store.settings)
  const draft = structuredClone(store.settings)
  let dirty = false
  const dirtyBadge = el('span', { class: 'avo-hint' }, '设置未修改')
  const markDirty = () => { dirty = true; dirtyBadge.textContent = '有未保存的修改'; dirtyBadge.style.color = 'var(--avo-warning)'; refreshDynamic() }
  const set = (key, value) => { draft[key] = value; markDirty() }

  const text = (key, placeholder, type = 'text') => {
    const node = el('input', { class: 'avo-input', type, placeholder, value: draft[key] ?? '' })
    node.addEventListener('input', () => set(key, type === 'number' ? (node.value === '' ? '' : Number(node.value)) : node.value))
    return node
  }
  const area = (key, placeholder) => {
    const node = el('textarea', { class: 'avo-textarea', placeholder, value: draft[key] ?? '' })
    node.addEventListener('input', () => set(key, node.value))
    return node
  }
  const toggle = (key, label, fallback = false) => switchInput(label, draft[key] ?? fallback, value => set(key, value))
  const choice = (key, options, fallback) => {
    const box = el('div', { class: 'avo-choice' })
    const draw = () => box.replaceChildren(...options.map(([value, title, desc]) => {
      const checked = (draft[key] || fallback) === value
      const radio = el('input', { type: 'radio', name: `avo-${key}`, checked })
      radio.addEventListener('change', () => { set(key, value); draw() })
      return el('label', { class: checked ? 'checked' : '' }, radio, el('div', {}, el('b', {}, title), el('span', {}, desc)))
    }))
    draw()
    return box
  }
  const pathInput = (key, placeholder, options = {}) => pathControl(ui,ctx,{value:draft[key] || '',onChange:value=>set(key,value),placeholder,...options})
  const card = (iconName, title, hint, ...children) => el('div', { class: 'avo-card avo-section', 'data-section': title, 'data-icon': iconName },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon(iconName), title), hint ? el('span', { class: 'avo-hint' }, hint) : null), ...children)

  // ---------- 基本 ----------
  const targetBox = el('div', { class: 'avo-stack' })
  const ruleInfo = el('div', { class: 'avo-hint' })
  let rules = []
  const drawRuleInfo = () => {
    const rule = rules.find(item => Number(item.id) === Number(draft.strm_rule_id))
    if (!rule) { ruleInfo.replaceChildren('选择一条开启了“生成 STRM”的规则'); return }
    const notes = []
    if (!rule.generate_strm) notes.push(el('span', { class: 'avo-badge danger' }, '未开启生成 STRM'))
    if (rule.enabled === false) notes.push(el('span', { class: 'avo-badge danger' }, '规则已停用'))
    if (rule.meta_sync === 'cloud_overwrite') notes.push(el('span', { class: 'avo-badge warning' }, '元数据同步为“云端覆盖”，建议改为不同步'))
    if (String(rule.sync_mode || '').includes('realtime')) notes.push(el('span', { class: 'avo-badge success' }, '实时同步'))
    ruleInfo.replaceChildren(el('div', { class: 'avo-stack', style: { gap: '4px' } },
      ui.pathLine(`cd2:${rule.source_path}`, '视频'), ui.pathLine(rule.output_path, '元数据'), notes.length ? el('div', { class: 'avo-row' }, ...notes) : null))
  }
  const ruleControl=hostSelect(ui,{label:'STRM 规则',value:draft.strm_rule_id||'',empty:'请选择 STRM 规则',load:async force=>{
    rules=await hostResource(ctx,'/api/rules',force)
    drawRuleInfo()
    return rules.map(rule=>({value:rule.id,label:`${rule.name||'未命名规则'}${rule.generate_strm?'':' · 未开启 STRM'}`}))
  },onChange:value=>{set('strm_rule_id',Number(value));drawRuleInfo()}})


  const drawTarget = () => {
    if ((draft.action_mode || 'organize') === 'in_place') { targetBox.replaceChildren(el('div', { class: 'avo-notice info' }, icon('spark'), '原地刮削：视频留在收件目录，NFO、封面和剧照写在视频旁边，与视频同名。')); return }
    targetBox.replaceChildren(
      choice('mode', [['local', '纯本地', '视频和元数据都放本地目标目录，整理后刷新 Emby'], ['strm', 'CD2 + STRM', '视频进 STRM 规则的源目录，元数据留在输出目录；宿主生成 STRM 并刷新']], 'local'),
      (draft.mode || 'local') === 'strm'
        ? field('STRM 规则', el('div', { class: 'avo-stack' }, ruleControl.root, ruleInfo), '视频移到规则的 CD2 源目录，NFO、封面、字幕写到 STRM 输出目录的同一相对位置')
        : field('本地整理目标', pathInput('local_target', '/mnt/media/AV', { title: '选择本地整理目标', only: 'local' }), '整理后的视频与元数据放在这里，不能和收件目录互相包含'))
  }

  const basic = card('home', '基本', '工作模式与目录',
    field('工作模式', choice('action_mode', [
      ['from_nfo','读取已有 NFO 整理','使用视频旁的 NFO 资料，不访问刮削来源'],
      ['organize', '刮削并整理', '识别番号 → 刮削 → 生成 NFO / 封面 → 按模板移动'],
      ['rename_only', '只整理不刮削', '只按番号移动和改名，不联网、不写元数据'],
      ['in_place', '原地刮削', '不移动视频，只在原位置写入 NFO 和图片'],
    ], 'organize')),
    el('div', { class: 'avo-fields', style: { marginTop: '16px' } },
      field('收件目录', pathInput('inbox', '/mnt/inbox 或 cd2:/115/inbox', { title: '选择收件目录' }), '本地 Linux 路径或 CD2 路径；建议加入宿主整理规则的排除路径'),
      field('失败目录', pathInput('failed_folder', '留空表示不移动', { title: '选择失败目录' }), '连续失败达到次数后移到这里'),
      field('失败几次后移动', text('failed_move_after', '0 表示不自动移动', 'number'), '0 表示从不自动移动，只留在待处理')),
    el('div', { style: { marginTop: '16px' } }, targetBox))

  // ---------- 命名 ----------
  const preview = el('div', { class: 'avo-preview' })
  const drawPreview = () => {
    const suffix = numberSuffix(SAMPLE.parsed.flags, SAMPLE.parsed.part, { chinese: draft.chinese_suffix !== false, uncensored: draft.uncensored_suffix !== false, k4: Boolean(draft.k4_suffix) })
    const vars = templateVariables(SAMPLE.meta, { ...SAMPLE.parsed, suffix }, { titleMaxChars: Number(draft.title_max_chars ?? 60) })
    const template = draft.action_mode === 'rename_only' ? (draft.rename_only_template || '{prefix}/{number}') : (draft.dir_template || DEFAULT_DIR_TEMPLATE)
    const dir = renderTemplate(template, vars).join('/')
    const base = renderTemplate(String(draft.file_template || DEFAULT_FILE_TEMPLATE).replace(/\//g, ' '), vars)[0] || 'SSIS-001'
    const root = draft.action_mode === 'in_place' ? '（原目录）' : draft.mode === 'strm' ? 'cd2:/…/STRM 源目录' : (draft.local_target || '/整理目标')
    preview.replaceChildren(el('div', { class: 'avo-hint' }, `示例：SSIS-001 中字，演员甲、演员乙`),
      el('div', { class: 'avo-path', style: { marginTop: '6px' } }, draft.action_mode === 'in_place' ? '视频不移动，元数据与原文件同名' : `${root}/${dir}/${base}.mp4`),
      draft.action_mode === 'rename_only' || draft.action_mode === 'in_place' ? null : el('div', { class: 'avo-path avo-hint' }, `${base}.nfo · ${base}-poster.jpg · ${base}-fanart.jpg`))
  }
  const naming = card('edit', '命名', '目录与文件名模板',
    el('div', { class: 'avo-fields' },
      field('目录模板', text('dir_template', DEFAULT_DIR_TEMPLATE), '可用变量：{number} {title} {actor} {actors} {studio} {label} {series} {director} {year} {date} {prefix}；/ 分隔目录'),
      field('文件名模板', text('file_template', DEFAULT_FILE_TEMPLATE), '{suffix} 为 -C / -UC / -4K / -cd1 等标记'),
      field('只整理模式的目录模板', text('rename_only_template', '{prefix}/{number}'), '只整理不刮削时没有标题和演员，只能用番号相关变量'),
      field('标题最长字数', text('title_max_chars', '60', 'number'), '目录名里的标题超出时截断，0 表示不限制')),
    el('div', { class: 'avo-row', style: { margin: '14px 0', gap: '20px' } }, toggle('chinese_suffix', '中字加 -C', true), toggle('uncensored_suffix', '破解加 -UC', true), toggle('k4_suffix', '4K 加 -4K', false)),
    field('预览', preview))

  // ---------- 识别 ----------
  const cleanErrors = el('div', { class: 'error' })
  const cleanArea = area('clean_rules', '# 每行一条\n@私人收藏\n/\\bhhb\\d*\\b/i\nXYZ => SSIS-')
  const thresholdValue = el('b', {}, String(draft.fuzzy_threshold ?? 85))
  const threshold = el('input', { type: 'range', min: '50', max: '100', step: '1', value: String(draft.fuzzy_threshold ?? 85), style: { width: '100%', accentColor: 'var(--avo-accent)' } })
  threshold.addEventListener('input', () => { thresholdValue.textContent = threshold.value; set('fuzzy_threshold', Number(threshold.value)) })
  const recognition = card('spark', '识别', '自定义清理与模糊匹配',
    field('自定义清理规则', cleanArea, '先于内置清理执行。写文本直接去掉；/正则/i 去掉匹配内容；原文 => 替换 或 /正则/ => 替换（可用 $1）；# 开头为注释', cleanErrors),
    el('div', { style: { marginTop: '16px' } }, toggle('fuzzy_enabled', '启用模糊匹配（认不出精确番号时自动处理，不需要人工）', true)),
    el('div', { class: 'avo-fields', style: { marginTop: '16px' } },
      field(el('span', {}, '匹配度阈值：', thresholdValue), threshold, '最高匹配度达到此值才自动整理；越高越严格。完整标题为 100，只有前半段标题约 80 多'),
      field('领先差距（分）', text('fuzzy_margin', '5', 'number'), '第一名必须比第二名高出这么多分，避免同系列相近标题选错'),
      field('模糊匹配最少字数', text('fuzzy_min_chars', '6', 'number'), '去掉番号和噪音后剩下的文字少于此数时不做标题比较')))

  // ---------- 刮削来源 ----------
  const scraping = renderSourcesCard(ui, store, ctx, draft, set)

  // ---------- 元数据 ----------
  const mapInfo = el('div', { class: 'avo-hint' })
  const metadata = card('image', '元数据', '图片、剧照与映射',
    el('div', { class: 'avo-row', style: { gap: '24px', marginBottom: '16px' } },
      toggle('download_images', '下载封面（海报与背景图）', true), toggle('download_extrafanart', '下载剧照（extrafanart）', false), toggle('cover_cache', '在插件里缓存封面用于页面显示', true)),
    el('div', { class: 'avo-fields' },
      field('剧照最多张数', text('extrafanart_limit', '10', 'number'), '放在视频目录的 extrafanart 子目录，Emby / Kodi 会作为剧照显示'),
      field('演员名映射', area('actor_map', '# 原名 => 新名；新名留空表示删除\n三上悠亜 => 三上悠亚'), '按映射表转换，留空则删除'),
      field('标签映射', area('tag_map', '# 原标签 => 新标签；新标签留空表示删除\n單體作品 => 单体作品\n高畫質 =>'), '统一繁简写法或去掉不需要的标签')),
    mapInfo)

  // ---------- 运行 ----------
  const running = card('settings', '运行', '扫描、刷新与通知',
    el('div', { class: 'avo-fields' },
      field('最小视频大小（MB）', text('min_size_mb', '100', 'number'), '更小的文件视为预览或广告，不处理'),
      field('文件静置时间（秒）', text('stable_seconds', '120', 'number'), '修改时间在此之内的文件可能仍在写入，下次再处理'),
      field('每次最多处理文件数', text('max_files_per_run', '50', 'number')),
      field('同时处理文件数', text('concurrency', '3', 'number'), '1–8；识别与刮削并发进行，同一目标目录的写入和移动仍按顺序')),
    el('div', { class: 'avo-stack', style: { marginTop: '16px' } },
      toggle('emby_refresh', '纯本地 / 原地刮削模式整理后刷新 Emby', true),
      toggle('takeover_failed', '接手宿主整理失败且能认出番号的视频（移进收件目录后由本插件整理）', false),
      toggle('notify', '整理完成后发送通知', false)))

  // ---------- 校验与保存 ----------
  const advanced = renderAdvancedSettings(ui, ctx, draft, set)
  const problems = el('div', { class: 'avo-stack', style: { gap: '6px' } })
  function validate() {
    const list = [...validateAdvanced(draft), ...advanced.errors()]
    const absolute = value => !value || value.startsWith('/') || value.startsWith('cd2:')
    if (!draft.inbox && !draft.directories?.some(d => d.enabled !== false && d.path)) list.push('请设置收件目录')
    else if (!absolute(draft.inbox)) list.push('收件目录必须是 Linux 绝对路径或 cd2: 路径')
    if ((draft.action_mode || 'organize') !== 'in_place' && !draft.directories?.length) {
      if ((draft.mode || 'local') === 'local' && !String(draft.local_target || '').startsWith('/')) list.push('纯本地模式需要设置本地整理目标')
      if (draft.mode === 'strm' && !Number(draft.strm_rule_id)) list.push('CD2 + STRM 模式需要选择 STRM 规则')
      const inbox = String(draft.inbox || '').replace(/\/+$/, ''), target = String(draft.local_target || '').replace(/\/+$/, '')
      if (draft.mode !== 'strm' && inbox && target && (target === inbox || target.startsWith(inbox + '/') || inbox.startsWith(target + '/'))) list.push('整理目标与收件目录不能互相包含')
    }
    const failed = String(draft.failed_folder || '')
    if (failed && draft.inbox && failed.startsWith(String(draft.inbox).replace(/\/+$/, '') + '/')) list.push('失败目录不能放在收件目录里')
    if (draft.directories?.length) { try { for (const config of directoryConfigs(draft)) resolveDestination(normalizeSettings(config), rules) } catch (e) { list.push(e.message) } }
    return list
  }
  function refreshDynamic() {
    const { errors } = compileCleanRules(draft.clean_rules)
    cleanErrors.textContent = errors.join('；')
    const actors = parseMapping(draft.actor_map).size, tags = parseMapping(draft.tag_map).size
    mapInfo.textContent = actors || tags ? `已配置 ${actors} 条演员映射、${tags} 条标签映射` : ''
    drawPreview()
    const list = validate()
    problems.replaceChildren(...list.map(message => el('div', { class: 'avo-notice warning' }, icon('alert'), message)))
  }
  const rerenderTarget = () => { drawTarget(); refreshDynamic() }
  basic.addEventListener('change', event => { if (event.target?.type === 'radio') rerenderTarget() })
  drawTarget()
  refreshDynamic()

  const saveBar = el('div', { class: 'avo-savebar' }, dirtyBadge,
    el('div', { class: 'avo-row' },
      button('还原', { kind: 'ghost', icon: 'refresh', onClick: async () => { store.settings = { ...original }; await app.render() } }),
      button('保存设置', { kind: 'primary', icon: 'check', onClick: async () => {
        const list = validate()
        if (list.length) throw new Error(list[0])
        const inboxChanged = original.inbox !== draft.inbox || JSON.stringify(original.directories) !== JSON.stringify(draft.directories) || original.watch_interval !== draft.watch_interval
        await store.saveSettings(draft)
        if (inboxChanged && store.watch) await enableWatch(ctx, store.settings)
        dirty = false
        ui.toast(inboxChanged && store.watch ? '设置已保存，目录监听已切换到新的收件目录' : '设置已保存', 'success')
        await app.refresh()
      } })))

  app.beforeLeave = async () => !dirty || ui.confirm('离开设置', '设置还没有保存，离开后修改会丢失。确定离开吗？', '不保存，离开', 'danger')
  scraping.classList.add('avo-section')
  scraping.dataset.section = '刮削来源'
  scraping.dataset.icon = 'database'
  const sections = [basic, naming, recognition, scraping, metadata, ...advanced.cards, running]
  const sectionSearch = el('input',{class:'avo-input',type:'search',placeholder:'查找设置分组','aria-label':'查找设置分组'})
  // Keep all controls mounted to preserve unsaved edits; show one section.
  const selected = sections.find(section => section.dataset.section === view.section) || basic
  const navItems = sections.map(section => el('button', {
    type: 'button', class: 'avo-nav-item',
    onclick: () => mark(section),
  }, icon(section.dataset.icon, 15), section.dataset.section))
  const mark = active => {
    view.section = active.dataset.section
    navItems.forEach((item, index) => {
      const selected = sections[index] === active
      item.classList.toggle('active', selected)
      item.setAttribute('aria-current', selected ? 'page' : 'false')
      sections[index].hidden = !selected
    })
  }
  sectionSearch.addEventListener('input',()=>navItems.forEach((item,index)=>{item.hidden=!sections[index].dataset.section.includes(sectionSearch.value.trim())}))
  mark(selected)
  const nav = el('nav', { class: 'avo-settings-nav', 'aria-label': '设置分区' }, el('span', { class: 'avo-nav-label' }, '设置分组'), sectionSearch, ...navItems)
  return el('div', { class: 'avo-settings' }, nav,
    el('div', { class: 'avo-stack avo-settings-main', style: { gap: '16px' } }, problems, ...sections, saveBar))
}
