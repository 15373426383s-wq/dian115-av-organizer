// 边界守卫：宿主把「后台任务可达的文件」判定为后台源码，不作为页面资源下发。
// 页面与后台一旦互相 import，被牵连的文件就会在浏览器里 404，
// 表现为「插件打不开：Failed to fetch dynamically imported module」。
// 这里锁死两条规则，并保证后台那份共享副本与页面原件逐字节一致。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map(match => match[1])
}

// 1) 页面代码不得引用后台目录，后台代码不得引用页面目录
test('页面与后台不跨目录引用模块', () => {
  const violations = []
  for (const file of walk(join(root, 'ui'))) {
    for (const spec of importsOf(file)) {
      const target = resolve(dirname(file), spec).replace(/\\/g, '/')
      if (target.includes('/jobs/')) violations.push(`${relative(root, file)} -> ${spec}`)
    }
  }
  for (const file of walk(join(root, 'jobs'))) {
    if (file.replace(/\\/g, '/').includes('/jobs/lib/shared/')) continue
    for (const spec of importsOf(file)) {
      const target = resolve(dirname(file), spec).replace(/\\/g, '/')
      if (target.includes('/ui/')) violations.push(`${relative(root, file)} -> ${spec}`)
    }
  }
  assert.deepEqual(violations, [], '跨目录引用会让宿主把文件判成后台源码：\n' + violations.join('\n'))
})

// 2) 后台共享副本必须与页面原件完全一致，避免两份实现各自漂移
test('后台共享副本与页面原件逐字节一致', () => {
  const shared = join(root, 'jobs', 'lib', 'shared')
  const files = []
  const collect = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) collect(full)
      else files.push(full)
    }
  }
  collect(shared)
  assert.ok(files.length > 0, '后台共享副本目录为空')
  const drifted = []
  for (const file of files) {
    const twin = join(root, 'ui', 'lib', relative(shared, file))
    assert.ok(readFileSync(twin, 'utf8') !== undefined, '缺少页面原件：' + twin)
    if (!readFileSync(file).equals(readFileSync(twin))) drifted.push(relative(shared, file))
  }
  assert.deepEqual(drifted, [], '这些副本与页面原件不一致，请同步后提交：\n' + drifted.join('\n'))
})

// 3) 页面头部版本号必须与清单一致
test('页面头部版本号与清单一致', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'))
  const brand = readFileSync(join(root, 'ui', 'brand.js'), 'utf8')
  const version = brand.match(/VERSION\s*=\s*'([^']+)'/)?.[1]
  assert.equal(version, manifest.version)
})
