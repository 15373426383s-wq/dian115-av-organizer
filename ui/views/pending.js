// 待处理：识别或刮削失败的文件。可指定番号、改名、立即重试、移到失败目录、忽略。
import { parseMedia, compileCleanRules, splitExtension } from '../lib/number.js'
import { formatTime, formatSize } from '../components.js'

export function renderPending(ui, store, ctx, app, state) {
  const { el, icon, button } = ui
  state.filter ??= 'active'
  state.query ??= ''
  const body = el('div')
  const counter = el('span', { class: 'avo-hint' })
  const search = el('input', { class: 'avo-input', placeholder: '搜索文件名、路径、原因', value: state.query })
  search.addEventListener('input', () => { state.query = search.value; draw() })
  const filter = el('select', { class: 'avo-select' }, ...[['active', '待处理'], ['ignored', '已忽略'], ['all', '全部']].map(([value, label]) => el('option', { value, selected: state.filter === value }, label)))
  filter.addEventListener('change', () => { state.filter = filter.value; draw() })

  const runFor = async (paths, message) => {
    try {
      await store.runOrganize({ paths })
      ui.toast(message || '已提交整理，稍后刷新查看结果', 'success')
    } catch (error) {
      // 整理正在运行时提交会被拒；控制键已写入，本轮结束后的下一轮会处理。
      ui.toast('已保存。当前有整理在运行，结束后会自动按设置处理', 'warning', 6000)
    }
    setTimeout(() => app.refresh(false, true), 1500)
  }

  function card(item) {
    const ignored = store.ignored.has(item.path)
    const numberInput = el('input', { class: 'avo-input', placeholder: '输入正确的番号，例如 SSIS-001', value: item.manual_number || item.number || (item.scores?.[0]?.number) || item.candidates?.[0] || '' })
    const parsed = item.parsed || {}
    const candidates = item.scores?.length ? item.scores : (item.candidates || []).map(number => ({ number }))
    const logsBox = el('pre', { class: 'avo-pre', hidden: true }, (item.logs || []).join('\n') || '没有日志')

    const actions = el('div', { class: 'avo-row' },
      button('按番号整理', { kind: 'primary', size: 'sm', icon: 'check', onClick: async () => {
        const number = numberInput.value.trim()
        if (!number) throw new Error('请先填写番号')
        await store.setManual(item.path, number)
        if (ignored) await store.setIgnored(item.path, false)
        await runFor([item.path], `已提交：按 ${number} 整理 ${item.name}`)
      } }),
      button('改名', { size: 'sm', icon: 'edit', onClick: () => renameDialog(ui, store, ctx, item, app, runFor) }),
      button('立即重试', { size: 'sm', icon: 'refresh', onClick: () => runFor([item.path], `已提交重试 ${item.name}`) }),
      store.settings.failed_folder ? button('移到失败目录', { size: 'sm', icon: 'move', onClick: async () => {
        if (!await ui.confirm('移到失败目录', `把 ${item.name} 移到 ${store.settings.failed_folder}？移走后不会再自动整理。`, '移动')) return
        await ctx.files.call({ operation: 'move', path: item.path, destination_dir: store.settings.failed_folder })
        ui.toast('已移到失败目录', 'success')
        await app.refresh()
      } }) : null,
      button(ignored ? '取消忽略' : '忽略', { size: 'sm', kind: ignored ? '' : 'ghost', icon: 'ban', onClick: async () => {
        await store.setIgnored(item.path, !ignored)
        ui.toast(ignored ? '已恢复自动处理' : '已忽略，之后不再自动处理', 'success')
        draw()
      } }),
      button('日志', { size: 'sm', kind: 'ghost', icon: 'file', onClick: () => { logsBox.hidden = !logsBox.hidden } }))

    return el('div', { class: `avo-pending${ignored ? ' ignored' : ''}` },
      el('div', { class: 'avo-row between', style: { alignItems: 'flex-start' } },
        el('div', { class: 'avo-stack', style: { gap: '2px', minWidth: 0 } },
          el('div', { class: 'name' }, icon('file', 14), ' ', item.name, ignored ? el('span', { class: 'avo-badge', style: { marginLeft: '8px' } }, '已忽略') : null),
          ui.pathLine(item.path)),
        el('span', { class: 'avo-badge warning' }, `第 ${item.attempts || 1} 次`)),
      el('div', { class: 'reason' }, icon('alert', 13), ' ', item.reason || '原因未知'),
      el('div', { class: 'avo-meta' },
        item.size ? el('span', {}, formatSize(item.size)) : null,
        el('span', {}, `首次失败 ${formatTime(item.first_at || item.at)}`),
        el('span', {}, `最近一次 ${formatTime(item.at)}`),
        !ignored && item.next_attempt_at ? el('span', {}, `下次自动重试 ${formatTime(item.next_attempt_at)}`) : null,
        item.manual_number ? el('span', {}, `已指定番号 ${item.manual_number}`) : null),
      parsed.cleaned !== undefined ? el('div', { class: 'avo-meta' },
        el('span', {}, '清理后：', el('span', { class: 'avo-path' }, parsed.cleaned || '（空）')),
        parsed.query ? el('span', {}, '标题线索：', parsed.query) : null,
        parsed.loose?.length ? el('span', {}, '宽松候选：', parsed.loose.map(c => c.number).join('、')) : null) : null,
      candidates.length ? el('div', {}, el('span', { class: 'avo-hint' }, '候选（点击填入）：'),
        ...candidates.map(c => el('span', { class: 'avo-chip click', title: c.title || '', onclick: () => { numberInput.value = c.number } }, c.number, c.score != null ? el('b', {}, ` ${c.score}`) : null, c.title ? el('span', { class: 'avo-hint' }, ` ${String(c.title).slice(0, 24)}`) : null))) : null,
      el('div', { class: 'avo-inline' }, numberInput),
      actions, logsBox)
  }

  function draw() {
    const items = Object.values(store.pending).filter(item => {
      const ignored = store.ignored.has(item.path)
      if (state.filter === 'active' && ignored) return false
      if (state.filter === 'ignored' && !ignored) return false
      const q = state.query.trim().toLowerCase()
      return !q || [item.name, item.path, item.reason].some(value => String(value || '').toLowerCase().includes(q))
    }).sort((a, b) => String(b.at).localeCompare(String(a.at)))
    counter.textContent = `共 ${items.length} 个`
    body.replaceChildren(...(items.length ? items.slice(0, 200).map(card) : [ui.empty(state.filter === 'ignored' ? '没有已忽略的文件' : '没有待处理的文件，全部识别成功', 'check')]))
  }
  draw()

  return el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('alert'), '待处理'),
      el('span', { class: 'avo-hint' }, '认不出番号、匹配度不足、刮削失败或目标已存在的文件；会按 1 小时起翻倍的间隔自动重试')),
    el('div', { class: 'avo-toolbar' }, search, filter, el('span', { class: 'grow' }), counter,
      button('全部立即重试', { size: 'sm', icon: 'refresh', disabled: !Object.keys(store.pending).length, onClick: async () => { await store.runOrganize({ retry_pending: true }); ui.toast('已提交重试', 'success') } })),
    body)
}

// 改名：在宿主上直接重命名源文件，实时预览新名字的识别结果。
function renameDialog(ui, store, ctx, item, app, runFor) {
  const { el, button } = ui
  const { ext } = splitExtension(item.name)
  const d = ui.dialog('重命名文件', { width: 560, icon: 'edit', subtitle: '改名后按新名字重新识别' })
  const input = el('input', { class: 'avo-input', value: item.name })
  const preview = el('div', { class: 'avo-preview' })
  const { rules } = compileCleanRules(store.settings.clean_rules)
  const update = () => {
    const name = input.value.trim()
    const parsed = parseMedia(name, '', { cleanRules: rules })
    preview.replaceChildren(el('dl', { class: 'avo-kv' },
      el('dt', {}, '识别番号'), el('dd', {}, parsed.number ? el('b', {}, parsed.number) : el('span', { style: { color: 'var(--avo-danger)' } }, parsed.reason || '认不出')),
      el('dt', {}, '标记'), el('dd', {}, [parsed.flags.chinese && '中字', parsed.flags.uncensored && '破解', parsed.flags.k4 && '4K', parsed.part && `第 ${parsed.part} 段`].filter(Boolean).join('、') || '无')))
  }
  input.addEventListener('input', update)
  update()
  d.body.append(ui.field('新文件名', input, `只改名不移动；请保留扩展名 .${ext}。改名后会自动按新名字重新整理。`), preview)
  d.foot.append(button('取消', { onClick: () => d.close() }), button('改名并整理', { kind: 'primary', icon: 'check', onClick: async () => {
    const name = input.value.trim()
    if (!name || /[/\\]/.test(name)) throw new Error('文件名不能为空，也不能包含 /')
    if (name === item.name) throw new Error('文件名没有变化')
    await ctx.files.call({ operation: 'rename', path: item.path, name })
    d.close()
    ui.toast(`已改名为 ${name}`, 'success')
    await runFor([], '已提交整理')
  } }))
  setTimeout(() => input.focus(), 50)
}
