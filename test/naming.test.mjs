import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeComponent, renderTemplate, templateVariables, joinPath, dirname, basename, isWithin, truncateBytes } from '../ui/lib/naming.js'
import { buildNFO } from '../ui/lib/nfo.js'

test('文件名清理：斜杠投影为全角并截断字节', () => {
  assert.equal(sanitizeComponent('A/B\\C: D?'), 'A／B＼C： D？')
  assert.equal(sanitizeComponent('  ..hidden. '), 'hidden')
  const long = '标'.repeat(100)
  assert.ok(new TextEncoder().encode(truncateBytes(long, 50)).length <= 50)
})

test('模板渲染：变量里的斜杠不会产生额外目录', () => {
  const vars = templateVariables({ number: 'SSIS-001', title: '前篇/后篇', actors: ['演员A', '演员B'] }, { suffix: '-C' })
  assert.deepEqual(renderTemplate('{actor}/{number} {title}', vars), ['演员A', 'SSIS-001 前篇／后篇'])
  assert.deepEqual(renderTemplate('{number}{suffix}', vars), ['SSIS-001-C'])
})

test('演员过多或缺失时的占位', () => {
  assert.equal(templateVariables({ actors: ['a', 'b', 'c', 'd'] }, {}).actor, '多人')
  assert.equal(templateVariables({ actors: [] }, {}).actor, '未知演员')
})

test('路径拼接保留 cd2: 前缀', () => {
  assert.equal(joinPath('cd2:/115/AV', 'a', 'b.mp4'), 'cd2:/115/AV/a/b.mp4')
  assert.equal(joinPath('/mnt/lib/', '/a/', 'b'), '/mnt/lib/a/b')
  assert.equal(dirname('cd2:/115/AV/a.mp4'), 'cd2:/115/AV')
  assert.equal(basename('/x/y/z.mkv'), 'z.mkv')
  assert.ok(isWithin('/mnt/in', '/mnt/in/a'))
  assert.ok(!isWithin('/mnt/in', '/mnt/inbox/a'))
})

test('NFO 转义并写入番号', () => {
  const xml = buildNFO({ number: 'SSIS-001', title: 'A & <B>', actors: ['X'], genres: ['g'], release_date: '2021-02-03', series: 'S' }, { extraTags: ['中文字幕'], poster: 'p.jpg' })
  assert.match(xml, /<title>SSIS-001 A &amp; &lt;B&gt;<\/title>/)
  assert.match(xml, /<uniqueid type="num" default="true">SSIS-001<\/uniqueid>/)
  assert.match(xml, /<year>2021<\/year>/)
  assert.match(xml, /<tag>中文字幕<\/tag>/)
  assert.match(xml, /<set>\n    <name>S<\/name>\n  <\/set>/)
})
