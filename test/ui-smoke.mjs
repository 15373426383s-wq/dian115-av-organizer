// 页面冒烟测试：用 jsdom 挂载插件页面，模拟宿主 ctx，逐个点击各标签与操作，捕获运行时错误。
// 需要 jsdom：在任意目录 npm i jsdom 后运行 JSDOM_DIR=<该目录> node test/ui-smoke.mjs（不在插件里安装依赖）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const { JSDOM } = createRequire(`${process.env.JSDOM_DIR || process.cwd()}/`)('jsdom')
const pluginRoot = process.argv[2] || new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://host.test/', pretendToBeVisual: true })
const { window } = dom
globalThis.window = window
const errors = []
window.addEventListener('error', e => errors.push(e.error || e.message))
process.on('unhandledRejection', e => errors.push(e))
window.navigator.clipboard = { writeText: async () => {} }
window.prompt = () => '新建目录'
window.confirm = () => true

const kv = new Map()
const now = Date.now()
kv.set('history', [
  { id: 'h1', at: new Date(now - 60000).toISOString(), status: 'success', source: '/mnt/in/a/SSIS-001-C.mp4', source_name: 'SSIS-001-C.mp4', size: 4e9, target: '/mnt/lib/演员甲/SSIS-001 标题/SSIS-001-C.mp4', meta_dir: '/mnt/lib/演员甲/SSIS-001 标题', base: 'SSIS-001-C',
    number: 'SSIS-001', title: '示例标题', original_title: '原标题', actors: ['演员甲', '演员乙'], genres: ['剧情', '单体作品'], studio: 'S1', label: 'S1', series: '新人', director: '导演', release_date: '2021-02-19', runtime: 120, plot: '简介文字',
    sources: ['javbus', 'javdb'], source_urls: { javbus: 'https://www.javbus.com/SSIS-001', javdb: 'https://javdb.com/v/x' }, flags: { chinese: true }, part: 0, method: 'exact', score: 100,
    files: { nfo: '/mnt/lib/x/SSIS-001-C.nfo', poster: '/mnt/lib/x/SSIS-001-C-poster.jpg', fanart: '/mnt/lib/x/SSIS-001-C-fanart.jpg', extrafanart: '/mnt/lib/x/extrafanart', extrafanart_count: 5, subtitles: ['/mnt/lib/x/SSIS-001-C.zh.srt'] }, cover: 'covers/abc.jpg', duration_ms: 5300, logs: ['ok'] },
  { id: 'h2', at: new Date(now - 3600000).toISOString(), status: 'success', number: 'MIDV-100', title: '模糊命中', actors: [], genres: [], sources: ['javdb'], method: 'fuzzy', score: 91, target: '/mnt/lib/MIDV-100.mp4', meta_dir: '/mnt/lib', base: 'MIDV-100', files: {} },
  { id: 'h3', at: new Date(now - 86400000 * 3).toISOString(), status: 'failed_moved', number: '', source: '/mnt/in/x.mp4', target: '/mnt/failed/x.mp4', note: '连续 3 次失败' },
])
kv.set('pending', {
  '/mnt/in/unknown clip.mp4': { path: '/mnt/in/unknown clip.mp4', name: 'unknown clip.mp4', size: 2e9, reason: '模糊搜索「unknown clip」：最高匹配度 62 低于阈值 85', attempts: 2, at: new Date(now - 1000).toISOString(), first_at: new Date(now - 7200000).toISOString(), next_attempt_at: new Date(now + 3600000).toISOString(),
    scores: [{ number: 'ABC-123', score: 62, title: '某标题' }], parsed: { cleaned: 'unknown clip', query: 'unknown clip', loose: [] }, logs: ['JavDB：未找到'] },
  '/mnt/in/ignored.mp4': { path: '/mnt/in/ignored.mp4', name: 'ignored.mp4', reason: '没有认出番号', attempts: 1, at: new Date(now).toISOString() },
})
kv.set('last_run', { at: new Date(now - 120000).toISOString(), duration_ms: 64000, success: 3, pending: 1, skipped: 0, scanned: 12 })
kv.set('ignore:x', null)
kv.set('subscription_state', { items: {
  'SSIS-001': { number: 'SSIS-001', enabled: true, status: 'waiting', created_at: new Date().toISOString(), attempts: 0 },
}, receipts: {} })
let subscriptionRevision = 1
let settings = { mode: 'local', action_mode: 'organize', inbox: '/mnt/in', local_target: '/mnt/lib', sources: 'javbus,javdb,fc2', fuzzy_threshold: 85, failed_folder: '/mnt/failed' }
const calls = []
const runs = []
const ctx = {
  id: 'local.av-organizer',
  theme: { mode: 'light', subscribe: fn => { fn('light'); return () => {} } },
  settings: { get: async () => ({ ...settings }), set: async value => { settings = { ...value }; calls.push(['settings.set', value]); return { revision: 1 } } },
  storage: { get: async key => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); calls.push(['storage.set', key]); return { revision: 1 } }, remove: async key => { kv.delete(key); calls.push(['storage.remove', key]); return { ok: true } }, list: async () => [] },
  watch: { list: async () => [{ id: 'inbox', job: 'organize', kind: 'local', path: '/mnt/in' }], add: async w => { calls.push(['watch.add', w]); return { ok: true } }, remove: async id => { calls.push(['watch.remove', id]); return { ok: true } } },
  tasks: {
    run: async (job, key, input) => { calls.push(['tasks.run', job, input]); const r = { id: 'run-' + runs.length, job_id: job, status: 'queued', input }; runs.push(r); return r },
    get: async id => {
      const r = runs.find(item => item.id === id)
      if (r.job_id === 'probe') return { ...r, status: 'succeeded', result: { ok: true, method: 'fuzzy', score: 92, meta: { number: 'SSIS-001', title: 'T', actors: ['A'], sources: ['javbus'], cover: 'https://img/c.jpg', samples: ['x'] }, scores: [{ number: 'SSIS-001', score: 92, title: 'T' }], logs: ['l'] } }
      return { ...r, status: 'succeeded', result: { rescraped: [{ ok: true }] } }
    },
    list: async () => [{ id: 'r0', job_id: 'organize', status: 'attention_required', updated_at: new Date().toISOString() }],
    retry: async id => { calls.push(['tasks.retry', id]); return {} },
  },
  files: {
    call: async options => {
      calls.push(['files.call', options])
      if (options.operation === 'list') return [{ name: 'movies', path: options.path.replace(/\/$/, '') + '/movies', is_dir: true, modified: new Date().toISOString() }, { name: 'a.txt', path: '/a.txt', is_dir: false }]
      return { ok: true }
    },
    downloadURL: path => '/files/download?path=' + encodeURIComponent(path),
  },
  cd2: { call: async (method, options) => { calls.push(['cd2.call', method, options]); return method === 'list' ? [{ name: '115', path: '/115', is_dir: true }] : {} } },
  api: { get: async path => {
    calls.push(['api.get', path])
    if (path.endsWith('/storage/subscription_state')) return structuredClone({ value: kv.get('subscription_state'), revision: subscriptionRevision })
    if (path === '/api/pt/sites') return { data: [{ id: 7, name: '馒头', parser_type: 'mteam', url: 'https://m-team.test' }] }
    if (path === '/api/pt/downloaders') return { data: [{ name: 'qb-av' }] }
    if (path.endsWith('/media/badges')) return { active_id: 'builtin', packs: [{ name: '默认', badges: [{ name: '4K', asset_url: '/api/resource-badges/assets/a/b/c' }] }] }
    return path === '/api/rules' ? [{ id: 7, name: 'AV', source_path: '/115/AV', output_path: '/strm/AV', generate_strm: true, meta_sync: 'cloud_overwrite', sync_mode: 'cron' }] : {}
  }, post: async (path, body) => { calls.push(['api.post', path, body]); return {} }, put: async (path, body) => {
    assert.ok(path.endsWith('/storage/subscription_state'))
    assert.equal(body.expected_revision, subscriptionRevision)
    kv.set('subscription_state', structuredClone(body.value)); subscriptionRevision++
  } },
}

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const root = window.document.getElementById('root')
const { mount } = await import(pathToFileURL(pluginRoot + '/ui/page.js').href)
const cleanup = await mount(root, ctx)
await tick()
const $ = selector => window.document.querySelector(selector)
const $$ = selector => [...window.document.querySelectorAll(selector)]
const clickText = (text, scope = window.document) => {
  const node = [...scope.querySelectorAll('button, a, .avo-tab, .avo-dir, .avo-chip, .avo-item, .avo-cover, label')].find(n => n.textContent.trim().includes(text))
  assert.ok(node, `找不到按钮：${text}`)
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return node
}
const text = () => root.textContent

// 概览
assert.match(text(), /已整理/)
assert.match(text(), /核对并继续/)
assert.match(text(), /JavBus/)
assert.equal($$('.avo-cover').length, 2)
clickText('核对并继续'); await tick()
assert.ok(calls.some(c => c[0] === 'tasks.retry'))
clickText('立即整理'); await tick()
assert.ok(calls.some(c => c[0] === 'tasks.run' && c[1] === 'organize'))
// 封面墙点开详情
$$('.avo-cover')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick()
assert.ok($('.avo-overlay.drawer'), '详情抽屉未打开')
const drawer = $('.avo-overlay.drawer')
assert.match(drawer.textContent, /演员甲/)
assert.match(drawer.textContent, /JavDB/)
assert.match(drawer.textContent, /剧照/)
assert.match(drawer.textContent, /匹配度|精确番号/)
clickText('重新刮削', drawer); await tick(100)
assert.ok(calls.some(c => c[0] === 'tasks.run' && c[2]?.rescrape?.[0] === 'h1'))
$$('.avo-overlay').forEach(n => n.remove())

// 整理记录
clickText('整理记录'); await tick()
assert.equal($$('.avo-item').length, 3)
const search = $('.avo-toolbar input')
search.value = 'MIDV'; search.dispatchEvent(new window.Event('input')); await tick()
assert.equal($$('.avo-item').length, 1)
search.value = ''; search.dispatchEvent(new window.Event('input'))
const methodSelect = $$('.avo-toolbar select')[1]
methodSelect.value = 'fuzzy'; methodSelect.dispatchEvent(new window.Event('change')); await tick()
assert.equal($$('.avo-item').length, 1)
assert.match($('.avo-item').textContent, /模糊匹配 91/)
$('.avo-item').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick()
assert.ok($('.avo-overlay.drawer'))
$$('.avo-overlay').forEach(n => n.remove())

// 待处理
clickText('待处理'); await tick()
assert.equal($$('.avo-pending').length, 2)
const cardOf = name => $$('.avo-pending').find(n => n.textContent.includes(name))
const card = cardOf('unknown clip')
assert.match(card.textContent, /低于阈值/)
clickText('ABC-123', card); await tick()
assert.equal(card.querySelector('.avo-inline input').value, 'ABC-123')
clickText('按番号整理', card); await tick(80)
assert.ok(calls.some(c => c[0] === 'storage.set' && String(c[1]).startsWith('manual:')))
clickText('忽略', cardOf('ignored.mp4')); await tick(80)
assert.ok(calls.some(c => c[0] === 'storage.set' && String(c[1]).startsWith('ignore:')))
clickText('改名', cardOf('unknown clip')); await tick()
const renameInput = $('.avo-overlay input')
renameInput.value = 'SSIS-002.mp4'; renameInput.dispatchEvent(new window.Event('input')); await tick()
assert.match($('.avo-overlay').textContent, /SSIS-002/)
clickText('改名并整理', $('.avo-overlay')); await tick(80)
assert.ok(calls.some(c => c[0] === 'files.call' && c[1].operation === 'rename' && c[1].name === 'SSIS-002.mp4'))

// 识别测试
clickText('识别测试'); await tick()
const probeInput = $('.avo-card input')
probeInput.value = 'hhd800.com@SSIS-001-C.mp4'; probeInput.dispatchEvent(new window.Event('input')); await tick()
assert.match(text(), /SSIS-001/)
assert.match(text(), /中文字幕/)
clickText('测试匹配'); await tick(150)
assert.match(text(), /会自动整理为 SSIS-001/)
const sourceInput = $$('.avo-card')[1].querySelector('input')
sourceInput.value = 'SSIS-001'
clickText('检测全部来源'); await tick(300)
assert.ok($$('.avo-card')[1].querySelectorAll('tr').length >= 5, '来源检测应覆盖已启用的多个来源')

// 插件内订阅：添加任务、暂停/恢复、独立配置，不改变宿主订阅。
clickText('番号订阅'); await tick()
assert.match(text(), /无资源时按周期继续搜索/)
assert.equal($('.avo-sub-settings').open, false, '订阅设置默认收起')
assert.equal($('.avo-sub-detail').hidden, true, '记录详情默认收起')
clickText('详情', root.querySelector('article')); await tick()
assert.equal($('.avo-sub-detail').hidden, false)
const subQuery = $('[aria-label="搜索订阅"]')
subQuery.value = 'NO-MATCH'; subQuery.dispatchEvent(new window.Event('input')); await tick()
assert.equal(root.querySelectorAll('article').length, 0)
subQuery.value = ''; subQuery.dispatchEvent(new window.Event('input')); await tick()
assert.equal(root.querySelectorAll('article').length, 1)
const addNumber = $('[aria-label="添加订阅番号"]')
addNumber.value = 'SSIS-001 MIDV-100'; addNumber.dispatchEvent(new window.Event('input'))
clickText('添加并搜索'); await tick()
assert.ok(calls.some(c => c[0] === 'tasks.run' && c[1] === 'subscriptions' && c[2].text === 'SSIS-001 MIDV-100'))
clickText('暂停', root.querySelector('article')); await tick()
assert.equal(kv.get('subscription_state').items['SSIS-001'].enabled, false)
clickText('恢复', root.querySelector('article')); await tick()
assert.equal(kv.get('subscription_state').items['SSIS-001'].enabled, true)
root.querySelector('.avo-sub-settings').open = true
await tick()
assert.equal($('[aria-label="115 保存目录"]').readOnly,true)
assert.ok($('[aria-label="115 账号"]'))
assert.match(text(), /qb-av/)
clickText('添加查询源示例'); await tick()
clickText('保存订阅设置'); await tick()
assert.equal(kv.get('subscription_config').sources[0].target, '115')
assert.equal(kv.get('subscription_config').interval_minutes, 60)
const jsonInput = $('[aria-label="数据库查询源 JSON"]')
jsonInput.value = '{}'; jsonInput.dispatchEvent(new window.Event('input'))
clickText('保存订阅设置'); await tick()
assert.match(text(), /查询源必须是 JSON 数组/)
jsonInput.value = '[]'; jsonInput.dispatchEvent(new window.Event('input'))
clickText('保存订阅设置'); await tick()

// 设置
clickText('文件管理'); await tick()
assert.match(text(), /整理选项/)
const fileCheck = root.querySelector('input[type=checkbox]')
fileCheck.checked = true; fileCheck.dispatchEvent(new window.Event('change'))
clickText('整理选中项'); await tick()
assert.ok(calls.some(c => c[0] === 'tasks.run' && c[1] === 'organize' && c[2].scan_root === '/mnt/in' && c[2].paths.length === 1))
clickText('演员资料'); await tick()
assert.match(text(), /同步下一页/)
clickText('同步下一页'); await tick()
assert.ok(calls.some(c => c[0] === 'tasks.run' && c[1] === 'actors'))
clickText('设置'); await tick(50)
assert.equal($$('.avo-settings-main>.avo-section').filter(node => !node.hidden).length, 1, '设置只展示一个分区')
clickText('图片与水印', $('.avo-settings-nav')); await tick()
assert.equal($$('.avo-settings-main>.avo-section').find(node => !node.hidden).dataset.section, '图片与水印')
assert.match(text(), /翻译与完整性/)
assert.match(text(), /多目录与文件/)
clickText('读取图片标记'); await tick()
clickText('添加所选标记'); await tick()
clickText('基本', $('.avo-settings-nav')); await tick()
assert.match(text(), /工作模式/)
assert.match(text(), /预览/)
assert.match(text(), /SSIS-001/)
// 切换到 STRM 模式，规则下拉出现并提示云端覆盖
clickText('CD2 + STRM'); await tick(50)
const select = [...root.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '7'))
assert.ok(select, 'STRM 规则下拉未出现')
select.value = '7'; select.dispatchEvent(new window.Event('change')); await tick()
assert.match(text(), /云端覆盖/)
// 路径浏览器
const inboxField=$$('.avo-field').find(n=>n.querySelector('label')?.textContent==='收件目录')
clickText('选择',inboxField); await tick(50)
assert.ok($('.avo-overlay .avo-file-list'))
clickText('movies', $('.avo-overlay')); await tick(50)
const storageSelect=$('.avo-overlay [aria-label="存储位置"]')
storageSelect.value='cd2';storageSelect.dispatchEvent(new window.Event('change'));await tick(50)
assert.ok(calls.some(c => c[0] === 'cd2.call' && c[1] === 'list'))
clickText('选择此目录', $('.avo-overlay')); await tick(50)
// 刮削来源管理：预设清单、启用切换、排序、新建自定义来源
clickText('刮削来源', $('.avo-settings-nav')); await tick()
assert.match(text(), /刮削来源/)
const sourceRows = $$('.avo-source')
assert.ok(sourceRows.length >= 20, '来源清单数量 ' + sourceRows.length)
const firstCheckbox = sourceRows[0].querySelector('input[type=checkbox]')
firstCheckbox.checked = !firstCheckbox.checked; firstCheckbox.dispatchEvent(new window.Event('change')); await tick()
const checkboxFor = name => $$('.avo-source').find(row => row.textContent.includes(name)).querySelector('input[type=checkbox]')
for (const name of ['AVSOX', 'FreeJavBT', '7mmtv']) {
  const checkbox = checkboxFor(name); checkbox.checked = false; checkbox.dispatchEvent(new window.Event('change'))
}
clickText('启用 HEYZO 备用源'); await tick()
for (const name of ['AVSOX', 'FreeJavBT', '7mmtv']) assert.equal(checkboxFor(name).checked, true)
assert.equal(checkboxFor('JavBus').checked, false, '启用备用源不应改动其他来源开关')
const downButton = $$('.avo-source')[0].querySelector('button[title=下移]')
downButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick()
clickText('新建来源'); await tick()
assert.match($('.avo-overlay').textContent, /规则有效/)
clickText('保存', $('.avo-overlay')); await tick(50)
assert.ok(!$('.avo-overlay'), '保存后对话框应关闭')
assert.ok($$('.avo-source').some(n => n.textContent.includes('我的来源')), '自定义来源未出现在清单')
// 自定义清理错误提示
clickText('识别', $('.avo-settings-nav')); await tick()
const cleanArea = [...root.querySelectorAll('textarea')][0]
cleanArea.value = '/(bad/'; cleanArea.dispatchEvent(new window.Event('input')); await tick()
assert.match(text(), /无效/)
cleanArea.value = ''; cleanArea.dispatchEvent(new window.Event('input'))
clickText('保存设置'); await tick(80)
assert.ok(calls.some(c => c[0] === 'settings.set'), '设置未保存')
assert.equal(settings.strm_rule_id, 7)
assert.ok(JSON.parse(settings.custom_sources).some(def => def.id === 'my-source'), '自定义来源未保存')
assert.ok(settings.source_order, '来源顺序未保存')
assert.ok(Object.values(JSON.parse(settings.source_config)).some(item => typeof item.enabled === 'boolean'), '启用状态未保存')
for (const id of ['avsox', 'freejavbt', 'mmtv']) assert.equal(JSON.parse(settings.source_config)[id].enabled, true)
assert.equal(JSON.parse(settings.source_config).javbus.enabled, false)
assert.equal(settings.mode, 'strm')
assert.ok(String(settings.inbox).startsWith('cd2:'), '路径浏览器选择的目录没有写入：' + settings.inbox)

cleanup()
await tick()
if (errors.length) { console.error(errors); process.exit(1) }
console.log('页面冒烟测试通过：概览、详情抽屉、整理记录、待处理、识别测试、番号订阅、设置与路径浏览器')
process.exit(0)
