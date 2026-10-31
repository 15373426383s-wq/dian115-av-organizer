// 单文件处理的时间预算。
//
// 只提供检查点，**不包装宿主对象**：ctx.files / ctx.api / ctx.http 是宿主注入的运行时对象，
// 在进程内做 { ...obj } 复制或重新绑定方法会出问题——
//   复制：方法不可枚举，复制后 call 变成 undefined（"Cannot read property 'call' of undefined"）
//   重绑：(...a) => obj.call(...a) 之后调用会触发宿主错误（"script host call failed"）
// 所以这里只算时间，在阶段边界调用 check()。
export function fileDeadline(ctx, env, seconds, now = Date.now) {
  const limit = Math.max(0, Math.min(21600, Number(seconds) || 0))
  const end = now() + limit * 1000
  const check = () => {
    if (limit && now() > end) throw new Error(`单文件处理超过 ${limit} 秒，已停止后续操作`)
  }
  return { ctx, env, check, limit }
}
