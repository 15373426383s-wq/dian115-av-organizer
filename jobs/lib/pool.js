// 并发工具：宿主的异步调用在独立协程里执行，插件用 Promise 并发即可真正同时进行。

// 以最多 limit 个并发处理 items，结果按原顺序返回。
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

// 按键限速：同一个键（站点）的两次请求至少间隔 delayMs，不同站点互不等待。
export function createThrottle(delayMs, sleep) {
  const nextAt = new Map()
  return async key => {
    if (!(delayMs > 0)) return
    const now = Date.now()
    const at = Math.max(now, nextAt.get(key) || 0)
    nextAt.set(key, at + delayMs)
    if (at > now) await sleep(at - now)
  }
}

// 按键互斥：同一个键的任务排队执行，例如同一个目标目录的写入与移动。
export function keyedLock() {
  const tails = new Map()
  return async (key, fn) => {
    const previous = tails.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

// 串行化：并发调用按到达顺序依次执行，保存状态时避免旧快照覆盖新快照。
export function serial() {
  let tail = Promise.resolve()
  return fn => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }
}
