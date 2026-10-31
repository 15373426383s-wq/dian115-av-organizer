import test from 'node:test'
import assert from 'node:assert/strict'
import {run} from '../jobs/actors.js'

// 宿主 refreshEmbyControlItem 的实际允许值；未知值在接触 Emby 前返回 400。
const MODES = new Set(['None', 'ValidationOnly', 'Default', 'FullRefresh'])
function fixture(settings = {}, item = {}) {
  const calls = [], kv = new Map()
  const ctx = {
    settings: {get: async () => settings},
    storage: {get: async key => kv.get(key), set: async (key, value) => kv.set(key, structuredClone(value))},
    task: {update: async () => {}, log: async () => {}, checkpoint: async () => {}},
    api: {
      get: async path => {calls.push({method: 'GET', path}); return {items: [{id: 'person-1', name: '演员甲', overview: '', has_primary_image: false, ...item}], total: 100}},
      post: async (path, body) => {
        calls.push({method: 'POST', path, body})
        assert.match(path, /\/items\/person-1\/refresh(?:\?|$)/)
        if (!MODES.has(body.metadata_refresh_mode) || !MODES.has(body.image_refresh_mode)) throw new Error(`POST ${path}: HTTP 400 · 不支持的元数据刷新模式`)
        return {success: true}
      },
    },
  }
  return {ctx, calls, kv}
}

test('演员默认补缺使用宿主支持的模式，提交刷新不冒充已完成刮削', async () => {
  const {ctx, calls, kv} = fixture()
  const result = await run(ctx, {manual: true})
  assert.equal(result.failed, 0)
  assert.equal(result.submitted, 1)
  assert.equal(result.success, 0)
  assert.deepEqual(calls[1].body, {recursive: false, metadata_refresh_mode: 'Default', image_refresh_mode: 'Default', replace_all_metadata: false, replace_all_images: false})
  assert.equal(kv.get('actors_history')[0].status, 'submitted')
})

for (const [name, item, metadataMode, imageMode] of [
  ['已有简介', {overview: '已有资料'}, 'None', 'Default'],
  ['已有头像', {has_primary_image: true}, 'Default', 'None'],
]) test(`演员补缺独立保护${name}`, async () => {
  const {ctx, calls} = fixture({}, item)
  const result = await run(ctx, {manual: true})
  assert.equal(result.submitted, 1)
  assert.equal(calls[1].body.metadata_refresh_mode, metadataMode)
  assert.equal(calls[1].body.image_refresh_mode, imageMode)
  assert.equal(calls[1].body.replace_all_metadata, false)
  assert.equal(calls[1].body.replace_all_images, false)
})

test('演员资料已完整，或两个字段均关闭时，不发送刷新请求', async () => {
  for (const [settings, item] of [[{}, {overview: '已有资料', has_primary_image: true}], [{actor_options: {info: false, images: false}}, {}]]) {
    const {ctx, calls} = fixture(settings, item)
    const result = await run(ctx, {manual: true})
    assert.equal(result.skipped, 1)
    assert.equal(calls.length, 1)
  }
})

test('演员只覆盖头像时不刷新简介；全部覆盖仅作用于已开启字段', async () => {
  const existing = {overview: '已有资料', has_primary_image: true}
  for (const settings of [{actor_options: {overwrite_images: true}}, {actor_refresh: 'all', actor_options: {info: false}}]) {
    const {ctx, calls} = fixture(settings, existing)
    assert.equal((await run(ctx, {manual: true})).submitted, 1)
    assert.deepEqual(calls[1].body, {recursive: false, metadata_refresh_mode: 'None', image_refresh_mode: 'FullRefresh', replace_all_metadata: false, replace_all_images: true})
  }
  const {ctx, calls} = fixture({actor_refresh: 'all'}, existing)
  await run(ctx, {manual: true})
  assert.deepEqual(calls[1].body, {recursive: false, metadata_refresh_mode: 'FullRefresh', image_refresh_mode: 'FullRefresh', replace_all_metadata: true, replace_all_images: true})
})

test('演员查询和刷新沿用同一 Emby 实例及分页位置', async () => {
  const {ctx, calls, kv} = fixture({actor_proxy_id: 7, actor_library_id: 'lib-1'})
  await run(ctx, {manual: true, offset: 20})
  assert.match(calls[0].path, /proxy_id=7&type=Person/)
  assert.match(calls[0].path, /library_id=lib-1&offset=20$/)
  assert.match(calls[1].path, /refresh\?proxy_id=7$/)
  assert.equal(kv.get('actors_offset'), 21)
})

test('演员刷新失败保留原因及失败状态，不计入已提交刷新', async () => {
  const {ctx, kv} = fixture()
  ctx.api.post = async () => {throw new Error('Emby 返回 HTTP 503')}
  const result = await run(ctx, {manual: true})
  assert.equal(result.failed, 1)
  assert.equal(result.submitted, 0)
  assert.equal(kv.get('actors_history')[0].status, 'failed')
  assert.match(kv.get('actors_history')[0].error, /503/)
})
