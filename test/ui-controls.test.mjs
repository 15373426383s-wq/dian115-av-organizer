import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createUI} from '../ui/components.js'
import {createFileBrowser} from '../ui/file-browser.js'
import {hostSelect,hostResource,pick115Directory,embyControls,aiControls} from '../ui/host-controls.js'
import {renderSubscriptions} from '../ui/views/subscriptions.js'
import {sourceChoices,sourceRules} from '../ui/source-controls.js'

const {JSDOM}=createRequire(`${process.env.JSDOM_DIR||process.cwd()}/`)('jsdom')
const tick=()=>new Promise(resolve=>setTimeout(resolve,5))
function fixture(t){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://host.test',pretendToBeVisual:true})
  const root=dom.window.document.getElementById('root'),ui=createUI(root)
  t.after(()=>{ui.dispose();dom.window.close()})
  const event=(node,type,value)=>{if(value!==undefined)node.value=value;node.dispatchEvent(new dom.window.Event(type,{bubbles:true}))}
  const button=(scope,label)=>{const node=[...scope.querySelectorAll('button')].find(n=>n.textContent.trim()===label||n.title===label);assert.ok(node,`未找到按钮：${label}`);node.click();return node}
  return {dom,root,ui,event,button}
}

test('目录浏览按节点 ID 前进，长编号和包含斜线的名称保持完整',async t=>{
  const {root,ui,button}=fixture(t),calls=[],cid='9876543210987654321',name='中文 / A\\B'
  const ctx={api:{get:async path=>{calls.push(path);return {account:{mode:'backup',id:7},dirs:calls.length===1?[{cid,name}]:[]}}}}
  const promise=pick115Directory(ui,ctx,{mode:'backup',id:7})
  await tick();assert.equal(ui.doc.querySelector('.avo-crumbs').textContent,'根目录');button(ui.doc,name);await tick()
  assert.match(calls[1],new RegExp(`account_mode=backup&account_id=7&cid=${cid}$`))
  assert.equal(ui.doc.querySelectorAll('.avo-crumbs button').length,2)
  button(ui.doc,'保存到此目录')
  assert.deepEqual(await promise,{cid,name:`根目录 / ${name}`,account:{mode:'backup',id:7}})
  assert.equal(root.children.length,0)
})

test('115 目录读取失败或账号不符不能选中；关闭弹窗使晚到响应失效',async t=>{
  const {ui,button}=fixture(t)
  let resolve
  const ctx={api:{get:()=>new Promise(done=>{resolve=done})}}
  const promise=pick115Directory(ui,ctx,{mode:'main',id:1})
  const select=button(ui.doc,'保存到此目录');assert.equal(select.disabled,true)
  resolve({account:{mode:'main',id:2},dirs:[]});await tick()
  assert.match(ui.doc.body.textContent,/账号与选择不一致/);assert.equal(select.disabled,true)
  button(ui.doc,'重新读取');button(ui.doc,'取消');assert.equal(await promise,null)
  resolve({account:{mode:'main',id:1},dirs:[]});await tick()
  assert.equal(ui.doc.querySelector('.avo-overlay'),null)
})

test('宿主选择器失败保留旧值，刷新与依赖切换不被旧请求覆盖',async t=>{
  const {ui,root}=fixture(t),pending=[];let changed=false
  const control=hostSelect(ui,{label:'测试选择器',value:'saved',load:()=>new Promise(resolve=>pending.push(resolve)),onChange:()=>{changed=true}})
  root.append(control.root)
  const newer=control.refresh();pending[1]([{value:'saved',label:'已保存账号'}]);await newer
  pending[0]([{value:'old',label:'过期账号'}]);await control.ready
  assert.equal(control.select.value,'saved');assert.match(control.root.textContent,/已保存账号/);assert.doesNotMatch(control.root.textContent,/过期账号/)
  control.setValue('not-loaded');assert.equal(control.select.value,'not-loaded');assert.equal(changed,false)
  const failed=hostSelect(ui,{label:'失败',value:'existing',load:async()=>{throw new Error('暂时无法读取')}});root.append(failed.root);await failed.ready
  assert.equal(failed.select.value,'existing');assert.match(failed.root.textContent,/暂时无法读取/)
})

test('宿主资源请求共用缓存；错误后可重新读取',async()=>{
  let count=0,fail=true
  const ctx={api:{get:async()=>{count++;if(fail)throw new Error('offline');return {items:[]}}}}
  await assert.rejects(hostResource(ctx,'/resource'));fail=false
  await Promise.all([hostResource(ctx,'/resource'),hostResource(ctx,'/resource')]);assert.equal(count,2)
  await hostResource(ctx,'/resource',true);assert.equal(count,3)
})

test('本地/CD2 共用浏览器忽略慢响应，选择对应路径并保留文件复选状态',async t=>{
  const {ui,root,event,button}=fixture(t);let first
  const ctx={files:{call:()=>new Promise(resolve=>{first=resolve})},cd2:{call:async(method,args)=>{assert.equal(method,'list');assert.equal(args.path,'/');return [{name:'115 云盘',path:'/115 云盘',is_dir:true}]}}}
  const browser=createFileBrowser(ui,ctx,{initial:'/slow',multiple:true});root.append(browser.root)
  await browser.go('cd2:/');first([{name:'旧目录',is_dir:true}]);await browser.loaded
  assert.equal(browser.path,'cd2:/');assert.doesNotMatch(root.textContent,/旧目录/)
  const check=root.querySelector('input[type=checkbox]');check.checked=true;event(check,'change')
  assert.deepEqual(browser.selected,['cd2:/115 云盘']);assert.ok(root.querySelector('.avo-file-row.selected'))
  button(root,'清空选择');await tick();assert.deepEqual(browser.selected,[])
  browser.dispose()
})

test('切换 Emby 服务器清除媒体库；切换 AI 提供商清除模型，均使用目录选项',async t=>{
  const {ui,root,event}=fixture(t),calls=[],changes=[]
  const ctx={id:'local.av-organizer',api:{get:async path=>{
    calls.push(path)
    if(path.includes('/instances'))return {items:[{id:7,name:'影院',api_key_configured:true}]}
    if(path.includes('/libraries'))return {items:[{id:'library-a',name:'电影'}]}
    return {default_provider_id:'a',providers:[{id:'a',name:'提供商甲',model:'model-a'},{id:'b',name:'提供商乙',model:'model-b',models:['model-b','model-c']}]}
  }}}
  root.append(...embyControls(ui,ctx,{instance:'',library:'old',onInstance:v=>changes.push(['server',v]),onLibrary:v=>changes.push(['library',v])}),...aiControls(ui,ctx,{provider:'a',model:'model-a',onProvider:v=>changes.push(['provider',v]),onModel:v=>changes.push(['model',v])}))
  await tick();event(root.querySelector('[aria-label="Emby 服务器"]'),'change','7');event(root.querySelector('[aria-label="AI 提供商"]'),'change','b');await tick()
  assert.ok(calls.includes('/api/plugin-host/emby/libraries?proxy_id=7'))
  assert.deepEqual(changes,[['server','7'],['library',''],['provider','b'],['model','']])
  const model=root.querySelector('[aria-label="AI 模型"]');assert.deepEqual([...model.options].map(o=>o.value),['','model-b','model-c'])
})

test('订阅切换账号立即清空原目录，选目录后冻结具体账号，不需要手填 ID',async t=>{
  const {ui,root,event,button}=fixture(t),view={},store={subscriptions:{items:{},receipts:{}},subscriptionConfig:{account:{mode:'main',id:1},save_cid:'123',save_cid_name:'原目录'},runs:[]}
  const ctx={api:{get:async path=>{
    if(path.endsWith('/accounts/options'))return {accounts:[{mode:'main',id:1,name:'主账号'},{mode:'backup',id:2,name:'备用账号'}]}
    if(path.startsWith('/api/115/directories'))return {account:{mode:'backup',id:2},dirs:[]}
    return {data:[]}
  }}}
  root.append(renderSubscriptions(ui,store,ctx,{},view));await tick()
  event(root.querySelector('[aria-label="115 账号"]'),'change','backup:2')
  assert.equal(view.draft.save_cid,'');assert.equal(root.querySelector('[aria-label="115 保存目录"]').readOnly,true)
  button(root,'选择目录');await tick();button(ui.doc,'保存到此目录');await tick()
  assert.equal(view.draft.save_cid,'0');assert.deepEqual(view.draft.account,{mode:'backup',id:2});assert.equal(view.dirty,true)
})

test('资料来源选择、排序与字段规则可往返旧配置，不丢失暂不可用来源',async t=>{
  const {root,ui,event,button}=fixture(t),draft={};let saved
  root.append(sourceChoices(ui,draft,{value:['javbus','retired'],onChange:value=>{saved=value}}))
  assert.match(root.textContent,/retired（暂不可用）/)
  event(root.querySelector('select'),'change','javdb');assert.deepEqual(saved,['javbus','retired','javdb'])
  const last=root.querySelectorAll('.avo-choice-row')[2];button(last,'优先使用此来源');await tick();assert.deepEqual(saved,['javbus','javdb','retired'])
  root.replaceChildren(sourceRules(ui,draft,{value:{title:['javbus']},onChange:value=>{saved=value}}))
  button(root,'移除规则');await tick();assert.deepEqual(saved,{})
})

test('弹窗继承主题、限制焦点、关闭恢复焦点；销毁移除提示与弹窗',async t=>{
  const {root,ui,dom}=fixture(t),trigger=ui.button('打开');root.append(trigger);trigger.focus()
  ui.setTheme('dark');const d=ui.dialog('目录选择');d.foot.append(ui.button('确定'));await tick()
  const overlay=ui.doc.querySelector('.avo-overlay');assert.equal(overlay.dataset.theme,'dark');assert.equal(overlay.getAttribute('aria-label'),'目录选择')
  const buttons=overlay.querySelectorAll('button');buttons[buttons.length-1].focus();ui.doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(ui.doc.activeElement,buttons[0])
  ui.setTheme('light');assert.equal(overlay.dataset.theme,'light');d.close();assert.equal(ui.doc.activeElement,trigger)
  const control=ui.el('input');root.append(ui.field('路径',control));assert.equal(root.querySelector('label').htmlFor,control.id)
  ui.dialog('待关闭');ui.toast('测试提示');ui.dispose();assert.equal(ui.doc.querySelector('.avo-overlay,.avo-toasts'),null)
})

test('多目录目标、模式和 STRM 规则选择同步到配置；清除目标恢复继承',async t=>{
  const {renderAdvancedSettings}=await import('../ui/views/advanced-settings.js')
  const {ui,root,event,button}=fixture(t),draft={directories:[{id:'inbox-a',path:'/in',enabled:true,overrides:{local_target:'/old'}}]}
  const ctx={api:{get:async path=>path==='/api/rules'?[{id:8,name:'媒体规则'}]:path.endsWith('/ai/providers')?{providers:[]}:{items:[]}},files:{call:async()=>[{name:'新目录',path:'/chosen',is_dir:true}]}}
  const result=renderAdvancedSettings(ui,ctx,draft,(key,value)=>{draft[key]=value});root.append(...result.cards);await tick()
  const section=root.querySelector('[data-section="多目录与文件"]'),row=section.querySelector('.avo-card')
  const target=[...row.querySelectorAll('.avo-field')].find(n=>n.querySelector('label')?.textContent==='整理目标')
  button(target,'选择');await tick();button(ui.doc.querySelector('.avo-overlay'),'新目录');await tick();button(ui.doc,'选择此目录');await tick()
  const mode=[...row.querySelectorAll('.avo-field')].find(n=>n.querySelector('label')?.textContent==='存储模式').querySelector('select')
  event(mode,'change','strm');event(row.querySelector('[aria-label="本目录 STRM 规则"]'),'change','8')
  assert.deepEqual(draft.directories[0].overrides,{local_target:'/chosen',mode:'strm',strm_rule_id:8})
  assert.deepEqual(JSON.parse(row.querySelector('textarea').value),draft.directories[0].overrides)
  button(target,'清除目录选择');await tick();assert.equal(Object.hasOwn(draft.directories[0].overrides,'local_target'),false)
})
