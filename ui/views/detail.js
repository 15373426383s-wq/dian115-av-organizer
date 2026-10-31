// 整理记录详情抽屉：封面、元数据、识别方式、数据来源、文件路径、处理日志。
import { formatDate, formatDuration, formatSize, METHOD_LABEL, STATUS_LABEL, STATUS_KIND } from '../components.js'

import { sourceName } from '../lib/registry.js'

export function openDetail(ui, store, item, { onChanged } = {}) {
  const { el, icon, button, pathLine } = ui
  const d = ui.dialog(item.number || '未知番号', { drawer: true, icon: 'film', subtitle: item.title || item.source_name || '' })
  const cover = store.coverURL(item.cover)
  const poster = cover
    ? el('img', { class: 'poster', src: cover, alt: item.number, loading: 'lazy' })
    : el('div', { class: 'poster', style: { display: 'grid', placeItems: 'center', color: 'var(--avo-muted)' } }, icon('image', 40))

  const flags = [
    item.flags?.chinese && el('span', { class: 'avo-badge info' }, '中文字幕'),
    item.flags?.uncensored && el('span', { class: 'avo-badge danger' }, '无码破解'),
    item.flags?.k4 && el('span', { class: 'avo-badge' }, '4K'),
    item.part ? el('span', { class: 'avo-badge' }, `第 ${item.part} 段`) : null,
  ]
  const method = METHOD_LABEL[item.method] || '—'
  const score = item.score !== null && item.score !== undefined && item.method !== 'exact' ? `（匹配度 ${item.score}）` : ''

  const info = el('dl', { class: 'avo-kv' },
    ...kv(el, '番号', el('b', { class: 'avo-path', style: { fontSize: '14px' } }, item.number || '—')),
    ...kv(el, '标题', item.title || '—'),
    ...(item.original_title && item.original_title !== item.title ? kv(el, '原标题', item.original_title) : []),
    ...kv(el, '发行日期', item.release_date || '—'),
    ...kv(el, '时长', item.runtime ? `${item.runtime} 分钟` : '—'),
    ...kv(el, '厂商', item.studio || '—'),
    ...kv(el, '发行商', item.label || '—'),
    ...kv(el, '系列', item.series || '—'),
    ...kv(el, '导演', item.director || '—'),
  )

  const top = el('div', { class: 'avo-detail' },
    el('div', { class: 'avo-stack' }, poster,
      el('div', { class: 'avo-row' }, el('span', { class: `avo-badge ${STATUS_KIND[item.status] || ''}` }, STATUS_LABEL[item.status] || item.status), ...flags)),
    el('div', { class: 'avo-stack' }, info,
      section(el, icon, 'user', '演员', chips(el, item.actors, '未识别演员')),
      section(el, icon, 'tag', '标签', chips(el, item.genres, '无标签'))))

  const plot = item.plot ? section(el, icon, 'file', '简介', el('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, item.plot)) : null

  const sourceLinks = Object.entries(item.source_urls || {})
  const recognition = section(el, icon, 'spark', '识别与数据来源', el('dl', { class: 'avo-kv' },
    ...kv(el, '识别方式', `${method}${score}`),
    ...kv(el, '数据来源', sourceLinks.length
      ? el('div', { class: 'avo-row' }, ...sourceLinks.map(([id, url]) => el('a', { href: url, target: '_blank', rel: 'noreferrer noopener', class: 'avo-chip click' }, icon('link', 12), sourceName(id, store.settings))))
      : (item.sources || []).map(id => sourceName(id, store.settings)).join('、') || '—'),
    ...(item.field_sources && Object.keys(item.field_sources).length > 1 ? kv(el, '字段来源', Object.entries(item.field_sources).filter(([f]) => ['title', 'actors', 'cover', 'plot', 'release_date', 'studio'].includes(f)).map(([f, id]) => `${FIELD_LABEL[f]}：${sourceName(id, store.settings)}`).join('；')) : []),
    ...kv(el, '原文件', item.source_name || ''),
    ...kv(el, '文件大小', formatSize(item.size) || '—'),
    ...kv(el, '整理时间', formatDate(item.at)),
    ...(item.rescraped_at ? kv(el, '重新刮削', formatDate(item.rescraped_at)) : []),
    ...kv(el, '耗时', item.duration_ms ? formatDuration(item.duration_ms) : '—'),
    ...(item.note ? kv(el, '说明', item.note) : []),
  ))

  const files = item.files || {}
  const paths = section(el, icon, 'folder', '文件位置', el('div', { class: 'avo-stack', style: { gap: '6px' } },
    pathLine(item.source, '来源'),
    pathLine(item.in_place ? '' : item.target, '视频'),
    pathLine(item.meta_dir, '元数据目录'),
    pathLine(files.nfo, 'NFO'),
    pathLine(files.poster, '海报'),
    pathLine(files.fanart, '背景图'),
    files.extrafanart ? pathLine(`${files.extrafanart}（${files.extrafanart_count || 0} 张）`, '剧照') : null,
    ...(files.subtitles || []).map(path => pathLine(path, '字幕')),
  ))

  const logs = item.logs?.length ? section(el, icon, 'list', '处理日志', el('pre', { class: 'avo-pre' }, item.logs.join('\n'))) : null

  d.body.append(top, plot, recognition, paths, logs)
  const canRescrape = item.status === 'success' && item.meta_dir && item.base
  d.foot.append(
    item.target ? button('复制视频路径', { icon: 'copy', onClick: () => ui.copyText(item.target) }) : null,
    canRescrape ? button('编辑资料', { onClick: () => openMetadataEditor(ui,store,item,onChanged) }) : null,
    canRescrape ? button('重新刮削', { kind: 'primary', icon: 'refresh', onClick: async () => {
      const run = await store.runOrganize({ rescrape: [item.id], rescrape_only: true })
      ui.toast(`已开始重新刮削 ${item.number}`, 'info')
      const done = await store.waitRun(run.id)
      const result = done.result?.rescraped?.[0]
      if (done.status === 'succeeded' && result?.ok) {
        ui.toast(`${item.number} 已重新刮削`, 'success')
        d.close()
        await onChanged?.(item.id)
      } else {
        ui.toast(result?.reason || done.error || '重新刮削失败', 'error', 8000)
      }
    } }) : null,
  )
  return d
}

const FIELD_LABEL = { title: '标题', actors: '演员', cover: '封面', plot: '简介', release_date: '发行日期', studio: '厂商' }

function kv(el, label, value) {
  return [el('dt', {}, label), el('dd', {}, value)]
}

function section(el, icon, iconName, title, content) {
  return el('div', {}, el('div', { class: 'avo-section-title' }, icon(iconName, 15), title), content)
}

function chips(el, values, emptyText) {
  return values?.length
    ? el('div', {}, ...values.map(value => el('span', { class: 'avo-chip' }, value)))
    : el('span', { class: 'avo-hint' }, emptyText)
}

function openMetadataEditor(ui,store,item,onChanged){
  const {el,field,button}=ui,d=ui.dialog(`编辑 ${item.number}`,{drawer:true}),edit={}
  for(const [key,label] of Object.entries({title:'标题',plot:'简介',actors:'演员（逗号分隔）',genres:'类型（逗号分隔）',studio:'制作商',label:'发行商',series:'系列',director:'导演',release_date:'发行日期',runtime:'时长'})){
    const array=['actors','genres'].includes(key),node=el(key==='plot'?'textarea':'input',{class:key==='plot'?'avo-textarea':'avo-input',value:array?(item[key] || []).join(','):item[key] || ''})
    node.addEventListener('input',()=>{edit[key]=array?node.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean):node.value})
    d.body.append(field(label,node))
  }
  if(item.source_variants?.length){
    const choice=el('select',{class:'avo-select'},...item.source_variants.map((v,i)=>el('option',{value:String(i)},v.source)))
    const preview=el('pre',{class:'avo-pre'});choice.addEventListener('change',()=>{preview.textContent=JSON.stringify(item.source_variants[Number(choice.value)],null,2)});preview.textContent=JSON.stringify(item.source_variants[0],null,2)
    d.body.append(field('来源原始资料对比',choice),preview)
  }
  const submit=async(relocate)=>{
    const input=relocate?{paths:[item.target],scan_root:'/',overrides:{reuse_metadata:true,existing_files:item.files,manual_number:item.number,manual_metadata:{...item,...edit,cover:item.cover_remote || '',poster:item.poster || ''}}}:{rescrape:[item.id],rescrape_only:true,reuse_metadata:true,metadata:edit}
    const run=await store.runOrganize(input);ui.toast('任务已提交','success');d.close();await store.waitRun(run.id);await onChanged?.(item.id)
  }
  d.foot.append(button('保存资料并更新 NFO',{kind:'primary',onClick:()=>submit(false)}),button('按当前模板重新整理',{onClick:()=>submit(true)}))
}
