// 后台的来源执行层：按注册表准备 Cookie（含可选的年龄确认）并通过引擎执行来源规则。
import { sourcePlan, searchPlan, sourcesForNumber } from './shared/registry.js'
import { runSource, runSearch } from './engine.js'

export { sourcePlan, searchPlan, sourcesForNumber }

// 每次运行准备一次：用户 Cookie，以及用户开启“年龄确认”后各站点的年龄确认 Cookie。
export async function prepareSourceCookies(ctx, settings, session, log = () => {}, extraDefs = []) {
  for (const item of sourcePlan(settings, extraDefs)) {
    if ((!item.enabled && settings.__only_source !== item.def.id) || !item.base) continue
    const cookies = new Map()
    for (const text of [settings.age_confirm ? item.def.age_cookie : '', item.cookie]) for (const part of String(text || '').split(';')) {
      const at = part.indexOf('='); if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
    }
    if (!cookies.size) continue
    try {
      await ctx.http.cookies({ url: item.base, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), session })
    } catch (error) {
      log(`${item.def.name} Cookie 设置失败：${error.message || error}`)
    }
  }
}

export function runPlanItem(env, item, number) {
  return runSource(env, { ...item.def, base: item.base }, number, { vars: { base: item.base, token: item.token } })
}

export function searchPlanItem(env, item, keyword) {
  return runSearch(env, { ...item.def, base: item.base }, keyword, { vars: { base: item.base, token: item.token, number: keyword } })
}
