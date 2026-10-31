// 本地/CD2 共用浏览器；115 原生目录由节点选择器处理，不拼接远端名称。
export function normalizePath(value = '/') {
  const cloud = String(value).startsWith('cd2:')
  const parts = []
  for (const p of String(value).replace(/^cd2:/, '').split('/')) {
    if (!p || p === '.') continue
    p === '..' ? parts.pop() : parts.push(p)
  }
  return (cloud ? 'cd2:' : '') + '/' + parts.join('/')
}
export function parentPath(value) {
  const path = normalizePath(value), slash = path.lastIndexOf('/')
  return slash <= (path.startsWith('cd2:') ? 4 : 0) ? (path.startsWith('cd2:') ? 'cd2:/' : '/') : path.slice(0, slash)
}
export function filePath(parent, item) {
  const cloud = parent.startsWith('cd2:')
  if (item.path) return normalizePath((cloud && !String(item.path).startsWith('cd2:') ? 'cd2:' : '') + item.path)
  return normalizePath(parent + '/' + item.name)
}

export function createFileBrowser(ui, ctx, options = {}) {
  const {el, button, icon} = ui
  let current = normalizePath(options.initial || '/'), rows = [], sequence = 0, ready = false
  if (options.only === 'local' && current.startsWith('cd2:')) current = '/'
  if (options.only === 'cd2' && !current.startsWith('cd2:')) current = 'cd2:/'
  const selected = new Map()
  const status = el('span', {class: 'avo-hint', role: 'status'})
  const crumbs = el('nav', {class: 'avo-crumbs', 'aria-label': '当前目录'})
  const list = el('div', {class: 'avo-file-list'})
  const filter = el('input', {class: 'avo-input', type: 'search', placeholder: '筛选当前目录', 'aria-label': '筛选当前目录'})
  const sort = el('select', {class: 'avo-select', 'aria-label': '文件排序'}, ...[['name','按名称'],['modified','按修改时间'],['size','按文件大小']].map(([value,label])=>el('option',{value},label)))
  const mode = el('select', {class: 'avo-select', 'aria-label': '存储位置'}, ...[['local','本地文件'],['cd2','CD2 云盘']].filter(([key])=>!options.only||key===options.only).map(([value,label])=>el('option',{value},label)))
  mode.value = current.startsWith('cd2:') ? 'cd2' : 'local'
  const notify = () => {
    status.textContent = `${rows.length} 项${selected.size ? ` · 已选 ${selected.size} 项` : ''}`
    options.onSelection?.([...selected.keys()])
  }
  function draw() {
    const shown = rows.filter(r=>(r.name || '').toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())).sort((a,b)=>Number(b.is_dir)-Number(a.is_dir)||(sort.value==='size'?Number(b.size||0)-Number(a.size||0):sort.value==='modified'?String(b.modified||'').localeCompare(String(a.modified||'')):String(a.name).localeCompare(String(b.name),'zh-CN',{numeric:true})))
    list.replaceChildren(...shown.map(item=>{
      const path = filePath(current,item)
      const check = options.multiple ? el('input',{type:'checkbox',checked:selected.has(path),'aria-label':`选择 ${item.name}`,onchange:event=>{event.target.checked?selected.set(path,item):selected.delete(path);event.target.closest('.avo-file-row').classList.toggle('selected',event.target.checked);notify()}}) : null
      const open = button(item.name,{kind:'ghost',icon:item.is_dir?'folder':'file',onClick:()=>item.is_dir?go(path):options.onFile?.(path,item)})
      return el('div',{class:`avo-file-row${selected.has(path)?' selected':''}`},check,open,
        el('span',{class:'avo-file-size'},item.is_dir?'文件夹':ui.formatSize(item.size)),el('span',{class:'avo-file-date'},ui.formatTime(item.modified)))
    }))
    if (!shown.length) list.append(ui.empty(filter.value ? '没有匹配的文件' : options.directoriesOnly ? '此目录没有子文件夹' : '此目录为空','folder'))
    notify()
  }
  async function go(path) {
    const request = ++sequence
    ready = false; rows = []; selected.clear(); options.onSelection?.([]); options.onReady?.(false)
    filter.disabled = true; sort.disabled = true
    const next = normalizePath(path), cloud = next.startsWith('cd2:'), raw = cloud ? next.slice(4) : next
    filter.value = ''; status.textContent = '正在读取…'
    list.replaceChildren(el('div',{class:'avo-skeleton',style:{height:'120px'}}))
    try {
      const data = cloud ? await ctx.cd2.call('list',{path:raw,force_refresh:false}) : await ctx.files.call({operation:'list',path:raw})
      if (request !== sequence || ctx.signal?.aborted) return
      if (!Array.isArray(data)) throw new Error('目录返回格式不正确，请刷新重试')
      current = next; mode.value = cloud?'cd2':'local'; rows = data.filter(item=>!options.directoriesOnly||item.is_dir)
      const parts=raw.split('/').filter(Boolean),root=cloud?'cd2:/':'/'
      crumbs.replaceChildren(button(cloud?'云盘根目录':'本地根目录',{kind:'ghost',size:'sm',onClick:()=>go(root)}),...parts.flatMap((part,index)=>[icon('chevron',12),button(part,{kind:'ghost',size:'sm',onClick:()=>go(root+parts.slice(0,index+1).join('/'))})]))
      ready = true; filter.disabled = false; sort.disabled = false; draw(); options.onPath?.(current); options.onReady?.(true)
    } catch(error) {
      if (request !== sequence || ctx.signal?.aborted) return
      rows = []; status.textContent = '读取失败'
      list.replaceChildren(el('div',{class:'avo-notice danger',role:'alert'},ui.errorText(error)),button('重新读取',{icon:'refresh',onClick:()=>go(next)}))
    }
  }
  filter.addEventListener('input',draw);sort.addEventListener('change',draw)
  mode.addEventListener('change',()=>go(mode.value==='cd2'?'cd2:/':'/'))
  const actions = el('div',{class:'avo-row'},button('上一级',{icon:'up',kind:'ghost',onClick:()=>go(parentPath(current))}),button('刷新目录',{icon:'refresh',kind:'ghost',onClick:()=>go(current)}))
  if (options.multiple) actions.append(button('全选当前结果',{kind:'ghost',onClick:()=>{for(const item of rows.filter(r=>(r.name||'').toLowerCase().includes(filter.value.toLowerCase())))selected.set(filePath(current,item),item);draw()}}),button('清空选择',{kind:'ghost',onClick:()=>{selected.clear();draw()}}))
  if (options.createDirectory !== false) actions.append(button('新建文件夹',{icon:'plus',kind:'ghost',onClick:async()=>{
    if (!ready) throw new Error('请先打开一个可读取的目录')
    const name = await ui.prompt('新建文件夹','文件夹名称')
    if (!name) return
    if (name==='.'||name==='..'||/[\\/]/.test(name)) throw new Error('请使用有效的文件夹名称')
    current.startsWith('cd2:') ? await ctx.cd2.call('mkdir',{parent:current.slice(4),name}) : await ctx.files.call({operation:'mkdir',path:filePath(current,{name})})
    await go(current)
  }}))
  const root=el('div',{class:'avo-browser'},el('div',{class:'avo-browser-toolbar'},mode,filter,sort),crumbs,el('div',{class:'avo-browser-actions'},actions,status),list)
  const loaded = go(current)
  return {root,loaded,go,get path(){return current},get ready(){return ready},get selected(){return [...selected.keys()]},dispose(){sequence++}}
}
