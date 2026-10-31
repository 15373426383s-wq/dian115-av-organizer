// 设置页“刮削来源”：内置预设 + 自定义来源的启用、排序、地址、Cookie / 令牌、测试、
// 复制修改、导入导出，以及合并模式、年龄确认、字段优先级。
import { PRESETS, SOURCE_CATEGORIES } from '../lib/presets.js'
import { sourcePlan, parseJSON, validateSource, customSources, fieldPriority } from '../lib/registry.js'
import {sourceChoices,sourceRules,NUMBER_KINDS} from '../source-controls.js'
import { METHOD_LABEL } from '../components.js'

export const KIND_LABEL = NUMBER_KINDS

const TEMPLATE = {
  id: 'my-source', name: '我的来源', category: 'general', type: 'html', kinds: ['standard'],
  base: 'https://example.com',
  detail: { url: '{base}/{number}' },
  rows: { sel: '.info p', label: 'span.header' },
  fields: {
    title: 'h1',
    release_date: { label: '发行日期|発売日' },
    actors: { sel: '.actors a', all: true },
    genres: { sel: '.genres a', all: true },
    cover: 'img.cover@src',
  },
}

export function renderSourcesCard(ui, store, ctx, draft, set) {
  const { el, icon, button, field, switchInput } = ui
  const list = el('div', { class: 'avo-sources' })
  const customErrors = el('div', { class: 'error' })
  const config = () => parseJSON(draft.source_config, {}) || {}
  const custom = () => parseJSON(draft.custom_sources, []) || []
  const saveConfig = value => set('source_config', JSON.stringify(value))
  const saveCustom = value => { set('custom_sources', JSON.stringify(value, null, 2)); draw() }
  const expanded = new Set()

  // 第一次修改时把当前生效的启用状态全部写成显式配置，之后只认显式配置。
  const ensureExplicit = () => {
    const current = config()
    if (Object.values(current).some(item => typeof item?.enabled === 'boolean')) return current
    for (const item of sourcePlan(draft)) current[item.def.id] = { ...(current[item.def.id] || {}), enabled: item.enabled }
    return current
  }

  function draw() {
    const plan = sourcePlan(draft)
    const order = plan.map(item => item.def.id)
    const { errors } = customSources(draft)
    customErrors.textContent = errors.join('；')
    const move = (id, delta) => {
      const next = [...order]
      const i = next.indexOf(id), j = i + delta
      if (j < 0 || j >= next.length) return
      ;[next[i], next[j]] = [next[j], next[i]]
      set('source_order', next.join(','))
      draw()
    }
    list.replaceChildren(...plan.map((item, index) => {
      const def = item.def
      const current = config()[def.id] || {}
      const enabledInput = el('input', { type: 'checkbox', checked: item.enabled, style: { accentColor: 'var(--avo-accent)', width: '18px', height: '18px' } })
      enabledInput.addEventListener('change', () => {
        const next = ensureExplicit()
        next[def.id] = { ...(next[def.id] || {}), enabled: enabledInput.checked }
        if (enabledInput.checked && def.needs_token && !next[def.id].token) ui.toast(`${def.name} 需要先在“设置”里填写令牌`, 'warning')
        saveConfig(next)
        draw()
      })
      const detail = el('div', { class: 'avo-stack', hidden: !expanded.has(def.id), style: { width: '100%', paddingTop: '10px' } })
      const input = (key, placeholder, type = 'text') => {
        const node = el('input', { class: 'avo-input', type, placeholder, value: current[key] || '' })
        node.addEventListener('input', () => { const next = config(); next[def.id] = { ...(next[def.id] || {}), [key]: node.value.trim() }; if (!next[def.id][key]) delete next[def.id][key]; saveConfig(next) })
        return node
      }
      detail.append(el('div', { class: 'avo-fields' },
        field('站点地址', input('base', def.base || '', 'url'), '用镜像站时填写；留空使用默认地址'),
        field('Cookie', input('cookie', '浏览器里复制的 Cookie（可选）', 'password'), '需要登录或已通过验证的浏览器状态时填写'),
        def.needs_token ? field('API 令牌', input('token', '必填', 'password'), '在站点账户里申请') : null),
        el('div', { class: 'avo-row' },
          button('复制为自定义来源', { size: 'sm', icon: 'copy', onClick: () => {
            const items = custom()
            const id = uniqueId(`${def.id}-custom`, [...PRESETS.map(p => p.id), ...items.map(c => c.id)])
            const copy = JSON.parse(JSON.stringify({ ...def, id, name: `${def.name}（自定义）` }))
            delete copy.custom
            items.push(copy)
            saveCustom(items)
            ui.toast(`已复制为 ${id}，可以在自定义来源里修改规则`, 'success')
          } }),
          def.custom ? button('编辑规则', { size: 'sm', icon: 'edit', onClick: () => editSource(def.id) }) : null,
          def.custom ? button('删除', { size: 'sm', kind: 'danger', icon: 'trash', onClick: async () => {
            if (!await ui.confirm('删除自定义来源', `删除 ${def.name}？`, '删除', 'danger')) return
            saveCustom(custom().filter(c => c.id !== def.id))
          } }) : null))
      const kinds = def.kinds.map(k => KIND_LABEL[k] || k).join('、')
      return el('div', { class: 'avo-source', style: { flexWrap: 'wrap' } },
        enabledInput,
        el('span', { class: 'avo-badge' }, `#${index + 1}`),
        el('div', { class: 'name', style: { minWidth: '160px' } },
          el('div', { class: 'avo-row', style: { gap: '6px' } }, def.name,
            el('span', { class: 'avo-badge' }, SOURCE_CATEGORIES[def.category] || '自定义'),
            def.custom ? el('span', { class: 'avo-badge info' }, '自定义') : checkBadge(el, def.check),
            def.needs_token && !current.token ? el('span', { class: 'avo-badge danger' }, '缺令牌') : null),
          el('div', { class: 'avo-hint' }, `${kinds}${def.search ? ' · 支持搜索' : ''}${item.base ? ' · ' + item.base.replace(/^https?:\/\//, '') : ''}`)),
        button('', { size: 'sm', kind: 'ghost', icon: 'up', title: '上移', disabled: index === 0, onClick: () => move(def.id, -1) }),
        button('', { size: 'sm', kind: 'ghost', icon: 'down', title: '下移', disabled: index === plan.length - 1, onClick: () => move(def.id, 1) }),
        button('测试', { size: 'sm', icon: 'play', onClick: () => testDialog(ui, store, ctx, { source: def.id, name: def.name, sample: sampleFor(def) }) }),
        button('', { size: 'sm', kind: 'ghost', icon: 'settings', title: '地址、Cookie、令牌', onClick: () => { expanded.has(def.id) ? expanded.delete(def.id) : expanded.add(def.id); detail.hidden = !expanded.has(def.id) } }),
        detail)
    }))
  }

  function editSource(id) {
    const items = custom()
    const existing = items.find(c => c.id === id)
    const d = ui.dialog(existing ? `编辑来源：${existing.name}` : '新建自定义来源', { width: 820, icon: 'database', subtitle: 'JSON 规则，保存前会校验，可直接测试' })
    const area = el('textarea', { class: 'avo-textarea', style: { minHeight: '46vh' }, value: JSON.stringify(existing || TEMPLATE, null, 2) })
    const status = el('div', { class: 'avo-hint' })
    const check = () => {
      try {
        const def = JSON.parse(area.value)
        const problem = validateSource(def)
        status.className = problem ? 'error' : 'avo-hint'
        status.textContent = problem || '规则有效'
        return problem ? null : def
      } catch (error) {
        status.className = 'error'
        status.textContent = `JSON 格式错误：${error.message}`
        return null
      }
    }
    area.addEventListener('input', check)
    check()
    d.body.append(
      el('p', { class: 'avo-hint', style: { margin: 0 } }, '规则说明：detail.url / search.url 支持 {base} {number} {number_lower} {number_nodash} {cid} {fc2_id} {heyzo_id} {date_id_underscore} {date_id_dash} {keyword}；字段写 "选择器" 或 "选择器@属性"，或 {label, value, all, json, re, template, from, type}。kinds 可选：' + Object.entries(KIND_LABEL).map(([k, v]) => `${k}（${v}）`).join('、')),
      area, status)
    d.foot.append(
      button('取消', { onClick: () => d.close() }),
      button('测试', { icon: 'play', onClick: () => { const def = check(); if (!def) throw new Error(status.textContent); return testDialog(ui, store, ctx, { sourceDef: def, name: def.name, sample: sampleFor(def) }) } }),
      button('保存', { kind: 'primary', icon: 'check', onClick: () => {
        const def = check()
        if (!def) throw new Error(status.textContent)
        const next = custom().filter(c => c.id !== id && c.id !== def.id)
        next.push(def)
        saveCustom(next)
        const cfg = config()
        if (Object.values(cfg).some(item => typeof item?.enabled === 'boolean') && cfg[def.id]?.enabled === undefined) { cfg[def.id] = { ...(cfg[def.id] || {}), enabled: true }; saveConfig(cfg) }
        d.close()
        ui.toast(`已保存来源 ${def.name}（保存设置后生效）`, 'success')
      } }))
  }

  function importDialog() {
    const d = ui.dialog('导入来源规则', { width: 720, icon: 'database', subtitle: '粘贴导出的 JSON，同 id 的来源会被替换' })
    const area = el('textarea', { class: 'avo-textarea', style: { minHeight: '40vh' }, placeholder: '粘贴来源规则：单个对象或数组' })
    d.body.append(area)
    d.foot.append(button('取消', { onClick: () => d.close() }), button('导入', { kind: 'primary', onClick: () => {
      let value
      try { value = JSON.parse(area.value) } catch (error) { throw new Error(`JSON 格式错误：${error.message}`) }
      const defs = Array.isArray(value) ? value : [value]
      const bad = defs.map(def => [def?.id, validateSource(def)]).filter(([, problem]) => problem)
      if (bad.length) throw new Error(bad.map(([id, problem]) => `${id || '未命名'}：${problem}`).join('；'))
      const ids = new Set(defs.map(def => def.id))
      saveCustom([...custom().filter(c => !ids.has(c.id)), ...defs])
      d.close()
      ui.toast(`已导入 ${defs.length} 个来源（保存设置后生效）`, 'success')
    } }))
  }

  draw()

  const modeChoice = el('div', { class: 'avo-choice' })
  const drawMode = () => modeChoice.replaceChildren(...[['fast', '快速', '按顺序查询，资料齐全就停止'], ['full', '完整', '查询多个来源，按字段优先级合并（更慢、更全）']].map(([value, title, desc]) => {
    const checked = (draft.scrape_mode || 'fast') === value
    const radio = el('input', { type: 'radio', name: 'avo-scrape-mode', checked })
    radio.addEventListener('change', () => { set('scrape_mode', value); drawMode() })
    return el('label', { class: checked ? 'checked' : '' }, radio, el('div', {}, el('b', {}, title), el('span', {}, desc)))
  }))
  drawMode()
  const text = (key, placeholder, type = 'text') => {
    const node = el('input', { class: 'avo-input', type, placeholder, value: draft[key] ?? '' })
    node.addEventListener('input', () => set(key, type === 'number' ? (node.value === '' ? '' : Number(node.value)) : node.value))
    return node
  }
  const priority=sourceRules(ui,draft,{value:fieldPriority(draft),onChange:value=>set('field_priority',Object.entries(value).filter(([,ids])=>ids.length).map(([key,ids])=>`${key}: ${ids.join(',')}`).join('\n'))})

  return el('div', { class: 'avo-card' },
    el('div', { class: 'avo-card-head' }, el('h2', {}, icon('database'), '刮削来源'),
      el('div', { class: 'avo-row' },
        button('新建来源', { size: 'sm', icon: 'plus', onClick: () => editSource('') }),
        button('启用 HEYZO 备用源', { size: 'sm', onClick: () => {
          const next = ensureExplicit()
          for (const id of ['avsox', 'freejavbt', 'mmtv']) next[id] = { ...next[id], enabled: true }
          saveConfig(next); draw(); ui.toast('已启用 AVSOX、FreeJavBT、7mmtv，请保存设置', 'success')
        } }),
        button('导入', { size: 'sm', icon: 'down', onClick: importDialog }),
        button('导出自定义', { size: 'sm', icon: 'copy', onClick: () => ui.copyText(JSON.stringify(custom(), null, 2)) }))),
    el('p', { class: 'avo-hint', style: { marginBottom: '12px' } }, `内置 ${PRESETS.length} 个来源，按番号类型选用。状态标注的是开发时实测；当前网络请用“测试”核对。升级保留已有开关，新来源可按需启用。`),
    field('合并模式', modeChoice),
    el('div', { class: 'avo-fields', style: { margin: '16px 0' } },
      field('完整模式最多查询', text('max_sources', '6', 'number'), '每个番号最多查询几个来源'),
      field('刮削代理', text('proxy', 'http://192.168.1.2:7890'), '部分站点限制地区访问；也可以把站点域名加入宿主代理名单'),
      field('从 CookieCloud 导入的域名', text('cookiecloud_domains', 'javbus.com,javdb.com'), '浏览器里通过验证或登录后同步过来'),
      field('同时查询来源数', text('source_parallel', '4', 'number'), '一个番号同时查询几个来源（1–8）'),
      field('同站请求间隔（毫秒）', text('request_delay_ms', '1500', 'number'), '同一站点两次请求之间的最短间隔；不同站点互不等待'),
      field('模糊搜索优先来源',sourceChoices(ui,draft,{value:String(draft.search_sources||'javdb,javbus').split(/[,\s，]+/).filter(Boolean),searchOnly:true,onChange:value=>set('search_sources',value.join(','))}),'按顺序优先使用已启用的来源。')),
    el('div', { class: 'avo-notice info', style: { marginBottom: '14px' } }, icon('alert'),
      el('div', { class: 'avo-stack', style: { gap: '6px' } },
        switchInput('我已年满 18 岁：访问这些站点时自动确认年龄（等同在浏览器里点击“我已年满 18 岁”）', draft.age_confirm, value => set('age_confirm', value)),
        el('span', { class: 'avo-hint' }, '按站点设置年龄 Cookie 或提交年龄确认表单；登录、验证码和地区限制仍需自行配置。'))),
    field('来源顺序与启用', list),
    customErrors,
    el('div', { style: { marginTop: '16px' } }, field('字段来源优先（完整模式）', priority, '选择字段与优先来源，其他字段沿用整体来源顺序。')))
}

function uniqueId(base, taken) {
  let id = base, n = 2
  while (taken.includes(id)) id = `${base}-${n++}`
  return id
}

function sampleFor(def) {
  if (def.check?.sample) return def.check.sample
  const kind = def.kinds?.[0]
  return { fc2: 'FC2-PPV-1234567', carib: '010120-001', pondo: '010120_001', musume: '010120_01', heyzo: 'HEYZO-1234', tokyohot: 'N1234', prefixed: '300MIUM-123' }[kind] || 'SSIS-001'
}

// 测试一个来源：内置来源用已保存设置，编辑器里的规则直接随请求带上。
export function testDialog(ui, store, ctx, { source, sourceDef, name, sample }) {
  const { el, button } = ui
  const d = ui.dialog(`测试来源：${name}`, { width: 640, icon: 'play', subtitle: '按番号取一次详情，不走缓存，不写入任何文件' })
  const input = el('input', { class: 'avo-input', value: sample || 'SSIS-001', placeholder: '番号' })
  const result = el('div')
  d.body.append(ui.field('番号', input, sourceDef ? '直接测试编辑器里的规则' : '使用已保存的设置（地址、Cookie、年龄确认、代理）；改过的设置请先保存'), result)
  d.foot.append(button('关闭', { onClick: () => d.close() }), button('开始测试', { kind: 'primary', icon: 'play', onClick: async () => {
    const number = input.value.trim()
    if (!number) throw new Error('请填写番号')
    result.replaceChildren(el('div', { class: 'avo-skeleton', style: { height: '90px' } }))
    const started = Date.now()
    const run = await ctx.tasks.run('probe', `source-test:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, { text: number, ...(sourceDef ? { source_def: sourceDef } : { source }) })
    const done = await store.waitRun(run.id, 120000)
    const r = done.result || {}
    const meta = r.meta
    const ms = ((Date.now() - started) / 1000).toFixed(1)
    if (done.status !== 'succeeded') { result.replaceChildren(el('div', { class: 'avo-notice danger' }, done.error || '测试失败')); return }
    if (!meta) { result.replaceChildren(el('div', { class: 'avo-notice warning' }, el('div', { class: 'avo-stack', style: { gap: '4px' } }, el('b', {}, `没有取得数据（${ms} 秒）`), ...(r.logs || [r.reason]).filter(Boolean).map(line => el('div', {}, line))))); return }
    const rows = [['番号', meta.number], ['标题', meta.title], ['发行日期', meta.release_date], ['时长', meta.runtime ? `${meta.runtime} 分钟` : ''], ['厂商', meta.studio], ['发行商', meta.label], ['系列', meta.series], ['导演', meta.director],
      ['演员', (meta.actors || []).join('、')], ['标签', (meta.genres || []).join('、')], ['封面', meta.cover], ['海报', meta.poster], ['剧照', meta.samples?.length ? `${meta.samples.length} 张` : ''], ['简介', (meta.plot || '').slice(0, 120)]]
    const empty = rows.filter(([, v]) => !v).map(([k]) => k)
    result.replaceChildren(
      el('div', { class: 'avo-notice info' }, el('b', {}, `取得数据（${ms} 秒，${METHOD_LABEL[r.method] || ''}）`), empty.length ? el('span', {}, `；没取到：${empty.join('、')}`) : null),
      el('div', { class: 'avo-detail', style: { gridTemplateColumns: '110px 1fr', marginTop: '12px' } },
        meta.poster || meta.cover ? el('img', { class: 'poster', src: meta.poster || meta.cover, referrerpolicy: 'no-referrer', alt: meta.number }) : el('div', { class: 'poster' }),
        el('dl', { class: 'avo-kv' }, ...rows.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: /^https?:/.test(v) ? 'avo-path' : '' }, v)]))))
  } }))
}

// 预设来源的实测结果：用户网络不同，结果可能不同，以“测试”按钮为准。
const CHECK_BADGE = {
  ok: ['success', '已实测'], gated: ['warning', '需年龄确认'], region: ['warning', '需代理'], protected: ['warning', '有防护验证'],
  down: ['danger', '站点故障'], broken: ['danger', '暂不可用'], untested: ['', '未实测'],
}
function checkBadge(el, check) {
  if (!check) return null
  const [kind, label] = CHECK_BADGE[check.result] || CHECK_BADGE.untested
  return el('span', { class: `avo-badge ${kind}`, title: `${check.at} 实测${check.note ? '：' + check.note : ''}。不同网络结果可能不同，以“测试”为准` }, label)
}
