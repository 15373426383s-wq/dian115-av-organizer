import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { numberVars, fillTemplate, jsonPath, sameCode, runSource, runSearch, normalizeDate } from '../jobs/lib/engine.js'
import { PRESETS, numberKind } from '../ui/lib/presets.js'
import { sourcePlan, sourcesForNumber, validateSource, fieldPriority, searchPlan } from '../ui/lib/registry.js'
import { mergeMeta } from '../jobs/lib/scrape.js'

const preset = id => PRESETS.find(p => p.id === id)

test('番号变量：DMM 内容编号、FC2、HEYZO、日期编号', () => {
  assert.equal(numberVars('SSIS-001').cid, 'ssis00001')
  assert.equal(numberVars('300MIUM-123').cid, '300mium00123')
  assert.equal(numberVars('FC2-PPV-1234567').fc2_id, '1234567')
  assert.equal(numberVars('HEYZO-1234').heyzo_id, '1234')
  assert.equal(numberVars('010120-001').date_id_underscore, '010120_001')
  assert.equal(numberVars('010120_001').date_id_dash, '010120-001')
})

test('模板：网址原样放入，普通变量编码，请求头不编码', () => {
  assert.equal(fillTemplate('{base}/search?q={keyword}', { base: 'https://a.test', keyword: '新人 出道' }), 'https://a.test/search?q=%E6%96%B0%E4%BA%BA%20%E5%87%BA%E9%81%93')
  assert.equal(fillTemplate('Bearer {token}', { token: 'a/b+c' }, true), 'Bearer a/b+c')
})

test('JSON 路径：嵌套、下标、数组映射', () => {
  const data = { a: { list: [{ name: 'x' }, { name: 'y' }] }, b: [1, 2] }
  assert.deepEqual(jsonPath(data, 'a.list[].name'), ['x', 'y'])
  assert.equal(jsonPath(data, 'a.list[1].name'), 'y')
  assert.equal(jsonPath(data, 'b[0]'), 1)
  assert.equal(jsonPath(data, 'missing.x'), undefined)
})

test('番号比较与日期规整', () => {
  assert.ok(sameCode('ssis00001', 'SSIS-001'))
  assert.ok(sameCode('FC2-PPV-1234567', 'FC2-1234567'))
  assert.ok(!sameCode('SSIS-001', 'SSIS-010'))
  assert.equal(normalizeDate('2021年2月9日'), '2021-02-09')
  assert.equal(normalizeDate('20210209'), '2021-02-09')
})

test('全部预设规则有效，且都带实测结果', () => {
  assert.ok(PRESETS.length >= 23, String(PRESETS.length))
  for (const def of PRESETS) {
    assert.equal(validateSource(def), '', def.id)
    assert.ok(['ok', 'gated', 'region', 'protected', 'down', 'broken', 'untested'].includes(def.check?.result), def.id)
    assert.equal(def.verified, def.check.result === 'ok', def.id)
  }
  assert.ok(PRESETS.filter(def => def.verified).length >= 10)
})

test('注册表：默认启用、旧版设置兼容、显式配置、令牌、按番号类型选来源', () => {
  const defaults = sourcePlan({})
  assert.ok(defaults.find(i => i.def.id === 'javbus').enabled)
  assert.ok(!defaults.find(i => i.def.id === 'javlibrary').enabled)
  assert.ok(!defaults.find(i => i.def.id === 'theporndb').enabled, '没有令牌不启用')
  const legacy = sourcePlan({ sources: 'javdb,javbus', javdb_base: 'https://mirror.test/', javbus_cookie: 'a=1' })
  assert.equal(legacy[0].def.id, 'javdb')
  assert.equal(legacy[0].base, 'https://mirror.test')
  assert.equal(legacy.find(i => i.def.id === 'javbus').cookie, 'a=1')
  const explicit = sourcePlan({ source_config: JSON.stringify({ javdb: { enabled: true }, theporndb: { enabled: true, token: 't' } }) })
  assert.deepEqual(explicit.filter(i => i.enabled).map(i => i.def.id).sort(), ['javdb', 'theporndb'])
  const kinds = id => sourcesForNumber({}, { kind: 'uncensored-date', number: id }).map(i => i.def.id)
  assert.ok(kinds('010120-001').includes('caribbeancom') && !kinds('010120-001').includes('1pondo') && !kinds('010120-001').includes('r18dev'))
  assert.ok(kinds('010120_001').includes('1pondo') && !kinds('010120_001').includes('caribbeancom'))
  assert.ok(kinds('010120_01').includes('10musume'))
  const fc2 = sourcesForNumber({}, { kind: 'fc2', number: 'FC2-PPV-1234567' }).map(i => i.def.id)
  assert.ok(fc2.includes('fc2') && !fc2.includes('javbus'))
  assert.equal(numberKind('dmm', 'ABP-123'), 'standard')
  assert.ok(searchPlan({}).length > 0)
})

test('自定义来源：校验错误不影响其他来源，同 id 覆盖内置', () => {
  const plan = sourcePlan({ custom_sources: JSON.stringify([{ id: 'javbus', name: '我的 JavBus', type: 'html', kinds: ['standard'], detail: { url: '{base}/{number}' }, fields: { title: 'h3' } }, { id: 'BAD' }]) })
  assert.equal(plan.find(i => i.def.id === 'javbus').def.name, '我的 JavBus')
})

test('字段优先合并：指定字段按来源顺序，标签合并', () => {
  const merged = mergeMeta([
    { source: 'a', number: 'X-1', title: 'A 标题', plot: '', actors: ['甲'], genres: ['g1'] },
    { source: 'b', number: 'X-1', title: 'B 标题', plot: 'B 简介', cover: 'c', actors: ['乙'], genres: ['g2'] },
  ], fieldPriority({ field_priority: 'title: b\nactors: b' }))
  assert.equal(merged.title, 'B 标题')
  assert.deepEqual(merged.actors, ['乙'])
  assert.equal(merged.plot, 'B 简介')
  assert.deepEqual(merged.genres, ['g1', 'g2'])
  assert.equal(merged.field_sources.title, 'b')
})

// ---------- 用模拟响应跑预设 ----------

function env(responses, htmlLoad) {
  const calls = []
  return {
    calls,
    html: { load: htmlLoad },
    base: (id, fallback) => fallback,
    pause: async () => {},
    get: async (url, init = {}) => {
      calls.push({ url, init })
      for (const [pattern, response] of responses) {
        if (pattern.test(url)) return { url: response.url || url, status: response.status || 200, body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) }
      }
      return { url, status: 404, body: '' }
    },
  }
}

test('R18.dev：先按番号取内容编号，再取完整资料', async () => {
  const e = env([
    [/dvd_id=ssis-001\/json/, { body: { content_id: 'ssis00001' } }],
    [/combined=ssis00001\/json/, { body: { dvd_id: 'SSIS-001', title_ja: '日文标题', release_date: '2021-02-19 10:00:00', runtime_mins: 120, maker_name_ja: 'エスワン', actresses: [{ name_kanji: '演员甲' }], categories: [{ name_ja: '単体作品' }], jacket_full_url: 'https://pics/x.jpg', gallery: [{ image_full: 'https://pics/1.jpg' }] } }],
  ])
  const meta = await runSource(e, preset('r18dev'), 'SSIS-001')
  assert.equal(meta.title, '日文标题')
  assert.equal(meta.release_date, '2021-02-19')
  assert.equal(meta.runtime, 120)
  assert.deepEqual(meta.actors, ['演员甲'])
  assert.deepEqual(meta.samples, ['https://pics/1.jpg'])
})

test('一本道 JSON：时长按秒换算，番号来自请求', async () => {
  const e = env([[/movie_id\/010120_001\.json/, { body: { MovieID: '010120_001', Title: '标题', Duration: 3600, ActressesJa: ['甲'], UCNAME: ['巨乳'], Release: '2020-01-01', ThumbHigh: 'https://x/t.jpg' } }]])
  const meta = await runSource(e, preset('1pondo'), '010120_001')
  assert.equal(meta.runtime, 60)
  assert.equal(meta.studio, '一本道')
  assert.equal(meta.cover, 'https://x/t.jpg')
})

test('ThePornDB：令牌写进请求头', async () => {
  const e = env([[/\/jav\?parse=/, { body: { data: [{ id: 99 }] } }], [/\/jav\/99$/, { body: { data: { external_id: 'SSIS-001', title: 'T' } } }]])
  const meta = await runSource(e, preset('theporndb'), 'SSIS-001', { vars: { token: 'tok' } })
  assert.equal(meta.title, 'T')
  assert.deepEqual(e.calls[0].init.headers.Authorization, ['Bearer tok'])
})

test('返回的番号对不上时不采用', async () => {
  const e = env([[/barcode\/SSIS-001/, { body: { result: { barcode: 'SSIS-010', name: '别的作品' } } }]])
  assert.equal(await runSource(e, preset('airav'), 'SSIS-001'), null)
})

test('年龄验证与地区限制给出明确提示', async () => {
  await assert.rejects(runSource(env([[/./, { url: 'https://www.javbus.com/doc/driver-verify?x', body: '' }]], () => null), preset('javbus'), 'SSIS-001'), /年龄验证/)
  await assert.rejects(runSource(env([[/./, { status: 200, body: 'prohibited in the country' }]], () => null), preset('javbus'), 'SSIS-001'), /地区/)
})

// HTML 预设：用 jsdom 实现与宿主 ctx.html 相同接口的选择集（没有 jsdom 时跳过）。
let JSDOM = null
try { JSDOM = createRequire(`${process.env.JSDOM_DIR || process.cwd()}/`)('jsdom').JSDOM } catch { /* 跳过 */ }

function htmlLoad(body, { baseURL } = {}) {
  const doc = new JSDOM(body, { url: baseURL || 'https://x.test/' }).window.document
  const wrap = nodes => {
    const list = [...nodes]
    const sel = {
      length: list.length,
      find: s => wrap(list.flatMap(n => [...n.querySelectorAll(s)])),
      first: () => wrap(list.slice(0, 1)),
      eq: i => wrap(list.slice(i, i + 1)),
      text: () => list.map(n => n.textContent).join('').trim(),
      html: () => list[0]?.innerHTML || '',
      attr: name => list[0]?.getAttribute(name) ?? null,
      next: s => wrap(list.map(n => n.nextElementSibling).filter(n => n && (!s || n.matches(s)))),
      hasClass: c => Boolean(list[0]?.classList.contains(c)),
      each: fn => { for (const [i, n] of list.entries()) if (fn(wrap([n]), i) === false) break; return sel },
      map: fn => list.map((n, i) => fn(wrap([n]), i)),
    }
    return sel
  }
  return wrap([doc.documentElement])
}

const html = JSDOM ? test : test.skip

html('JavBus：标签行、演员、由封面推出竖版海报、剧照', async () => {
  const page = `<div class="container"><h3>SSIS-001 新人标题</h3><a class="bigImage" href="/pics/cover/abc_b.jpg"><img></a>
    <div class="info"><p><span class="header">識別碼:</span> <span style="color:#CC0000;">SSIS-001</span></p>
    <p><span class="header">發行日期:</span> 2021-02-19</p><p><span class="header">長度:</span> 120分鐘</p>
    <p><span class="header">製作商:</span> <a href="/studio/1">エスワン</a></p><p><span class="header">系列:</span> <a href="/series/2">新人</a></p>
    <p><span class="genre"><label><input type="checkbox"><a href="/genre/1">單體作品</a></label></span></p></div>
    <div class="star-name"><a href="/star/1">演员甲</a></div>
    <div id="sample-waterfall"><a class="sample-box" href="https://pics.dmm.co.jp/1.jpg"></a></div></div>`
  const meta = await runSource(env([[/javbus\.com\/SSIS-001/, { body: page }]], htmlLoad), preset('javbus'), 'SSIS-001')
  assert.equal(meta.title, '新人标题')
  assert.equal(meta.release_date, '2021-02-19')
  assert.equal(meta.runtime, 120)
  assert.equal(meta.studio, 'エスワン')
  assert.deepEqual(meta.actors, ['演员甲'])
  assert.deepEqual(meta.genres, ['單體作品'])
  assert.equal(meta.cover, 'https://www.javbus.com/pics/cover/abc_b.jpg')
  assert.equal(meta.poster, 'https://www.javbus.com/pics/thumb/abc.jpg')
  assert.deepEqual(meta.samples, ['https://pics.dmm.co.jp/1.jpg'])
})

html('JavDB：先搜索再进详情，跳过男演员，标题取原标题', async () => {
  const search = `<div class="movie-list"><div class="item"><a href="/v/xyz"><div class="video-title"><strong>SSIS-001</strong> 中文标题</div></a></div></div>`
  const detail = `<h2 class="title"><strong class="current-title">中文标题</strong><span class="origin-title">日文原标题</span></h2><img class="video-cover" src="https://c0.jdbstatic.com/c.jpg">
    <nav class="movie-panel-info"><div class="panel-block"><strong>番號:</strong><span class="value">SSIS-001</span></div>
    <div class="panel-block"><strong>演員:</strong><span class="value"><a>演员甲</a><strong class="symbol female">♀</strong><a>男优</a><strong class="symbol male">♂</strong></span></div>
    <div class="panel-block"><strong>類別:</strong><span class="value"><a>巨乳</a>,<a>单体</a></span></div></nav>`
  const e = env([[/search\?q=/, { body: search }], [/\/v\/xyz/, { body: detail }]], htmlLoad)
  const meta = await runSource(e, preset('javdb'), 'SSIS-001')
  assert.equal(meta.title, '日文原标题')
  assert.deepEqual(meta.actors, ['演员甲'])
  assert.deepEqual(meta.genres, ['巨乳', '单体'])
  const items = await runSearch(e, preset('javdb'), '中文标题')
  assert.equal(items[0].number, 'SSIS-001')
  assert.equal(items[0].title, '中文标题')
})

html('JavLibrary：番号搜索直接跳到详情页', async () => {
  const detail = `<div id="video_title"><h3><a>SSIS-001 标题</a></h3></div><div id="video_id"><td class="text">SSIS-001</td></div><div id="video_date"><td class="text">2021-02-19</td></div>
    <div id="video_cast"><span class="star"><a>演员甲</a></span></div><img id="video_jacket_img" src="//pics.dmm.co.jp/x.jpg">`
  const e = env([[/vl_searchbyid/, { url: 'https://www.javlibrary.com/cn/?v=javli123', body: detail }], [/\?v=javli123/, { body: detail }]], htmlLoad)
  const meta = await runSource(e, preset('javlibrary'), 'SSIS-001')
  assert.equal(meta.title, '标题')
  assert.equal(meta.cover, 'https://pics.dmm.co.jp/x.jpg')
})

html('MGStage 与 FC2“未找到”页面', async () => {
  const mgs = `<h1 class="tag">素人标题</h1><div class="detail_data"><table><tr><th>品番：</th><td>300MIUM-123</td></tr><tr><th>出演：</th><td><a>素人甲</a></td></tr></table></div><a id="EnlargeImage" href="https://image.mgstage.com/pb.jpg"></a>`
  const meta = await runSource(env([[/product_detail\/300MIUM-123/, { body: mgs }]], htmlLoad), preset('mgstage'), '300MIUM-123')
  assert.equal(meta.title, '素人标题')
  assert.deepEqual(meta.actors, ['素人甲'])
  assert.equal(await runSource(env([[/article\/1234567/, { body: 'お探しの商品が見つかりません' }]], htmlLoad), preset('fc2'), 'FC2-PPV-1234567'), null)
})

// 1.2.3：按当前站点响应结构构造中性样例，不把页面、封面或认证信息带入插件包。
const avsoxDetail = { code: 200, data: { movieFanHao: 'HEYZO-1048', title: '样本标题', title_ja: '原文标题', releaseDate: '2016-01-02', length: 60, posterLarge: 'https://images.test/cover.jpg', posterSmall: 'https://images.test/poster.jpg', star: [{ starName: '波多野結衣', avatarUrl: 'https://images.test/actor.webp' }], studio: { studioName: 'HEYZO' }, genre: [{ genreName: '样本分类' }], sampleLarge: ['https://images.test/sample.jpg'] } }
function avsoxEnv(search = [{ movieId: 'wrong', movieFanHao: 'HEYZO-10480' }, { movieId: 'nbjvybn', movieFanHao: 'HEYZO-1048', title: '样本标题' }], detail = avsoxDetail) {
  return env([
    [/\/cn$/, { body: '<meta content="fixture-token" name="csrf-token">' }],
    [/\/api\/search$/, { body: { code: 200, data: search } }],
    [/\/api\/getMovie$/, { body: detail }],
  ], htmlLoad)
}

html('AVSOX 当前 API：前置 CSRF、JSON 搜索、精确编号、详情及演员头像', async () => {
  const e = avsoxEnv()
  const meta = await runSource(e, preset('avsox'), 'HEYZO-1048')
  assert.equal(meta.number, 'HEYZO-1048'); assert.equal(meta.release_date, '2016-01-02'); assert.equal(meta.runtime, 60)
  assert.deepEqual(meta.actors, ['波多野結衣']); assert.deepEqual(meta.actor_photos, { '波多野結衣': 'https://images.test/actor.webp' })
  assert.equal(meta.source_url, 'https://avsox.click/cn/movie/nbjvybn')
  assert.deepEqual(e.calls[1].init.json, [{ search: 'HEYZO-1048', lang: 'cn' }, 60, 1])
  assert.deepEqual(e.calls[2].init.json, ['nbjvybn', 'cn'])
  assert.deepEqual(e.calls[2].init.headers['X-CSRF-Token'], ['fixture-token'])
  assert.equal(e.calls.length, 3)
})
html('AVSOX 独立关键词搜索也准备 CSRF，保留中文 JSON 字符串', async () => {
  const e = avsoxEnv(); const result = await runSearch(e, preset('avsox'), '演员 姓名')
  assert.equal(result.length, 2); assert.equal(e.calls[1].init.json[0].search, '演员 姓名')
})
html('AVSOX 不用近似编号、空结果或错误响应冒充命中', async () => {
  const wrong = avsoxEnv([{ movieId: 'wrong', movieFanHao: 'HEYZO-10480' }])
  assert.equal(await runSource(wrong, preset('avsox'), 'HEYZO-1048'), null)
  assert.equal(wrong.calls.length, 2)
  assert.equal(await runSource(avsoxEnv([]), preset('avsox'), 'HEYZO-1048'), null)
  await assert.rejects(runSource(avsoxEnv(undefined, { code: 419, data: avsoxDetail.data }), preset('avsox'), 'HEYZO-1048'), /数据接口返回错误/)
  assert.equal(await runSource(avsoxEnv(undefined, { code: 200, data: { ...avsoxDetail.data, movieFanHao: 'HEYZO-1049' } }), preset('avsox'), 'HEYZO-1048'), null)
})
html('AVSOX 手工详情仍调用数据 API，核对来源及返回番号', async () => {
  const e = avsoxEnv()
  const meta = await runSource(e, { ...preset('avsox'), manual_url: 'https://avsox.click/cn/movie/nbjvybn' }, 'HEYZO-1048')
  assert.equal(meta.number, 'HEYZO-1048'); assert.equal(e.calls.length, 2)
  assert.deepEqual(e.calls[1].init.json, ['nbjvybn', 'cn'])
  await assert.rejects(runSource(e, { ...preset('avsox'), manual_url: 'https://other.test/cn/movie/nbjvybn' }, 'HEYZO-1048'), /站点不一致/)
})
html('缺少 CSRF 是页面变化错误，不当作没有该番号', async () => {
  await assert.rejects(runSource(env([[/./, { body: '<div id="app"></div>' }]], htmlLoad), preset('avsox'), 'HEYZO-1048'), /缺少 csrf/)
})
html('FreeJavBT：番号分在多个节点，元数据限定详情区，不取推荐作品', async () => {
  const page = '<h1 class="text-white">样本标题</h1><div class="single-video-meta code"><span>番號:&nbsp;</span><a>HEYZO</a> <span>-1048</span></div><div class="single-video-meta"><span>日期:</span><span>2016-01-02</span></div><div class="single-video-meta"><span>女優:</span><a class="actress">波多野結衣</a></div><a class="actress">推荐演员</a><meta property="og:image" content="/cover.jpg">'
  const meta = await runSource(env([[/./, { body: page }]], htmlLoad), preset('freejavbt'), 'HEYZO-1048')
  assert.equal(meta.number, 'HEYZO-1048'); assert.deepEqual(meta.actors, ['波多野結衣']); assert.equal(meta.cover, 'https://freejavbt.com/cover.jpg')
  assert.equal(meta.release_date, '2016-01-02')
})
html('7mmtv：搜索精确匹配、主封面与 HH:MM:SS 时长', async () => {
  const e = env([
    [/searchform/, { body: '<figure class="video-preview"><a href="/zh/uncensored_content/1/HEYZO-1048.html"><img alt="HEYZO-1048 样本标题"></a></figure>' }],
    [/HEYZO-1048.html/, { body: '<h1 class="fullvideo-title">HEYZO-1048 样本标题</h1><div class="d-flex mb-4"><span>HEYZO-1048</span><span>2016-01-02</span><span>01:01:24</span></div><div class="content_main_cover"><img src="/cover.jpg"></div><div class="fullvideo-idol"><span><a>波多野結衣</a></span></div>' }],
  ], htmlLoad)
  const meta = await runSource(e, preset('mmtv'), 'HEYZO-1048')
  assert.equal(meta.runtime, 61); assert.equal(meta.cover, 'https://7mmtv.sx/cover.jpg'); assert.deepEqual(meta.actors, ['波多野結衣'])
})
html('Airav.io：搜索、中文简介及 JSON-LD @graph 中的影片节点', async () => {
  const e = env([
    [/search_result/, { body: '<div class="oneVideo"><a href="/cn/video?hid=sample"><h5>[HEYZO-1048] 样本标题</h5></a></div>' }],
    [/\/video\?/, { body: '<div class="video-title"><h1>[HEYZO-1048] 样本标题</h1></div><div class="video-info"><div>番號：<span>HEYZO-1048</span></div><div>女優：<a>波多野結衣</a></div><p>样本简介</p></div><script type="application/ld+json">{"@type":"WebSite","name":"站点"}</script><script type="application/ld+json">{"@graph":[{"@type":"BreadcrumbList"},{"@type":"VideoObject","thumbnailUrl":["/cover.jpg"],"datePublished":"2016-01-02"}]}</script>' }],
  ], htmlLoad)
  const meta = await runSource(e, preset('airav_io'), 'HEYZO-1048')
  assert.equal(meta.plot, '样本简介'); assert.equal(meta.cover, 'https://airav.io/cover.jpg'); assert.deepEqual(meta.actors, ['波多野結衣'])
})
html('JavBus 仅在已开启年龄确认时提交实际表单，不使用 existmag', async () => {
  assert.equal(preset('javbus').age_cookie, undefined)
  const page = '<form id="form1" method="post" action=""><input name="Submit" type="submit" value="確認"></form>'
  const e = env([], htmlLoad); e.ageConfirm = true
  e.get = async (url, init) => { e.calls.push({url,init}); return init.method === 'POST'
    ? {status:200,url:'https://www.javbus.com/HEYZO-1048',body:'<div class="container"><h3>HEYZO-1048 样本标题</h3></div><div class="info"><p><span class="header">識別碼:</span><span>HEYZO-1048</span></p></div>'}
    : {status:200,url:'https://www.javbus.com/doc/driver-verify?referer=sample',body:page} }
  assert.equal((await runSource(e, preset('javbus'), 'HEYZO-1048')).number, 'HEYZO-1048')
  assert.equal(e.calls.length, 2); assert.deepEqual(e.calls[1].init.form, { Submit: '確認' })
  e.ageConfirm = false; e.calls.length = 0
  await assert.rejects(runSource(e, preset('javbus'), 'HEYZO-1048'), /年龄验证/); assert.equal(e.calls.length,1)
})
html('年龄表单重复拦截或跨站跳转时停止，不循环提交', async () => {
  for (const [url, action, calls] of [
    ['https://www.javbus.com/doc/driver-verify', '', 2],
    ['https://other.test/doc/driver-verify', '', 1],
    ['https://www.javbus.com/doc/driver-verify', 'https://other.test/submit', 1],
  ]) {
    const e = env([[/./, { url, body: `<form id="form1" method="post" action="${action}"></form>` }]], htmlLoad); e.ageConfirm = true
    await assert.rejects(runSource(e,preset('javbus'),'HEYZO-1048'),/年龄验证/); assert.equal(e.calls.length,calls)
  }
})
html('防护页 HTTP 200 不能误报未找到，普通统计脚本不影响解析', async () => {
  const {isChallengePage} = await import('../jobs/lib/engine.js')
  assert.ok(!isChallengePage({status:200,body:'<h1>Title</h1><script src="https://static.cloudflareinsights.com/beacon.min.js"></script>'}))
  assert.ok(isChallengePage({status:200,body:'<title>Just a moment...</title>'}))
  await assert.rejects(runSource(env([[/./,{body:'<title>Just a moment...</title>'}]],htmlLoad),preset('freejavbt'),'HEYZO-1048'),/防护验证/)
})
html('AVSOX 并发首次初始化共享 CSRF，后续刮削重新读取且不缓存失败', async () => {
  const e = avsoxEnv();const get=e.get
  e.get=async(...args)=>{await new Promise(r=>setTimeout(r,1));return get(...args)}
  const results=await Promise.all([runSource(e,preset('avsox'),'HEYZO-1048'),runSource(e,preset('avsox'),'HEYZO-1048')])
  assert.ok(results.every(m=>m?.number==='HEYZO-1048'));assert.equal(e.calls.filter(c=>c.url.endsWith('/cn')).length,1)
  await runSource(e,preset('avsox'),'HEYZO-1048');assert.equal(e.calls.filter(c=>c.url.endsWith('/cn')).length,2)
  const broken=env([[/./,{status:503,body:''}]],htmlLoad)
  await assert.rejects(runSource(broken,preset('avsox'),'HEYZO-1048'),/HTTP 503/);assert.equal(broken.sourceSteps.size,0)
})

test('时长解析：时分秒、分钟与 ISO duration，拒绝无效时钟', async () => {
  const {normalizeRuntime}=await import('../jobs/lib/engine.js')
  for(const [raw,minutes] of [['00:59:29',59],['01:42:30',103],['59:29',59],['120分鐘',120],['約120分',120],['1時間30分',90],['PT1H42M30S',103],['01:80:00',0],['00:59:90',0],['',0]]) assert.equal(normalizeRuntime(raw),minutes,raw)
})
html('加勒比和 Tokyo-Hot 的真实时钟格式转为分钟', async () => {
  const carib='<div class="movie-info"><h1>样本标题</h1><li class="movie-spec"><span class="spec-title">再生時間</span><span class="spec-content">00:59:29</span></li></div>'
  assert.equal((await runSource(env([[/./,{body:carib}]],htmlLoad),preset('caribbeancom'),'010120-001')).runtime,59)
  const tokyo='<div class="contents"><h2>样本标题</h2></div><div class="infowrapper"><dl><dt>作品番号</dt><dd>N1234</dd><dt>収録時間</dt><dd>01:42:30</dd></dl></div>'
  assert.equal((await runSource(env([[/./,{body:tokyo}]],htmlLoad),{...preset('tokyohot'),detail:{url:'https://my.tokyo-hot.com/product/n1234/'}},'N1234')).runtime,103)
})
html('FreeJavBT 排除站点标记的男演员，保留女优', async () => {
  const page='<h1 class="text-white">样本标题</h1><div class="single-video-meta code"><span>番號:</span><a>SSIS</a><span>-001</span></div><div class="single-video-meta"><span>女優:</span><a class="actress">演员甲</a><a class="actress text-primary">男演员</a><a class="actress">演员乙</a></div>'
  assert.deepEqual((await runSource(env([[/./,{body:page}]],htmlLoad),preset('freejavbt'),'SSIS-001')).actors,['演员甲','演员乙'])
})
test('需要令牌的来源在缺少令牌时明确报错，不发送匿名认证请求',async()=>{
  const e=env([])
  await assert.rejects(runSource(e,preset('theporndb'),'SSIS-001'),/填写令牌/)
  assert.equal(e.calls.length,0)
})

// FANZA 新站使用公开 GraphQL 元数据；样例仅保留响应结构。
const fanzaDetail = {id:'ssis00001',makerContentId:'SSIS-001',title:'样本标题',description:'样本简介',duration:8826,makerReleasedAt:'2021-02-18T15:00:00Z',deliveryStartDate:'2021-02-12T15:00:00Z',packageImage:{largeUrl:'https://images.test/fanza.jpg'},actresses:[{name:'演员甲',imageUrl:'https://images.test/actor.jpg'}],sampleImages:[{largeImageUrl:'https://images.test/sample.jpg'}],maker:{name:'厂商'},label:{name:'品牌'},genres:[{name:'分类'}]}
function fanzaEnv(items=[{id:'ssis00001',title:'样本标题'}],details={ssis00001:fanzaDetail}) {
  const e=env([]); e.ageConfirm=true
  e.get=async(url,init)=>{
    e.calls.push({url,init})
    const body=init.json.query.includes('PluginLookup')?{data:{legacySearchPPV:{result:{contents:items}}}}:{data:{ppvContent:details[init.json.variables.id]??null}}
    return {status:200,url,body:JSON.stringify(body)}
  }
  return e
}
test('FANZA 新接口：内容编号搜索、站点真实封面、秒转分钟与日本发行日期',async()=>{
  const e=fanzaEnv(),meta=await runSource(e,preset('fanza'),'SSIS-001')
  assert.equal(e.calls[0].init.json.variables.keyword,'ssis00001')
  assert.equal(e.calls[1].init.json.variables.id,'ssis00001')
  assert.ok(e.calls.every(c=>c.url==='https://api.video.dmm.co.jp/graphql'&&c.init.method==='POST'))
  assert.equal(meta.number,'SSIS-001');assert.equal(meta.runtime,147);assert.equal(meta.release_date,'2021-02-19')
  assert.equal(meta.cover,'https://images.test/fanza.jpg');assert.deepEqual(meta.actors,['演员甲']);assert.deepEqual(meta.actor_photos,{'演员甲':'https://images.test/actor.jpg'})
  assert.equal(meta.source_url,'https://video.dmm.co.jp/av/content/?id=ssis00001')
  const fallback=fanzaEnv(undefined,{ssis00001:{...fanzaDetail,makerReleasedAt:null}})
  assert.equal((await runSource(fallback,preset('fanza'),'SSIS-001')).release_date,'2021-02-13')
  assert.equal(normalizeDate('2021-02-19',540),'2021-02-19')
  assert.equal(normalizeDate('2021-02-19T00:00:00+09:00',540),'2021-02-19')
})
test('FANZA 厂商前缀候选必须用详情返回的番号确认，不误用搜索前缀或公共网页',async()=>{
  const e=fanzaEnv([{id:'1sdabp00001',title:'样本标题'}],{'1sdabp00001':{...fanzaDetail,id:'1sdabp00001',makerContentId:'SDABP-001'}})
  const meta=await runSource(e,preset('fanza'),'SDABP-001')
  assert.equal(meta.number,'SDABP-001');assert.equal(e.calls[1].init.json.variables.id,'1sdabp00001')
  assert.equal(meta.source_url,'https://video.dmm.co.jp/av/content/?id=1sdabp00001')
  assert.equal(await runSource(fanzaEnv([{id:'1sdabp00001'}],{'1sdabp00001':{...fanzaDetail,makerContentId:'SDABP-002'}}),preset('fanza'),'SDABP-001'),null)
})
test('FANZA 错号、空详情、API 错误和无年龄确认不报成功',async()=>{
  assert.equal(await runSource(fanzaEnv(undefined,{ssis00001:{...fanzaDetail,makerContentId:'SSIS-002'}}),preset('fanza'),'SSIS-001'),null)
  assert.equal(await runSource(fanzaEnv(undefined,{}),preset('fanza'),'SSIS-001'),null)
  const missing=fanzaEnv(undefined,{ssis00001:{...fanzaDetail,makerContentId:''}})
  await assert.rejects(runSource(missing,preset('fanza'),'SSIS-001'),/可核验的番号/)
  const failed=env([[/./,{body:{errors:[{message:'upstream failure'}],data:{ppvContent:null}}}]]);failed.ageConfirm=true
  await assert.rejects(runSource(failed,preset('fanza'),'SSIS-001'),/数据接口返回错误/)
  const age=fanzaEnv();age.ageConfirm=false
  await assert.rejects(runSource(age,preset('fanza'),'SSIS-001'),/年龄验证/)
  await assert.rejects(runSearch(age,preset('fanza'),'演员甲'),/年龄验证/)
  assert.equal(age.calls.length,0)
})
test('FANZA 关键词搜索原样传入，手工详情仍走 API 并严格检查站点及番号',async()=>{
  const e=fanzaEnv();await runSearch(e,preset('fanza'),'演员甲')
  assert.equal(e.calls[0].init.json.variables.keyword,'演员甲')
  e.calls.length=0
  const source={...preset('fanza'),manual_url:'https://video.dmm.co.jp/av/content/?id=ssis00001'}
  assert.equal((await runSource(e,source,'SSIS-001')).number,'SSIS-001');assert.equal(e.calls.length,1)
  assert.equal(await runSource(e,source,'SSIS-002'),null)
  for(const manual_url of ['https://other.test/av/content/?id=ssis00001','https://video.dmm.co.jp/av/content/','https://video.dmm.co.jp/other/?id=ssis00001'])await assert.rejects(runSource(e,{...source,manual_url},'SSIS-001'),/详情地址/)
})
test('FANZA 自动迁移旧官方地址，保留用户自定义代理地址',()=>{
  const base=url=>sourcePlan({source_config:{fanza:{base:url}}}).find(i=>i.def.id==='fanza').base
  assert.equal(base('https://www.dmm.co.jp/'),'https://api.video.dmm.co.jp')
  assert.equal(base('https://video.dmm.co.jp'),'https://api.video.dmm.co.jp')
  assert.equal(base('https://mirror.test/'),'https://mirror.test')
})
html('JavBus 年龄确认后的人工答题明确停止，不发送答案',async()=>{
  const quiz='<form method="post"><input name="userAnswers[0]" value="a"></form>'
  const e=env([[/./,{url:'https://www.javbus.com/doc/driver-verify',body:quiz}]],htmlLoad);e.ageConfirm=true
  await assert.rejects(runSource(e,preset('javbus'),'HEYZO-1048'),/人工答题验证/)
  assert.equal(e.calls.length,1);assert.notEqual(e.calls[0].init.method,'POST')
})

test('默认带 Accept-Language，避免被站点判成机器人（JavBus 会 302 到答题页）', async () => {
  // 404 让引擎在解析前返回，只为看请求头
  const e = env([[/javbus\.com\/SSIS-001/, { status: 404, body: 'not found' }]])
  await runSource(e, { ...preset('javbus'), detail: { url: 'https://www.javbus.com/SSIS-001' } }, 'SSIS-001')
  const headers = e.calls[0].init.headers
  assert.match(String(headers['Accept-Language'][0]), /zh-CN/)
  assert.match(String(headers.Accept[0]), /text\/html/)
  // 仍然带 Referer
  assert.equal(String(headers.Referer[0]), 'https://www.javbus.com/')
})

test('来源规则可覆盖默认请求头', async () => {
  const e = env([[/javbus\.com\/SSIS-001/, { body: { title: '标题' } }]])
  await runSource(e, { ...preset('javbus'), type: 'json', headers: { 'Accept-Language': 'ja-JP' }, detail: { url: 'https://www.javbus.com/SSIS-001' } }, 'SSIS-001')
  // JSON 接口默认不写 Accept，但语言头仍在
  assert.equal(e.calls[0].init.headers.Accept, undefined)
  assert.equal(String(e.calls[0].init.headers['Accept-Language'][0]), 'ja-JP')
})
