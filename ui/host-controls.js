import {accountKey, accountQuery, accountSelector} from './lib/accounts.js'

const contexts = new WeakMap()
export function hostResource(ctx, path, force = false) {
  if (!contexts.has(ctx)) contexts.set(ctx,new Map())
  const cache=contexts.get(ctx),old=cache.get(path)
  if (!force && old && Date.now()-old.at<30000) return old.promise
  const row={at:Date.now()}
  row.promise=ctx.api.get(path).catch(error=>{if(cache.get(path)===row)cache.delete(path);throw error})
  cache.set(path,row);return row.promise
}

// 读取失败或已保存选项消失时保留原值，不能静默改用另一个账号、目录或模型。
export function hostSelect(ui, {label, value = '', empty = '使用默认设置', load, onChange}) {
  const {el,button}=ui
  let selected=String(value??''),version=0,options=[]
  const select=el('select',{class:'avo-select','aria-label':label}),message=el('span',{class:'avo-hint',role:'status'})
  const draw=items=>{
    options=items
    select.replaceChildren(el('option',{value:''},empty),...items.map(item=>el('option',{value:String(item.value),disabled:item.disabled},item.label)))
    if(selected && !items.some(item=>String(item.value)===selected))select.append(el('option',{value:selected},'已保存的选项暂不可用，请重新选择'))
    select.value=selected
  }
  const refresh=async(force=false)=>{
    const request=++version;select.disabled=true;message.textContent='正在读取…'
    try{const items=await load(force);if(request!==version)return;draw(items);message.textContent=items.length?'': '主程序中暂无可选项'}
    catch(e){if(request!==version)return;draw([]);message.textContent=ui.errorText(e)}
    finally{if(request===version)select.disabled=false}
  }
  select.addEventListener('change',()=>{selected=select.value;onChange?.(selected)})
  const root=el('div',{class:'avo-selector'},el('div',{class:'avo-inline'},select,button('',{icon:'refresh',kind:'ghost',title:`刷新${label}`,onClick:()=>refresh(true)})),message)
  const ready=refresh()
  return {root,select,ready,refresh,setValue(value){selected=String(value??'');draw(options)},clear(){selected='';draw(options)}}
}

export function pathControl(ui,ctx,{value='',onChange,title='选择目录',only,clearable=true,placeholder='请选择目录'}={}) {
  const input=ui.el('input',{class:'avo-input avo-path',value,readOnly:true,placeholder,'aria-label':title})
  const root=ui.el('div',{class:'avo-inline avo-path-control'},input,ui.button('选择',{icon:'folder',onClick:async()=>{
    const next=await ui.pathPicker(ctx,input.value,{title,only})
    if(next!==null){input.value=next;onChange?.(next)}
  }}))
  if(clearable)root.append(ui.button('',{icon:'close',kind:'ghost',title:'清除目录选择',onClick:()=>{input.value='';onChange?.('')}}))
  return root
}

export function accountControl(ui,ctx,value,onChange) {
  return hostSelect(ui,{label:'115 账号',value:value?.id?accountKey(value):'',empty:'使用当前主账号',load:async force=>{
    const data=await hostResource(ctx,'/api/115/accounts/options',force)
    return (data.accounts||[]).filter(a=>['main','backup'].includes(a.mode)&&a.id).map(a=>({value:accountKey(a),label:`${a.name||a.user_name||'115 账号'}${a.cookie_status==='invalid'?' · 登录已失效':''}`,disabled:a.cookie_status==='invalid'}))
  },onChange:key=>{const [mode,id]=key.split(':');onChange(accountSelector(key?{mode,id}:{mode:'main'}))}})
}

export function pick115Directory(ui,ctx,selectedAccount) {
  return new Promise(resolve=>{
    let settled=false,version=0,ready=false,account=accountSelector(selectedAccount),trail=[{cid:'0',name:'根目录'}]
    const dialog=ui.dialog('选择 115 保存目录',{icon:'cloud',width:720,onClose:()=>{version++;if(!settled)resolve(null)}})
    const crumbs=ui.el('nav',{class:'avo-crumbs','aria-label':'115 当前目录'}),list=ui.el('div',{class:'avo-file-list'})
    const confirm=ui.button('保存到此目录',{kind:'primary',icon:'check',onClick:()=>{
      if(!ready)throw new Error('请先打开一个可读取的目录')
      settled=true;dialog.close();resolve({cid:trail.at(-1).cid,name:trail.map(x=>x.name).join(' / '),account})
    }})
    async function go(nextTrail){
      const request=++version;ready=false;confirm.disabled=true
      list.replaceChildren(ui.el('div',{class:'avo-skeleton',style:{height:'140px'}}))
      try{
        const data=await ctx.api.get(`/api/115/directories?${accountQuery(account)}&cid=${encodeURIComponent(nextTrail.at(-1).cid)}`)
        if(request!==version||ctx.signal?.aborted)return
        if(!Array.isArray(data.dirs))throw new Error('无法读取此目录，请在主程序检查账号状态')
        if(data.dirs.some(dir=>typeof dir.cid!=='string'||!/^\d+$/.test(dir.cid)))throw new Error('目录编号格式不正确，请刷新后重试')
        if(data.account?.id){
          const actual=accountSelector(data.account)
          if(account.id&&accountKey(actual)!==accountKey(account))throw new Error('返回的账号与选择不一致，请重新选择')
          account=actual
        }
        if(!account.id)throw new Error('未能确认当前账号，请先选择具体的 115 账号')
        trail=nextTrail;ready=true;confirm.disabled=false
        crumbs.replaceChildren(...trail.flatMap((node,index)=>[index?ui.icon('chevron',12):null,ui.button(node.name,{kind:'ghost',size:'sm',onClick:()=>go(trail.slice(0,index+1))})]).filter(Boolean))
        list.replaceChildren(...data.dirs.map(dir=>ui.button(dir.name,{kind:'ghost',icon:'folder',onClick:()=>go([...trail,{cid:String(dir.cid),name:dir.name}])})))
        if(!data.dirs.length)list.append(ui.empty('此目录没有子文件夹','folder'))
      }catch(error){if(request!==version)return;list.replaceChildren(ui.el('div',{class:'avo-notice danger',role:'alert'},ui.errorText(error)),ui.button('重新读取',{icon:'refresh',onClick:()=>go(nextTrail)}))}
    }
    dialog.body.append(ui.el('p',{class:'avo-hint'},'选择的目录仅用于当前 115 账号。'),ui.el('div',{class:'avo-browser'},crumbs,list))
    dialog.foot.append(ui.button('取消',{onClick:()=>dialog.close()}),confirm)
    go(trail)
  })
}

export function embyControls(ui,ctx,{instance='',library='',onInstance,onLibrary}) {
  let current=String(instance||'')
  const libraries=hostSelect(ui,{label:'Emby 媒体库',value:library,empty:'全部媒体库',load:async force=>{
    const data=await hostResource(ctx,`/api/plugin-host/emby/libraries${Number(current)>0?'?proxy_id='+encodeURIComponent(current):''}`,force)
    return(data.items||[]).map(item=>({value:item.id,label:item.name}))
  },onChange:onLibrary})
  const instances=hostSelect(ui,{label:'Emby 服务器',value:current,empty:'使用默认服务器',load:async force=>{
    const data=await hostResource(ctx,'/api/plugin-host/emby/instances',force)
    return(data.items||[]).map(item=>({value:String(item.id),label:item.name+(item.is_default?' · 默认':''),disabled:!item.api_key_configured}))
  },onChange:value=>{current=value;onInstance(value);libraries.clear();onLibrary('');libraries.refresh()}})
  return [ui.field('Emby 服务器',instances.root),ui.field('媒体库',libraries.root)]
}

export function aiControls(ui,ctx,{provider='',model='',onProvider,onModel}) {
  const path=`/api/extensions/v3/${ctx.id||'local.av-organizer'}/ai/providers`
  let current=provider
  const models=hostSelect(ui,{label:'AI 模型',value:model,empty:'使用提供商默认模型',load:async force=>{
    const data=await hostResource(ctx,path,force),selected=(data.providers||[]).find(p=>p.id===(current||data.default_provider_id))
    return [...new Set([selected?.model,...selected?.models||[]].filter(Boolean))].map(name=>({value:name,label:name}))
  },onChange:onModel})
  const providers=hostSelect(ui,{label:'AI 提供商',value:provider,empty:'使用整理默认提供商',load:async force=>(await hostResource(ctx,path,force)).providers?.map(p=>({value:p.id,label:p.name}))||[],onChange:value=>{current=value;onProvider(value);models.clear();onModel('');models.refresh()}})
  return [ui.field('AI 提供商',providers.root),ui.field('AI 模型',models.root)]
}
