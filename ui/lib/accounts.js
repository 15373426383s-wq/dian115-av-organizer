// 同一账号选择同时用于目录浏览、离线提交与回执核对。
export function accountSelector(value = {}) {
  const mode = value?.mode || 'main', id = value?.id
  if (!['main', 'backup'].includes(mode)) throw new Error('请选择一个具体的 115 账号')
  if (id !== undefined && id !== '' && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('115 账号选择无效，请重新选择')
  if (mode === 'backup' && !id) throw new Error('请选择备用账号')
  return {mode, ...(id ? {id: Number(id)} : {})}
}
export function accountQuery(value) {
  const account = accountSelector(value)
  return new URLSearchParams({account_mode: account.mode, ...(account.id ? {account_id: String(account.id)} : {})}).toString()
}
export const accountKey = value => {const a = accountSelector(value); return `${a.mode}:${a.id || ''}`}
