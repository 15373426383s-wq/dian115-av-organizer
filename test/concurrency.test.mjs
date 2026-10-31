import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPool, createThrottle, keyedLock, serial } from '../jobs/lib/pool.js'
import { run, recover } from '../jobs/organize.js'
import { fileDeadline } from '../jobs/lib/deadline.js'

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

test('mapPool：并发不超过上限，结果保持原顺序', async () => {
  let running = 0, peak = 0
  const out = await mapPool([30, 10, 20, 5, 15], 2, async (ms, index) => {
    running++; peak = Math.max(peak, running)
    await tick(ms)
    running--
    return index
  })
  assert.deepEqual(out, [0, 1, 2, 3, 4])
  assert.equal(peak, 2)
})

test('站点限速：同一站点按间隔排队，不同站点不等待', async () => {
  const waits = []
  const throttle = createThrottle(1000, async ms => { waits.push(ms) })
  await Promise.all([throttle('a'), throttle('a'), throttle('a'), throttle('b')])
  assert.equal(waits.length, 2, '只有同站点后两次需要等待')
  assert.ok(waits[0] > 900 && waits[1] > 1900)
  const free = createThrottle(0, async () => { throw new Error('不应等待') })
  await free('a'); await free('a')
})

test('按键互斥与串行化', async () => {
  const lock = keyedLock(), order = []
  await Promise.all([
    lock('d', async () => { order.push('a1'); await tick(20); order.push('a2') }),
    lock('d', async () => { order.push('b1'); order.push('b2') }),
    lock('e', async () => { order.push('c') }),
  ])
  assert.ok(order.indexOf('b1') > order.indexOf('a2'), '同键排队')
  assert.ok(order.indexOf('c') < order.indexOf('a2'), '不同键并行')
  const queue = serial(), seen = []
  await Promise.all([queue(async () => { await tick(15); seen.push(1) }), queue(async () => { seen.push(2) })])
  assert.deepEqual(seen, [1, 2])
})

// 并发整理：慢速来源下多个文件同时刮削；同一目标只放一个文件，其余留在待处理。
const SOURCE = {
  id: 'slow', name: 'Slow', type: 'json', base: 'https://slow.test', kinds: ['standard', 'prefixed'],
  detail: { url: '{base}/v/{number}.json' },
  fields: { number: { json: 'number' }, title: { json: 'title' }, actors: { json: 'actors', all: true }, cover: { json: 'cover' } },
}
function slowCtx(files, concurrency) {
  const storage = new Map(), moves = [], existing = new Set()
  let inFlight = 0, peak = 0
  const checkpoints = []
  const ctx = {
    settings: { get: async () => ({ inbox: '/mnt/in', mode: 'local', local_target: '/mnt/lib', custom_sources: JSON.stringify([SOURCE]), source_config: JSON.stringify({ slow: { enabled: true } }), search_sources: 'slow', min_size_mb: 0, stable_seconds: 0, download_images: false, request_delay_ms: 0, concurrency }) },
    storage: { get: async key => storage.get(key) ?? null, set: async (key, value) => { await tick(Math.random() * 5); storage.set(key, structuredClone(value)); return 1 }, remove: async key => storage.delete(key) },
    task: { id: 't', update: async () => {}, log: async () => {}, checkpoint: async value => { checkpoints.push(structuredClone(value)) } },
    crypto: { sha1: value => Buffer.from(value).toString('hex').slice(0, 16) },
    sleep: tick, html: {}, cookiecloud: async () => ({}), notify: async () => ({}),
    http: {
      cookies: async () => [], importCookies: async () => ({}),
      request: async options => {
        inFlight++; peak = Math.max(peak, inFlight)
        await tick(30)
        inFlight--
        const number = decodeURIComponent(new URL(options.url).pathname.replace(/^\/v\//, '').replace(/\.json$/, ''))
        return { status: 200, url: options.url, body: JSON.stringify({ number, title: `标题 ${number}`, actors: ['演员'], cover: 'https://img.test/x.jpg' }) }
      },
    },
    api: { get: async () => [], post: async () => ({}) },
    files: { call: async options => {
      if (options.operation === 'walk') return files.map(f => ({ ...f, is_dir: false }))
      if (options.operation === 'exists') return existing.has(options.path)
      if (options.operation === 'move') { await tick(5); moves.push(options.destination); existing.add(options.destination); return {} }
      return {}
    } },
  }
  return { ctx, storage, moves, checkpoints, peak: () => peak }
}
const file = name => ({ name, path: `/mnt/in/${name}`, size: 900 * 1024 * 1024, modified: '2020-01-01T00:00:00Z' })

test('多个文件并发刮削，全部成功且状态完整', async () => {
  const names = ['SSIS-001.mp4', 'SSIS-002.mp4', 'SSIS-003.mp4', 'SSIS-004.mp4', 'SSIS-005.mp4', 'SSIS-006.mp4']
  const { ctx, storage, peak } = slowCtx(names.map(file), 3)
  const result = await run(ctx, {})
  assert.equal(result.success, 6)
  assert.ok(peak() >= 3, `并发请求峰值 ${peak()}`)
  assert.equal(storage.get('history').length, 6, '并发保存没有丢失记录')
})

test('同一目标的两个文件不会互相覆盖', async () => {
  const { ctx, moves, storage } = slowCtx([file('SSIS-001.mp4'), file('[x]SSIS-001.mp4')], 4)
  const result = await run(ctx, {})
  assert.equal(result.success, 1)
  assert.equal(result.skipped, 1)
  assert.equal(moves.filter(path => path.endsWith('SSIS-001.mp4')).length, 1)
  assert.match(Object.values(storage.get('pending'))[0].reason, /目标已存在/)
})

test('中断恢复核对全部在途文件，兼容旧版单文件断点', async () => {
  const { ctx, storage } = slowCtx([], 1)
  const items = [{ path: '/mnt/in/A-1.mp4', videoTarget: '/mnt/lib/A-1.mp4', number: 'A-1' }, { path: '/mnt/in/B-1.mp4', videoTarget: '/mnt/lib/B-1.mp4', number: 'B-1' }]
  const arrived = new Set(['/mnt/lib/A-1.mp4', '/mnt/lib/B-1.mp4', '/mnt/lib/C-1.mp4'])
  ctx.files.call = async options => options.operation === 'exists' ? arrived.has(options.path) : {}
  await recover(ctx, { stage: 'files', items })
  await recover(ctx, { stage: 'file', path: '/mnt/in/C-1.mp4', videoTarget: '/mnt/lib/C-1.mp4', number: 'C-1' })
  assert.deepEqual(storage.get('history').map(item => item.number).sort(), ['A-1', 'B-1', 'C-1'])
})

test('fileDeadline 不包装宿主对象（复制/重绑会让宿主调用失败）', async () => {
  const files = { call: async op => `ok:${op.operation}` }
  const ctx = { files, api: { post: async () => 1 }, http: {}, task: { log: async () => {} } }
  const env = { get: async () => 'page' }
  const budget = fileDeadline(ctx, env, 60)
  // 原样返回，引用不变，方法可以直接调用
  assert.equal(budget.ctx, ctx)
  assert.equal(budget.env, env)
  assert.equal(await budget.ctx.files.call({ operation: 'stat' }), 'ok:stat')
  assert.equal(await budget.env.get('https://x'), 'page')
  budget.check() // 未到点不抛
})

test('fileDeadline 到点后 check() 抛错', async () => {
  let clock = 0
  const budget = fileDeadline({}, {}, 1, () => clock)
  budget.check()
  clock = 5000
  assert.throws(() => budget.check(), /单文件处理超过 1 秒/)
})

test('未设置预算时 check() 永远放行', async () => {
  const budget = fileDeadline({}, {}, 0, () => 1e12)
  assert.doesNotThrow(() => budget.check())
})
