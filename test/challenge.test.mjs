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

test('直连失败退回宿主 render，并把 html 映射成 body', async () => {
  const ctx = fakeCtx({ answer: { status: 500, body: 'boom' }, render: { html: '<html>rendered</html>', url: 'https://example.com/r', http_status_verified: true } })
  const logs = []
  const response = await solveChallenge(ctx, settings, 'https://example.com/a', 'scrape', original, line => logs.push(line))
  assert.equal(response.body, '<html>rendered</html>')
  assert.equal(response.url, 'https://example.com/r')
  assert.equal(response.status, 200)
  assert.equal(ctx.calls.render.length, 1)
  assert.equal(ctx.calls.render[0].endpoint, 'http://192.168.1.157:8191')
  assert.ok(logs.some(line => line.includes('FlareSolverr 直连失败')))
})

test('F 盾返回 error 状态时不会把错误页当成结果', async () => {
  const bad = { status: 200, body: JSON.stringify({ status: 'error', message: 'Challenge not solved' }) }
  assert.throws(() => solutionToResponse(bad, original, 'https://example.com/a'), /Challenge not solved/)
  const ctx = fakeCtx({ answer: bad, render: { html: '<html>ok</html>', url: 'https://example.com/a' } })
  const response = await solveChallenge(ctx, settings, 'https://example.com/a', 'scrape', original)
  assert.equal(response.body, '<html>ok</html>')
})

test('没有配置端点时直接走宿主 render', async () => {
  const ctx = fakeCtx({ render: { html: '<html>x</html>', url: 'https://example.com/x' } })
  const response = await solveChallenge(ctx, {}, 'https://example.com/x', 'scrape', original)
  assert.equal(response.body, '<html>x</html>')
  assert.equal(ctx.calls.request.length, 0)
  assert.equal(ctx.calls.render[0].endpoint, undefined)
})
