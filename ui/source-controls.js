import {sourcePlan} from './lib/registry.js'

export const SOURCE_FIELDS={title:'标题',plot:'简介',actors:'演员',genres:'类型',cover:'封面',poster:'海报',samples:'剧照',release_date:'发行日期',runtime:'时长',studio:'制作商',label:'发行商',series:'系列',director:'导演',actor_photos:'演员头像',trailer:'预告片'}
export const NUMBER_KINDS={standard:'有码',prefixed:'素人',fc2:'FC2',carib:'加勒比',pondo:'一本道系',musume:'10musume',heyzo:'HEYZO',tokyohot:'Tokyo-Hot',heydouga:'HEYDOUGA'}

// 刮削顺序、模糊搜索与字段规则共用同一选源/排序控件。
export function sourceChoices(ui,draft,{value=[],onChange,searchOnly=false,ordered=true}) {
  let values=[...value]
  const root=ui.el('div',{class:'avo-stack avo-source-choices'})
  function draw(){
    const plan=sourcePlan(draft).filter(item=>!searchOnly||item.def.search)
    const select=ui.el('select',{class:'avo-select','aria-label':'添加资料来源'})
    const fill=()=>{select.replaceChildren(ui.el('option',{value:''},'选择资料来源…'),...plan.filter(item=>!values.includes(item.def.id)).map(item=>ui.el('option',{value:item.def.id},item.def.name+(item.enabled?'':' · 未启用'))))}
    fill()
    // 自定义来源可以在同一设置页新增，打开选单时重新读取草稿。
    select.addEventListener('focus',()=>{plan.splice(0,plan.length,...sourcePlan(draft).filter(item=>!searchOnly||item.def.search));fill()})
    const change=next=>{values=next;onChange([...next]);draw()}
    select.addEventListener('change',()=>{if(select.value)change([...values,select.value])})
    root.replaceChildren(...values.map((id,index)=>ui.el('div',{class:'avo-row between avo-choice-row'},ui.el('span',{},ordered?`${index+1}. `:'',plan.find(item=>item.def.id===id)?.def.name||`${id}（暂不可用）`),ui.el('div',{class:'avo-row'},
      ordered?ui.button('',{kind:'ghost',size:'sm',icon:'up',title:'优先使用此来源',disabled:index===0,onClick:()=>{const next=[...values];[next[index-1],next[index]]=[next[index],next[index-1]];change(next)}}):null,
      ui.button('',{kind:'ghost',size:'sm',icon:'close',title:'移除此来源',onClick:()=>change(values.filter((_,i)=>i!==index))})))),select)
  }
  draw();return root
}

export function sourceRules(ui,draft,{value={},keys=SOURCE_FIELDS,onChange,ordered=true}) {
  let rules=structuredClone(value)
  const root=ui.el('div',{class:'avo-stack'})
  function draw(){
    const add=ui.el('select',{class:'avo-select','aria-label':'添加来源规则'},ui.el('option',{value:''},'添加规则…'),...Object.entries(keys).filter(([key])=>!Object.hasOwn(rules,key)).map(([value,label])=>ui.el('option',{value},label)))
    add.addEventListener('change',()=>{if(add.value){rules[add.value]=[];onChange(structuredClone(rules));draw()}})
    root.replaceChildren(...Object.entries(rules).map(([key,value])=>ui.el('div',{class:'avo-rule-group'},
      ui.el('div',{class:'avo-row between'},ui.el('b',{},keys[key]||key),ui.button('移除规则',{kind:'ghost',size:'sm',onClick:()=>{delete rules[key];onChange(structuredClone(rules));draw()}})),
      sourceChoices(ui,draft,{value,ordered,onChange:value=>{rules[key]=value;onChange(structuredClone(rules))}}))),add)
  }
  draw();return root
}
