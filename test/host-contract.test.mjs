// 宿主契约回归：这两条是实机踩出来的坑，写死在这里防止再犯。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copy, move, looksCloud, cloudContext } from '../jobs/lib/host-fs.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') out.push(...jsFiles(path)) }
    else if (name.endsWith('.js')) out.push(path)
  }
  return out
}

test('不在 finally 块里 await 宿主调用', () => {
  // 宿主在「return 触发的 finally」中执行 await 宿主调用会让脚本执行器整体失败：
  // 任务只报 "script host call failed"，JS 的 catch 和 throw 都不生效，日志也会断掉。
  // 这类问题在实机上排查代价极高，所以在源码层面直接禁止。
  const offenders = []
  for (const file of [...jsFiles(join(root, 'jobs')), ...jsFiles(join(root, 'ui'))]) {
    const src = readFileSync(file, 'utf8')
    for (const match of src.matchAll(/finally\s*\{([\s\S]*?)\n\s*\}/g)) {
      if (/await\s+ctx\./.test(match[1])) offenders.push(file.replace(root + '/', '') + ' :: ' + match[1].trim().slice(0, 80))
    }
  }
  assert.deepEqual(offenders, [], '禁止在 finally 中 await 宿主调用：\n' + offenders.join('\n'))
})

function fakeHost({ clouds = [{ name: '115', path: '/115' }] } = {}) {
  const calls = []
  return {
    calls,
    api: { get: async path => { if (path === '/api/cd2/clouds') return { clouds }; throw new Error('unexpected ' + path) } },
    cd2: { call: async (method, options) => { calls.push({ op: 'cd2.' + method, ...options }); return method === 'stat' ? { path: options.path } : null } },
    files: { call: async options => { calls.push({ op: 'files.' + options.operation, ...options }); return { backend: 'system' } } },
    sleep: async () => {},
  }
}

test('云端路径的文件操作不请求字节进度', async () => {
  // 宿主对 CD2 云端操作无法计算已传字节，progress 模式下会让脚本执行器崩溃。
  const ctx = fakeHost()
  await cloudContext(ctx)
  assert.equal(looksCloud('cd2:/115/AV/a.mkv'), true)
  assert.equal(looksCloud('/CloudNAS/CloudDrive/115/a.mkv'), true)
  assert.equal(looksCloud('/mnt/lib/a.mkv'), false)

  await copy(ctx, '/CloudNAS/CloudDrive/115/in/a.mkv', 'cd2:/115/AV/a.mkv', { overwrite: true })
  const copyCall = ctx.calls.find(item => item.op === 'files.copy')
  assert.equal(copyCall.progress, false)

  // 本机之间仍然要进度，任务队列才能显示搬运百分比。
  await move(ctx, '/mnt/a.mkv', '/mnt/lib/b.mkv', {});
  assert.equal(ctx.calls.at(-1).progress, true)
})
