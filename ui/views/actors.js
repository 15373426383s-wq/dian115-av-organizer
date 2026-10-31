import {formatTime} from '../components.js'

const STATUS={success:['已同步','success'],submitted:['已请求刷新','info'],failed:['同步失败','danger'],pending:['处理中','warning']}

export function renderActors(ui,store,ctx,app,state={}) {
  const {el,button}=ui
  let records=[]
  const list=el('div'),status=el('span',{class:'avo-hint',role:'status'}),summary=el('div',{class:'avo-stats avo-actor-stats'})
  const query=el('input',{class:'avo-input',type:'search',placeholder:'搜索演员、简介或错误','aria-label':'搜索演员',value:state.query||''})
  const filter=el('select',{class:'avo-select','aria-label':'演员同步状态'},el('option',{value:''},'全部状态'),...Object.entries(STATUS).map(([value,[label]])=>el('option',{value},label)))
  filter.value=state.filter||''
  function draw(){
    const rows=records.filter(item=>(!filter.value||item.status===filter.value)&&`${item.name} ${item.overview||''} ${item.error||''}`.toLowerCase().includes(query.value.toLowerCase()))
    summary.replaceChildren(...[['success','已同步'],['submitted','等待 Emby 刷新'],['failed','同步失败']].map(([key,label])=>el('div',{class:'avo-stat'},el('span',{class:'label'},label),el('strong',{class:'value'},records.filter(item=>item.status===key).length))))
    status.textContent=`显示 ${rows.length} 条，共 ${records.length} 条记录`
    list.replaceChildren(...(rows.length?rows.map(item=>{
      const [label,tone]=STATUS[item.status]||['未知状态','']
      const avatar=item.image?el('img',{class:'avo-actor-avatar',src:ctx.files.downloadURL(item.image,{inline:true}),alt:item.name,loading:'lazy',onerror:event=>event.target.replaceWith(el('div',{class:'avo-actor-avatar'},ui.icon('user')))}):el('div',{class:'avo-actor-avatar'},ui.icon('user'))
      return el('article',{class:'avo-actor-row'},avatar,el('div',{class:'avo-actor-main'},el('b',{},item.name),el('span',{class:'avo-actor-summary',title:item.error||item.overview},item.error||item.overview||(item.image?'头像已更新':'演员资料处理完成'))),el('div',{class:'avo-actor-status'},el('span',{class:`avo-pill ${tone}`},label),el('time',{class:'avo-hint',dateTime:item.at},formatTime(item.at))))
    }):[ui.empty(records.length?'没有匹配的同步记录':'还没有同步记录。配置资料来源后即可开始同步。','users')]))
  }
  const refresh=async()=>{records=await ctx.storage.get('actors_history')||[];if(!ctx.signal?.aborted)draw()}
  query.addEventListener('input',()=>{state.query=query.value;draw()});filter.addEventListener('change',()=>{state.filter=filter.value;draw()})
  const root=el('div',{class:'avo-stack'},summary,el('section',{class:'avo-card avo-stack'},
    el('div',{class:'avo-card-head'},el('div',{},el('h2',{},'同步记录'),el('p',{class:'avo-hint'},store.settings.actors_enabled?'每小时自动同步一页，每页最多 50 位演员':'自动同步已关闭，可手动同步下一页')),
      el('div',{class:'avo-row'},button('刷新记录',{kind:'ghost',icon:'refresh',onClick:refresh}),button('同步下一页',{kind:'primary',icon:'refresh',onClick:async()=>{await ctx.tasks.run('actors',`actors:${Date.now()}`,{manual:true});ui.toast('已提交演员同步任务，完成后刷新记录查看结果','success')}}))),
    el('div',{class:'avo-toolbar'},query,filter,status),list))
  refresh().catch(error=>{list.replaceChildren(el('div',{class:'avo-notice danger',role:'alert'},ui.errorText(error)),button('重新读取',{onClick:refresh}))})
  return root
}
