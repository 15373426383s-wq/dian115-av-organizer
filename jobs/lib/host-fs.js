// 统一文件层：把宿主文件操作按「本机 / CD2」分流封装，插件其它模块只调用这一层。
//
// 宿主分流规则（public-kit/developer-guide.md「文件与 CD2」）：
//   两端都在 CD2 挂载路径内（或 cd2: 写法） → CloudDrive2 gRPC 服务端执行，不经过本地 I/O，只能在同一云盘内；
//   任一边不在 CD2 内 → 系统命令执行，CD2 一侧使用其挂载路径。
//
// 由此产生两个必须处理的现实：
//   1. CD2 云端内容与本机文件互相看不到，插件自己生成的文件（NFO/图片/字幕）只能走系统命令进挂载；
//   2. 写进挂载不等于写进云端。宿主对「系统命令写 CD2 挂载」可能返回成功但云端不可见，
//      所以写入后必须回读云端确认，不能只看命令返回值。

import { isCd2Path, cd2Internal, joinPath, dirname, basename } from './shared/naming.js'

// CD2 写入后的回读确认：云端是异步上传，给几次重试。
const VERIFY_ATTEMPTS = 5
const VERIFY_INTERVAL_MS = 2000

// 宿主 CD2 云盘列表：[{name:'115open', path:'/115open'}]。
export async function cloudList(ctx) {
  try {
    const list = (await ctx.api.get('/api/cd2/clouds'))?.clouds
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

// 云盘列表按运行上下文缓存（一次运行内云盘不会变）。
// 同时把云盘前缀放进模块级变量，供 looksCloud 做同步判定。
const cloudCache = new WeakMap()
let cloudPrefixes = []
export async function cloudContext(ctx) {
  let entry = cloudCache.get(ctx)
  if (!entry) {
    entry = { clouds: await cloudList(ctx) }
    cloudCache.set(ctx, entry)
    cloudPrefixes = entry.clouds.map(cloud => '/' + cloud.name)
  }
  return entry
}

// 路径是否落在云端（同步判定）。宿主对 CD2 云端操作无法计算字节级进度：
// 在 progress 模式下会让脚本执行器整体失败，任务只报 "script host call failed"，
// JS 的 catch 也来不及执行。所以只要任一端在云端，就必须关掉进度上报。
export function looksCloud(path) {
  const value = String(path || '')
  if (isCd2Path(value)) return true
  return cloudPrefixes.some(prefix => value.includes(prefix + '/') || value === prefix)
}

// 目标路径是否落在 CD2：cd2: 写法，或落在某个云盘的挂载路径内。
export async function isCloudTarget(ctx, path) {
  if (isCd2Path(path)) return true
  const { clouds } = await cloudContext(ctx)
  return Boolean(toCloudPath(path, clouds))
}

// 源文件是否在 CD2。宿主 stat 会返回 backend（挂载路径或 cd2: 路径下的文件是 cd2），
// 读不到就按本机处理。CD2 里的文件用 move 会被宿主判成「移动源身份已变化」，
// 所以搬运前必须先问清楚源在哪一侧。
export async function isCloudSource(ctx, path) {
  try {
    const info = await ctx.files.call({ operation: 'stat', path })
    return Boolean(info && info.backend === 'cd2')
  } catch { return false }
}

// 宿主绝对路径落在某个 CD2 挂载内时，返回该云盘的内部路径（/云盘名/...）；否则返回 ''。
// 例：/CloudNAS/CloudDrive/115open/未刮削 → /115open/未刮削
export function toCloudPath(path, clouds) {
  const value = String(path || '')
  if (isCd2Path(value)) return cd2Internal(value)
  if (!value.startsWith('/')) return ''
  for (const cloud of clouds || []) {
    const key = '/' + cloud.name
    const at = value.indexOf(key)
    if (at >= 0 && (value.length === at + key.length || value[at + key.length] === '/')) return value.slice(at)
  }
  return ''
}

// 由收件目录反推 CD2 挂载前缀（插件拿不到系统设置里的 cd2_mount_prefix，
// 但收件目录本身就在挂载内，前缀就是云盘名之前的那一段）。
export function mountPrefixFrom(path, clouds) {
  const value = String(path || '')
  if (!value.startsWith('/')) return ''
  for (const cloud of clouds || []) {
    const key = '/' + cloud.name
    const at = value.indexOf(key)
    if (at >= 0 && (value.length === at + key.length || value[at + key.length] === '/')) return value.slice(0, at)
  }
  return ''
}

// 路径是否落在 CD2（cd2: 写法，或落在挂载前缀内）。
export function isCloudPath(path, prefix) {
  if (isCd2Path(path)) return true
  const value = String(path || '')
  const root = String(prefix || '').replace(/\/+$/, '')
  return Boolean(root) && value === root || Boolean(root) && value.startsWith(root + '/')
}

// ---------- 基础操作 ----------

export async function stat(ctx, path) {
  return ctx.files.call({ operation: 'stat', path })
}

export async function exists(ctx, path) {
  return ctx.files.call({ operation: 'exists', path }).catch(() => false)
}

export async function list(ctx, path) {
  return ctx.files.call({ operation: 'list', path })
}

export async function mkdir(ctx, path) {
  return ctx.files.call({ operation: 'mkdir', path })
}

export async function remove(ctx, path) {
  return ctx.files.call({ operation: 'remove', path, progress: false })
}

export async function removeMany(ctx, paths) {
  return ctx.files.call({ operation: 'remove', paths, progress: false })
}

export async function rename(ctx, path, name) {
  return ctx.files.call({ operation: 'rename', path, name })
}

// 宿主在后台任务里执行 move/copy/remove 时会每秒把进度写进当前任务，
// 任务队列里能看到「移动 a.mkv 1.2 GiB/4.0 GiB（1/3）」。
// 但云端（CD2）操作无法计算已传字节，progress 会让脚本执行器直接失败，必须关掉。
export async function move(ctx, path, destination, { overwrite = false, progress = true } = {}) {
  const want = progress && !looksCloud(path) && !looksCloud(destination)
  return ctx.files.call({ operation: 'move', path, destination, overwrite, progress: want })
}

export async function copy(ctx, path, destination, { overwrite = false, progress = true } = {}) {
  const want = progress && !looksCloud(path) && !looksCloud(destination)
  return ctx.files.call({ operation: 'copy', path, destination, overwrite, progress: want })
}

// ---------- CD2 云端 ----------

export async function cloudStat(ctx, cloudPath) {
  try {
    return await ctx.cd2.call('stat', { path: cd2Internal(cloudPath) })
  } catch { return null }
}

export async function cloudListDir(ctx, cloudPath, forceRefresh = false) {
  try {
    return await ctx.cd2.call('list', { path: cd2Internal(cloudPath), force_refresh: forceRefresh })
  } catch { return [] }
}

// 回读云端确认文件真的落地了。CD2 上传是异步的，需要重试。
export async function waitCloudFile(ctx, cloudPath, attempts = VERIFY_ATTEMPTS, intervalMs = VERIFY_INTERVAL_MS, sleep = ctx.sleep) {
  for (let i = 0; i < attempts; i++) {
    const file = await cloudStat(ctx, cloudPath)
    if (file && file.path) return file
    if (i < attempts - 1) await sleep(intervalMs)
  }
  return null
}

// 把插件生成的文件放进目标目录。
// 本机目标：直接复制。
// CD2 目标：走系统命令进挂载，再用云端回读确认；确认不了就保留插件目录里的原件并报告原因，
//          避免宿主「返回成功但云端没有」时把元数据悄悄丢掉。
export async function putFile(ctx, stagedPath, destination, { overwrite = false, progress = true, verify = true, log } = {}) {
  // 以前只认 cd2: 字面量，落进 CD2 挂载的普通绝对路径（/CloudNAS/...）不会回读确认。
  // 现在统一换算成云盘内部路径再回读，mount 与 cd2: 两种写法都能覆盖。
  let cloudPath = ''
  if (verify && looksCloud(destination)) {
    try { cloudPath = toCloudPath(destination, (await cloudContext(ctx)).clouds) } catch { cloudPath = '' }
  }
  const result = await copy(ctx, stagedPath, destination, { overwrite, progress })
  if (!cloudPath) return { ok: true, verified: true, result }
  const landed = await waitCloudFile(ctx, cloudPath)
  if (!landed) {
    await log?.(`CD2 未确认落地：${destination}（宿主已接收写入，但云端读不到该文件）`)
    return { ok: false, verified: false, result, reason: 'CD2 未确认落地' }
  }
  await ctx.files.call({ operation: 'remove', path: stagedPath, progress: false }).catch(() => {})
  return { ok: true, verified: true, result }
}

// CD2 内的搬运。ctx.files.call 本身就会按宿主规则分流：源与目标都在 CD2 内时自动走
// CloudDrive2 gRPC（不经本地 I/O），因此这里不直接调 gRPC，避免参数语义歧义。
//
// CD2 的 move 会返回「移动源身份已变化」，所以云端搬运用「复制 → 回读确认 → 删源」。
export async function cloudTransfer(ctx, source, destination, { overwrite = false, progress = true, cloudPaths, log } = {}) {
  const clouds = cloudPaths || (await cloudContext(ctx)).clouds
  const destCloud = toCloudPath(destination, clouds)
  // 目标不在 CD2 内：按普通搬运处理。原实现会用源文件路径去云端回读，
  // 结果「复制/移动其实成功，却报 CD2 复制未生效，源文件也不删」。
  if (!destCloud) return { backend: 'system', outcome: await move(ctx, source, destination, { overwrite, progress }) }
  const existing = await cloudStat(ctx, destination)
  if (existing) {
    if (!overwrite) throw new Error(`目标已存在：${destination}`)
    await remove(ctx, destination)
  }
  await copy(ctx, source, destination, { overwrite, progress })
  const landed = await waitCloudFile(ctx, destination)
  if (!landed) {
    await log?.(`CD2 复制未确认落地：${destination}`)
    throw new Error(`CD2 复制未生效：${destination}`)
  }
  await remove(ctx, source)
  return { backend: 'cd2' }
}

// 本机与 CD2 通用的搬运：CD2 目标走「复制→确认→删源」，本机目标直接 move。
export async function transfer(ctx, source, destination, { overwrite = false, progress = true, cloudPaths, log } = {}) {
  const clouds = cloudPaths || (await cloudContext(ctx)).clouds
  if (!toCloudPath(destination, clouds)) return { backend: 'system', outcome: await move(ctx, source, destination, { overwrite, progress }) }
  return { backend: 'cd2', outcome: await cloudTransfer(ctx, source, destination, { overwrite, progress, cloudPaths: clouds, log }) }
}

export { isCd2Path, cd2Internal, joinPath, dirname, basename }
