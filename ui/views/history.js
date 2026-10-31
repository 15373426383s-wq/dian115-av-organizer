// 整理记录：搜索、筛选、列表 / 封面墙两种视图、分页，点开看详情。
import { formatTime, METHOD_LABEL, STATUS_LABEL, STATUS_KIND } from '../components.js'
import { openDetail } from './detail.js'
import { coverTile } from './overview.js'

const PAGE_SIZE = 40

export function renderHistory(ui, store, ctx, app, state) {
  const { el, icon } = ui
  state.query ??= ''
  state.status ??= ''
  state.method ??= ''
  state.view ??= 'list'
  state.page ??= 0

  const body = el('div')
  const counter = el('span', { class: 'avo-hint' })
  const search = el('input', { class: 'avo-input', placeholder: '搜索番号、标题、演员、标签、路径', value: state.query })
  search.addEventListener('input', () => { state.query = search.value; state.page = 0; draw() })
  const select = (key, options) => {
    const node = el('select', { class: 'avo-select' }, ...options.map(([value, label]) => el('option', { value, selected: state[key] === value }, label)))
    node.addEventListener('change', () => { state[key] = node.value; state.page = 0; draw() })
    return node
  }
  const viewButtons = el('div', { class: 'avo-row' })
  const drawViewButtons = () => viewButtons.replaceChildren(
    ui.button('', { kind: state.view === 'list' ? 'primary' : '', size: 'sm', icon: 'list', title: '列表', onClick: () => { state.view = 'list'; drawViewButtons(); draw() } }),
    ui.button('', { kind: state.view === 'grid' ? 'primary' : '', size: 'sm', icon: 'grid', title: '封面墙', onClick: () => { state.view = 'grid'; drawViewButtons(); draw() } }))
  drawViewButtons()

  const toolbar = el('div', { class: 'avo-toolbar' }, search,
    select('status', [['', '全部状态'], ['success', '已整理'], ['skipped', '已跳过'], ['failed_moved', '移到失败目录']]),
    select('method', [['', '全部识别方式'], ['exact', '精确番号'], ['loose', '宽松番号'], ['fuzzy', '模糊匹配'], ['manual', '指定番号']]),
    el('span', { class: 'grow' }), counter, viewButtons)

  const matches = item => {
    if (state.status && item.status !== state.status) return false
    if (state.method && item.method !== state.method) return false
    const q = state.query.trim().toLowerCase()
    if (!q) return true
    return [item.number, item.title, item.original_title, item.source_name, item.source, item.target, item.studio, item.series, ...(item.actors || []), ...(item.genres || [])]
      .some(value => String(value || '').toLowerCase().includes(q))
  }

  const open = item => openDetail(ui, store, item, { onChanged: () => app.refresh() })

  function row(item) {
    const url = store.coverURL(item.cover)
    const method = METHOD_LABEL[item.method]
    return el('div', { class: 'avo-item', onclick: () => open(item) },
      url ? el('img', { class: 'avo-thumb', src: url, alt: item.number, loading: 'lazy' }) : el('div', { class: 'avo-thumb' }, icon(item.status === 'success' ? 'image' : 'alert', 20)),
      el('div', { class: 'main' },
        el('div', { class: 'line1' }, el('span', { class: 'num' }, item.number || '—'), el('span', { class: `avo-badge ${STATUS_KIND[item.status] || ''}` }, STATUS_LABEL[item.status] || item.status),
          method ? el('span', { class: `avo-badge ${item.method === 'exact' ? '' : 'warning'}` }, method + (item.method !== 'exact' && item.score != null ? ` ${item.score}` : '')) : null,
          item.flags?.chinese ? el('span', { class: 'avo-badge info' }, '中字') : null,
          item.flags?.uncensored ? el('span', { class: 'avo-badge danger' }, '破解') : null),
        el('div', { class: 'ttl' }, item.title || item.note || item.source_name || ''),
        el('div', { class: 'avo-meta' },
          item.actors?.length ? el('span', {}, icon('user', 12), ' ', item.actors.slice(0, 3).join('、')) : null,
          item.release_date ? el('span', {}, item.release_date) : null,
          item.studio ? el('span', {}, item.studio) : null,
          el('span', { class: 'avo-path' }, item.in_place ? item.source : item.target))),
      el('div', { class: 'side' }, el('span', {}, formatTime(item.at)), el('span', {}, (item.sources || []).join(' · '))))
  }

  function draw() {
    const list = store.history.filter(matches)
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    state.page = Math.min(state.page, pages - 1)
    const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)
    counter.textContent = `共 ${list.length} 条`
    if (!list.length) {
      body.replaceChildren(ui.empty(store.history.length ? '没有符合条件的记录' : '还没有整理记录', 'list'))
      return
    }
    const content = state.view === 'grid'
      ? el('div', { class: 'avo-covers' }, ...slice.map(item => coverTile(ui, store, item, () => open(item))))
      : el('div', { class: 'avo-list' }, ...slice.map(row))
    const pager = pages > 1 ? el('div', { class: 'avo-pager' },
      ui.button('上一页', { size: 'sm', disabled: state.page === 0, onClick: () => { state.page--; draw() } }),
      el('span', {}, `${state.page + 1} / ${pages}`),
      ui.button('下一页', { size: 'sm', disabled: state.page >= pages - 1, onClick: () => { state.page++; draw() } })) : null
    body.replaceChildren(content, pager || '')
  }
  draw()

  return el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('list'), '整理记录'), el('span', { class: 'avo-hint' }, '最多保留最近 500 条；点击查看封面、元数据、数据来源与文件位置')),
    toolbar, body)
}
