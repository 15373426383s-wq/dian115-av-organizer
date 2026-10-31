import {renderText} from '../lib/templates.js'
import {templateVariables,renderTemplate} from '../lib/naming.js'
import {parseName} from '../lib/number.js'
const groups={naming:['dir_template','file_template','title_template','image_template','naming','nfo','nfo_enabled'],sources:['source_config','source_order','custom_sources','sources','field_priority','field_blocklist','category_source_order'],images:['image_options','image_selection','watermark','download_images','download_extrafanart'],actors:['actor_options','actor_sources'],all:[]}
const secret=/password|cookie|token|secret|api[_-]?key|translation_key|authorization/i
export function configExport(settings,group='all',includeSecrets=false){
  const data={}
  for(const [key,value]of Object.entries(settings))if(group==='all' || (groups[group] || []).includes(key))data[key]=value
  const sanitize=(value,key='')=>{
    if(!includeSecrets && secret.test(key))return ''
    if(Array.isArray(value))return value.map(v=>sanitize(v))
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,k)]))
    if(typeof value==='string' && !includeSecrets && /^https?:\/\//i.test(value)){try{const url=new URL(value);url.username='';url.password='';for(const name of [...url.searchParams.keys()])if(secret.test(name))url.searchParams.set(name,'');return url.href}catch{}}
    if(typeof value==='string' && /^(source_config|custom_sources)$/.test(key)){try{return JSON.stringify(sanitize(JSON.parse(value)))}catch{}}
    return value
  }
  return {format:'av-organizer.settings',version:1,group,settings:sanitize(data)}
}
export function renderConfigTools(ui,draft,set){
  const {el,field,button}=ui,group=el('select',{class:'avo-select'},...Object.entries({all:'全部',naming:'命名与 NFO',sources:'数据来源',images:'图片',actors:'演员'}).map(([key,value])=>el('option',{value:key},value)))
  const input=el('input',{type:'file',accept:'application/json,.json'}),preview=el('pre',{class:'avo-pre'}),secrets=el('input',{type:'checkbox'}),candidate=el('textarea',{class:'avo-textarea',rows:4,value:'{"number":"ABC-123","title":"示例标题","actors":["演员甲"],"release_date":"2024-01-01"}'})
  let imported=null
  input.addEventListener('change',async()=>{try{const file=input.files?.[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('配置文件最大 2 MiB');const raw=JSON.parse(await file.text());if(raw.format!=='av-organizer.settings' || raw.version!==1 || !raw.settings || Array.isArray(raw.settings))throw new Error('不支持的配置格式');imported=raw.settings;preview.textContent=`待导入 ${Object.keys(imported).length} 项：${Object.keys(imported).join('、')}。应用后还需保存设置。`}catch(e){imported=null;ui.toast(e.message,'error')}})
  return el('section',{class:'avo-card avo-section','data-section':'配置与模板','data-icon':'settings'},el('h2',{},'配置与模板'),field('配置分组',group),el('label',{class:'avo-row'},secrets,'导出时包含登录信息'),
    el('div',{class:'avo-row'},button('导出配置',{onClick:()=>{const blob=new Blob([JSON.stringify(configExport(draft,group.value,secrets.checked),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a',{href:url,download:`av-organizer-${group.value}.json`});a.click();URL.revokeObjectURL(url)}}),input,button('应用已选配置',{onClick:()=>{if(!imported)throw new Error('先选择有效配置文件');const data=configExport(imported,group.value,true).settings;for(const [key,value]of Object.entries(data))if(!['__proto__','constructor','prototype'].includes(key))set(key,value);preview.textContent='配置已应用到草稿；保存后生效。';ui.toast('已应用配置，请保存','success')}})),
    field('模板预览资料（JSON）',candidate),button('运行模板预览',{onClick:()=>{const meta=JSON.parse(candidate.value),parsed=parseName(meta.number || ''),vars=templateVariables(meta,parsed,{filename:`${meta.number}.mp4`});preview.textContent=`目录：${renderTemplate(draft.dir_template,vars).join('/')}\n文件：${renderTemplate(draft.file_template,vars).join(' ')}\n标题：${renderText(draft.title_template || '{number} {title}',vars)}`}}),preview)
}
