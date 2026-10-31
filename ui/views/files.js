import {createFileBrowser} from '../file-browser.js'
import {pathControl} from '../host-controls.js'
import {sourcePlan} from '../lib/registry.js'

export function renderFiles(ui,store,ctx,app,state={}) {
  const {el,button,field}=ui
  const count=el('span',{class:'avo-pill'},'未选择文件')
  const selected=new Set()
  const browser=createFileBrowser(ui,ctx,{initial:state.path||store.settings.inbox||'/',multiple:true,
    onPath:path=>{state.path=path},onSelection:paths=>{selected.clear();paths.forEach(p=>selected.add(p));count.textContent=paths.length?`已选择 ${paths.length} 项`:'未选择文件'},
  })
  const mode=el('select',{class:'avo-select'},...[
    ['organize','刮削并整理'],['in_place','原地刮削'],['rename_only','仅整理名称'],['from_nfo','读取已有资料'],
  ].map(([value,label])=>el('option',{value,selected:(store.settings.action_mode||'organize')===value},label)))
  let destination=store.settings.local_target||''
  const target=pathControl(ui,ctx,{value:destination,title:'选择本次整理目标',only:'local',placeholder:'沿用全局目标目录',onChange:value=>{destination=value}})
  const number=el('input',{class:'avo-input',placeholder:'如 SSIS-001，仅处理一部作品时填写'})
  const sourceURL=el('input',{class:'avo-input',type:'url',placeholder:'可选，指定该作品的资料页网址'})
  const sourceID=el('select',{class:'avo-select'},el('option',{value:''},'按已启用来源自动查找'),...sourcePlan(store.settings).map(item=>el('option',{value:item.def.id},item.def.name)))
  const overrides=el('textarea',{class:'avo-textarea',rows:4,value:'{}','aria-label':'本次任务高级配置'})
  const options=el('aside',{class:'avo-card avo-stack avo-file-options'},
    el('div',{class:'avo-card-head'},el('h2',{},ui.icon('settings'),'整理选项'),count),
    field('处理方式',mode),field('整理目标',target),
    el('details',{class:'avo-advanced-field'},el('summary',{},'指定作品资料'),el('div',{class:'avo-stack'},field('番号',number),field('资料来源',sourceID),field('详情网址',sourceURL))),
    el('details',{class:'avo-advanced-field'},el('summary',{},'本次高级配置'),field('配置覆盖',overrides,'只影响本次任务，使用 JSON 格式。')),
    button('整理选中项',{kind:'primary',icon:'play',onClick:async()=>{
      if(!selected.size)throw new Error('请先勾选文件或文件夹')
      const custom=JSON.parse(overrides.value||'{}')
      if(!custom||Array.isArray(custom)||typeof custom!=='object')throw new Error('高级配置必须是 JSON 对象')
      await store.runOrganize({paths:[...selected],scan_root:browser.path,overrides:{...custom,manual_number:number.value.trim(),source_id:sourceID.value,source_url:sourceURL.value.trim(),action_mode:mode.value,...(destination?{local_target:destination}:{})}})
      ui.toast(`已提交 ${selected.size} 项，可在任务队列查看进度`,'success');await app.refresh(false,true)
    }}),el('p',{class:'avo-hint'},'文件夹会按当前扫描规则处理。操作进度在主程序任务队列中显示。'))
  return el('div',{class:'avo-files-layout'},el('section',{class:'avo-card avo-file-panel'},el('div',{class:'avo-card-head'},el('h2',{},ui.icon('folder'),'文件管理器')),browser.root),options)
}
