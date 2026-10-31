// 只读联网测试适配器；生产插件直接复用宿主 HTTP、Cookie 与 HTML。
import { createRequire } from 'node:module'
import { createThrottle } from '../jobs/lib/pool.js'
const { JSDOM, VirtualConsole } = createRequire(`${process.env.JSDOM_DIR || process.cwd()}/`)('jsdom')
const { CookieJar } = createRequire(`${process.env.JSDOM_DIR || process.cwd()}/`)('tough-cookie')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export function htmlLoad(body, { baseURL } = {}) {
  const doc = new JSDOM(body, { url: baseURL || 'https://x.test/', virtualConsole: new VirtualConsole() }).window.document
  const wrap = nodes => {
    const list = [...nodes]
    const sel = {
      length: list.length,
      find: s => wrap(list.flatMap(n => [...n.querySelectorAll(s)])),
      first: () => wrap(list.slice(0, 1)), eq: i => wrap(list.slice(i, i + 1)),
      text: () => list.map(n => n.textContent).join('').trim(), html: () => list[0]?.innerHTML || '',
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

export function createLiveEnv({onResponse, delay = Number(process.env.LIVE_DELAY_MS ?? 1500)} = {}) {
  const jar = new CookieJar(), trace = []
  async function requestBytes(url, init = {}) {
    let target = url, method = init.method || (init.form || init.json !== undefined ? 'POST' : 'GET'), body
    const headers = { 'User-Agent': UA, 'Accept-Language': 'ja,zh-CN;q=0.9,en;q=0.8' }
    for (const [k,v] of Object.entries(init.headers || {})) headers[k] = Array.isArray(v) ? v[0] : v
    if (init.form) { body = new URLSearchParams(init.form); headers['Content-Type'] = 'application/x-www-form-urlencoded' }
    else if (init.json !== undefined) { body = JSON.stringify(init.json); headers['Content-Type'] = 'application/json' }
    const signal = AbortSignal.timeout((init.timeout_seconds || 25) * 1000)
    for (let hop = 0; hop <= 10; hop++) {
      // 与宿主一致：每一跳收取 Set-Cookie，并只向对应域发送 Cookie。
      headers.Cookie = await jar.getCookieString(target)
      const response = await fetch(target, {headers,method,body,redirect:'manual',signal})
      for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, target)
      const location = response.headers.get('location')
      if ([301,302,303,307,308].includes(response.status) && location) {
        await response.body?.cancel()
        const next = new URL(location,target).href
        if (new URL(next).origin !== new URL(target).origin) for (const key of Object.keys(headers)) if (/^(authorization|proxy-authorization)$/i.test(key)) delete headers[key]
        if (response.status === 303 || ([301,302].includes(response.status) && method === 'POST')) {
          method = 'GET'; body = undefined
          for (const key of Object.keys(headers)) if (/^content-type$/i.test(key)) delete headers[key]
        }
        target = next; continue
      }
      const max = init.max_bytes || 32 * 1024 * 1024
      if (Number(response.headers.get('content-length') || 0) > max) { await response.body?.cancel(); throw new Error('响应超过测试读取上限') }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > max) throw new Error('响应超过测试读取上限')
      trace.push(`${response.status} ${url}${target !== url ? ' → '+target : ''}`)
      return {status:response.status,url:target,headers:Object.fromEntries(response.headers),bytes}
    }
    throw new Error('重定向超过 10 次')
  }
  return {
    trace, html: {load:htmlLoad}, base:(id,fallback)=>fallback, pause:async()=>{},
    throttle:createThrottle(delay,ms=>new Promise(resolve=>setTimeout(resolve,ms))),
    async setCookie(url,cookie) { await jar.setCookie(cookie,url) },
    requestBytes,
    async get(url,init={}) {
      const response = await requestBytes(url,init), {bytes} = response
      const declared = (response.headers['content-type'] || '').match(/charset=([\w-]+)/i)?.[1] || bytes.subarray(0,4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8'
      let body
      try { body = new TextDecoder(declared.toLowerCase()).decode(bytes) } catch { body = bytes.toString('utf8') }
      const result = {status:response.status,url:response.url,body}
      if (onResponse) await onResponse(result,url)
      return result
    },
  }
}
export const env = createLiveEnv()
export const trace = env.trace
