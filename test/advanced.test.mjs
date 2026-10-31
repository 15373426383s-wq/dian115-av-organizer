import test from 'node:test'
import assert from 'node:assert/strict'
import { renderText } from '../ui/lib/templates.js'
import { renderTemplate } from '../ui/lib/naming.js'
import { directoryConfigs, advancedSettings, mergeSettings } from '../ui/lib/advanced.js'
import { normalizeSettings, resolveDestination, planFile } from '../jobs/lib/plan.js'
import { enrichMetadata, processArtwork, HOST } from '../jobs/lib/enrich.js'
import { buildNFO } from '../ui/lib/nfo.js'
import { mergeMeta } from '../jobs/lib/scrape.js'
import { findActor, exactActorName } from '../jobs/actors.js'
import { run, recover } from '../jobs/organize.js'

test('Jinja-style filters, nested conditions and path-safe values', () => {
  const vars = { number: 'ABC-123', actors: ['A/B', 'C'], title: '', year: '2024', enabled: true }
  assert.equal(renderText('{% if enabled %}{{ actors | first }}{% if year == "2024" %}新{% else %}旧{% endif %}{% else %}无{% endif %}', vars), 'A/B新')
  assert.equal(renderText('{{ title | default("untitled") | upper }} {{ number | split("-") | last }}', vars), 'UNTITLED 123')
  assert.deepEqual(renderTemplate('{{ actors | first }}/{{ number | lower }}', vars), ['A／B', 'abc-123'])
  assert.throws(() => renderText('{{ process.exit() }}', vars), /不支持/)
  assert.throws(() => renderText('{% if enabled %}x', vars), /endif/)
})
test('directory profiles and per-task overrides do not mutate global settings', () => {
  const original = { inbox: '/old', local_target: '/out', directories: [{ id: 'a', path: '/in/a', overrides: { file_template: '{number}' } }, { id: 'b', path: '/in/b', enabled: false }] }
  const before = structuredClone(original), configs = directoryConfigs(original, { overrides: { transfer_mode: 'copy' } })
  assert.equal(configs.length, 1); assert.equal(configs[0].inbox, '/in/a'); assert.equal(configs[0].transfer_mode, 'copy')
  assert.deepEqual(original, before)
  assert.deepEqual(mergeSettings({ translation: { enabled: true, language: '中文' }, nfo: { fields: { actor: true } } }, { translation: { model: 'override' }, nfo: { fields: { plot: false } } }), { translation: { enabled: true, language: '中文', model: 'override' }, nfo: { fields: { actor: true, plot: false } } })
  assert.throws(() => directoryConfigs(original, { directory_id: 'b' }), /不存在/)
  const settings = normalizeSettings({ ...configs[0], metadata_target: '/meta', category_rules: [{ match: 'number', pattern: '^FC2-', category: 'FC2', template: '{category}/{number}' }] })
  const plan = planFile({ path: '/in/a/FC2-123456.mp4', name: 'FC2-123456.mp4' }, { number: 'FC2-123456', kind: 'fc2' }, { number: 'FC2-123456' }, settings, resolveDestination(settings))
  assert.equal(plan.metaDir, '/meta/FC2/FC2-123456'); assert.equal(plan.videoDir, '/out/FC2/FC2-123456')
})
test('FFP resolution and AI translation feed NFO, preserving original metadata', async () => {
  const calls = [], ctx = { api: { post: async (path, body) => { calls.push([path, body]); return path.endsWith('/probe') ? { width: 3840, height: 2160, duration: 7200, video_codec: 'hevc' } : { text: '{"title":"译文","plot":"简介"}', model: 'host-model', finish_reason: 'stop' } } } }
  const original = { number: 'ABC-123', title: 'original', plot: 'plot', actors: ['A'] }, parsed = { flags: {} }
  const meta = await enrichMetadata(ctx, original, parsed, { path: '/media/a.mp4', name: 'a.720p.mp4' }, advancedSettings({ resolution_mode: 'probe', translation: { enabled: true } }), async () => {})
  assert.equal(meta.resolution, '4K'); assert.equal(meta.title, '译文'); assert.equal(meta.original_title, 'original'); assert.equal(original.title, 'original'); assert.equal(parsed.flags.k4, true)
  assert.equal(calls[1][0], HOST + '/ai/complete'); assert.equal(calls[1][1].context.number, 'ABC-123')
  const nfo = buildNFO(meta, { config: { fields: { originaltitle: false, actor: false }, set: 'none' } })
  assert.match(nfo, /<width>3840<\/width>/); assert.match(nfo, /译文/); assert.doesNotMatch(nfo, /<originaltitle>|<actor>|<set>/)
})
test('strict FFP and malformed mandatory AI output fail before moving a file', async () => {
  const settings = advancedSettings({ resolution_mode: 'probe', translation: { enabled: true, required: true } })
  const ctx = { api: { post: async () => ({ width: 0, height: 0 }) } }
  await assert.rejects(enrichMetadata(ctx, { title: 'x' }, {}, { name: 'x.mp4', path: '/x.mp4' }, settings, async () => {}), /有效/)
  settings.resolution_mode = 'filename'; ctx.api.post = async () => ({ text: '{"title":[]}' })
  await assert.rejects(enrichMetadata(ctx, { title: 'x' }, {}, { name: 'x.mp4' }, settings, async () => {}), /格式/)
})
test('host badges and custom image geometry are used in actual image request', async () => {
  const calls = [], ctx = { api: { post: async (path, body) => { calls.push([path, body]); if (body.inspect) return body.source === 'cover' ? { width: 1500, height: 1000 } : { width: 100, height: 50 }; return { image: { faces: 0, crop_applied: 'right' } } } } }
  await processArtwork(ctx, 'cover', 'poster.jpg', 'poster', {}, { flags: {}, kind: 'standard' }, advancedSettings({ image_options: { crop: 'face', max_width: 1200 }, watermark: { enabled: true, rules: [{ source: '/api/resource-badges/assets/a/b/c', when: 'always' }, { source: 'custom.png', when: 'always' }] } }), async () => {})
  const body = calls.at(-1)[1]
  assert.equal(body.crop, 'face'); assert.equal(body.width, 666); assert.equal(body.overlays.length, 2); assert.ok(body.overlays[1].y > body.overlays[0].y)
  assert.equal(body.format, 'jpeg'); assert.equal(body.destination, 'poster.jpg')
  assert.equal(calls.filter(([, request]) => request.source === 'cover' && request.inspect).length, 1)
})
test('artwork defaults to 1200 pixels before watermarking, keeps small images and explicit original size', async () => {
  const calls = []
  let dimensions = { width: 3000, height: 4500 }
  const ctx = { api: { post: async (path, body) => { calls.push(body); return body.inspect ? dimensions : { image: {} } } } }
  const run = settings => processArtwork(ctx, 'cover', 'poster.jpg', 'poster', {}, { flags: {}, kind: 'standard' }, advancedSettings(settings), async () => {})
  await run({})
  assert.equal(calls.at(-1).width, 1200)
  dimensions = { width: 400, height: 600 }
  await run({})
  assert.equal(calls.at(-1).width, 400)
  calls.length = 0
  await run({ image_options: { max_width: 0 } })
  assert.equal(calls.at(-1).width, 0)
  assert.equal(calls.filter(body => body.inspect).length, 0)
})
test('field source blocklist excludes blocked data even when it has first priority', () => {
  const result = mergeMeta([{ source: 'a', title: 'bad', actors: ['Bad'], genres: ['Bad'] }, { source: 'b', title: 'good', actors: ['Good'], genres: ['Good'] }], { title: ['a'] }, { title: ['a'], actors: ['a'], genres: ['a'] })
  assert.equal(result.title, 'good'); assert.deepEqual(result.actors, ['Good']); assert.deepEqual(result.genres, ['Good'])
})
test('actor sources require exact actor identity and support nested mappings', async () => {
  const ctx = { http: { request: async () => ({ status: 200, body: JSON.stringify({ results: [{ name: 'Wrong', image: 'https://image/1' }, { name: 'Alice', bio: 'Bio', image: 'https://image/2' }] }) }) } }
  const actor = await findActor(ctx, 'Alice', [{ url: 'https://api/actors?q={name}', items_path: 'results', overview_path: 'bio' }])
  assert.equal(actor.image, 'https://image/2'); assert.equal(exactActorName('Alice 2', 'Alice'), false)
  const request = ctx.http.request; let calls = 0
  ctx.http.request = async () => { if (!calls++) throw new Error('source unavailable'); return request() }
  assert.equal((await findActor(ctx, 'Alice', [{ url: 'https://bad' }, { url: 'https://good', items_path: 'results' }])).image, 'https://image/2')
})
test('multiple directory scans retain another directory pending records', async () => {
  const storage = new Map([['pending', { '/a/unknown.mp4': { path: '/a/unknown.mp4', signature: '2:', next_attempt_at: '2099-01-01' }, '/b/unknown.mp4': { path: '/b/unknown.mp4', signature: '2:', next_attempt_at: '2099-01-01' } }]])
  const ctx = {
    settings: { get: async () => ({ directories: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], action_mode: 'in_place', min_size_mb: 0, stable_seconds: 0 }) },
    storage: { get: async k => structuredClone(storage.get(k) ?? null), set: async (k, v) => storage.set(k, structuredClone(v)), remove: async k => storage.delete(k) },
    files: { call: async r => r.operation === 'walk' ? [{ path: r.path + '/unknown.mp4', name: 'unknown.mp4', size: 2 }] : false },
    api: {}, task: { update: async () => {}, log: async () => {}, checkpoint: async () => {} }, http: { cookies: async () => {} }, sleep: async () => {},
  }
  const result = await run(ctx)
  assert.equal(result.directories.length, 2); assert.deepEqual(Object.keys(storage.get('pending')).sort(), ['/a/unknown.mp4', '/b/unknown.mp4'])
})

test('retained-file recovery requires a transfer receipt and matching size', async () => {
  const data = new Map(), ctx = { storage: { get: async k => data.get(k) ?? null, set: async (k, v) => data.set(k, structuredClone(v)) }, task: { log: async () => {} }, files: { call: async r => r.operation === 'exists' ? true : { size: 100 } } }
  const item = { path: '/in/a.mp4', videoTarget: '/out/a.mp4', retained: true, transfer_mode: 'copy', expected_size: 100, signature: '100:date' }
  await recover(ctx, { stage: 'files', items: [item] })
  assert.equal(data.get('history'), undefined); assert.equal(data.get('done'), undefined)
  await recover(ctx, { stage: 'files', items: [{ ...item, transfer_complete: true, expected_size: 200 }] })
  assert.equal(data.get('history'), undefined)
  await recover(ctx, { stage: 'files', items: [{ ...item, transfer_complete: true }] })
  assert.equal(data.get('history').length, 1); assert.equal(data.get('done')['/in/a.mp4'], '100:date')
})
