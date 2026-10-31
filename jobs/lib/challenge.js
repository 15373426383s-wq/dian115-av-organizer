// 挑战页兜底：拿到防护/验证页面时，改用 FlareSolverr 兼容服务重新取页面。
//
// 优先「直连 request.get」而不是宿主 render：
//   1. 只实现 request.get 的实例（例如 F 盾）也能用；
//   2. 宿主 render 需要先 sessions.create，某些实例上会卡住甚至把服务拖死；
//   3. 直连可以自己控制超时预算，不会长时间占住来源请求。
// 直连失败再退回宿主 render。两条路径统一成 {status, body, url}，
// 因为来源解析读的是 response.body，而宿主 render 返回的字段名是 html。

const V1 = /\/v1$/i

export function flareSolverrEndpoint(settings = {}) {
  const base = String(settings.flaresolverr_endpoint || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return V1.test(base) ? base : `${base}/v1`
}

export function challengeBudget(settings = {}) {
  return Math.min(120, Math.max(20, (Number(settings.request_timeout) || 30) * 2))
}

// 把 FlareSolverr 的响应整理成和普通 http 响应同形的对象。
export function solutionToResponse(answer, original, url) {
  if (answer.status < 200 || answer.status >= 300) throw new Error(`HTTP ${answer.status}`)
  let data
  try { data = JSON.parse(String(answer.body || '{}')) } catch { throw new Error('FlareSolverr 返回的不是 JSON') }
  const solution = data.solution || {}
  if (data.status !== 'ok' || !solution.response) throw new Error(data.message || '没有返回页面')
  return {
    ...original,
    status: Number(solution.status) || 200,
    body: solution.response,
    url: solution.url || url,
    rendered: true,
  }
}

export async function solveChallenge(ctx, settings, url, session, original, log = () => {}) {
  const endpoint = flareSolverrEndpoint(settings)
  if (endpoint) {
    try {
      const budget = challengeBudget(settings)
      const answer = await ctx.http.request({
        url: endpoint,
        method: 'POST',
        // F 盾在内网，明确直连，避免被宿主代理带走。
        proxy: 'direct',
        headers: { 'Content-Type': ['application/json'] },
        body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: budget * 1000 }),
        timeout_seconds: budget + 10,
      })
      const response = solutionToResponse(answer, original, url)
      await log(`已用 FlareSolverr 渲染 ${url}`)
      return response
    } catch (error) {
      await log(`FlareSolverr 直连失败：${error.message || error}`)
    }
  }
  const base = String(settings.flaresolverr_endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
  const rendered = await ctx.http.render({ ...(base ? { endpoint: base } : {}), url, session, timeout_seconds: 120 })
  return { ...original, status: 200, body: rendered.html || '', url: rendered.url || url, rendered: true, http_status_verified: rendered.http_status_verified }
}
