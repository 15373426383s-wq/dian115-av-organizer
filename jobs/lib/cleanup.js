import {splitExtension,isVideoFile} from '../../ui/lib/number.js'
import {isWithin,joinPath} from '../../ui/lib/naming.js'
export function cleanupCandidates(files,settings,now=Date.now()) {
  const config=settings.cleanup_source || {}, protect=new Set(String(config.protect_extensions || '').toLowerCase().split(/[,\s]+/))
  const whitelist=new Set(String(settings.extensions || 'mp4,mkv,avi,mov,wmv,ts,m2ts,m4v,webm,mpg,mpeg,iso,vob,strm').toLowerCase().split(/[,\s]+/).map(e=>e.replace(/^\./,'')))
  return files.filter(f=>{
    if(f.is_dir || !isWithin(settings.inbox,f.path))return false
    const ext=splitExtension(f.name).ext
    if(protect.has(ext))return false
    const modified=Date.parse(f.modified || '')
    if(!Number.isFinite(modified) || now-modified<settings.stable_seconds*1000)return false
    const black=String(settings.filename_blacklist || '').split('\n').filter(Boolean).some(w=>f.name.toLowerCase().includes(w.toLowerCase()))
    return config.blacklisted && black || config.small && isVideoFile(f.name) && f.size<settings.min_size_mb*1024*1024 || config.unknown_extension && !whitelist.has(ext)
  })
}
export async function quarantineFiles(ctx,files,settings) {
  const cfg=settings.cleanup_source || {}
  if(!cfg.enabled)return 0
  const root=String(cfg.quarantine || '').replace(/\/+$/,'')
  if(!root.startsWith('/') || root.split('/').includes('..') || isWithin(settings.inbox,root) || isWithin(root,settings.inbox))throw new Error('清理目录必须位于收件目录之外')
  const candidates=cleanupCandidates(files,settings)
  for(const f of candidates){
    const target=joinPath(root,f.path.slice(settings.inbox.length))
    if(await ctx.files.call({operation:'exists',path:target}))continue
    await ctx.files.call({operation:'move',path:f.path,destination:target,overwrite:false})
    await ctx.task.log(`已移入清理目录：${f.name}`)
  }
  return candidates.length
}
