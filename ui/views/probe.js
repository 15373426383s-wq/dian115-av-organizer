// 识别测试：逐步展示识别过程；测试匹配走与整理相同的流程；检测各刮削来源。
import { parseMedia, compileCleanRules, applyCleanRules, toHalfWidth, splitExtension } from '../lib/number.js'
import { usableQuery } from '../lib/fuzzy.js'
import { numberKind } from '../lib/presets.js'
import { METHOD_LABEL, formatDuration } from '../components.js'

import { sourcePlan } from '../lib/registry.js'

export function renderProbe(ui, store, ctx, app, state) {
  const { el, icon, button } = ui
  state.text ??= ''
  state.parent ??= ''
  const s = store.settings
  const input = el('input', { class: 'avo-input', placeholder: '粘贴文件名或番号，例如 hhd800.com@SSIS-001-C.mp4', value: state.text })
  const parentInput = el('input', { class: 'avo-input', placeholder: '上一级目录名（可选）', value: state.parent })
  const steps = el('div', { class: 'avo-steps' })
  const result = el('div')

  function drawSteps() {
    state.text = input.value
    state.parent = parentInput.value
    const value = input.value.trim()
    if (!value) { steps.replaceChildren(el('div', { class: 'avo-hint' }, '输入后实时显示每一步的识别结果')); return }
    const { rules, errors } = compileCleanRules(s.clean_rules)
    const stem = splitExtension(value).stem
    const custom = applyCleanRules(toHalfWidth(stem), rules)
    const parsed = parseMedia(value, parentInput.value.trim(), { cleanRules: rules })
    const min = Number(s.fuzzy_min_chars || 6)
    const step = (title, content, muted) => el('div', { class: `avo-step${muted ? ' muted' : ''}` }, el('b', {}, title), el('div', {}, content))
    steps.replaceChildren(
      step('1. 自定义清理', rules.length ? custom || '（空）' : '未设置自定义清理规则', !rules.length),
      errors.length ? step('清理规则错误', errors.join('；')) : null,
      step('2. 内置清理（站点前缀、分辨率、编码等）', parsed.cleaned || '（空）'),
      step('3. 精确番号', parsed.number ? el('span', {}, el('b', {}, parsed.number), `（${parsed.kind}，来自${parsed.from === 'directory' ? '目录名' : '文件名'}）`) : (parsed.reason || '没有认出'), !parsed.number),
      step('4. 宽松候选', parsed.loose?.length ? parsed.loose.map(c => c.number + (c.short ? '（两位数）' : '')).join('、') : (parsed.candidates?.length > 1 ? `多个番号：${parsed.candidates.join('、')}` : '无'), !parsed.loose?.length),
      step('5. 标题线索（用于模糊匹配）', parsed.query ? `${parsed.query}${usableQuery(parsed.query, min) ? '' : `（不足 ${min} 字，不做比较）`}` : '无', !parsed.query),
      step('标记', [parsed.flags.chinese && '中文字幕', parsed.flags.uncensored && '无码破解', parsed.flags.k4 && '4K', parsed.part && `第 ${parsed.part} 段`].filter(Boolean).join('、') || '无', true))
  }
  input.addEventListener('input', drawSteps)
  parentInput.addEventListener('input', drawSteps)
  drawSteps()

  async function testMatch() {
    const text = input.value.trim()
    if (!text) throw new Error('请输入文件名或番号')
    result.replaceChildren(el('div', { class: 'avo-skeleton', style: { height: '120px' } }))
    const started = Date.now()
    const run = await ctx.tasks.run('probe', `probe:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, { text, parent: parentInput.value.trim() })
    const done = await store.waitRun(run.id, 180000)
    const r = done.result || {}
    if (done.status !== 'succeeded') { result.replaceChildren(el('div', { class: 'avo-notice danger' }, icon('alert'), done.error || done.message || '测试失败')); return }
    result.replaceChildren(matchCard(ui, r, Date.now() - started))
  }

  const sourceNumber = el('input', { class: 'avo-input', placeholder: '用于检测的番号，例如 SSIS-001', value: state.sourceNumber || '' })
  const sourceTable = el('div')
  async function checkSources() {
    const number = sourceNumber.value.trim()
    if (!number) throw new Error('请填写用于检测的番号')
    state.sourceNumber = number
    // 只检测已启用且支持这个番号类型的来源。
    const kind = numberKind(parseMedia(number).kind, parseMedia(number).number || number)
    const rows = sourcePlan(store.settings).filter(item => item.enabled && item.def.kinds.includes(kind)).map(item => ({ id: item.def.id, name: item.def.name, status: '检测中…' }))
    if (!rows.length) throw new Error('没有已启用且支持这个番号类型的来源')
    const drawTable = () => sourceTable.replaceChildren(el('table', { class: 'avo-table' },
      el('tr', {}, ...['来源', '状态', '耗时', '结果'].map(h => el('th', {}, h))),
      ...rows.map(row => el('tr', {}, el('td', {}, row.name), el('td', {}, row.ok === undefined ? el('span', { class: 'avo-badge' }, row.status) : el('span', { class: `avo-badge ${row.ok ? 'success' : 'danger'}` }, row.ok ? '可用' : '失败')),
        el('td', {}, row.ms ? formatDuration(row.ms) : ''), el('td', {}, row.detail || '')))))
    drawTable()
    for (const row of rows) {
      const started = Date.now()
      try {
        const run = await ctx.tasks.run('probe', `source:${row.id}:${Date.now()}`, { text: number, source: row.id, no_fuzzy: true })
        const done = await store.waitRun(run.id, 120000)
        const r = done.result || {}
        row.ok = Boolean(done.status === 'succeeded' && r.meta)
        row.detail = row.ok ? `${r.meta.number} ${r.meta.title || ''}` : (r.reason || done.error || (r.logs || []).join('；') || '没有结果')
      } catch (error) {
        row.ok = false
        row.detail = error.message || String(error)
      }
      row.ms = Date.now() - started
      drawTable()
    }
  }

  return el('div', { class: 'avo-grid cols-2' },
    el('div', { class: 'avo-card' },
      el('div', { class: 'avo-card-head' }, el('h2', {}, icon('search'), '识别测试'), button('测试匹配', { kind: 'primary', icon: 'play', onClick: testMatch })),
      el('div', { class: 'avo-stack' }, input, parentInput, steps,
        el('p', { class: 'avo-hint' }, '“测试匹配”与整理走同一套流程（精确番号 → 宽松番号 → 模糊搜索），只联网取数据，不移动任何文件。')),
      result),
    el('div', { class: 'avo-card' },
      el('div', { class: 'avo-card-head' }, el('h2', {}, icon('database'), '来源检测'), button('检测全部来源', { icon: 'refresh', onClick: checkSources })),
      el('div', { class: 'avo-stack' }, sourceNumber,
        el('p', { class: 'avo-hint' }, '逐个检测已启用、并支持这个番号类型的来源，用来核对 Cookie、代理和站点规则。来源的启用、地址和规则在“设置 → 刮削来源”里管理。'),
        sourceTable)))
}

function matchCard(ui, r, ms) {
  const { el, icon } = ui
  const meta = r.meta
  const head = r.ok
    ? el('div', { class: 'avo-notice info' }, icon('check'), el('div', {}, el('b', {}, `会自动整理为 ${meta.number}`), `（${METHOD_LABEL[r.method] || r.method}${r.score != null && r.method !== 'exact' ? `，匹配度 ${r.score}` : ''}；用时 ${formatDuration(ms)}）`))
    : el('div', { class: 'avo-notice warning' }, icon('alert'), el('div', {}, el('b', {}, '不会自动整理：'), r.reason || '没有结果'))
  const detail = meta ? el('div', { class: 'avo-detail', style: { gridTemplateColumns: '140px 1fr', marginTop: '12px' } },
    meta.poster || meta.cover ? el('img', { class: 'poster', src: meta.poster || meta.cover, referrerpolicy: 'no-referrer', alt: meta.number }) : el('div', { class: 'poster' }),
    el('dl', { class: 'avo-kv' },
      el('dt', {}, '标题'), el('dd', {}, meta.title || '—'),
      el('dt', {}, '演员'), el('dd', {}, (meta.actors || []).join('、') || '—'),
      el('dt', {}, '发行'), el('dd', {}, meta.release_date || '—'),
      el('dt', {}, '厂商'), el('dd', {}, meta.studio || '—'),
      el('dt', {}, '系列'), el('dd', {}, meta.series || '—'),
      el('dt', {}, '标签'), el('dd', {}, (meta.genres || []).slice(0, 12).join('、') || '—'),
      el('dt', {}, '剧照'), el('dd', {}, meta.samples?.length ? `${meta.samples.length} 张` : '—'),
      el('dt', {}, '来源'), el('dd', {}, (meta.sources || []).join(' → ')))) : null
  const scores = r.scores?.length ? el('table', { class: 'avo-table', style: { marginTop: '12px' } },
    el('tr', {}, ...['候选', '匹配度', '标题'].map(h => el('th', {}, h))),
    ...r.scores.map(c => el('tr', {}, el('td', {}, c.number), el('td', {}, String(c.score ?? '')), el('td', {}, c.title || '')))) : null
  const logs = r.logs?.length ? el('pre', { class: 'avo-pre', style: { marginTop: '12px' } }, r.logs.join('\n')) : null
  return el('div', { style: { marginTop: '14px' } }, head, detail, scores, logs)
}
