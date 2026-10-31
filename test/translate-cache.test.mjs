import test from 'node:test'
import assert from 'node:assert/strict'
import {
  translationCacheKey, translationCacheEnabled, translateWithCache,
  clearTranslationCache, translationCacheStats, TRANSLATION_CACHE_TTL_MS, TRANSLATION_CACHE_LIMIT,
} from '../jobs/lib/translate-cache.js'

function fakeCtx() {
  const map = new Map()
  return {
    storage: {
      get: async key => (map.has(key) ? map.get(key) : null),
      set: async (key, value) => { map.set(key, value) },
      remove: async key => { map.delete(key) },
    },
    _map: map,
  }
}

const settings = { translation: { language: '简体中文', model: 'm1' }, metadata_options: { translation_engine: 'host' } }
const fields = { title: 'Original title', plot: 'Original plot' }
const reply = { values: { title: '中文标题', plot: '中文简介' }, model: 'm1' }

test('缓存键：同输入同键，语言/模型/原文变化都会换键', () => {
  const meta = { number: 'SSIS-001' }
  const base = translationCacheKey(meta, fields, settings)
  assert.equal(base, translationCacheKey(meta, fields, settings))
  assert.notEqual(base, translationCacheKey(meta, fields, { ...settings, translation: { ...settings.translation, language: '日本語' } }))
  assert.notEqual(base, translationCacheKey(meta, fields, { ...settings, translation: { ...settings.translation, model: 'm2' } }))
  assert.notEqual(base, translationCacheKey(meta, { ...fields, title: 'Changed' }, settings))
  assert.notEqual(base, translationCacheKey({ number: 'SSIS-002' }, fields, settings))
  assert.match(base, /^tr:[0-9a-f]{16}$/)
})

test('命中缓存后不再调用翻译', async () => {
  const ctx = fakeCtx()
  let calls = 0
  const translate = async () => { calls++; return reply }
  const logs = []
  const log = async line => logs.push(line)
  const first = await translateWithCache(ctx, { number: 'SSIS-001' }, fields, settings, translate, log)
  assert.equal(first.cached, false)
  assert.deepEqual(first.values, reply.values)
  const second = await translateWithCache(ctx, { number: 'SSIS-001' }, fields, settings, translate, log)
  assert.equal(second.cached, true)
  assert.deepEqual(second.values, reply.values)
  assert.equal(second.model, 'm1')
  assert.equal(calls, 1)
  assert.ok(logs.some(line => line.includes('翻译命中本地缓存')))
})

test('关闭缓存时每次都翻译', async () => {
  const ctx = fakeCtx()
  let calls = 0
  const translate = async () => { calls++; return reply }
  const off = { ...settings, translation: { ...settings.translation, cache: false } }
  await translateWithCache(ctx, { number: 'SSIS-001' }, fields, off, translate)
  await translateWithCache(ctx, { number: 'SSIS-001' }, fields, off, translate)
  assert.equal(calls, 2)
  assert.equal(ctx._map.size, 0)
  assert.equal(translationCacheEnabled(off), false)
  assert.equal(translationCacheEnabled({ no_cache: true, ...settings }), false)
})

test('字段形状变了不命中，缓存值不串味', async () => {
  const ctx = fakeCtx()
  let calls = 0
  const translate = async () => { calls++; return reply }
  const key = translationCacheKey({ number: 'SSIS-001' }, fields, settings)
  await ctx.storage.set(key, { at: Date.now(), values: { title: '只有标题' }, model: 'm1' })
  const result = await translateWithCache(ctx, { number: 'SSIS-001' }, fields, settings, translate)
  assert.equal(result.cached, false)
  assert.equal(calls, 1)
})

test('缓存过期后重新翻译', async () => {
  const ctx = fakeCtx()
  let calls = 0
  const translate = async () => { calls++; return reply }
  const key = translationCacheKey({ number: 'SSIS-001' }, fields, settings)
  await ctx.storage.set(key, { at: Date.now() - TRANSLATION_CACHE_TTL_MS - 1000, values: reply.values, model: 'm1' })
  const result = await translateWithCache(ctx, { number: 'SSIS-001' }, fields, settings, translate)
  assert.equal(result.cached, false)
  assert.equal(calls, 1)
})

test('超过上限淘汰最旧条目，清空可一键回收', async () => {
  const ctx = fakeCtx()
  const translate = () => ({ values: reply.values, model: 'm1' })
  for (let index = 0; index < TRANSLATION_CACHE_LIMIT + 5; index++) {
    await translateWithCache(ctx, { number: `T-${index}` }, fields, settings, translate)
  }
  const stats = await translationCacheStats(ctx)
  assert.equal(stats.entries, TRANSLATION_CACHE_LIMIT)
  // 最早写入的那条已被淘汰
  assert.equal(await ctx.storage.get(translationCacheKey({ number: 'T-0' }, fields, settings)), null)
  const removed = await clearTranslationCache(ctx)
  assert.equal(removed, TRANSLATION_CACHE_LIMIT)
  assert.equal((await translationCacheStats(ctx)).entries, 0)
})

test('旧设置也能拿到新增的嵌套默认值（translation.cache）', async () => {
  const { withDefaults } = await import('../ui/lib/defaults.js')
  const merged = withDefaults({ translation: { enabled: true, fields: ['title'] } })
  assert.equal(merged.translation.cache, true)
  assert.equal(merged.translation.enabled, true)
  assert.deepEqual(merged.translation.fields, ['title'])
  assert.equal(withDefaults({ translation: { cache: false } }).translation.cache, false)
})
