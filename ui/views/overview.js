// 概览：统计、运行状态、目录监听、最近整理的封面墙。
import { VIDEO_EXTENSIONS } from '../lib/number.js'
import { formatTime, formatDuration } from '../components.js'
import { openDetail } from './detail.js'

const MODE_LABEL = { from_nfo:'读取已有资料',organize: '刮削并整理', rename_only: '只整理不刮削', in_place: '原地刮削' }
// 任务阶段：扫描 → 下载 → 搬运 → 完成。搬运阶段由宿主写字节级进度，下载阶段由插件自己报。
const STAGE_LABEL = { scan:'扫描收件目录', download:'下载资源', organize:'整理中', 'file:move':'搬运文件', 'file:copy':'复制文件', 'file:remove':'清理文件', files:'文件处理', done:'完成' }

// 当前任务的进度细节：阶段 + 已处理计数 + 百分比。
export function progressDetail(run) {
  if (!run) return ''
  const parts = []
  const stage = STAGE_LABEL[run.stage] || run.stage
  if (stage) parts.push(`阶段：${stage}`)
  if (Number(run.total) > 0) parts.push(`已处理 ${run.done || 0}/${run.total}${run.failed ? ` · 失败 ${run.failed}` : ''}`)
  if (Number(run.progress) > 0) parts.push(`进度 ${Math.round(run.progress)}%`)
  return parts.join(' · ')
}
import { sourceName, sourcePlan } from '../lib/registry.js'
import { directoryConfigs } from '../lib/advanced.js'

export function renderOverview(ui, store, ctx, app) {
  const { el, icon, button } = ui
  const s = store.settings
  const history = store.history
  const success = history.filter(item => item.status === 'success')
  const today = new Date().toDateString()
  const todayCount = success.filter(item => new Date(item.at).toDateString() === today).length
  const pendingPaths = Object.keys(store.pending)
  const ignoredCount = pendingPaths.filter(path => store.ignored.has(path)).length
  const failedMoved = history.filter(item => item.status === 'failed_moved').length
  const sourceHits = {}
  for (const item of success) for (const id of item.sources || []) sourceHits[id] = (sourceHits[id] || 0) + 1
  const fuzzyCount = success.filter(item => item.method === 'fuzzy' || item.method === 'loose').length

  const stat = (label, value, foot, iconName, onClick) => el(onClick ? 'button' : 'div', { type: onClick ? 'button' : undefined, class: `avo-stat${onClick ? ' link' : ''}`, onclick: onClick },
    el('div', { class: 'label' }, icon(iconName, 14), label), el('div', { class: 'value' }, String(value)), foot ? el('div', { class: 'foot' }, foot) : null)

  const stats = el('div', { class: 'avo-stats' },
    stat('已整理', success.length, `最近 ${history.length} 条记录内`, 'film', () => app.go('history')),
    stat('今日整理', todayCount, `${fuzzyCount} 次模糊识别命中`, 'clock', () => app.go('history')),
    stat('待处理', pendingPaths.length - ignoredCount, `${ignoredCount} 个已忽略 · ${failedMoved} 个已移出`, 'alert', () => app.go('pending')),
    stat('进行中订阅', Object.values(store.subscriptions?.items || {}).filter(item => item.enabled && ['waiting', 'searching', 'submitting'].includes(item.status)).length, '缓存与站点自动查找', 'clock', () => app.go('subscriptions')))

  // 运行状态
  const runs = store.organizeRuns()
  const active = runs.find(item => item.status === 'running' || item.status === 'queued')
  const blocked = runs.filter(item => item.status === 'attention_required')
  const last = store.lastRun
  const notices = []
  if (!s.inbox && !s.directories?.some(d=>d.enabled!==false&&d.path)) notices.push(el('div', { class: 'avo-notice warning' }, icon('alert'), el('div', {}, '还没有设置收件目录。', el('a', { href: '#', onclick: event => { event.preventDefault(); app.go('settings') } }, '去设置'))))
  if (blocked.length) {
    notices.push(el('div', { class: 'avo-notice danger' }, icon('alert'),
      el('div', { class: 'avo-row between', style: { width: '100%' } },
        el('div', {}, `有 ${blocked.length} 个整理任务中断，核对后继续。`),
        el('div', {}, button('核对并继续', { kind: 'primary', size: 'sm', icon: 'check', onClick: async () => {
          for (const item of blocked) await ctx.tasks.retry(item.id)
          ui.toast('已核对：视频已到目标位置的补记历史，其余文件重新扫描整理', 'success')
          await app.refresh()
        } })))))
  }

  const target = s.action_mode === 'in_place' ? '视频原目录（原地刮削）' : s.mode === 'strm' ? `STRM 规则 #${s.strm_rule_id || '未选择'}（视频进 CD2，元数据留本地）` : (s.local_target || '未设置')
  const watch = store.watch
  const statusCard = el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('home'), '运行状态'),
      el('div', { class: 'avo-row' },
        button('重试全部待处理', { kind: 'ghost', size: 'sm', icon: 'refresh', disabled: Boolean(active) || !pendingPaths.length, onClick: async () => {
          await store.runOrganize({ retry_pending: true })
          ui.toast('已提交重试', 'success')
        } }))),
    el('dl', { class: 'avo-kv' },
      dt(el, '工作模式'), el('dd', {}, el('span', { class: 'avo-badge info' }, MODE_LABEL[s.action_mode] || MODE_LABEL.organize), ' ', s.mode === 'strm' ? el('span', { class: 'avo-badge' }, 'CD2 + STRM') : el('span', { class: 'avo-badge' }, '纯本地')),
      dt(el, '收件目录'), el('dd', { class: 'avo-path' }, s.directories?.some(d=>d.enabled!==false&&d.path)?s.directories.filter(d=>d.enabled!==false&&d.path).map(d=>d.path).join(' · '):s.inbox || '未设置'),
      dt(el, '整理目标'), el('dd', { class: 'avo-path' }, target),
      dt(el, '目录监听'), el('dd', {}, watch
        ? el('span', {}, el('span', { class: `avo-badge ${watch.error ? 'danger' : 'success'}` }, watch.error ? '异常' : '监听中'), ' ', el('span', { class: 'avo-path' }, `${watch.kind === 'cd2' ? 'cd2:' : ''}${watch.path}`), watch.error ? el('div', { class: 'avo-hint' }, watch.error) : null)
        : el('span', { class: 'avo-badge' }, '未启用（仍会每 30 分钟定时扫描）')),
      dt(el, '当前任务'), el('dd', {}, active ? el('div', { class: 'avo-stack', style: { gap: '4px' } },
        el('span', {}, active.message || '运行中'),
        el('div', { class: 'avo-bar' }, el('i', { style: { width: `${Math.round(active.progress || 0)}%` } })),
        el('div', { class: 'avo-hint' }, progressDetail(active)),
        (active.logs || []).length ? el('div', { class: 'avo-hint' }, (active.logs || []).slice(-3).join(' / ')) : null) : '空闲'),
      dt(el, '上次整理'), el('dd', {}, last ? `${formatTime(last.at)} · 扫描 ${last.scanned} 个 · 成功 ${last.success} · 待处理 ${last.pending} · 跳过 ${last.skipped} · 用时 ${formatDuration(last.duration_ms)}` : '暂无')),
    el('div', { class: 'avo-row', style: { marginTop: '14px' } },
      button(watch ? '重新启用监听' : '启用目录监听', { icon: 'eye', disabled: !s.inbox && !s.directories?.length, onClick: async () => { await enableWatch(ctx, s); ui.toast('目录监听已启用', 'success'); await app.refresh() } }),
      watch ? button('停止全部监听', { kind: 'danger', icon: 'ban', onClick: async () => { for (const item of store.watches || [watch]) await ctx.watch.remove(item.id); ui.toast('已停止目录监听', 'success'); await app.refresh() } }) : null,
      ...(store.watches || []).map(item => el('span', { class: 'avo-badge' }, `${item.path}${item.error ? ' · ' + item.error : ''}`))))

  const hits = Object.entries(sourceHits).sort((a, b) => b[1] - a[1])
  const total = hits.reduce((sum, [, n]) => sum + n, 0)
  const enabledSources=sourcePlan(s).filter(item=>item.enabled)
  const sourceCard = el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('database'), '数据来源命中')),
    hits.length ? el('div', { class: 'avo-stack' }, ...hits.map(([id, n]) => el('div', { class: 'avo-stack', style: { gap: '4px' } },
      el('div', { class: 'avo-row between' }, el('span', {}, sourceName(id, s)), el('span', { class: 'avo-hint' }, `${n} 次 · ${Math.round((n / total) * 100)}%`)),
      el('div', { class: 'avo-bar' }, el('i', { style: { width: `${(n / total) * 100}%` } })))))
      : ui.empty('整理成功后这里会显示各来源的命中情况', 'database'),
    el('p', { class: 'avo-hint', style: { marginTop: '12px' } }, `已启用 ${enabledSources.length} 个来源：${enabledSources.slice(0, 8).map(item => item.def.name).join(' → ')}${enabledSources.length > 8 ? ' …' : ''}`))

  const recent = success.slice(0, 8)
  const recentCard = el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('grid'), '最近整理'), button('查看全部', { kind: 'ghost', size: 'sm', onClick: () => app.go('history') })),
    recent.length ? el('div', { class: 'avo-covers' }, ...recent.map(item => coverTile(ui, store, item, () => openDetail(ui, store, item, { onChanged: () => app.refresh() }))))
      : ui.empty('还没有整理记录。设置好收件目录后点“立即整理”。'))

  return el('div', { class: 'avo-stack avo-overview', style: { gap: '16px' } }, ...notices, stats, el('div', { class: 'avo-overview-panels' }, statusCard, sourceCard), recentCard)
}

export function coverTile(ui, store, item, onClick) {
  const { el, icon } = ui
  const url = store.coverURL(item.cover)
  const cover = url ? el('img', { src: url, alt: item.number, loading: 'lazy', onerror: event => event.target.replaceWith(icon('image', 28)) }) : icon('image', 28)
  return el('div', { class: 'avo-cover', onclick: onClick, title: item.title || item.number },
    el('div', { class: 'img' }, cover,
      el('div', { class: 'flag' }, item.flags?.chinese ? el('span', { class: 'avo-badge info' }, '中字') : null, item.method && item.method !== 'exact' ? el('span', { class: 'avo-badge warning' }, item.method === 'manual' ? '指定' : '模糊') : null)),
    el('div', { class: 'cap' }, el('b', {}, item.number), el('span', {}, item.title || (item.actors || []).join('、'))))
}

// 目录监听按宿主契约只传挂载路径，不传 kind：宿主按 CD2 挂载前缀自行判定后端。
// 配置里也不接受 cd2: 前缀，CD2 请填容器内可见的挂载路径（如 /mnt/cd2/115/未刮削）。
export async function enableWatch(ctx, settings) {
  const configs = directoryConfigs(settings)
  for (const item of await ctx.watch.list()) if (item.job === 'organize' || item.id === 'inbox') await ctx.watch.remove(item.id)
  let clouds = []
  try { clouds = (await ctx.api.get('/api/cd2/clouds'))?.clouds || [] } catch (e) { clouds = [] }
  for (const config of configs) {
    const inbox = String(config.inbox || '')
    if (inbox.startsWith('cd2:')) throw new Error(`收件目录请填容器内可见的挂载路径（例如 /mnt/cd2/115/未刮削），不要使用 cd2: 前缀：${inbox}`)
    const inCloud = clouds.some(item => {
      const key = '/' + item.name, at = inbox.indexOf(key)
      return at >= 0 && (inbox.length === at + key.length || inbox[at + key.length] === '/')
    })
    await ctx.watch.add({ id: config.directory_id || 'inbox', path: inbox, job: 'organize',
      interval_seconds: Math.max(5, Number(config.watch_interval) || 30), realtime: config.watch_realtime !== false, recursive: true,
      patterns: inCloud ? undefined : VIDEO_EXTENSIONS.filter(ext => ext !== 'strm').map(ext => `*.${ext}`) })
  }
}

function dt(el, text) {
  return el('dt', {}, text)
}
