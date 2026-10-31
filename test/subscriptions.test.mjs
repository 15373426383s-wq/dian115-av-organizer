import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { run, recover, addSubscriptions } from '../jobs/subscriptions.js'
import { extractNumbers, subscriptionConfig, validateSubscriptionConfig, subscriptionURL, changeSubscriptions } from '../ui/lib/subscriptions.js'
import { prepareCandidate, infoHash, ed2kLink, submitCandidate, verifyReceipt } from '../jobs/lib/subscription-sources.js'
import { torrentInfoBytes } from '../jobs/lib/torrent.js'

const hash = 'a'.repeat(40)
const source = { id: 'db', url: 'https://db.test/search?n={number}', target: '115' }
const magnet = h => `magnet:?xt=urn:btih:${h}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function harness(config = {}, shared = {}) {
  shared.value ||= null
  shared.revision ||= 0
  shared.posts ||= []
  shared.requests ||= []
  const ctx = {
    task: { id: `task-${Math.random()}`, checkpoint: async value => { ctx.checkpoint = value }, update: async () => {} },
    sleep: pause,
    crypto: { sha256: value => createHash('sha256').update(value).digest('hex'), sha1: value => createHash('sha1').update(value).digest('hex') },
    codec: { base64Decode: value => new Uint8Array(Buffer.from(value, 'base64')) },
    storage: { get: async () => subscriptionConfig({ cache_enabled: false, ...config }) },
    http: { request: async request => { shared.requests.push(request); return shared.search ? shared.search(request) : { status: 200, data: { items: [] } } } },
    api: {
      get: async path => {
        if (path === subscriptionURL) return structuredClone({ value: shared.value, revision: shared.revision })
        if (path.startsWith('/api/115/offline/tasks')) return shared.offline || { items: [], page_count: 1 }
        if (shared.get) return shared.get(path)
        throw new Error(`Unexpected GET ${path}`)
      },
      put: async (path, data) => {
        assert.equal(path, subscriptionURL)
        if (data.expected_revision !== shared.revision) throw Object.assign(new Error('conflict'), { status: 409 })
        if (shared.beforePut) await shared.beforePut(data)
        shared.value = structuredClone(data.value); shared.revision++
        return { revision: shared.revision }
      },
      post: async (path, body) => {
        shared.posts.push({ path, body })
        if (shared.post) return shared.post(path, body)
        assert.equal(path, '/api/115/offline/add')
        return { success: true, accepted: 1, save_cid: '0' }
      },
    },
  }
  return { ctx, shared }
}

test('av 消息批量提取、规范化和去重；非命令不接收', () => {
  assert.deepEqual(extractNumbers('AV　ssis.001 SSIS-001 FC2-PPV-1234567', true), ['SSIS-001', 'FC2-PPV-1234567'])
  assert.deepEqual(extractNumbers('/av@bot MIDV-100', true), ['MIDV-100'])
  assert.deepEqual(extractNumbers('avatar SSIS-001', true), [])
  assert.deepEqual(extractNumbers('av 没有番号', true), [])
  assert.deepEqual(extractNumbers('av SSIS-001 ABC12', true), ['SSIS-001', 'ABC-012'])
})

test('没有来源也先加插件订阅，重复消息不重建', async () => {
  const { ctx, shared } = harness()
  assert.equal((await run(ctx, { text: 'av SSIS-001 MIDV-100' })).added, 2)
  assert.equal((await run(ctx, { text: 'av SSIS-001 MIDV-100' })).added, 0)
  assert.equal(Object.keys(shared.value.items).length, 2)
  assert.equal(shared.posts.length, 0)
  assert.equal(shared.value.items['SSIS-001'].status, 'waiting')
})

test('坏配置不阻止添加；关闭搜索仍保存消息', async () => {
  const { ctx, shared } = harness({ sources: [{ id: 'x', url: 'bad', target: '115' }] })
  await assert.rejects(run(ctx, { text: 'av SSIS-001' }))
  assert.ok(shared.value.items['SSIS-001'])
  const disabled = harness({ enabled: false })
  await run(disabled.ctx, { text: 'av MIDV-100' })
  assert.equal(disabled.shared.value.items['MIDV-100'].attempts, 0)
})

test('多个消息与定时任务并发，不覆盖记录、不重复提交同一种子', async () => {
  const shared = { search: async () => { await pause(5); return { status: 200, data: { items: [{ number: 'SSIS-001', magnet: magnet(hash) }] } } } }
  const a = harness({ sources: [source] }, shared), b = harness({ sources: [source] }, shared)
  await Promise.all([run(a.ctx, { text: 'av SSIS-001 MIDV-100' }), run(b.ctx, { text: 'av SSIS-001 ABC-123' }), run(harness({ sources: [source] }, shared).ctx)])
  assert.deepEqual(Object.keys(shared.value.items).sort(), ['ABC-123', 'MIDV-100', 'SSIS-001'])
  assert.equal(shared.posts.length, 1)
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
})

test('不同番号和来源真正并发，限制番号并发数', async () => {
  let active = 0, maximum = 0
  const { ctx, shared } = harness({ sources: [source, { ...source, id: 'db2' }], concurrency: 2 })
  shared.search = async () => { active++; maximum = Math.max(maximum, active); await pause(100); active--; return { status: 200, data: { items: [] } } }
  await run(ctx, { text: 'av SSIS-001 MIDV-100 ABC-123 JUL-100' })
  assert.equal(maximum, 4)
})

test('一份合集同时命中两个番号时只提交一次，两项均完成', async () => {
  const { ctx, shared } = harness({ sources: [source], concurrency: 2 })
  shared.search = async () => ({ status: 200, data: { items: [{ title: 'SSIS-001 MIDV-100 合集', magnet: magnet(hash) }] } })
  shared.post = async () => { await pause(30); return { success: true, accepted: 1 } }
  await run(ctx, { text: 'av SSIS-001 MIDV-100' })
  assert.equal(shared.posts.length, 1)
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
  assert.equal(shared.value.items['MIDV-100'].status, 'submitted')
})

test('只接收精确番号结果，单源失败不妨碍其他来源', async () => {
  const { ctx, shared } = harness({ sources: [source, { ...source, id: 'broken', url: 'https://bad.test' }] })
  shared.search = async request => {
    if (request.url.includes('bad.test')) throw new Error('secret=DO_NOT_LOG')
    return { status: 200, data: { items: [{ number: 'SSIS-002', magnet: magnet('b'.repeat(40)) }, { title: 'SSIS-001 中文', magnet: magnet(hash) }] } }
  }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.posts[0].body.urls[0], magnet(hash))
  assert.equal(JSON.stringify(shared.value).includes('DO_NOT_LOG'), false)
})

test('定时搜索只处理到期订阅，未命中会安排下一次', async () => {
  const { ctx, shared } = harness({ sources: [source], interval_minutes: 30 })
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.requests.length, 1)
  await run(ctx)
  assert.equal(shared.requests.length, 1)
  shared.value.items['SSIS-001'].next_at = '2000-01-01T00:00:00Z'
  await run(ctx)
  assert.equal(shared.requests.length, 2)
  assert.ok(Date.parse(shared.value.items['SSIS-001'].next_at) > Date.now())
})

test('暂停后不提交正在搜索的结果', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  shared.search = async () => {
    await changeSubscriptions(ctx, state => { state.items['SSIS-001'].enabled = false })
    return { status: 200, data: { items: [{ number: 'SSIS-001', magnet: magnet(hash) }] } }
  }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.posts.length, 0)
  assert.equal(shared.value.items['SSIS-001'].lease, null)
})

test('数据库 POST 和字段映射，将种子 URL 提交给下载器', async () => {
  const config = { sources: [{ ...source, target: 'downloader', method: 'POST', body: { query: '{number}' }, results_path: 'data.rows', fields: { number: 'code', download_url: 'url' } }], downloader: 'qb-av' }
  const { ctx, shared } = harness(config)
  shared.search = async request => { assert.equal(request.json.query, 'SSIS-001'); return { status: 200, data: { data: { rows: [{ code: 'SSIS-001', url: 'https://db.test/file.torrent' }] } } } }
  shared.post = async (path, body) => { assert.equal(path, '/api/pt/download'); assert.equal(body.downloader, 'qb-av'); return { code: 'ok', data: { success: true, download_id: hash, downloader: 'qb-av' } } }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
})

test('115 的种子 URL 读取原始 info 字节计算磁力，绝不把 .torrent 当视频离线', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  const info = 'd6:lengthi1e4:name1:xe'
  shared.search = async request => request.response_type === 'base64'
    ? { status: 200, body_base64: Buffer.from(`d4:info${info}e`).toString('base64') }
    : { status: 200, data: { items: [{ number: 'SSIS-001', torrent_url: 'https://db.test/file.torrent' }] } }
  await run(ctx, { text: 'av SSIS-001' })
  const expected = createHash('sha1').update(info).digest('hex')
  assert.equal(shared.posts[0].body.urls[0], magnet(expected))
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
})

test('损坏种子或 HTML 登录页不产生离线任务', async () => {
  for (const bytes of ['<html>login</html>', 'd4:infod6:lengthi1e', 'd4:info1:xe', 'd4:infode4:infodee']) {
    assert.throws(() => torrentInfoBytes(new TextEncoder().encode(bytes)))
  }
  const { ctx, shared } = harness()
  shared.search = async () => ({ status: 200, body_base64: Buffer.from('<html>login</html>').toString('base64') })
  await assert.rejects(prepareCandidate(ctx, { target: '115', download_url: 'https://db.test/a.torrent' }))
  assert.equal(shared.posts.length, 0)
})

test('Base32 磁力归一到相同 SHA-1，磁力参数顺序不影响识别', () => {
  assert.equal(infoHash('magnet:?dn=test&xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '0'.repeat(40))
  assert.equal(infoHash(`magnet:?dn=test&xt=urn:btih:${hash}`), hash)
})

test('馒头仅搜索明确选定的站点，PT 永不提交 115', async () => {
  const { ctx, shared } = harness({ mteam_enabled: true, mteam_site_ids: [7] })
  shared.post = async (path, body) => {
    if (path === '/api/pt/search') {
      assert.deepEqual(body.site_ids, [7]); assert.equal(body.keyword, 'SSIS-001')
      return { code: 'ok', data: { torrents: [
        { site_id: 8, title: 'SSIS-001', download_url: 'https://wrong.test/1' },
        { site_id: 7, title: 'SSIS-002', download_url: 'https://mteam.test/2' },
        { site_id: 7, title: 'SSIS-001', download_url: 'https://mteam.test/1', torrent_id: '1' },
      ], window: { until: '2026-10-30T01:00:00Z', complete: true } } }
    }
    assert.equal(path, '/api/pt/download'); assert.equal(body.site_id, 7); assert.equal(body.download_url, 'https://mteam.test/1')
    return { code: 'ok', data: { success: true, downloader: 'qb', download_id: hash } }
  }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
  assert.equal(shared.posts.some(r => r.path.includes('115')), false)
})

test('提交超时不认为失败，不因定时或重复消息再次提交', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  shared.search = async () => ({ status: 200, data: { items: [{ number: 'SSIS-001', magnet: magnet(hash) }] } })
  shared.post = async () => { throw new Error('timeout with secret URL') }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.value.items['SSIS-001'].status, 'attention')
  await run(ctx, { text: 'av SSIS-001' }); await run(ctx, { force: true })
  assert.equal(shared.posts.length, 1)
  assert.equal(JSON.stringify(shared.value).includes('secret URL'), false)
})

test('HTTP 200 的业务失败和 state_uncertain 不标记已提交', async () => {
  for (const result of [{ success: false }, { success: true, state_uncertain: true }]) {
    const { ctx, shared } = harness({ sources: [{ ...source, target: 'downloader' }] })
    shared.search = async () => ({ status: 200, data: { items: [{ number: 'SSIS-001', magnet: magnet(hash) }] } })
    shared.post = async () => ({ code: 'ok', data: result })
    await run(ctx, { text: 'av SSIS-001' })
    assert.equal(shared.value.items['SSIS-001'].status, 'attention')
  }
})

test('提交成功但存储回写中断：恢复核对 115 哈希，不重新提交', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  shared.search = async () => ({ status: 200, data: { items: [{ number: 'SSIS-001', magnet: magnet(hash) }] } })
  shared.beforePut = async data => { if (data.value.items['SSIS-001']?.status === 'submitted') throw new Error('disk') }
  await assert.rejects(run(ctx, { text: 'av SSIS-001' }), /中断/)
  assert.equal(shared.value.items['SSIS-001'].status, 'submitting')
  delete shared.beforePut
  shared.offline = { items: [{ info_hash: hash, status: 'downloading', target_cid: '0' }], page_count: 1 }
  await recover(ctx, ctx.checkpoint)
  assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.posts.length, 1)
})

test('恢复未找到远端结果时保持需要核对，不把查询不到当作未提交', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  await addSubscriptions(ctx, ['SSIS-001'])
  const item = shared.value.items['SSIS-001']
  Object.assign(item, { lease: ctx.task.id, status: 'submitting', receipt_key: 'r1' })
  shared.value.receipts.r1 = { task_id: ctx.task.id, status: 'submitting', candidate: { target: '115', info_hash: hash } }
  await recover(ctx, {})
  assert.equal(shared.value.items['SSIS-001'].status, 'attention')
  assert.equal(shared.posts.length, 0)
})

test('恢复只搜索未提交的中断任务，释放锁后可以重新搜索', async () => {
  const { ctx, shared } = harness()
  await addSubscriptions(ctx, ['SSIS-001'])
  Object.assign(shared.value.items['SSIS-001'], { lease: ctx.task.id, status: 'searching' })
  await recover(ctx, {})
  assert.equal(shared.value.items['SSIS-001'].status, 'waiting')
  assert.equal(shared.value.items['SSIS-001'].lease, null)
})

test('手动继续搜索会跳过已提交资源，选下一个新资源', async () => {
  const { ctx, shared } = harness({ sources: [source] })
  shared.search = async () => ({ status: 200, data: { items: [hash, 'b'.repeat(40)].map(h => ({ number: 'SSIS-001', magnet: magnet(h) })) } })
  await run(ctx, { text: 'av SSIS-001' })
  Object.assign(shared.value.items['SSIS-001'], { status: 'waiting', continue_search: true })
  await run(ctx, { force: true })
  assert.equal(shared.posts.length, 2)
  assert.equal(shared.posts[1].body.urls[0], magnet('b'.repeat(40)))
})

test('卸载不依赖插件外的存储或后台常驻定时器；清单由宿主撤销', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url)))
  const job = manifest.jobs.find(job => job.id === 'subscriptions')
  assert.equal(job.interval_seconds, 60); assert.equal(job.allow_overlap, true)
  assert.ok(manifest.events.some(event => event.job === 'subscriptions' && event.prefixes.includes('av ')))
  const code = await readFile(new URL('../jobs/subscriptions.js', import.meta.url), 'utf8')
  assert.doesNotMatch(code, /setInterval|localStorage|\/api\/subscribe\//)
})

const baseTime = '2026-10-30T01:00:00Z'
const laterTime = '2026-10-30T02:00:00Z'
const md4 = 'd'.repeat(32)
const ed2k = name => `ed2k://|file|${name}|12345|${md4}|/`
const cacheSource = 'cache:offline'
const cachePage = (items = [], more = {}) => ({ items, complete: true, until: baseTime, ...more })
const cacheRow = (h = hash) => ({ title: 'SSIS-001', file_name: 'SSIS-001.mp4', magnet_link: magnet(h), info_hash: h })

test('磁力和 ED2K 缓存都能直接提交 115；ED2K 保留链接且按 MD4 与大小去重', async () => {
  for (const link of [magnet(hash), ed2k('SSIS-001.mp4')]) {
    const { ctx, shared } = harness({ cache_enabled: true })
    shared.get = async path => {
      assert.ok(path.startsWith('/api/cache/magnet/changes?'))
      assert.equal(new URL(path, 'http://host').searchParams.get('keyword'), 'SSIS-001')
      return cachePage([{ ...cacheRow(), magnet_link: link, info_hash: link.startsWith('ed2k:') ? md4 : hash }])
    }
    shared.post = async (path, body) => {
      assert.equal(path, '/api/115/offline/add'); assert.deepEqual(body.urls, [link])
      assert.equal(shared.value.items['SSIS-001'].source_state[cacheSource].baseline_at, baseTime)
      assert.equal(shared.value.items['SSIS-001'].pending_candidates.length, 1)
      return { success: true, accepted: 1 }
    }
    await run(ctx, { text: 'av SSIS-001' })
    assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
    assert.equal(shared.value.items['SSIS-001'].pending_candidates.length, 0)
    Object.assign(shared.value.items['SSIS-001'], { status: 'waiting', continue_search: true })
    await run(ctx, { force: true })
    assert.equal(shared.posts.length, 1)
  }
  assert.equal(ed2kLink('ed2k://|file|x|0|' + md4 + '|/'), null)
  assert.equal(ed2kLink('ed2k://|file|x|1|not-md4|/'), null)
  assert.equal(ed2kLink(ed2k('SSIS%2D001.mp4')).name, 'SSIS-001.mp4')
})

test('空缓存结果也推进每个番号的独立基线；之后只请求新时间段', async () => {
  const { ctx, shared } = harness({ cache_enabled: true })
  const queries = []
  shared.get = async path => { queries.push(new URL(path, 'http://host').searchParams); return cachePage() }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(queries[0].get('since'), '1970-01-01T00:00:00Z')
  assert.equal(shared.value.items['SSIS-001'].source_state[cacheSource].baseline_at, baseTime)
  shared.get = async path => { queries.push(new URL(path, 'http://host').searchParams); return cachePage([], { until: laterTime }) }
  await run(ctx, { force: true })
  assert.equal(queries[1].get('since'), '2026-10-30T00:59:00Z')
  assert.equal(shared.value.items['SSIS-001'].source_state[cacheSource].baseline_at, laterTime)
  await run(ctx, { text: 'av MIDV-100' })
  assert.equal(queries[2].get('since'), '1970-01-01T00:00:00Z')
})

test('缓存多页保留固定窗口和同秒 ID 游标，全部完成才推进基线', async () => {
  const { ctx, shared } = harness({ cache_enabled: true })
  shared.get = async () => cachePage([], { complete: false, cursor_time: '2026-10-30T00:30:00Z', cursor_id: 101 })
  await run(ctx, { text: 'av SSIS-001' })
  let state = shared.value.items['SSIS-001'].source_state[cacheSource]
  assert.equal(state.baseline_at, undefined); assert.equal(state.window.cursor_id, 101)
  shared.get = async path => {
    const query = new URL(path, 'http://host').searchParams
    assert.equal(query.get('until'), baseTime); assert.equal(query.get('cursor_id'), '101')
    assert.equal(query.get('cursor_time'), '2026-10-30T00:30:00Z')
    return cachePage()
  }
  await run(harness({ cache_enabled: true }, shared).ctx, { force: true })
  state = shared.value.items['SSIS-001'].source_state[cacheSource]
  assert.equal(state.baseline_at, baseTime); assert.equal(state.window, undefined)
})

test('缓存失败不推进基线；其他 PT 站点独立推进；下一次从原窗口重试', async () => {
  const { ctx, shared } = harness({ cache_enabled: true, mteam_enabled: true, mteam_site_ids: [7, 8] })
  shared.get = async () => cachePage()
  shared.post = async () => ({ code: 'ok', data: { torrents: [], window: { complete: true, until: baseTime } } })
  await run(ctx, { text: 'av SSIS-001' })
  shared.get = async () => { throw new Error('token=secret') }
  shared.post = async (_, body) => {
    assert.equal(body.published_after, '2026-10-30T00:58:00Z'); assert.equal(body.incremental, true)
    if (body.site_ids[0] === 8) throw new Error('cookie=secret')
    return { code: 'ok', data: { torrents: [], window: { complete: true, until: laterTime } } }
  }
  await run(ctx, { force: true })
  const states = shared.value.items['SSIS-001'].source_state
  assert.equal(states[cacheSource].baseline_at, baseTime)
  assert.equal(states['pt:7'].baseline_at, laterTime); assert.equal(states['pt:8'].baseline_at, baseTime)
  assert.doesNotMatch(JSON.stringify(shared.value), /token=|cookie=/)
})

test('PT 分页逐次续读，空末页推进基线；重复页不推进', async () => {
  const { ctx, shared } = harness({ mteam_enabled: true, mteam_site_ids: [7] })
  shared.post = async (_, body) => {
    assert.equal(body.page, 1); assert.equal(body.max_pages, 1)
    return { code: 'ok', data: { torrents: [], window: { complete: false, next_page: 2, until: baseTime, page_signature: 'page-1' } } }
  }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.value.items['SSIS-001'].source_state['pt:7'].baseline_at, undefined)
  shared.post = async (_, body) => {
    assert.equal(body.page, 2); assert.equal(body.published_before, baseTime)
    return { code: 'ok', data: { torrents: [], window: { complete: false, next_page: 3, until: baseTime, page_signature: 'page-1' } } }
  }
  await run(ctx, { force: true })
  assert.equal(shared.value.items['SSIS-001'].source_state['pt:7'].window.page, 2)
  shared.post = async (_, body) => {
    assert.equal(body.page, 2); assert.equal(body.published_before, baseTime)
    return { code: 'ok', data: { torrents: [], window: { complete: true, until: baseTime } } }
  }
  await run(ctx, { force: true })
  assert.equal(shared.value.items['SSIS-001'].source_state['pt:7'].baseline_at, baseTime)
})

test('基线与候选原子保存，暂停或重启不会丢掉未提交的 ED2K', async () => {
  const { ctx, shared } = harness({ cache_enabled: true })
  shared.get = async () => {
    await changeSubscriptions(ctx, state => { state.items['SSIS-001'].enabled = false })
    return cachePage([cacheRow(), { title: '', file_name: 'SSIS-001.mp4', magnet_link: ed2k('SSIS-001.mp4'), info_hash: md4 }])
  }
  await run(ctx, { text: 'av SSIS-001' })
  let item = shared.value.items['SSIS-001']
  assert.equal(shared.posts.length, 0); assert.equal(item.pending_candidates.length, 2)
  assert.equal(item.source_state[cacheSource].baseline_at, baseTime)
  item.enabled = true
  shared.get = async () => cachePage([], { until: laterTime })
  await run(harness({ cache_enabled: true }, shared).ctx, { force: true })
  item = shared.value.items['SSIS-001']; assert.equal(item.pending_candidates.length, 1)
  Object.assign(item, { status: 'waiting', continue_search: true })
  await run(harness({ cache_enabled: true }, shared).ctx, { force: true })
  assert.deepEqual(shared.posts.map(p => p.body.urls[0]), [magnet(hash), ed2k('SSIS-001.mp4')])
})

test('保存基线失败时不提交，也不丢失下一次读取范围', async () => {
  const { ctx, shared } = harness({ cache_enabled: true })
  shared.get = async () => cachePage([cacheRow()])
  shared.beforePut = async data => { if (data.value.items['SSIS-001']?.source_state?.[cacheSource]?.baseline_at) throw new Error('disk full') }
  await run(ctx, { text: 'av SSIS-001' })
  assert.equal(shared.posts.length, 0)
  assert.equal(shared.value.items['SSIS-001'].source_state, undefined)
  delete shared.beforePut
  await run(ctx, { force: true })
  assert.equal(shared.posts.length, 1)
})

test('外部数据库增量 GET/POST 都传窗口和游标；换源只重置该源', async () => {
  for (const method of ['GET', 'POST']) {
    const db = { ...source, method, incremental: true,
      url: method === 'GET' ? 'https://db.test/search?n={number}&since={since}&until={until}&cursor={cursor}' : source.url,
      body: { number: '{number}', since: '{since}', until: '{until}', cursor: '{cursor}' } }
    const config = { sources: [db], cache_enabled: true }
    const { ctx, shared } = harness(config)
    shared.get = async () => cachePage()
    let expectedSince = '1970-01-01T00:00:00Z'
    shared.search = async req => {
      const data = method === 'POST' ? req.json : Object.fromEntries(new URL(req.url).searchParams)
      assert.equal(data.since, expectedSince); assert.ok(data.until)
      return { status: 200, data: { items: [], complete: true } }
    }
    await run(ctx, { text: 'av SSIS-001' })
    const baseline = shared.value.items['SSIS-001'].source_state['db:db'].baseline_at
    expectedSince = new Date(Date.parse(baseline) - 60000).toISOString().replace('.000Z', 'Z')
    await run(ctx, { force: true })
    db.headers = { Authorization: 'private test value' }; expectedSince = '1970-01-01T00:00:00Z'
    await run(ctx, { force: true })
    assert.equal(shared.value.items['SSIS-001'].source_state[cacheSource].baseline_at, baseTime)
    assert.doesNotMatch(JSON.stringify(shared.value), /private test value/)
  }
})

test('ED2K 提交超时保留候选和基线，不能用 MD4 冒充 BTIH 自动确认', async () => {
  const { ctx, shared } = harness({ cache_enabled: true })
  shared.get = async () => cachePage([{ file_name: 'SSIS-001.mp4', magnet_link: ed2k('SSIS-001.mp4'), info_hash: md4 }])
  shared.post = async () => { throw new Error('timeout') }
  await run(ctx, { text: 'av SSIS-001' })
  const item = shared.value.items['SSIS-001']
  assert.equal(item.status, 'attention'); assert.equal(item.pending_candidates.length, 1)
  assert.equal(item.source_state[cacheSource].baseline_at, baseTime)
  const receipt = shared.value.receipts[item.receipt_key]
  assert.equal(receipt.candidate.info_hash, ''); assert.equal(receipt.candidate.resource_hash, md4)
  // The existing explicit user-confirmation flow authorizes this exact retry.
  receipt.status = 'retry_allowed'; item.status = 'waiting'
  shared.get = async () => cachePage([], { until: laterTime })
  shared.post = async () => ({ success: true, accepted: 1 })
  await run(ctx, { force: true })
  assert.equal(shared.posts.length, 2); assert.equal(shared.value.items['SSIS-001'].status, 'submitted')
})

test('升级到独立 PT 基线后仍识别旧版无哈希回执，不重交已有种子', async () => {
  const { ctx, shared } = harness({ mteam_enabled: true, mteam_site_ids: [7] })
  await addSubscriptions(ctx, ['SSIS-001'])
  shared.value.items['SSIS-001'].continue_search = true
  const legacy = ctx.crypto.sha256(JSON.stringify(['downloader', '', 'host-mteam:11']))
  shared.value.receipts[legacy] = { status: 'submitted', downloader: '', at: baseTime,
    candidate: { source_id: 'host-mteam', site_id: 7, target: 'downloader', resource_id: '11', download_url: 'https://pt.test/11' } }
  shared.post = async (path, body) => {
    if (path === '/api/pt/search') return { code: 'ok', data: { torrents: [11, 12].map(id => ({ site_id: 7, title: 'SSIS-001', torrent_id: String(id), download_url: `https://pt.test/${id}` })), window: { until: baseTime, complete: true } } }
    assert.equal(path, '/api/pt/download'); assert.equal(body.download_url, 'https://pt.test/12')
    return { code: 'ok', data: { success: true, download_id: '12' } }
  }
  await run(ctx, { force: true })
  assert.equal(shared.posts.filter(p => p.path === '/api/pt/download').length, 1)
})


test('115 具体账号与长目录编号原样提交；备用账号必须选目录',async()=>{
  const cid='9876543210987654321',config=subscriptionConfig({account:{mode:'backup',id:7},save_cid:cid})
  validateSubscriptionConfig(config)
  assert.throws(()=>validateSubscriptionConfig(subscriptionConfig({account:{mode:'backup',id:7}})),/选择保存目录/)
  assert.throws(()=>subscriptionConfig({account:{mode:'backup_pool'}}),/具体的/)
  const {ctx,shared}=harness()
  shared.post=async()=>({success:true,accepted:1,save_cid:cid,account:{mode:'backup',id:7}})
  const result=await submitCandidate(ctx,config,{target:'115',download_url:magnet(hash)})
  assert.deepEqual(shared.posts[0].body,{urls:[magnet(hash)],account:{mode:'backup',id:7},save_cid:cid})
  assert.deepEqual(result.account,config.account)
})

test('115 同资源按账号去重，换账号可提交，同账号继续搜索不重交',async()=>{
  const shared={search:async()=>({status:200,data:{items:[{number:'SSIS-001',magnet:magnet(hash)}]}})}
  const runFor=async id=>{
    const {ctx}=harness({sources:[source],account:{mode:'main',id}},shared)
    await run(ctx,{text:'av SSIS-001',manual:true})
    return ctx
  }
  const first=await runFor(1)
  await changeSubscriptions(first,state=>{Object.assign(state.items['SSIS-001'],{status:'waiting',enabled:true,next_at:''})})
  await runFor(2)
  assert.equal(shared.posts.length,2)
  assert.deepEqual(shared.posts.map(p=>p.body.account.id),[1,2])
  await changeSubscriptions(first,state=>{Object.assign(state.items['SSIS-001'],{status:'waiting',enabled:true,next_at:''})})
  await runFor(1)
  assert.equal(shared.posts.length,2)
})

test('115 中断核对使用提交时的账号与目录，不能用其他账号或目录的同一哈希确认',async()=>{
  const cid='9876543210987654321',calls=[],receipt={candidate:{target:'115',info_hash:hash},account:{mode:'backup',id:7},save_cid:cid}
  let account={mode:'backup',id:7},target=cid
  const ctx={api:{get:async path=>{calls.push(path);return {account,items:[{info_hash:hash,status:'completed',target_cid:target}],page_count:1}}}}
  assert.equal(await verifyReceipt(ctx,receipt),true)
  assert.match(calls[0],/account_mode=backup&account_id=7/)
  account={mode:'main',id:9};assert.equal(await verifyReceipt(ctx,receipt),false)
  account=receipt.account;target='10';assert.equal(await verifyReceipt(ctx,receipt),false)
  receipt.result={account:{mode:'main',id:12},save_cid:'20'};account=receipt.result.account;target='20'
  assert.equal(await verifyReceipt(ctx,receipt),true)
  assert.match(calls.at(-1),/account_mode=main&account_id=12/)
})

test('115 接收响应账号或目录不符时不标记提交成功',async()=>{
  const {ctx,shared}=harness(),candidate={target:'115',download_url:magnet(hash)}
  shared.post=async()=>({success:true,accepted:1,account:{mode:'main',id:2}})
  await assert.rejects(submitCandidate(ctx,{account:{mode:'main',id:1}},candidate),/账号/)
  shared.post=async()=>({success:true,accepted:1,save_cid:'2'})
  await assert.rejects(submitCandidate(ctx,{save_cid:'1'},candidate),/目录/)
})
