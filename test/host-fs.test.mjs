// 统一文件层：路径换算、后端判定、CD2 写入回读校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  toCloudPath, mountPrefixFrom, isCloudTarget, isCloudSource,
  putFile, cloudTransfer, waitCloudFile,
} from '../jobs/lib/host-fs.js'

test('页面头部版本号与清单一致', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
  const { VERSION } = await import('../ui/brand.js')
  assert.equal(VERSION, manifest.version)
})

const CLOUDS = [{ name: '115open', path: '/115open' }]

function fakeCtx({ backend = 'system', cloudFiles = [], landCloud = true, failStat = false, sleep = async () => {} } = {}) {
  const calls = []
  const existing = new Set()
  const cloud = new Set(cloudFiles)
  const ctx = {
    calls,
    sleep,
    api: { get: async path => { calls.push({ op: 'api.get', path }); if (path === '/api/cd2/clouds') return { clouds: CLOUDS }; throw new Error('unexpected ' + path) } },
    cd2: {
      call: async (method, options) => {
        calls.push({ op: 'cd2.' + method, ...options })
        if (method === 'stat') return cloud.has(options.path) ? { path: options.path } : null
        if (method === 'list') return []
        return null
      },
    },
    files: {
      call: async options => {
        calls.push({ op: 'files.' + options.operation, ...options })
        switch (options.operation) {
          case 'stat': if (failStat) throw new Error('stat 不可用'); return { path: options.path, backend, is_dir: false, name: 'x' }
          case 'exists': return existing.has(options.path)
          case 'copy':
            existing.add(options.destination)
            if (landCloud) cloud.add(String(options.destination).replace(/^cd2:/, ''))
            return { backend: 'system' }
          case 'move': existing.add(options.destination); existing.delete(options.path); return { backend: 'system' }
          case 'remove': existing.delete(options.path); return {}
          default: throw new Error('unexpected ' + options.operation)
        }
      },
    },
  }
  return { ctx, calls, existing, cloud }
}

test('挂载路径换算成 CD2 内部路径，其它路径不换算', () => {
  assert.equal(toCloudPath('/CloudNAS/CloudDrive/115open/未刮削', CLOUDS), '/115open/未刮削')
  assert.equal(toCloudPath('cd2:/115open/已刮削', CLOUDS), '/115open/已刮削')
  assert.equal(toCloudPath('/mnt/media/电影', CLOUDS), '')
  assert.equal(toCloudPath('', CLOUDS), '')
})

test('挂载前缀由收件目录与云盘名反推', () => {
  assert.equal(mountPrefixFrom('/CloudNAS/CloudDrive/115open/未刮削', CLOUDS), '/CloudNAS/CloudDrive')
  assert.equal(mountPrefixFrom('/mnt/media', CLOUDS), '')
})

test('目标是否在 CD2：cd2: 写法与挂载路径算云端，本机路径不算', async () => {
  const { ctx } = fakeCtx()
  assert.equal(await isCloudTarget(ctx, 'cd2:/115open/未刮削'), true)
  assert.equal(await isCloudTarget(ctx, '/CloudNAS/CloudDrive/115open/未刮削'), true)
  assert.equal(await isCloudTarget(ctx, '/mnt/media/电影'), false)
})

test('源是否在 CD2 以宿主 stat 的 backend 为准，读不到按本机处理', async () => {
  const cloud = fakeCtx({ backend: 'cd2' })
  assert.equal(await isCloudSource(cloud.ctx, '/CloudNAS/CloudDrive/115open/未刮削/a.mkv'), true)
  const local = fakeCtx({ backend: 'system' })
  assert.equal(await isCloudSource(local.ctx, '/mnt/media/a.mkv'), false)
  const broken = fakeCtx({ failStat: true })
  assert.equal(await isCloudSource(broken.ctx, '/mnt/media/a.mkv'), false)
})

test('写本机目标只复制一次，不做云端回读', async () => {
  const { ctx, calls, existing } = fakeCtx()
  const result = await putFile(ctx, 'staging/a.nfo', '/mnt/lib/a.nfo')
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.ok(existing.has('/mnt/lib/a.nfo'))
  assert.equal(calls.filter(item => item.op === 'cd2.stat').length, 0)
})

test('写 CD2 目标要回读云端确认，确认后才清掉暂存', async () => {
  const { ctx, calls } = fakeCtx()
  const result = await putFile(ctx, 'staging/a.nfo', 'cd2:/115open/未刮削/a.nfo')
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.ok(calls.some(item => item.op === 'cd2.stat'))
  // 云端确认通过后暂存件被清理
  assert.ok(calls.some(item => item.op === 'files.remove' && item.path === 'staging/a.nfo'))
})

test('CD2 写入没落地时保留暂存件并给出原因', async () => {
  const { ctx, calls } = fakeCtx({ landCloud: false })
  const logs = []
  const result = await putFile(ctx, 'staging/a.nfo', 'cd2:/115open/未刮削/a.nfo', { log: async m => logs.push(m) })
  assert.equal(result.ok, false)
  assert.equal(result.verified, false)
  assert.match(result.reason, /CD2/)
  assert.ok(logs.some(item => /CD2 未确认落地/.test(item)))
  // 没有确认就不能删暂存件
  assert.equal(calls.some(item => item.op === 'files.remove' && item.path === 'staging/a.nfo'), false)
})

test('云端搬运是复制→回读确认→删源', async () => {
  const { ctx, calls } = fakeCtx()
  await cloudTransfer(ctx, 'cd2:/115open/未刮削/a.mkv', 'cd2:/115open/已整理/a.mkv', {})
  const ops = calls.map(item => item.op)
  assert.ok(ops.indexOf('files.copy') < ops.indexOf('files.remove'))
  assert.ok(ops.includes('cd2.stat'))
})

test('云端回读有重试，最终仍读不到就返回空', async () => {
  let attempts = 0
  const { ctx } = fakeCtx({ cloudFiles: [], sleep: async () => { attempts++ } })
  const found = await waitCloudFile(ctx, 'cd2:/115open/未刮削/a.nfo', 3, 0)
  assert.equal(found, null)
  assert.equal(attempts, 2)
})
