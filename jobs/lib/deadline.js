// Cooperative per-file budget: never race a still-running file transfer. Check
// between operations, then let an already-started write finish and checkpoint.
export function fileDeadline(ctx,env,seconds,now=Date.now){
  const limit=Math.max(0,Math.min(21600,Number(seconds)||0)), end=now()+limit*1000
  const check=()=>{if(limit && now()>end)throw new Error(`单文件处理超过 ${limit} 秒，已停止后续操作`)}
  const wrap=(fn,after=false)=>async(...args)=>{check();const value=await fn(...args);if(after)check();return value}
  const methods=(object,names)=>Object.fromEntries(names.filter(name=>typeof object?.[name]==='function').map(name=>[name,wrap((...args)=>object[name](...args))]))
  return {ctx:{...ctx,api:{...ctx.api,...methods(ctx.api,['get','post','put','patch','delete'])},files:{...ctx.files,...methods(ctx.files,['call'])},http:{...ctx.http,...methods(ctx.http,['request','render'])}},env:{...env,get:wrap((...args)=>env.get(...args),true)}}
}
