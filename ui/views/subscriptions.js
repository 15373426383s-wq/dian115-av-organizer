import {accountControl, pick115Directory, hostSelect, hostResource} from '../host-controls.js'
import { formatTime } from '../components.js'
import { SUBSCRIPTION_CONFIG, SUBSCRIPTION_LABELS, subscriptionConfig, validateSubscriptionConfig, changeSubscriptions } from '../lib/subscriptions.js'

export function renderSubscriptions(ui, store, ctx, app, view) {
  const { el, button, field, switchInput } = ui
  const state = store.subscriptions || { items: {}, receipts: {} }
  const items = Object.values(state.items).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const draft = view.draft ||= subscriptionConfig(store.subscriptionConfig)
  let sourceText = view.sourceText ?? JSON.stringify(draft.sources, null, 2)
  const mark = () => { view.dirty = true }
  app.beforeLeave = async () => !view.dirty || await ui.confirm('放弃未保存的订阅设置？', '订阅查询源和搜索设置尚未保存。')
  const input = (key, label, type = 'text') => {
    const node = el('input', { class: 'avo-input', type, value: draft[key] ?? '', 'aria-label': label })
    node.addEventListener('input', () => { draft[key] = type === 'number' ? Number(node.value) : node.value.trim(); mark() })
    return field(label, node)
  }
  const run = async (payload = {}) => {
    if (view.dirty) throw new Error('请先保存订阅设置')
    // Keep the same key and input if the initial request loses its response.
    const signature = JSON.stringify(payload)
    view.requests ||= {}
    view.requests[signature] ||= `subscription-page:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const result = await ctx.tasks.run('subscriptions', view.requests[signature], payload)
    delete view.requests[signature]
    ui.toast('已提交订阅任务，请在任务队列查看进度', 'success')
    return result
  }
  const numberInput = el('textarea', { class: 'avo-textarea avo-number-input', rows: 1, 'aria-label': '添加订阅番号', value: view.text || '', placeholder: '输入番号，多个用空格分隔' })
  numberInput.addEventListener('input', () => { view.text = numberInput.value })
  const add = el('section', { class: 'avo-card avo-compose' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, '番号订阅'), button('立即搜索待订阅', { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => run({ force: true }) })),
    el('div', { class: 'avo-inline' }, numberInput,
      button('添加并搜索', { kind: 'primary', icon: 'plus', onClick: async () => {
        if (!numberInput.value.trim()) throw new Error('请输入番号')
        await run({ text: numberInput.value.trim(), manual: true }); view.text = ''; numberInput.value = ''
      } })),
    el('p', { class: 'avo-hint' }, '支持 av 消息；无资源时按周期继续搜索。'))

  const sourceArea = el('textarea', { class: 'avo-textarea avo-mono', rows: 12, value: sourceText, 'aria-label': '数据库查询源 JSON', spellcheck: false })
  sourceArea.addEventListener('input', () => { sourceText = sourceArea.value; view.sourceText = sourceText; mark() })
  const setOption = (key,value) => {draft[key]=value;mark()}
  const directory = el('input',{class:'avo-input',readOnly:true,'aria-label':'115 保存目录',value:draft.save_cid_name || (draft.save_cid ? '已保存目录' : ''),placeholder:'使用账号默认目录'})
  const account = accountControl(ui,ctx,draft.account,value=>{setOption('account',value);draft.save_cid='';draft.save_cid_name='';directory.value=''})
  const saveDirectory = field('115 保存目录',el('div',{class:'avo-inline'},directory,button('选择目录',{icon:'folder',onClick:async()=>{
    const selected=await pick115Directory(ui,ctx,draft.account)
    if(!selected)return
    draft.account=selected.account;account.setValue(`${selected.account.mode}:${selected.account.id||''}`)
    draft.save_cid=selected.cid;draft.save_cid_name=selected.name;directory.value=selected.name;mark()
  }}),button('',{kind:'ghost',icon:'close',title:'使用默认目录',onClick:()=>{draft.save_cid='';draft.save_cid_name='';directory.value='';mark()}})))
  const downloader = hostSelect(ui,{label:'下载器',value:draft.downloader,empty:'使用默认下载器',load:async force=>(await hostResource(ctx,'/api/pt/downloaders',force)).data?.map(d=>({value:d.name,label:d.name+(d.is_default?' · 默认':'')}))||[],onChange:value=>setOption('downloader',value)})
  const siteOptions = el('div', { class: 'avo-toggle-grid' })
  async function loadSites(force=false){
    siteOptions.replaceChildren(el('span',{class:'avo-hint'},'正在读取站点…'))
    try{
      const sites=await hostResource(ctx,'/api/pt/sites',force)
      const matches=(sites.data||[]).filter(site=>site.enabled!==false && (/mteam|mtorrent/i.test(site.parser_type||'')||/m-team\./i.test(site.url||'')))
      siteOptions.replaceChildren(...matches.map(site=>switchInput(site.name,draft.mteam_site_ids.includes(site.id),checked=>setOption('mteam_site_ids',checked?[...new Set([...draft.mteam_site_ids,site.id])]:draft.mteam_site_ids.filter(id=>id!==site.id)))))
      const missing=draft.mteam_site_ids.filter(id=>!matches.some(site=>site.id===id))
      if(missing.length)siteOptions.append(el('span',{class:'avo-hint'},'部分已保存站点暂不可用'),button('移除不可用选择',{kind:'ghost',onClick:()=>{setOption('mteam_site_ids',draft.mteam_site_ids.filter(id=>!missing.includes(id)));loadSites()}}))
      if(!matches.length)siteOptions.append(el('span',{class:'avo-hint'},'请先在主程序添加并启用馒头站点'))
    }catch(error){siteOptions.replaceChildren(el('div',{class:'avo-notice danger'},ui.errorText(error)))}
  }
  loadSites()
  const configError = el('div', { class: 'avo-notice danger', role: 'alert', hidden: true })
  const settings = el('details', { class: 'avo-card avo-sub-settings', open: Boolean(view.configOpen) },
    el('summary', {}, ui.icon('settings'), el('span', {}, '订阅设置与查询源'),
      el('span', { class: 'avo-hint' }, `${draft.cache_enabled ? '缓存已启用' : '缓存未启用'} · 每 ${draft.interval_minutes} 分钟`)),
    el('div', { class: 'avo-stack', style: { marginTop: '16px' } },
      switchInput('启用自动搜索和自动提交', draft.enabled, value => { draft.enabled = value; mark() }),
      switchInput('搜索宿主磁力 / ED2K 缓存并提交 115', draft.cache_enabled, value => { draft.cache_enabled = value; mark() }),
      el('div', { class: 'avo-fields' }, input('interval_minutes', '搜索间隔（分钟）', 'number'), input('concurrency', '并发番号数（1–8）', 'number'),
        field('115 账号',account.root),saveDirectory,field('下载器',downloader.root)),
      el('p', { class: 'avo-hint' }, '保存设置后自动任务每分钟检查一次到期订阅。暂停自动搜索仍会接收并保存 av 消息中的番号。'),
      el('p', { class: 'avo-hint' }, '每个番号的缓存源、馒头站点各自保存时间基线。首次查询历史匹配资源，之后只查增量；空结果也更新基线，失败或未翻完页时保留进度。'),
      el('details', { class: 'avo-advanced-field' }, el('summary', {}, '外部数据库查询源', el('span', { class: 'avo-hint' }, `${draft.sources.length} 个来源`)),
      field('外部数据库查询源（JSON 数组）', sourceArea, '通过 HTTP/JSON 接口连接数据库，支持多个来源并发查询。'),
      button('添加查询源示例', { onClick: () => {
        const sources = JSON.parse(sourceArea.value || '[]')
        if (!Array.isArray(sources)) throw new Error('请填写 JSON 数组')
        sources.push({ id: `database-${sources.length + 1}`, name: '种子数据库', enabled: true,
          url: 'https://database.example/search?number={number}&since={since}&until={until}&cursor={cursor}&limit={limit}',
          incremental: true, method: 'GET', headers: {}, results_path: 'items', complete_path: 'complete', cursor_path: 'next_cursor', target: '115',
          fields: { number: 'number', title: 'title', magnet: 'magnet', ed2k: 'ed2k', download_url: 'torrent_url', info_hash: 'info_hash' } })
        sourceArea.value = JSON.stringify(sources, null, 2); sourceText = sourceArea.value; view.sourceText = sourceText; mark()
      } })),
      switchInput('搜索馒头并提交下载器', draft.mteam_enabled, value => { draft.mteam_enabled = value; mark() }),
      field('馒头站点',siteOptions),button('刷新站点和下载器',{icon:'refresh',kind:'ghost',onClick:()=>Promise.all([loadSites(true),downloader.refresh(true)])}),configError,
      button('保存订阅设置', { kind: 'primary', icon: 'check', onClick: async () => {
        try {
          const parsed = JSON.parse(sourceArea.value || '[]')
          if (!Array.isArray(parsed)) throw new Error('查询源必须是 JSON 数组')
          if (draft.mteam_site_ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('站点 ID 必须为正整数')
          const config = validateSubscriptionConfig(subscriptionConfig({ ...draft, sources: parsed }))
          await ctx.storage.set(SUBSCRIPTION_CONFIG, config)
          store.subscriptionConfig = config; view.draft = config; view.dirty = false; view.sourceText = JSON.stringify(config.sources, null, 2)
          configError.hidden = true; ui.toast('订阅设置已保存', 'success')
          await app.render()
        } catch (error) { configError.textContent = error.message; configError.hidden = false }
      } })))
  settings.addEventListener('toggle', () => { view.configOpen = settings.open })

  const controls = async (number, action) => {
    await changeSubscriptions(ctx, current => {
      const item = current.items[number]
      if (!item) return
      if (action === 'pause') item.enabled = false
      if (action === 'resume') { item.enabled = true; if (item.status === 'waiting') item.next_at = new Date().toISOString() }
      if (action === 'reopen' && item.status === 'submitted' && !item.lease) { item.enabled = true; item.status = 'waiting'; item.continue_search = true; item.next_at = new Date().toISOString() }
    })
    await app.refresh()
  }
  const renderRow = item => {
    const receipt = state.receipts[item.receipt_key]
    const pauseButton = button(item.enabled ? '暂停' : '恢复', { size: 'sm', kind: 'ghost',
      onClick: () => controls(item.number, item.enabled ? 'pause' : 'resume'),
    })
    const actions = el('div', { class: 'avo-row' })
    if (item.lease) actions.append(button('核对关联任务', { onClick: async () => {
      const task = await ctx.tasks.get(item.lease)
      if (['running', 'queued'].includes(task.status)) {
        ui.toast('任务仍在运行，请等待或在宿主任务队列取消后核对'); return
      }
      if (!['failed', 'cancelled', 'attention_required'].includes(task.status)) throw new Error('任务状态与订阅不一致，请检查宿主任务记录')
      await ctx.tasks.retry(item.lease)
      ui.toast('已提交核对任务', 'success')
    } }))
    if (item.status === 'submitted') actions.append(button('继续寻找其他资源', { onClick: () => controls(item.number, 'reopen') }))
    if (!item.lease && !['attention', 'submitting'].includes(item.status)) actions.append(button('取消订阅', { onClick: async () => {
      if (!await ui.confirm('取消订阅', `取消 ${item.number} 的订阅？已提交给 115 或下载器的任务会保留。`)) return
      await changeSubscriptions(ctx, current => {
        const currentItem = current.items[item.number]
        if (currentItem?.lease || ['attention', 'submitting'].includes(currentItem?.status)) throw new Error('订阅正在运行或需要核对，请先暂停并处理当前任务')
        delete current.items[item.number]
      })
      await app.refresh()
    } }))
    if (item.status === 'attention' && receipt?.status === 'attention' && !item.lease) {
      for (const confirmed of [true, false]) actions.append(button(confirmed ? '确认已提交' : '确认未提交，重试', { onClick: async () => {
        const accepted = await ui.confirm(confirmed ? '记录已提交结果？' : '允许重新提交？', confirmed
          ? '请先在 115 或下载器确认该种子已经接收。'
          : '只有确认 115 或下载器没有接收该种子，才能重试；否则可能重复下载。')
        if (!accepted) return
        await changeSubscriptions(ctx, current => {
          const currentReceipt = current.receipts[item.receipt_key]
          if (currentReceipt?.status !== 'attention') throw new Error('该结果已变化，请刷新后重试')
          currentReceipt.status = confirmed ? 'submitted' : 'retry_allowed'
          currentReceipt.checked_at = new Date().toISOString()
          for (const affected of Object.values(current.items).filter(i => i.receipt_key === item.receipt_key)) {
            if (affected.lease) throw new Error('该种子仍在运行，请先在任务队列核对任务')
            Object.assign(affected, { status: confirmed ? 'submitted' : 'waiting', next_at: new Date().toISOString(), note: '已人工核对' })
          }
        })
        await app.refresh()
      } }))
    }
    view.expanded ||= {}
    const detail = el('div', { class: 'avo-sub-detail', hidden: !view.expanded[item.number] },
      el('p', { class: 'avo-hint' }, `检查 ${item.attempts || 0} 次 · 上次 ${formatTime(item.last_search_at) || '尚未搜索'}`),
      item.note ? el('p', {}, item.note) : null,
      ...(Object.values(item.source_state || {})).map(source => el('p', { class: 'avo-hint' },
        `${source.name} · ${source.mode === 'full' ? '传统接口，尚未启用增量' : `基线 ${formatTime(source.baseline_at) || '首次扫描中'}${source.window ? ' · 分页续读中' : ''}`} · 最近检查 ${formatTime(source.checked_at) || '尚未检查'}`)),
      item.pending_candidates?.length ? el('p', { class: 'avo-hint' }, `已保存 ${item.pending_candidates.length} 个候选资源，继续订阅时处理`) : null,
      receipt ? el('p', { class: 'avo-hint' }, `${receipt.candidate.source_name} → ${receipt.candidate.target === '115' ? '115' : receipt.result?.downloader || receipt.downloader || '默认下载器'} · ${receipt.candidate.title}`) : null,
      ...(item.errors || []).map(error => el('div', { class: 'avo-notice warning' }, error)),
      item.status === 'submitted' ? el('p', { class: 'avo-hint' }, '115 或下载器已接收，下载进度请前往对应任务查看。') : null, actions)
    const expand = button('详情', { kind: 'ghost', size: 'sm', icon: 'chevron', onClick: () => {
      detail.hidden = !detail.hidden; view.expanded[item.number] = !detail.hidden
      expand.setAttribute('aria-expanded', String(!detail.hidden))
    } })
    expand.setAttribute('aria-expanded', String(!detail.hidden))
    const sources = Object.values(item.source_state || {})
    const tone = !item.enabled ? '' : item.status === 'submitted' ? 'success' : item.status === 'attention' ? 'warning' : ['searching', 'submitting'].includes(item.status) ? 'running' : ''
    return el('article', { class: 'avo-sub-record' }, el('div', { class: 'avo-sub-line' },
      el('div', { class: 'avo-sub-identity' }, el('strong', { class: 'avo-number' }, item.number),
        el('span', { class: 'avo-hint' }, sources.length ? sources.map(s => s.name).join(' · ') : '等待首次搜索')),
      el('span', { class: `avo-pill ${tone}` }, item.enabled ? SUBSCRIPTION_LABELS[item.status] || item.status : '已暂停'),
      el('div', { class: 'avo-sub-time' },
        el('span', { class: 'avo-hint' }, item.status === 'submitted' ? '提交时间' : item.status === 'attention' ? '处理方式' : '下次检查'),
        el('span', {}, !item.enabled ? '已暂停' : item.status === 'attention' ? '等待人工核对' : formatTime(item.status === 'submitted' ? item.submitted_at : item.next_at) || '等待调度')),
      el('div', { class: 'avo-row avo-sub-actions' }, item.errors?.length ? el('span', { class: 'avo-hint avo-warning', title: '展开详情查看查询错误' }, `${item.errors.length} 个异常`) : null, pauseButton, expand)), detail)
  }
  const list = el('div', { class: 'avo-sub-list' })
  const pager = el('div', { class: 'avo-pager' })
  const filters = el('div', { class: 'avo-filters', 'aria-label': '订阅状态' })
  const query = el('input', { class: 'avo-input avo-sub-search', placeholder: '搜索番号', 'aria-label': '搜索订阅', value: view.query || '' })
  const options = [['', '全部'], ['waiting', '进行中'], ['submitted', '已提交'], ['attention', '待核对'], ['paused', '已暂停']]
  const matches = (item, key) => !key || (key === 'paused' ? !item.enabled : item.enabled && (key === 'waiting' ? ['waiting', 'searching', 'submitting'].includes(item.status) : item.status === key))
  const draw = () => {
    filters.replaceChildren(...options.map(([key, label]) => {
      const node = button(label, { kind: view.filter === key || !view.filter && !key ? 'selected' : 'ghost', size: 'sm', onClick: () => { view.filter = key; view.page = 0; draw() } })
      node.setAttribute('aria-pressed', String((view.filter || '') === key))
      node.append(el('span', { class: 'avo-filter-count' }, String(items.filter(item => matches(item, key)).length)))
      return node
    }))
    const found = items.filter(item => matches(item, view.filter) && item.number.toLowerCase().includes((view.query || '').trim().toLowerCase()))
    const pages = Math.max(1, Math.ceil(found.length / 30)); view.page = Math.min(view.page || 0, pages - 1)
    list.replaceChildren(...(found.length ? found.slice(view.page * 30, (view.page + 1) * 30).map(renderRow) : [ui.empty(items.length ? '没有匹配的订阅' : '添加一个番号，开始自动查找资源', 'search')]))
    pager.hidden = pages <= 1
    pager.replaceChildren(button('上一页', { size: 'sm', disabled: !view.page, onClick: () => { view.page--; draw() } }), el('span', {}, `${view.page + 1} / ${pages}`), button('下一页', { size: 'sm', disabled: view.page === pages - 1, onClick: () => { view.page++; draw() } }))
  }
  query.addEventListener('input', () => { view.query = query.value; view.page = 0; draw() })
  draw()
  const interrupted = store.runs.filter(run => run.job_id === 'subscriptions' && ['attention_required', 'failed', 'cancelled'].includes(run.status))
  return el('div', { class: 'avo-stack avo-subscriptions' }, add, settings,
    ...interrupted.map(run => el('div', { class: 'avo-notice warning' }, '订阅任务有中断记录。', button('核对并继续', {
      onClick: async () => { await ctx.tasks.retry(run.id); ui.toast('已提交核对任务', 'success') },
    }))), el('section', { class: 'avo-card avo-sub-results' }, el('div', { class: 'avo-sub-toolbar' }, filters, query), list, pager))
}
