import test from 'node:test'
import assert from 'node:assert/strict'
import { run, recover } from '../jobs/organize.js'
import { mergeMeta } from '../jobs/lib/scrape.js'
import { resolveDestination, normalizeSettings } from '../jobs/lib/plan.js'
import { manualKey, ignoreKey } from '../ui/lib/keys.js'

const fakeCatalog = {
  'SSIS-001': { number: 'SSIS-001', title: '测试标题', actors: ['演员A'], genres: ['剧情'], release_date: '2021-02-19', cover: 'https://img.test/c.jpg', studio: 'S1' },
  'ABC-012': { number: 'ABC-012', title: '温泉旅行 完整版', actors: ['演员B'], cover: 'https://img.test/d.jpg' },
  'MIDV-100': { number: 'MIDV-100', title: '新人出道 透明感美少女', actors: ['演员C'], cover: 'https://img.test/e.jpg' },
  'MIDV-101': { number: 'MIDV-101', title: '新人出道 透明感美少女 第二弹', actors: ['演员C'], cover: 'https://img.test/f.jpg' },
}
let fakeSearch = []
let fakeRequests = 0
// 测试用自定义来源：JSON 类型规则，经由真实的规则引擎执行。
const FAKE_SOURCE = {
  id: 'fake', name: 'Fake', type: 'json', base: 'https://fake.test',
  kinds: ['standard', 'prefixed', 'fc2', 'carib', 'pondo', 'musume', 'heyzo', 'tokyohot', 'heydouga'],
  detail: { url: '{base}/v/{number}.json' },
  search: { url: '{base}/search.json?q={keyword}', json: 'items', number_json: 'number', title_json: 'title', link_template: '{base}/v/{number}.json' },
  fields: {
    number: { json: 'number' }, title: { json: 'title' }, actors: { json: 'actors', all: true }, genres: { json: 'genres', all: true },
    release_date: { json: 'release_date' }, studio: { json: 'studio' }, cover: { json: 'cover' }, samples: { json: 'samples', all: true },
  },
}
async function fakeRequest(options) {
  const url = new URL(options.url)
  if (options.save_to) return { status: 200, size: 5000, path: options.save_to }
  fakeRequests++
  if (url.pathname === '/search.json') return { status: 200, url: options.url, body: JSON.stringify({ items: fakeSearch }) }
  const number = decodeURIComponent(url.pathname.replace(/^\/v\//, '').replace(/\.json$/, ''))
  const meta = fakeCatalog[number]
  return meta ? { status: 200, url: options.url, body: JSON.stringify(meta) } : { status: 404, url: options.url, body: '' }
}

const MB = 1024 * 1024

function fakeCtx({ settings, files, rules = [] }) {
  const storage = new Map()
  const moves = [], writes = [], posts = [], dirs = []
  const existing = new Set()
  const ctx = {
    settings: { get: async () => settings },
    storage: { get: async key => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, structuredClone(value)); return 1 }, remove: async key => storage.delete(key) },
    task: { id: 't1', update: async () => {}, log: async () => {}, checkpoint: async () => {} },
    crypto: { sha1: value => Buffer.from(value).toString('hex').slice(0, 16) },
    sleep: async () => {},
    html: {},
    http: { request: fakeRequest, cookies: async () => [], importCookies: async () => ({}) },
    cookiecloud: async () => ({ cookies: [] }),
    notify: async () => ({}),
    api: {
      get: async path => { if (path === '/api/rules') return rules; throw new Error('unexpected ' + path) },
      post: async (path, body) => { posts.push(path); return {} },
    },
    cd2: { call: async (method, options) => (method === 'list' ? files.filter(f => f.dir === options.path) : null) },
    files: {
      call: async options => {
        switch (options.operation) {
          case 'walk': return files.map(f => ({ ...f, is_dir: false }))
          case 'exists': return existing.has(options.path)
          case 'mkdir': dirs.push(options.path); return { path: options.path }
          case 'write': writes.push(options); return { size: options.content.length }
          case 'move': moves.push([options.path, options.destination]); existing.add(options.destination); return { backend: 'system' }
          case 'remove': return {}
          default: throw new Error('unexpected ' + options.operation)
        }
      },
    },
  }
  return { ctx, storage, moves, writes, posts, dirs, existing }
}

const baseSettings = { inbox: '/mnt/in', custom_sources: JSON.stringify([FAKE_SOURCE]), source_config: JSON.stringify({ fake: { enabled: true } }), search_sources: 'fake', min_size_mb: 0, stable_seconds: 0, download_images: false }

test('纯本地模式：先写元数据再移动视频，字幕同名跟随，刷新 Emby', async () => {
  const files = [
    { name: 'hhd800.com@SSIS-001-C.mp4', path: '/mnt/in/a/hhd800.com@SSIS-001-C.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' },
    { name: 'hhd800.com@SSIS-001-C.zh.srt', path: '/mnt/in/a/hhd800.com@SSIS-001-C.zh.srt', size: 10, modified: '2020-01-01T00:00:00Z' },
    { name: 'random video.mp4', path: '/mnt/in/random video.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' },
  ]
  const { ctx, storage, moves, writes, posts } = fakeCtx({ settings: { ...baseSettings, mode: 'local', local_target: '/mnt/lib' }, files })
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.equal(result.pending, 1)
  const dir = '/mnt/lib/演员A/SSIS-001 测试标题'
  assert.deepEqual(moves.map(m => m[1]), [`${dir}/SSIS-001-C.nfo`, `${dir}/SSIS-001-C.zh.srt`, `${dir}/SSIS-001-C.mp4`])
  assert.match(writes[0].content, /<num>SSIS-001<\/num>/)
  assert.match(writes[0].content, /<tag>中文字幕<\/tag>/)
  assert.deepEqual(posts, ['/api/emby-control/library/refresh'])
  const pending = storage.get('pending')
  assert.match(pending['/mnt/in/random video.mp4'].reason, /模糊搜索「random video」没有结果/)
  assert.equal(storage.get('history')[0].number, 'SSIS-001')
})

test('CD2 + STRM 模式：视频进规则源目录，元数据写到输出目录同一相对位置，并触发规则同步', async () => {
  const files = [{ name: 'SSIS-001.mkv', path: '/115/inbox/SSIS-001.mkv', dir: '/115/inbox', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]
  const rules = [{ id: 7, name: 'AV', source_path: '/115/AV', output_path: '/strm/AV', generate_strm: true, sync_mode: 'cron', meta_sync: 'none' }]
  const { ctx, moves, posts } = fakeCtx({ settings: { ...baseSettings, inbox: 'cd2:/115/inbox', mode: 'strm', strm_rule_id: 7 }, files, rules })
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.deepEqual(moves, [
    [moves[0][0], '/strm/AV/演员A/SSIS-001 测试标题/SSIS-001.nfo'],
    ['cd2:/115/inbox/SSIS-001.mkv', 'cd2:/115/AV/演员A/SSIS-001 测试标题/SSIS-001.mkv'],
  ])
  assert.deepEqual(posts, ['/api/rules/7/sync'])
})

test('目标已存在时跳过不覆盖，文件留在待确认', async () => {
  const files = [{ name: 'SSIS-001.mp4', path: '/mnt/in/SSIS-001.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]
  const { ctx, moves, existing, storage } = fakeCtx({ settings: { ...baseSettings, mode: 'local', local_target: '/mnt/lib' }, files })
  existing.add('/mnt/lib/演员A/SSIS-001 测试标题/SSIS-001.mp4')
  const result = await run(ctx, {})
  assert.equal(result.skipped, 1)
  assert.equal(moves.length, 0)
  assert.match(storage.get('pending')['/mnt/in/SSIS-001.mp4'].reason, /目标已存在/)
})

test('待确认文件未变化时不重复刮削；人工指定番号后重新整理', async () => {
  const files = [{ name: 'unknown clip.mp4', path: '/mnt/in/unknown clip.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]
  const { ctx, moves } = fakeCtx({ settings: { ...baseSettings, mode: 'local', local_target: '/mnt/lib' }, files })
  assert.equal((await run(ctx, {})).pending, 1)
  assert.equal((await run(ctx, {})).pending, 0) // 未变化，跳过
  // 页面"指定番号"写入控制键，下一轮整理读取。
  await ctx.storage.set(manualKey('/mnt/in/unknown clip.mp4'), { number: 'ssis001', at: '2026-01-01T00:00:00Z' })
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.equal(moves.at(-1)[1], '/mnt/lib/演员A/SSIS-001 测试标题/SSIS-001.mp4')
  assert.equal(await ctx.storage.get(manualKey('/mnt/in/unknown clip.mp4')), null, '成功后清理控制键')
})

test('刮削不到时进入待确认并记录原因', async () => {
  const files = [{ name: 'ABC-999.mp4', path: '/mnt/in/ABC-999.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]
  const { ctx, storage, moves } = fakeCtx({ settings: { ...baseSettings, mode: 'local', local_target: '/mnt/lib' }, files })
  await run(ctx, {})
  assert.equal(moves.length, 0)
  assert.match(storage.get('pending')['/mnt/in/ABC-999.mp4'].reason, /刮削失败/)
})

test('设置校验：目标与收件目录互相包含时拒绝', () => {
  assert.throws(() => resolveDestination(normalizeSettings({ inbox: '/mnt/in', mode: 'local', local_target: '/mnt/in/lib' })), /互相包含/)
  assert.throws(() => resolveDestination(normalizeSettings({ inbox: '/mnt/in', mode: 'strm', strm_rule_id: 3 }), []), /STRM 规则/)
  const destination = resolveDestination(normalizeSettings({ inbox: '/mnt/in', mode: 'strm', strm_rule_id: 3 }), [{ id: 3, name: 'R', source_path: '/115/AV', output_path: '/strm', meta_sync: 'cloud_overwrite', sync_mode: 'realtime' }])
  assert.equal(destination.videoRoot, 'cd2:/115/AV')
  assert.equal(destination.rule.realtime, true)
  assert.match(destination.warnings[0], /云端覆盖/)
})

test('多来源合并：标量取第一个有值的来源，类别合并', () => {
  const merged = mergeMeta([
    { source: 'a', number: 'X-1', title: 'T', actors: [], genres: ['g1'] },
    { source: 'b', number: 'X-1', title: 'T2', cover: 'c', actors: ['A'], genres: ['g1', 'g2'] },
  ])
  assert.equal(merged.title, 'T')
  assert.equal(merged.cover, 'c')
  assert.deepEqual(merged.actors, ['A'])
  assert.deepEqual(merged.genres, ['g1', 'g2'])
  assert.deepEqual(merged.sources, ['a', 'b'])
})

test('中断恢复：视频已到目标位置时补记历史', async () => {
  const { ctx, storage, existing } = fakeCtx({ settings: baseSettings, files: [] })
  existing.add('/mnt/lib/x.mp4')
  const decision = await recover(ctx, { stage: 'file', path: '/mnt/in/x.mp4', videoTarget: '/mnt/lib/x.mp4', number: 'X-001' })
  assert.deepEqual(decision, { action: 'resume' })
  assert.equal(storage.get('history')[0].target, '/mnt/lib/x.mp4')
})

const localSettings = { ...baseSettings, mode: 'local', local_target: '/mnt/lib' }
const oneFile = name => [{ name, path: `/mnt/in/${name}`, size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]

test('模糊搜索：匹配度达到阈值且领先足够时自动整理', async () => {
  fakeSearch = [{ number: 'SSIS-001', title: '测试标题 特别篇' }, { number: 'IPX-999', title: '完全无关的作品' }]
  const { ctx, moves, storage } = fakeCtx({ settings: localSettings, files: oneFile('[合集] 测试标题 特别篇.mp4') })
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.equal(moves.at(-1)[1], '/mnt/lib/演员A/SSIS-001 测试标题/SSIS-001.mp4')
  const item = storage.get('history')[0]
  assert.equal(item.method, 'fuzzy')
  assert.ok(item.score >= 85, String(item.score))
})

test('模糊搜索：低于阈值不整理，待确认里记录匹配度', async () => {
  fakeSearch = [{ number: 'SSIS-001', title: '另一部片子的标题' }]
  const { ctx, moves, storage } = fakeCtx({ settings: localSettings, files: oneFile('测试标题 特别篇.mp4') })
  await run(ctx, {})
  assert.equal(moves.length, 0)
  const entry = storage.get('pending')['/mnt/in/测试标题 特别篇.mp4']
  assert.match(entry.reason, /低于阈值 85/)
  assert.equal(entry.scores[0].number, 'SSIS-001')
})

test('模糊搜索：前两名太接近时不整理（同系列作品）', async () => {
  fakeSearch = [{ number: 'MIDV-100', title: '新人出道 透明感美少女' }, { number: 'MIDV-101', title: '新人出道 透明感美少女 第二弹' }]
  const { ctx, moves, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_threshold: 70, fuzzy_margin: 20 }, files: oneFile('新人出道 透明感美少女.mp4') })
  await run(ctx, {})
  assert.equal(moves.length, 0)
  assert.match(storage.get('pending')['/mnt/in/新人出道 透明感美少女.mp4'].reason, /相差不足 20/)
})

test('模糊匹配度阈值可调：调低后自动整理', async () => {
  fakeSearch = [{ number: 'MIDV-100', title: '新人出道 透明感美少女' }]
  const { ctx, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_threshold: 60 }, files: oneFile('新人出道 美少女.mp4') })
  assert.equal((await run(ctx, {})).success, 1)
  assert.equal(storage.get('history')[0].number, 'MIDV-100')
})

test('关闭模糊匹配后只认精确番号', async () => {
  fakeSearch = [{ number: 'SSIS-001', title: '测试标题 特别篇' }]
  const { ctx, moves } = fakeCtx({ settings: { ...localSettings, fuzzy_enabled: false }, files: oneFile('测试标题 特别篇.mp4') })
  await run(ctx, {})
  assert.equal(moves.length, 0)
})

test('宽松番号：两位数编号需要标题线索达到阈值', async () => {
  fakeSearch = []
  const pass = fakeCtx({ settings: { ...localSettings, fuzzy_min_chars: 2 }, files: oneFile('abc 12 温泉旅行 完整版.mp4') })
  assert.equal((await run(pass.ctx, {})).success, 1)
  assert.equal(pass.storage.get('history')[0].method, 'loose')
  const fail = fakeCtx({ settings: { ...localSettings, fuzzy_min_chars: 2 }, files: oneFile('abc 12 无关文字很多很多.mp4') })
  await run(fail.ctx, {})
  assert.equal(fail.moves.length, 0)
})

test('自定义清理：替换规则先于识别执行', async () => {
  const { ctx, storage } = fakeCtx({ settings: { ...localSettings, clean_rules: '# 站点前缀\n/^私藏@/\nXYZ => SSIS-' }, files: oneFile('私藏@XYZ001.mp4') })
  assert.equal((await run(ctx, {})).success, 1)
  assert.equal(storage.get('history')[0].number, 'SSIS-001')
})

test('测试匹配任务：走同一识别流程，不移动文件', async () => {
  const { run: probe } = await import('../jobs/probe.js')
  fakeSearch = [{ number: 'SSIS-001', title: '测试标题 特别篇' }]
  const { ctx, moves } = fakeCtx({ settings: localSettings, files: [] })
  const result = await probe(ctx, { text: '测试标题 特别篇' })
  assert.equal(result.ok, true)
  assert.equal(result.method, 'fuzzy')
  assert.equal(result.meta.number, 'SSIS-001')
  assert.equal(moves.length, 0)
})

test('待确认自动重试：到点后无需人工再次尝试，间隔逐次翻倍', async () => {
  const files = oneFile('unknown clip 2.mp4')
  const { ctx, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_enabled: false }, files })
  await run(ctx, {})
  const first = storage.get('pending')['/mnt/in/unknown clip 2.mp4']
  assert.equal(first.attempts, 1)
  const delay = Date.parse(first.next_attempt_at) - Date.now()
  assert.ok(delay > 50 * 60 * 1000 && delay <= 3600 * 1000, String(delay))
  // 模拟到点
  storage.set('pending', { '/mnt/in/unknown clip 2.mp4': { ...first, next_attempt_at: new Date(Date.now() - 1000).toISOString() } })
  await run(ctx, {})
  const second = storage.get('pending')['/mnt/in/unknown clip 2.mp4']
  assert.equal(second.attempts, 2)
  assert.ok(Date.parse(second.next_attempt_at) - Date.now() > 110 * 60 * 1000)
})

test('单个文件的宿主操作出错不中断整批，并上报任务级计数', async () => {
  const files = [...oneFile('SSIS-001.mp4'), { name: 'SSIS-001-C.mp4', path: '/mnt/in/b/SSIS-001-C.mp4', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }]
  const { ctx, storage } = fakeCtx({ settings: localSettings, files })
  const updates = []
  ctx.task.update = async value => { updates.push(value) }
  const call = ctx.files.call
  ctx.files.call = async options => {
    if (options.operation === 'move' && options.path === '/mnt/in/SSIS-001.mp4') throw new Error('磁盘已满')
    return call(options)
  }
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.equal(result.pending, 1)
  assert.match(storage.get('pending')['/mnt/in/SSIS-001.mp4'].reason, /磁盘已满/)
  const last = updates.at(-1)
  assert.deepEqual([last.total, last.done, last.failed, last.progress], [2, 1, 1, 100])
})

test('整理记录带完整详情：元数据、来源、文件路径、封面缓存', async () => {
  fakeCatalog['SSIS-001'].samples = ['https://img.test/s1.jpg', 'https://img.test/s2.jpg']
  const { ctx, storage, moves } = fakeCtx({ settings: { ...localSettings, download_images: true, download_extrafanart: true, actor_map: '演员A => 演员甲' }, files: oneFile('SSIS-001-C.mp4') })
  const copies = []
  const call = ctx.files.call
  ctx.files.call = async options => { if (options.operation === 'copy') { copies.push(options); return {} } return call(options) }
  assert.equal((await run(ctx, {})).success, 1)
  const item = storage.get('history')[0]
  assert.ok(item.id)
  assert.equal(item.title, '测试标题')
  assert.deepEqual(item.actors, ['演员甲'])
  assert.deepEqual(item.sources, ['fake'])
  assert.equal(item.method, 'exact')
  assert.equal(item.flags.chinese, true)
  const dir = '/mnt/lib/演员甲/SSIS-001 测试标题'
  assert.equal(item.files.nfo, `${dir}/SSIS-001-C.nfo`)
  assert.equal(item.files.poster, `${dir}/SSIS-001-C-poster.jpg`)
  assert.equal(item.files.extrafanart_count, 2)
  assert.ok(moves.some(m => m[1] === `${dir}/extrafanart/fanart2.jpg`))
  assert.match(item.cover, /^covers\/[0-9a-f]+\.jpg$/)
  assert.equal(copies[0].destination, item.cover)
  delete fakeCatalog['SSIS-001'].samples
})

test('页面写入忽略标记后不再处理', async () => {
  const { ctx, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_enabled: false }, files: oneFile('noise.mp4') })
  await run(ctx, {})
  await ctx.storage.set(ignoreKey('/mnt/in/noise.mp4'), { at: 'x' })
  const entry = storage.get('pending')['/mnt/in/noise.mp4']
  storage.set('pending', { '/mnt/in/noise.mp4': { ...entry, next_attempt_at: new Date(0).toISOString() } })
  await run(ctx, { retry_pending: true })
  assert.equal(storage.get('pending')['/mnt/in/noise.mp4'].attempts, 1)
})

test('原地刮削：视频不动，元数据写在视频旁边，下次不重复处理', async () => {
  const { ctx, moves, storage } = fakeCtx({ settings: { ...baseSettings, action_mode: 'in_place' }, files: [{ name: 'SSIS-001.mkv', path: '/mnt/in/a/SSIS-001.mkv', size: 900 * MB, modified: '2020-01-01T00:00:00Z' }] })
  assert.equal((await run(ctx, {})).success, 1)
  assert.deepEqual(moves.map(m => m[1]), ['/mnt/in/a/SSIS-001.nfo'])
  assert.equal(storage.get('history')[0].in_place, true)
  assert.equal((await run(ctx, {})).success, 0)
})

test('只整理不刮削：按番号模板移动，不访问刮削来源', async () => {
  const before = fakeRequests
  const { ctx, moves } = fakeCtx({ settings: { ...localSettings, action_mode: 'rename_only' }, files: oneFile('hhd800.com@ssis001.mp4') })
  assert.equal((await run(ctx, {})).success, 1)
  assert.equal(moves.at(-1)[1], '/mnt/lib/SSIS/SSIS-001/SSIS-001.mp4')
  assert.equal(fakeRequests, before, '只整理模式不应联网')
})

test('连续失败达到次数后移到失败目录', async () => {
  const { ctx, moves, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_enabled: false, failed_folder: '/mnt/failed', failed_move_after: 1 }, files: oneFile('noise2.mp4') })
  await run(ctx, {})
  assert.deepEqual(moves.at(-1), ['/mnt/in/noise2.mp4', '/mnt/failed/noise2.mp4'])
  assert.equal(storage.get('pending')['/mnt/in/noise2.mp4'], undefined)
  assert.equal(storage.get('history')[0].status, 'failed_moved')
})

test('重新刮削：不走缓存，覆盖元数据并更新记录', async () => {
  const { ctx, storage, writes } = fakeCtx({ settings: localSettings, files: oneFile('SSIS-001.mp4') })
  await run(ctx, {})
  const id = storage.get('history')[0].id
  fakeCatalog['SSIS-001'].title = '新标题'
  const result = await run(ctx, { rescrape: [id], rescrape_only: true })
  assert.equal(result.rescraped[0].ok, true)
  assert.equal(storage.get('history')[0].title, '新标题')
  assert.ok(storage.get('history')[0].rescraped_at)
  assert.match(writes.at(-1).content, /新标题/)
  fakeCatalog['SSIS-001'].title = '测试标题'
})

test('不在收件目录里的待处理记录会被清理', async () => {
  const { ctx, storage } = fakeCtx({ settings: { ...localSettings, fuzzy_enabled: false }, files: [] })
  storage.set('pending', { '/mnt/in/gone.mp4': { path: '/mnt/in/gone.mp4', reason: 'x' } })
  await run(ctx, {})
  assert.deepEqual(storage.get('pending'), {})
})
