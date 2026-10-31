import test from 'node:test'
import assert from 'node:assert/strict'
import { solveChallenge, solutionToResponse, flareSolverrEndpoint, challengeBudget } from '../jobs/lib/challenge.js'

function fakeCtx({ answer, render } = {}) {
  const calls = { request: [], render: [] }
  return {
    calls,
    http: {
      request: async options => { calls.request.push(options); if (answer instanceof Error) throw answer; return answer },
      render: async options => { calls.render.push(options); if (render instanceof Error) throw render; return render },
    },
  }
}

const settings = { flaresolverr_endpoint: 'http://192.168.1.157:8191', request_timeout: 30 }
const original = { status: 403, body: '<html>challenge</html>', url: 'https://example.com/a', headers: {} }
const okAnswer = { status: 200, body: JSON.stringify({ status: 'ok', solution: { status: 200, response: '<html><title>SSIS-001</title></html>', url: 'https://example.com/final', userAgent: 'UA' } }) }

test('端点归一化：补 /v1，重复不叠加', () => {
  assert.equal(flareSolverrEndpoint({ flaresolverr_endpoint: 'http://h:8191' }), 'http://h:8191/v1')
  assert.equal(flareSolverrEndpoint({ flaresolverr_endpoint: 'http://h:8191/' }), 'http://h:8191/v1')
  assert.equal(flareSolverrEndpoint({ flaresolverr_endpoint: 'http://h:8191/v1' }), 'http://h:8191/v1')
  assert.equal(flareSolverrEndpoint({}), '')
})

test('预算按来源超时×2，20–120 秒封顶', () => {
  assert.equal(challengeBudget({ request_timeout: 30 }), 60)
  assert.equal(challengeBudget({ request_timeout: 5 }), 20)
  assert.equal(challengeBudget({ request_timeout: 99 }), 120)
  assert.equal(challengeBudget({}), 60)
})

test('直连 request.get 成功：返回 body/url/status，不走宿主 render', async () => {
  const ctx = fakeCtx({ answer: okAnswer })
  const logs = []
  const response = await solveChallenge(ctx, settings, 'https://example.com/a', 'scrape', original, line => logs.push(line))
  assert.equal(response.status, 200)
  assert.match(response.body, /SSIS-001/)
  assert.equal(response.url, 'https://example.com/final')
  assert.equal(response.rendered, true)
  // 请求体是 FlareSolverr 的 request.get，且明确 direct 不走代理
  assert.equal(ctx.calls.request.length, 1)
  const sent = ctx.calls.request[0]
  assert.equal(sent.url, 'http://192.168.1.157:8191/v1')
  assert.equal(sent.method, 'POST')
  assert.equal(sent.proxy, 'direct')
  const payload = JSON.parse(sent.body)
  assert.equal(payload.cmd, 'request.get')
  assert.equal(payload.url, 'https://example.com/a')
  assert.equal(payload.maxTimeout, 60000)
  assert.equal(ctx.calls.render.length, 0)
  assert.ok(logs.some(line => line.includes('已用 FlareSolverr 渲染')))
})

test('配了端点但直连失败：保留原响应，不再调用宿主 render（避免 sessions.create 拖死实例）', async () => {
  const ctx = fakeCtx({ answer: { status: 500, body: 'boom' }, render: { html: '<html>rendered</html>', url: 'https://example.com/r' } })
  const logs = []
  const response = await solveChallenge(ctx, settings, 'https://example.com/a', 'scrape', original, line => logs.push(line))
  assert.equal(response.body, original.body)
  assert.equal(response.url, original.url)
  assert.equal(response.status, original.status)
  assert.equal(ctx.calls.render.length, 0)
  assert.ok(logs.some(line => line.includes('FlareSolverr 渲染失败')))
})

test('F 盾返回 error 状态时不会把错误页当成结果', async () => {
  const bad = { status: 200, body: JSON.stringify({ status: 'error', message: 'Challenge not solved' }) }
  assert.throws(() => solutionToResponse(bad, original, 'https://example.com/a'), /Challenge not solved/)
  const ctx = fakeCtx({ answer: bad })
  const response = await solveChallenge(ctx, settings, 'https://example.com/a', 'scrape', original)
  assert.equal(response.body, original.body)
  assert.equal(ctx.calls.render.length, 0)
})

test('没有配置端点时原样返回，不发任何请求', async () => {
  const ctx = fakeCtx({})
  const response = await solveChallenge(ctx, {}, 'https://example.com/x', 'scrape', original)
  assert.equal(response, original)
  assert.equal(ctx.calls.request.length, 0)
  assert.equal(ctx.calls.render.length, 0)
})
