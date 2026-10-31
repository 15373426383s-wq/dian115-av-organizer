// 番号整理插件页面：概览、整理记录、待处理、识别测试、设置。
import { STYLE } from './styles.js'
import { createUI, errorText, formatTime } from './components.js'
import { createStore } from './data.js'
import { LOGO_SVG, VERSION } from './brand.js'
import { renderOverview } from './views/overview.js'
import { renderHistory } from './views/history.js'
import { renderPending } from './views/pending.js'
import { renderProbe } from './views/probe.js'
import { renderSettings } from './views/settings.js'
import { renderSubscriptions } from './views/subscriptions.js'
import { renderFiles } from './views/files.js'
import { renderActors } from './views/actors.js'

const TABS = [
  ['overview', '概览', 'home'],
  ['history', '整理记录', 'list'],
  ['pending', '待处理', 'alert'],
  ['probe', '识别测试', 'search'],
  ['subscriptions', '番号订阅', 'clock'],
  ['files', '文件管理', 'folder'],
  ['actors', '演员资料', 'users'],
  ['settings', '设置', 'settings'],
]

export async function mount(root, ctx) {
  const ui = createUI(root)
  const { el, icon } = ui
  const store = createStore(ctx)
  const viewState = Object.fromEntries(TABS.map(([key])=>[key,{}]))
  let disposed = false
  let current = 'overview'
  let lastSignature = ''
  const dataSignature = () => [store.history.length, store.history[0]?.id, store.history[0]?.rescraped_at, Object.keys(store.pending).join('|'),
    Object.values(store.pending).map(item => item.at).join('|'), [...store.ignored].join('|'), store.lastRun?.at,
    store.runs[0]?.id, store.runs[0]?.status, Math.round(store.runs[0]?.progress || 0), store.watch?.path, store.watch?.error,
    JSON.stringify(store.subscriptions)].join('#')

  const style = el('style', {}, STYLE)
  const subtitle = el('div', { class: 'avo-sub' }, '按番号识别、刮削与整理')
  const statusPill = el('span', { class: 'avo-pill' })
  const logo = el('div', { class: 'avo-logo' })
  logo.innerHTML = LOGO_SVG
  const runButton = ui.button('立即整理', { kind: 'primary', icon: 'play', onClick: async () => {
    const run = await store.runOrganize({})
    ui.toast(`已提交整理任务，可在任务队列查看进度（${run.id.slice(0, 8)}）`, 'success')
    await app.refresh(false, true)
  } })
  const header = el('div', { class: 'avo-header' },
    el('div', { class: 'avo-title' }, logo, el('div', { class: 'avo-title-text' }, el('div', { class: 'avo-title-line' }, el('h1', {}, '番号整理'), statusPill, el('span', { class: 'avo-chip', title: 'swgzy 维护版，基于 1.3.0' }, 'v' + VERSION)), subtitle)),
    el('div', { class: 'avo-row avo-header-actions' }, ui.button('刷新', { icon: 'refresh', onClick: () => app.refresh(true) }), runButton))
  const tabs = el('nav', { class: 'avo-tabs', role: 'tablist', 'aria-label':'功能导航' })
  const content = el('div', { class: 'avo-content', role: 'tabpanel', id: 'avo-panel' })
  const pageTitle=el('h2',{class:'avo-page-title'}),pageDescription=el('p',{class:'avo-hint'})
  const pageHead=el('div',{class:'avo-page-heading'},el('div',{},pageTitle,pageDescription))
  const wrapper = el('div', { class: 'avo avo-app' }, style, header,el('div',{class:'avo-shell'},el('aside',{class:'avo-sidebar'},el('span',{class:'avo-nav-label'},'工作空间'),tabs),el('main',{class:'avo-main'},pageHead,content)))
  root.append(wrapper)
  const setTheme=mode=>{wrapper.dataset.theme=mode;ui.setTheme?.(mode)}
  setTheme(ctx.theme?.mode||'light')
  const unsubscribeTheme=ctx.theme?.subscribe?.(setTheme)

  const app = {
    beforeLeave: null,
    async go(tab) {
      if (tab === current) return
      if (app.beforeLeave && !(await app.beforeLeave())) return
      app.beforeLeave = null
      current = tab
      app.render()
    },
    async refresh(announce = false, auto = false) {
      try {
        await Promise.all([store.loadSettings(), store.loadState()])
        const signature = dataSignature()
        const editing = content.contains(ui.doc.activeElement) && /INPUT|TEXTAREA|SELECT/.test(ui.doc.activeElement?.tagName || '')
        // 自动刷新只在数据变化、且没有在输入时重绘；设置页和识别测试页从不自动重绘。
        const redraw = !auto || (signature !== lastSignature && !editing && !viewState.subscriptions.dirty && !['settings', 'probe', 'files', 'actors'].includes(current))
        lastSignature = signature
        if (redraw && current !== 'settings') await app.render()
        else drawTabs()
        drawSubtitle()
        if (announce) ui.toast('已刷新', 'success', 1500)
      } catch (error) {
        ui.toast(errorText(error), 'error')
      }
    },
    async render() {
      if (disposed) return
      drawTabs()
      pageTitle.textContent=TABS.find(([key])=>key===current)?.[1]||''
      pageDescription.textContent={overview:'当前整理进度与资料库动态',history:'查看已整理作品、图片与处理详情',pending:'集中处理识别失败与需要确认的文件',probe:'验证文件名识别与资料来源',subscriptions:'保存番号，持续寻找新资源',files:'浏览文件，选择后创建整理任务',actors:'为媒体库补充演员简介与头像',settings:'按需配置整理、资料和自动化规则'}[current]
      const renderers = { overview: renderOverview, history: renderHistory, pending: renderPending, probe: renderProbe, settings: renderSettings, subscriptions: renderSubscriptions, files: renderFiles, actors: renderActors }
      try {
        content.replaceChildren(renderers[current](ui, store, ctx, app, viewState[current] || {}))
      } catch (error) {
        content.replaceChildren(el('div', { class: 'avo-notice danger' }, icon('alert'), errorText(error)))
      }
    },
  }

  function drawTabs() {
    const pending = Object.keys(store.pending).filter(path => !store.ignored.has(path)).length
    const counts = { pending, subscriptions: Object.values(store.subscriptions?.items || {}).filter(item => item.enabled && item.status === 'waiting').length }
    tabs.replaceChildren(...TABS.map(([key, label, iconName]) => el('button', {
      type: 'button', role: 'tab', class: `avo-tab${current === key ? ' active' : ''}`, 'aria-selected': String(current === key), 'aria-controls': 'avo-panel',tabIndex:current===key?0:-1, onkeydown:event=>{if(!['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const index=TABS.findIndex(([id])=>id===key);const next=event.key==='Home'?0:event.key==='End'?TABS.length-1:(index+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+TABS.length)%TABS.length;app.go(TABS[next][0]).then(()=>tabs.querySelectorAll('[role=tab]')[next]?.focus())},onclick: () => app.go(key),
    }, icon(iconName, 15), label, counts[key] ? el('span', { class: 'avo-count' }, String(counts[key])) : null)))
  }

  function drawSubtitle() {
    const active = store.organizeRuns().find(item => item.status === 'running' || item.status === 'queued')
    const configured = Boolean(store.settings.inbox || store.settings.directories?.some(d=>d.enabled!==false&&d.path))
    statusPill.className = `avo-pill ${active ? 'running' : !configured ? 'warning' : store.watch && !store.watch.error ? 'success' : ''}`
    statusPill.textContent = active ? `整理中 ${Math.round(active.progress || 0)}%` : !configured ? '未设置收件目录' : store.watch && !store.watch.error ? '监听中' : '空闲'
    runButton.disabled = Boolean(active) || !configured
    subtitle.textContent = active
      ? `正在整理：${active.message || '运行中'}`
      : store.lastRun ? `上次整理 ${formatTime(store.lastRun.at)} · 成功 ${store.lastRun.success} · 待处理 ${store.lastRun.pending}` : '按番号识别、刮削与整理'
  }

  content.replaceChildren(el('div', { class: 'avo-stack' }, el('div', { class: 'avo-skeleton', style: { height: '90px' } }), el('div', { class: 'avo-skeleton', style: { height: '240px' } })))
  await app.refresh()

  // 页面可见时每 15 秒刷新一次状态；设置页不自动重绘，避免冲掉正在编辑的内容。
  const timer = setInterval(() => {
    if (!disposed && ui.doc.visibilityState === 'visible') app.refresh(false, true).catch(() => {})
  }, 15000)

  return () => {
    disposed = true
    clearInterval(timer)
    unsubscribeTheme?.()
    ui.dispose?.()
    wrapper.remove()
  }
}
