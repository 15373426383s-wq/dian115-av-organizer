// 后台整理任务：扫描收件目录 → 认番号 → 刮削 → 先写元数据 → 再移动视频。
// 由目录监听、定时任务或插件页触发；同一时间只运行一个（allow_overlap=false）。
// 一次运行内多个文件并发处理（concurrency），同一目标目录的写入与移动按顺序进行。
//
// 状态键（插件 KV）：
//   pending      待处理文件，后台独占写入
//   history      整理记录（含详情），后台独占写入
//   done         原地刮削模式下已处理的文件签名，后台独占写入
//   manual:<k>   页面写入的指定番号；ignore:<k> 页面写入的忽略标记（后台只读与清理）
//   cache:<番号> 刮削结果缓存

import { isVideoFile, splitExtension, compileCleanRules, normalizeNumber } from './lib/shared/number.js'
import { joinPath, dirname, basename, isCd2Path, cd2Internal, isWithin } from './lib/shared/naming.js'
import { buildNFO } from './lib/shared/nfo.js'
import { manualKey, ignoreKey, fileKey } from './lib/shared/keys.js'
import { applyMappings } from './lib/shared/mapping.js'
import { identify, parseWithSettings, kindOf } from './lib/identify.js'
import { scrape } from './lib/scrape.js'
import { isChallengePage } from './lib/engine.js'
import { solveChallenge } from './lib/challenge.js'
import { sourcePlan, prepareSourceCookies } from './lib/sources.js'
import { normalizeSettings, resolveDestination, planFile, subtitleTargets, parentNameFor } from './lib/plan.js'
import { mapPool, createThrottle, keyedLock, serial } from './lib/pool.js'
import { directoryConfigs } from './lib/shared/advanced.js'
import { fileDeadline } from './lib/deadline.js'
import { enrichFileContext } from './lib/file-context.js'
import { editMetadata } from './lib/metadata.js'
import { supplementalArtwork } from './lib/supplemental-art.js'
import { quarantineFiles } from './lib/cleanup.js'
import { prepareArtwork } from './lib/artwork.js'
import { enrichMetadata, processArtwork, sendWebhooks, HOST } from './lib/enrich.js'
import { isCloudTarget, isCloudSource, cloudContext, putFile, cloudStat, waitCloudFile, cloudTransfer, toCloudPath } from './lib/host-fs.js'

const HISTORY_LIMIT = 500
const PLOT_LIMIT = 16000

export async function run(ctx, input = {}) {
  const raw = await ctx.settings.get()
  const configs = directoryConfigs(raw, input)
  const summaries = []
  for (const [index, config] of configs.entries()) summaries.push(await runDirectory(ctx, index ? { ...input, rescrape: [] } : input, config))
  if (summaries.length === 1) return summaries[0]
  const total = Object.fromEntries(['success', 'pending', 'skipped', 'remaining'].map(key => [key, summaries.reduce((sum, result) => sum + (result[key] || 0), 0)]))
  await ctx.task.update({ stage: 'done', message: `${configs.length} 个目录：成功 ${total.success}，待处理 ${total.pending}，跳过 ${total.skipped}`, progress: 100, total: total.success + total.pending + total.skipped, done: total.success + total.skipped, failed: total.pending })
  return { ...total, directories: summaries }
}

async function runDirectory(ctx, input, raw) {
  const started = Date.now()
  const settings = normalizeSettings(raw)
  const rules = settings.mode === 'strm' && settings.action_mode !== 'in_place' ? await ctx.api.get('/api/rules') : []
  const destination = resolveDestination(settings, rules)
  for (const warning of destination.warnings) await ctx.task.log('⚠️ ' + warning)
  for (const error of compileCleanRules(settings.clean_rules).errors) await ctx.task.log('⚠️ 自定义清理规则' + error + '，已跳过')

  const state = await loadState(ctx)
  const env = await scrapeEnv(ctx, settings)
  const save = serial()
  const persist = () => save(() => saveState(ctx, state))
  // 并发处理中的文件：断点记录全部在途文件，中断后逐个核对。
  const inflight = new Map()
  const runtime = { lock: keyedLock(), reserved: new Set(), checkpoint: () => ctx.task.checkpoint({ stage: 'files', items: [...inflight.values()] }), inflight }

  // 页面发起的重新刮削：只更新元数据，不移动视频。
  const rescraped = []
  for (const id of Array.isArray(input.rescrape) ? input.rescrape : []) {
    rescraped.push(await rescrapeOne(ctx, env, state, settings, id, input))
    await persist()
  }
  if (input.rescrape_only) {
    return { rescraped }
  }

  await ctx.task.update({ stage: 'scan', message: '扫描收件目录' })
  let files = await listInbox(ctx, settings)
  // 刚入库的视频会被 stable_seconds 挡在稳定窗口外。目录监听只在"有变化"时触发一次，
  // 那时还太新的文件不会再有第二次机会，所以这里等到它们稳定后再扫一遍。
  if (!files.videos.length) {
    const fresh = files.all.filter(item => isVideoFile(item.name) && splitExtension(item.name).ext !== 'strm' &&
      Number.isFinite(Date.parse(item.modified || '')) && Date.now() - Date.parse(item.modified) < settings.stable_seconds * 1000)
    if (fresh.length) {
      const newest = Math.max(...fresh.map(item => Date.parse(item.modified)))
      const wait = Math.min(settings.stable_seconds * 1000, Math.max(3000, settings.stable_seconds * 1000 - (Date.now() - newest) + 2000))
      await ctx.task.log(`收件目录里的 ${fresh.length} 个视频还在写入窗口内，等 ${Math.round(wait / 1000)} 秒后再整理`)
      await ctx.sleep(wait)
      files = await listInbox(ctx, settings)
    }
  }
  if(settings.cleanup_source?.enabled)await quarantineFiles(ctx,files.all.filter(f=>!files.videos.includes(f)),settings)
  prunePending(state, files, settings)
  const controls = await loadControls(ctx, state)
  const siblingsByDir = groupByDir(files.all)
  const candidates = files.videos.filter(file => shouldAttempt(file, state, controls, input))
  const batch = candidates.slice(0, settings.max_files_per_run)
  await ctx.task.log(`收件目录共有 ${files.videos.length} 个视频，本次处理 ${batch.length} 个`)

  // 任务级计数：任务队列显示"已处理 done/total"，单个文件移动的进度不会覆盖整体进度。
  const summary = { success: 0, skipped: 0, pending: 0, items: [] }
  const counts = () => ({ total: batch.length, done: summary.success + summary.skipped, failed: summary.pending })
  runtime.counts = counts
  const workers = Math.min(settings.concurrency, batch.length || 1)
  await ctx.task.update({ stage: 'organize', message: batch.length ? `准备处理 ${batch.length} 个文件（同时 ${workers} 个）` : '没有需要处理的文件', ...counts() })
  const active = new Set()
  const activeText = () => [...active].slice(0, 3).join('、') + (active.size > 3 ? ` 等 ${active.size} 个` : '')
  const extra = file => enrichFileContext(parseWithSettings(file, '', settings), file, [], settings).extra
  for (const group of [batch.filter(file=>!extra(file)), batch.filter(extra)]) await mapPool(group, settings.concurrency, async file => {
    active.add(file.name)
    await ctx.task.update({ stage: 'organize', message: `正在处理：${activeText()}`, ...counts() })
    let outcome
    try {
      outcome = await organizeOne(ctx, env, file, siblingsByDir.get(dirname(file.path)) || [], state, controls, settings, destination, runtime)
    } catch (error) {
      // 单个文件的宿主操作失败不中断整批，留在待处理并写明原因。
      outcome = markPending(state, file, `整理出错：${error.message || error}`, {})
      await ctx.task.log(`❌ ${file.name}：${error.message || error}`)
    }
    if (outcome.status === 'pending') outcome = await maybeMoveFailed(ctx, state, file, settings) || outcome
    if(outcome.status !== 'skipped') await sendWebhooks(ctx, settings, { ...outcome, status: outcome.status === 'success' ? 'success' : 'failure', source: file.path, filename: file.name, duration_ms: outcome.duration_ms ?? Date.now()-started, metadata: state.history.find(e=>e.target===outcome.target) || {}, category: outcome.category || '' }, message => ctx.task.log(message))
    summary[outcome.status === 'failed_moved' ? 'pending' : outcome.status]++
    summary.items.push({ name: file.name, ...outcome })
    active.delete(file.name)
    await persist()
    await ctx.task.update({ stage: 'organize', message: `${file.name}：${statusLabel(outcome.status)}`, ...counts() })
  })

  if (summary.success > 0) await afterBatch(ctx, settings, destination)
  if (settings.notify && (summary.success > 0 || summary.pending > 0)) await notifySummary(ctx, summary)
  await ctx.storage.set('last_run', { at: new Date().toISOString(), duration_ms: Date.now() - started, success: summary.success, pending: summary.pending, skipped: summary.skipped, scanned: files.videos.length })
  await ctx.task.update({ stage: 'done', message: `成功 ${summary.success}，待处理 ${summary.pending}，跳过 ${summary.skipped}`, progress: 100, ...counts() })
  return { success: summary.success, pending: summary.pending, skipped: summary.skipped, rescraped, remaining: Math.max(0, candidates.length - batch.length) }
}

// 中断恢复：移动核对源文件已离开；保留源文件的操作必须有完成回执。
export async function recover(ctx, checkpoint) {
  // 旧版断点只记录一个文件；并发版本记录全部在途文件。
  const items = checkpoint?.stage === 'files' ? checkpoint.items || [] : checkpoint?.stage === 'file' ? [checkpoint] : []
  const state = await loadState(ctx)
  let changed = false
  for (const item of items) {
    if (!item?.videoTarget || item.inPlace) continue
    let arrived = await existsSafe(ctx, item.videoTarget, false)
    if (arrived && item.retained && !item.transfer_complete) {
      await ctx.task?.log?.(`中断的复制或链接尚未确认完成，请核对目标文件：${item.videoTarget}`)
      arrived = false
    }
    if (arrived && !item.retained) arrived = !await existsSafe(ctx, item.path, true)
    if (arrived && Number(item.expected_size) > 0 && item.transfer_mode !== 'symlink') {
      const target = await ctx.files.call({ operation: 'stat', path: item.videoTarget }).catch(() => null)
      arrived = !!target && !target.is_dir && Number(target.size) === Number(item.expected_size)
    }
    if (arrived && !state.history.some(entry => entry.target === item.videoTarget)) {
      addHistory(state, { status: 'success', source: item.path, target: item.videoTarget, number: item.number, title: item.title || '', note: '中断后核对：视频已在目标位置' })
      delete state.pending[item.path]
      changed = true
    }
    if (arrived && item.retained && item.signature) { state.done[item.path] = item.signature; changed = true }
  }
  if (changed) await saveState(ctx, state)
  return { action: 'resume' }
}

async function organizeOne(ctx, env, file, siblings, state, controls, settings, destination, runtime) {
  const started = Date.now()
  // 单文件时间预算：只在阶段边界检查，不包装宿主对象（见 jobs/lib/deadline.js）。
  const budget = fileDeadline(ctx, env, settings.file_timeout)
  const previous = state.pending[file.path]
  const control = controls.get(file.path) || {}
  const logs = []
  const log = message => { logs.push(message); return ctx.task.log(`${file.name}：${message}`) }
  const parent = parentNameFor(file.path, settings.inbox)

  budget.check()
  const initial = enrichFileContext(parseWithSettings(file,parent,settings),file,siblings,settings)
  if(initial.extra && settings.action_mode !== 'in_place') return organizeExtra(ctx,file,initial,state,settings,runtime,log)
  let result
  if (settings.reuse_metadata && settings.manual_metadata?.title) {
    const parsed = {...initial,number:normalizeNumber(settings.manual_number || settings.manual_metadata.number || initial.number)}
    if(!parsed.number) throw new Error('复用资料需要有效番号')
    result={ok:true,parsed,meta:editMetadata({number:parsed.number},settings.manual_metadata),method:'manual',score:100}
  } else if (settings.action_mode === 'from_nfo') {
    const raw=await ctx.api.post(`${HOST}/media/nfo`,{path:joinPath(dirname(file.path),splitExtension(file.name).stem+'.nfo')})
    const number=normalizeNumber(raw.number || initial.number)
    if(!number || (initial.number && number!==initial.number))throw new Error('NFO 番号缺失或与视频不一致')
    result={ok:true,parsed:{...initial,number},meta:{...raw,number},method:'nfo',score:100}
  } else if (settings.action_mode === 'rename_only') {
    // 只整理不刮削：只需要番号，元数据只有番号本身。
    result = await identifyNumberOnly(file, parent, settings, settings.manual_number || control.number || previous?.manual_number)
  } else {
    await log('识别番号中')
    result = await identify(env, file, parent, settings, scrapeCache(ctx), {
      manualNumber: settings.manual_number || control.number || previous?.manual_number,
      log,
    })
  }
  if (!result.ok) {
    return markPending(state, file, result.reason, {
      candidates: result.candidates, number: result.number, scores: result.scores, logs,
      parsed: result.parsed || parseWithSettings(file, parent, settings),
      manual: control.number, manualAt: control.manualAt,
    })
  }
  const parsed = enrichFileContext(result.parsed,file,siblings,settings)
  if(settings.action_mode==='from_nfo'){
    const dir=dirname(file.path),base=splitExtension(file.name).stem,existing={}
    for(const type of ['poster','fanart','thumb'])for(const name of [`${base}-${type}.jpg`,`${type}.jpg`]){const path=joinPath(dir,name);if(await exists(ctx,path)){existing[type]=path;break}}
    settings={...settings,existing_files:existing}
  }
  if (settings.subtitle_library) {
    try {
      env.subtitleFiles ||= subtitleLibraryFiles(ctx, settings)
      result.librarySubtitles = matchSubtitles(await env.subtitleFiles, settings, result.meta.number)
      if (result.librarySubtitles.some(item => !/\.(en|eng|ja|jpn)(?:\.|$)/i.test(item.name))) parsed.flags = { ...parsed.flags, chinese: true }
    } catch (e) { await log(`字幕库读取失败：${e.message || e}`); result.librarySubtitles = [] }
  }
  const meta = settings.action_mode === 'rename_only' || settings.reuse_metadata ? applyMappings(editMetadata(result.meta,settings.manual_metadata), settings) : await (async () => {
    await log('刮削资料与分辨率中')
    const value = await enrichMetadata(ctx, applyMappings(result.meta, settings), parsed, file, settings, log)
    await log('资料完成')
    return value
  })()
  if (result.method !== 'exact') await log(`${methodText(result)} → ${meta.number}`)

  budget.check()
  const plan = planFile(file, parsed, meta, settings, destination)
  if(plan.videoTarget===file.path)plan.inPlace=true
  // 同一目标目录（例如同一番号的 CD1、CD2）的检查、写入与移动按顺序进行。
  budget.check()
  return runtime.lock(plan.metaDir || plan.videoDir || plan.videoTarget, () => placeFile(ctx, env, file, siblings, state, settings, runtime, { plan, parsed, meta, result, started, logs, log }))
}

async function placeFile(ctx, env, file, siblings, state, settings, runtime, { plan, parsed, meta, result, started, logs, log }) {
  if (!plan.inPlace && (runtime.reserved.has(plan.videoTarget) || (!settings.overwrite_video && await exists(ctx, plan.videoTarget)))) {
    markPending(state, file, `目标已存在：${plan.videoTarget}`, { candidates: [parsed.number], number: parsed.number, logs })
    addHistory(state, historyEntry({ status: 'skipped', file, plan, meta, parsed, result, note: '目标已存在，未覆盖', started, logs }))
    return { status: 'skipped', number: meta.number, target: plan.videoTarget }
  }

  if(settings.overwrite_video && ['hardlink','symlink'].includes(settings.transfer_mode) && await exists(ctx,plan.videoTarget)) throw new Error('链接模式不覆盖已有文件')
  if (!plan.inPlace) runtime.reserved.add(plan.videoTarget)
  runtime.inflight.set(file.path, { path: file.path, videoTarget: plan.videoTarget, inPlace: Boolean(plan.inPlace), retained: settings.transfer_mode !== 'move', transfer_mode: settings.transfer_mode, expected_size: Number(file.size) > 0 && Number(file.size) < 2147483648 ? Number(file.size) : 0, signature: signature(file), number: meta.number, title: meta.title })
  await runtime.checkpoint()
  try {
    return await finishFile(ctx, env, file, siblings, state, settings, runtime, { plan, parsed, meta, result, started, logs, log, transferComplete: async () => {
      runtime.inflight.get(file.path).transfer_complete = true
      await runtime.checkpoint()
    } })
  } finally {
    runtime.inflight.delete(file.path)
  }
}

// 视频搬运。源文件在 CD2 时，云端的 move 会返回「移动源身份已变化」，
// 而同一云盘内的 copy 是云端复制并可用，所以云端源统一按「复制 → 回读确认 → 删源」处理。
// 源与目标都在本机时直接 move（同文件系统是即时重命名）。
async function transferVideo(ctx, file, plan, settings, log) {
  const mode = settings.transfer_mode || 'move'
  const overwrite = Boolean(settings.overwrite_video)
  const targetCloud = await isCloudTarget(ctx, plan.videoTarget)
  if (mode !== 'move') {
    // 链接类操作没有字节进度，progress 传 true 反而会让宿主报错。
    await ctx.files.call({ operation: mode, path: file.path, destination: plan.videoTarget, overwrite, progress: false })
    return
  }
  // 目标是云端（STRM 模式下是 cd2:/...）时必须走云端搬运：源多半就在同一云盘里，
  // 用系统 move 跨挂载搬大文件既慢又容易让宿主中途失败。
  if (targetCloud || await isCloudSource(ctx, file.path)) {
    await cloudTransfer(ctx, file.path, plan.videoTarget, { overwrite, log })
    return
  }
  await ctx.files.call({ operation: 'move', path: file.path, destination: plan.videoTarget, overwrite, progress: true })
}

async function finishFile(ctx, env, file, siblings, state, settings, runtime, { plan, parsed, meta, result, started, logs, log, transferComplete }) {
  // 先写元数据，再移动视频：STRM 模式下宿主生成 .strm 并刷新 Emby 时，元数据已经就位。
  const written = settings.action_mode === 'rename_only'
    ? { files: {}, cover: '' }
    : await writeMetadata(ctx, env, meta, parsed, plan, settings, log, runtime)
  const subtitles = []
  if (!plan.inPlace) {
    await ctx.files.call({ operation: 'mkdir', path: plan.videoDir })
    await log(`搬运视频到 ${plan.videoTarget}`)
    await transferVideo(ctx, file, plan, settings, log)
    await transferComplete()
    // 视频先落位、再搬字幕：视频搬运失败时字幕仍留在收件目录，下一轮重试还能找到它们。
    const subtitleList = subtitleTargets(file.name, siblings, plan, settings)
    for (const subtitle of subtitleList) {
      try {
        const moveMode = settings.transfer_mode === 'move'
        if (moveMode && await isCloudSource(ctx, subtitle.source)) {
          await cloudTransfer(ctx, subtitle.source, subtitle.target, { overwrite: Boolean(settings.overwrite_video), log })
        } else {
          await ctx.files.call({ operation: moveMode ? 'move' : 'copy', path: subtitle.source, destination: subtitle.target, overwrite: Boolean(settings.overwrite_video), progress: false })
        }
        subtitles.push(subtitle.target)
      } catch (error) {
        await log(`字幕移动失败 ${basename(subtitle.source)}：${error.message || error}`)
      }
    }
    if (settings.transfer_mode !== 'move') state.done[file.path] = signature(file)
    if (settings.delete_empty && settings.transfer_mode === 'move') await removeEmptyParents(ctx, dirname(file.path), settings.inbox)
  } else {
    state.done[file.path] = signature(file)
  }
  if (result.librarySubtitles?.length) {
    try {
    await ctx.files.call({ operation: 'mkdir', path: plan.subtitleDir })
    for (const item of result.librarySubtitles) {
      const ext = splitExtension(item.name).ext
      const lang = item.name.match(/\.(zh|chs|cht|zh-cn|zh-tw|en|eng|ja|jpn)(?:\.|$)/i)?.[1] || 'chs'
      const target = joinPath(plan.subtitleDir, `${plan.base}.${lang}.${ext}`)
      if (await exists(ctx, target)) continue
      await ctx.files.call({ operation: 'copy', path: item.path, destination: target, overwrite: false, progress: false })
      subtitles.push(target)
    }
    } catch (e) { await log(`字幕库复制失败：${e.message || e}`) }
  }

  delete state.pending[file.path]
  await clearControls(ctx, file.path)
  addHistory(state, historyEntry({ status: 'success', file, plan, meta, parsed, result, written, subtitles, started, logs }))
  await ctx.task.log(`✅ ${file.name} → ${plan.inPlace ? '原地刮削' : plan.videoTarget}`)
  return { status: 'success', number: meta.number, target: plan.videoTarget, category: parsed.category, duration_ms: Date.now()-started }
}

async function identifyNumberOnly(file, parent, settings, manualNumber) {
  const parsed = parseWithSettings(file, parent, settings)
  if (manualNumber) { parsed.number = normalizeNumber(manualNumber); parsed.kind = kindOf(parsed.number) }
  if (!parsed.number) return { ok: false, reason: `${parsed.reason || '没有认出番号'}（只整理模式不做模糊搜索）`, candidates: parsed.candidates, parsed: parsedSummary(parsed) }
  return { ok: true, parsed, meta: { number: parsed.number, actors: [], genres: [], sources: [] }, method: manualNumber ? 'manual' : 'exact', score: 100 }
}

async function writeMetadata(ctx, env, meta, parsed, plan, settings, log, runtime) {
  // 下载进度：把当前下载项写进任务，任务队列里能看到「正在下载 海报（2/5）」。
  // 搬运阶段由宿主自己写字节级进度（stage=file:move），这里只补充插件侧的下载环节。
  const report = async message => {
    try { await ctx.task.update({ stage: 'download', message, ...(runtime?.counts?.() || {}) }) } catch { /* 进度更新失败不影响整理 */ }
  }
  // 元数据目标可能在本机，也可能在 CD2（STRM 模式下的输出目录常常是 CD2 挂载路径）。
  // 两种后端的落地方式不同：
  //   本机：宿主系统命令直接搬运，落地即可回读；
  //   CD2 ：插件生成的文件只能经挂载路径写进云端，写完必须回读云端确认——
  //         宿主对这类写入可能返回成功但云端读不到，确认不了就保留插件目录里的原件并说明原因。
  const cloudTarget = await isCloudTarget(ctx, plan.metaDir)
  const staging = `staging/${fileKey(plan.videoTarget)}`
  // 入口先抓住 files 引用：清理阶段直接用它，避免依赖作用域里的 ctx。
  const staged = []
  const files = {}
  const kept = []
  let cover = ''
  try {
  const names={poster:plan.posterName,fanart:plan.fanartName,thumb:plan.thumbName || `${plan.base}-thumb.jpg`}
  const wanted={...settings.image_options}
  if(settings.existing_files){
    for(const [target,name] of Object.entries(names)){
      const source=settings.existing_files[target], destination=joinPath(plan.metaDir,name)
      if(source && source!==destination && await exists(ctx,source)){await ctx.files.call({operation:'mkdir',path:plan.metaDir});await ctx.files.call({operation:'copy',path:source,destination,overwrite:settings.overwrite_images!==false,progress:false});files[target]=destination;wanted[target]=false}
    }
  }
  for(const [target,name] of Object.entries(names)) {
    if((settings.overwrite_images === false || settings.reuse_existing_artwork || settings.reuse_metadata) && await exists(ctx,joinPath(plan.metaDir,name))) {files[target]=joinPath(plan.metaDir,name);wanted[target]=false}
  }
  if (settings.download_images && !settings.reuse_metadata && (meta.cover || meta.poster)) {
    const artMeta=await supplementalArtwork(env,meta,settings,log)
    const paths=await prepareArtwork(ctx,env,artMeta,parsed,{...settings,image_options:wanted},staging,log,(text)=>report(`正在下载${text}`))
    for(const [target,item] of Object.entries(paths)){staged.push({path:item.path,name:names[target]});files[target]=joinPath(plan.metaDir,names[target])}
    const source=paths.poster?.path || paths.fanart?.path || paths.thumb?.path
    if(settings.cover_cache && source){
      cover=`covers/${fileKey(plan.videoTarget)}.jpg`
      await ctx.files.call({operation:'copy',path:source,destination:cover,overwrite:true,progress:false}).catch(()=>{cover=''})
    }
  }
  for (const target of settings.required_images || []) if (!files[target]) throw new Error(`必需图片缺失：${target}`)
  let trailer = ''
  if (!settings.reuse_metadata && settings.download_trailer && meta.trailer && /\.mp4(?:[?#]|$)/i.test(meta.trailer)) {
    const name = `${plan.base}-trailer.mp4`
    await report('正在下载预告片')
    const path = await download({ ...env, get: (url, options) => env.get(url, { ...options, timeout_seconds: Number(settings.trailer_timeout) || 120 }) }, meta.trailer, `${staging}/${name}`, meta.source_url, log)
    if (path) { staged.push({ path, name, directory: plan.videoDir || dirname(plan.videoTarget) }); files.trailer = joinPath(plan.videoDir || dirname(plan.videoTarget), name); trailer = files.trailer }
  } else if (!settings.reuse_metadata && settings.download_trailer && meta.trailer) {
    await log('预告片来源不是 MP4 直链，跳过下载')
  }
  const extrafanart = []
  if (!settings.reuse_metadata && settings.download_extrafanart && meta.samples?.length && settings.extrafanart_limit > 0) {
    const samples = meta.samples.slice(0, settings.extrafanart_limit)
    const saved = await mapPool(samples, 4, async (url, index) => {
      await report(`正在下载剧照（${index + 1}/${samples.length}）`)
      const input = await download(env, url, `${staging}/extra-raw-${index}`, meta.source_url, log)
      if (!input) return ''
      try { return await processArtwork(ctx, input, `${staging}/extrafanart/fanart${index + 1}.jpg`, 'extrafanart', meta, parsed, settings, log) }
      catch (e) { await log(`剧照处理失败：${e.message || e}`); return '' }
    })
    extrafanart.push(...saved.filter(Boolean))
  }
  const extraTags = []
  if (parsed.flags?.chinese) extraTags.push('中文字幕')
  if (parsed.flags?.uncensored) extraTags.push('无码破解')
  const extras = { resolution: [meta.resolution], actors: meta.actors, studio: [meta.studio], publisher: [meta.label], series: [meta.series], prefix: [meta.number?.split('-')[0]], subtitle: parsed.flags?.chinese ? ['中文字幕'] : [], mosaic: [parsed.flags?.uncensored ? '无码' : '有码'] }
  const expand = names => (names || []).flatMap(name => extras[name] || [name]).filter(Boolean)
  if(settings.nfo_enabled !== false) {
  const nfo = buildNFO(meta, { config: settings.nfo, extraTags: settings.nfo?.extra_tags ? expand(settings.nfo.extra_tags) : extraTags, extraGenres: expand(settings.nfo?.extra_genres), trailer, poster: files.poster ? plan.posterName : '', fanart: files.fanart ? plan.fanartName : '' })
  await ctx.files.call({ operation: 'write', path: `${staging}/${plan.nfoName}`, content: nfo })
  staged.push({ path: `${staging}/${plan.nfoName}`, name: plan.nfoName })
  files.nfo = joinPath(plan.metaDir, plan.nfoName)
  }

  await ctx.files.call({ operation: 'mkdir', path: plan.metaDir })
  // 逐个落地：CD2 目标用 copy + 云端回读确认，确认不了就把原件留在插件目录里。
  for (const item of staged) {
    if (item.directory) await ctx.files.call({ operation: 'mkdir', path: item.directory })
    const destination = joinPath(item.directory || plan.metaDir, item.name)
    const overwrite = item.name.endsWith('.nfo') || settings.overwrite_images !== false
    if (cloudTarget) {
      const put = await putFile(ctx, item.path, destination, { overwrite, log })
      if (!put.ok) kept.push(item.name)
    } else {
      await ctx.files.call({ operation: 'move', path: item.path, destination, overwrite, progress: false })
    }
  }
  // 校验元数据是否真的落到目标位置。
  const missing = []
  for (const [key, path] of Object.entries(files)) {
    if (typeof path !== 'string' || !path) continue
    if (!await exists(ctx, path)) { missing.push(key); delete files[key] }
  }
  if (missing.length) await log(`⚠ 元数据未能写入目标目录（${missing.join('、')}）：当前存储不接受写入插件生成的文件，本次只整理视频`)
  if (extrafanart.length) {
    // Kodi / Emby 约定：剧照放在视频同目录的 extrafanart 子目录。
    const dir = joinPath(plan.metaDir, settings.sample_layout==='extras' ? 'extras' : 'extrafanart')
    await ctx.files.call({ operation: 'mkdir', path: dir })
    for (const path of extrafanart) {
      const destination = joinPath(dir, settings.sample_layout==='extras' ? basename(path).replace(/\.jpg$/i,'.mp4') : basename(path))
      if (cloudTarget) {
        const put = await putFile(ctx, path, destination, { overwrite: settings.overwrite_images!==false, log })
        if (!put.ok) kept.push(basename(path))
      } else {
        await ctx.files.call({ operation: 'move', path, destination, overwrite: settings.overwrite_images!==false, progress: false })
      }
    }
    files.extrafanart = dir
    files.extrafanart_count = extrafanart.length
  }
  // 清理暂存必须在 return 之前完成，不能放在 finally 里：
  // 宿主在「return 触发的 finally」中执行 await 宿主调用会让脚本执行器整体失败
  // （任务只报 "script host call failed"，JS 的 catch 和 throw 都不生效，日志也会在这里断掉）。
  if (kept.length) await log(`以下文件未能写入目标，已保留在插件目录 ${staging}：${kept.join('、')}`).catch(() => {})
  else try { await ctx.files.call({ operation: 'remove', path: staging, progress: false }) } catch (e) { }
  return { files, cover }
  } catch (error) {
    // 真正的失败点先记下来，再保留暂存现场便于事后取回。
    await log(`写元数据失败：${String((error && (error.stack || error.message)) || error).split('\n').slice(0, 4).join(' | ')}`).catch(() => {})
    throw error
  }
}

async function download(env, url, saveTo, referer, log) {
  try {
    const result = await env.get(url, { save_to: saveTo, headers: referer ? { Referer: [referer] } : {} })
    if (result.status >= 200 && result.status < 300 && (result.size || 0) > 1024) return saveTo
    await log(`图片下载失败 ${url}：HTTP ${result.status}`)
  } catch (error) {
    await log(`图片下载失败 ${url}：${error.message || error}`)
  }
  return ''
}

// 重新刮削一条整理记录：用番号重新取数据（不走缓存），覆盖写入 NFO 与图片。
async function rescrapeOne(ctx, env, state, settings, id, input = {}) {
  const entry = state.history.find(item => item.id === id)
  if (!entry || entry.status !== 'success' || !entry.meta_dir || !entry.base) return { id, ok: false, reason: '记录不存在或不能重新刮削' }
  await ctx.task.update({ stage: 'rescrape', message: `重新刮削 ${entry.number}` })
  const parsed = { number: entry.number, kind: /^FC2-/i.test(entry.number) ? 'fc2' : 'standard', flags: entry.flags || {}, part: entry.part || 0 }
  const logs = []
  const log = message => { logs.push(message); return ctx.task.log(`${entry.number}：${message}`) }
  const { meta: raw, errors } = input.reuse_metadata ? {meta:editMetadata(entry,input.metadata || {}),errors:[]} : await scrape(env, parsed, { ...settings, no_cache: true }, scrapeCache(ctx))
  errors.forEach(log)
  if (!raw) return { id, ok: false, reason: `刮削失败：${errors.join('；')}` }
  const meta = input.reuse_metadata ? raw : await enrichMetadata(ctx, applyMappings(raw, settings), parsed, { path: entry.target, name: basename(entry.target) }, settings, log)
  const plan = { base: entry.base, metaDir: entry.meta_dir, videoTarget: entry.target, videoDir: dirname(entry.target), nfoName: `${entry.base}.nfo`, posterName: `${entry.base}-poster.jpg`, fanartName: `${entry.base}-fanart.jpg` }
  const written = await writeMetadata(ctx, env, meta, parsed, plan, {...settings,reuse_metadata:Boolean(input.reuse_metadata)}, log)
  Object.assign(entry, metaFields(meta), { files: { ...entry.files, ...written.files }, cover: written.cover || entry.cover, rescraped_at: new Date().toISOString(), logs: [...logs].slice(-20) })
  return { id, ok: true, number: meta.number }
}

// 连续失败达到次数后移到失败目录。
async function maybeMoveFailed(ctx, state, file, settings) {
  const entry = state.pending[file.path]
  if (!settings.failed_folder || settings.failed_move_after <= 0 || !entry || entry.attempts < settings.failed_move_after) return null
  let target = joinPath(settings.failed_folder, file.name)
  if (await exists(ctx, target)) {
    const { stem, ext } = splitExtension(file.name)
    target = joinPath(settings.failed_folder, `${stem}.${Date.now()}.${ext}`)
  }
  try {
    await ctx.files.call({ operation: 'mkdir', path: settings.failed_folder })
    await moveFile(ctx, file.path, target, false)
  } catch (error) {
    await ctx.task.log(`移到失败目录失败 ${file.name}：${error.message || error}`)
    return null
  }
  addHistory(state, { status: 'failed_moved', source: file.path, target, number: entry.number || '', title: '', note: `连续 ${entry.attempts} 次失败，已移到失败目录：${entry.reason}`, logs: entry.logs || [] })
  delete state.pending[file.path]
  await clearControls(ctx, file.path)
  return { status: 'failed_moved', target }
}

async function moveFile(ctx, source, target, overwrite) {
  return ctx.files.call({ operation: 'move', path: source, destination: target, overwrite, progress: false })
}

// 存在性判断。宿主对 CD2 挂载路径调 files.exists 会走 CloudDrive2 gRPC；路径不存在时宿主
// 直接让脚本执行器整体失败（任务只报 "script host call failed"，JS 的 catch 根本来不及执行，
// 日志也在这里断掉）。所以落在云盘挂载内的路径一律改用云端 stat。
// fallback 供「查询失败时按存在处理」的调用方使用。
async function existsSafe(ctx, path, fallback = false) {
  const { clouds } = await cloudContext(ctx)
  const cloud = toCloudPath(path, clouds)
  if (cloud) {
    try {
      const info = await ctx.cd2.call('stat', { path: cloud })
      return Boolean(info && (info.path || info.name))
    } catch { return fallback }
  }
  return ctx.files.call({ operation: 'exists', path }).catch(() => fallback)
}

async function exists(ctx, path) {
  return existsSafe(ctx, path, false)
}

async function afterBatch(ctx, settings, destination) {
  try {
    if ((destination.mode === 'local' || destination.mode === 'in_place') && settings.emby_refresh) {
      await ctx.api.post('/api/emby-control/library/refresh', {})
      await ctx.task.log('已请求刷新 Emby 媒体库')
    } else if (destination.mode === 'strm' && !destination.rule.realtime) {
      await ctx.api.post(`/api/rules/${destination.rule.id}/sync`, {})
      await ctx.task.log(`已触发 STRM 规则「${destination.rule.name}」增量同步，由宿主生成 STRM 并刷新 Emby`)
    }
  } catch (error) {
    await ctx.task.log(`整理后的刷新/同步失败：${error.message || error}`)
  }
}

async function notifySummary(ctx, summary) {
  const lines = summary.items.filter(item => item.status !== 'skipped').slice(0, 20)
    .map(item => item.status === 'success' ? `✅ ${item.number} ${basename(item.target)}` : `❓ ${item.name}：${item.reason || statusLabel(item.status)}`)
  await ctx.notify({ title: `番号整理：成功 ${summary.success}，待处理 ${summary.pending}`, body: lines.join('\n'), dedupe_key: `${ctx.task.id}:summary` }).catch(() => {})
}

// ---------- 收件目录 ----------

async function listInbox(ctx, settings) {
  const minBytes = settings.min_size_mb * 1024 * 1024
  const now = Date.now()
  let entries = []
  let complete = true
  if (settings.scan_paths?.length) {
    for (const path of settings.scan_paths) {
      const entry = await ctx.files.call({ operation: 'stat', path })
      if (entry.is_dir) entries.push(...await listRecursively(ctx, path, settings.scan_depth))
      else entries.push({ ...entry, path, name: entry.name || basename(path) })
    }
    complete = false
  } else if (isCd2Path(settings.inbox)) {
    const queue = [{ path: cd2Internal(settings.inbox), depth: 0 }]
    while (queue.length) {
      const current = queue.shift()
      const list = await ctx.cd2.call('list', { path: current.path, force_refresh: current.depth === 0 })
      for (const item of list || []) {
        const raw = item.path || joinPath(current.path, item.name)
        const path = isCd2Path(raw) ? raw : 'cd2:' + raw
        if (item.is_dir) { if (current.depth < settings.scan_depth) queue.push({ path: cd2Internal(path), depth: current.depth + 1 }); else complete = false }
        else entries.push({ name: item.name, path, size: item.size, modified: item.modified, is_dir: false })
      }
    }
  } else {
    try {
      entries = (await ctx.files.call({ operation: 'walk', path: settings.inbox, limit: 20000 })).filter(item => !item.is_dir)
      if (entries.length >= 20000) complete = false
    } catch (error) {
      // walk 不支持 CD2 挂载路径：收件目录在挂载点下时改为逐层 list。
      entries = await listRecursively(ctx, settings.inbox, settings.scan_depth)
      complete = false
    }
  }
  const videos = entries.filter(item => {
    if (!isVideoFile(item.name) || splitExtension(item.name).ext === 'strm') return false
    if (settings.extensions && !String(settings.extensions).toLowerCase().split(/[,\s]+/).map(v => v.replace(/^\./, '')).includes(splitExtension(item.name).ext)) return false
    if (String(settings.filename_blacklist || '').split('\n').map(v => v.trim()).filter(Boolean).some(v => item.name.toLowerCase().includes(v.toLowerCase()))) return false
    if ((item.size || 0) < minBytes) return false
    const modified = Date.parse(item.modified || '')
    return !(Number.isFinite(modified) && now - modified < settings.stable_seconds * 1000)
  })
  return { all: entries, videos, complete, present: new Set(entries.map(item => item.path)) }
}

async function listRecursively(ctx, root, maxDepth) {
  const out = [], queue = [{ path: root, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    for (const item of await ctx.files.call({ operation: 'list', path: current.path })) {
      if (item.is_dir) { if (current.depth < maxDepth) queue.push({ path: item.path, depth: current.depth + 1 }) }
      else out.push(item)
    }
  }
  return out
}

function groupByDir(entries) {
  const map = new Map()
  for (const entry of entries) {
    const dir = dirname(entry.path)
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir).push(entry)
  }
  return map
}

function signature(file) {
  return `${file.size || 0}:${file.modified || ''}`
}

// 已经不在收件目录里的待处理记录（被手动改名、移走或删除）直接清掉。
function prunePending(state, files, settings) {
  if (!files.complete) return
  for (const path of Object.keys(state.pending)) if (isWithin(settings.inbox, path) && !files.present.has(path)) delete state.pending[path]
  for (const path of Object.keys(state.done)) if (isWithin(settings.inbox, path) && !files.present.has(path)) delete state.done[path]
}

// 只为待处理文件读取页面写入的控制键（指定番号、忽略）。
async function loadControls(ctx, state) {
  const controls = new Map()
  for (const path of Object.keys(state.pending)) {
    const manual = await ctx.storage.get(manualKey(path))
    const ignore = await ctx.storage.get(ignoreKey(path))
    if (manual || ignore) controls.set(path, { number: manual?.number || '', manualAt: manual?.at || '', ignored: Boolean(ignore) })
  }
  return controls
}

async function clearControls(ctx, path) {
  await ctx.storage.remove(manualKey(path)).catch(() => {})
  await ctx.storage.remove(ignoreKey(path)).catch(() => {})
}

function shouldAttempt(file, state, controls, input) {
  if(Array.isArray(input.paths) && input.paths.includes(file.path))return true
  if (state.done[file.path] === signature(file)) return false
  const entry = state.pending[file.path]
  if (!entry) return true
  const control = controls.get(file.path) || {}
  if (control.ignored) return false
  if (Array.isArray(input.paths) && input.paths.includes(file.path)) return true
  if (control.number && control.manualAt !== entry.manual_at) return true
  if (input.retry_pending) return true
  if (entry.signature !== signature(file)) return true
  // 自动重试：站点暂时不可用、资料稍后才上架等情况不需要人工处理。
  return Date.parse(entry.next_attempt_at || '') <= Date.now()
}

const RETRY_BASE_MS = 3600 * 1000
const RETRY_MAX_MS = 24 * 3600 * 1000

function nextAttemptAt(attempts) {
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
  return new Date(Date.now() + delay).toISOString()
}

// ---------- 状态 ----------

function scrapeCache(ctx) {
  return {
    get: number => ctx.storage.get('cache:' + number),
    set: (number, value) => ctx.storage.set('cache:' + number, value),
  }
}

async function loadState(ctx) {
  return {
    pending: (await ctx.storage.get('pending')) || {},
    history: (await ctx.storage.get('history')) || [],
    done: (await ctx.storage.get('done')) || {},
  }
}

async function saveState(ctx, state) {
  await ctx.storage.set('pending', state.pending)
  await ctx.storage.set('history', state.history.slice(0, HISTORY_LIMIT))
  await ctx.storage.set('done', state.done)
}

function parsedSummary(parsed) {
  if (!parsed) return null
  return { cleaned: parsed.cleaned, number: parsed.number, kind: parsed.kind, query: parsed.query, loose: parsed.loose, candidates: parsed.candidates, flags: parsed.flags, part: parsed.part, from: parsed.from }
}

function markPending(state, file, reason, details) {
  const previous = state.pending[file.path]
  const attempts = previous?.signature === signature(file) ? (previous.attempts || 0) + 1 : 1
  state.pending[file.path] = {
    path: file.path, name: file.name, size: file.size || 0, signature: signature(file),
    reason, candidates: details.candidates || [], number: details.number || '', scores: details.scores || [],
    parsed: details.parsed?.cleaned !== undefined ? parsedSummary(details.parsed) : details.parsed || null,
    logs: (details.logs || []).slice(-20),
    // 记下页面写入的时间戳：同一次指定番号只自动尝试一次，避免每轮都重试。
    manual_number: details.manual || previous?.manual_number || '', manual_at: details.manualAt || previous?.manual_at || '',
    attempts, at: new Date().toISOString(), first_at: previous?.first_at || new Date().toISOString(),
    next_attempt_at: nextAttemptAt(attempts),
  }
  return { status: 'pending', reason }
}

function metaFields(meta) {
  return {
    number: meta.number, title: meta.title || '', original_title: meta.original_title || '',
    actors: meta.actors || [], genres: meta.genres || [], studio: meta.studio || '', label: meta.label || '',
    series: meta.series || '', director: meta.director || '', release_date: meta.release_date || '',
    runtime: meta.runtime || 0, plot: String(meta.plot || '').slice(0, PLOT_LIMIT),
    original_plot: String(meta.original_plot || '').slice(0, PLOT_LIMIT), display_title: meta.display_title || '',
    resolution: meta.resolution || '', media: meta.media || null, trailer: meta.trailer || '', actor_photos: meta.actor_photos || {},
    artwork_candidates: meta.artwork_candidates || {}, source_variants: meta.source_variants || [], category: meta.category || '',
    poster: meta.poster || '', samples: meta.samples || [], cover_remote: meta.cover || '', rating: meta.rating || '', votes: meta.votes || '',
    sources: meta.sources || [], source_urls: meta.source_urls || {}, field_sources: meta.field_sources || {}, cover_url: meta.poster || meta.cover || '',
  }
}

function historyEntry({ status, file, plan, meta, parsed, result, written = { files: {}, cover: '' }, subtitles = [], note = '', started, logs = [] }) {
  return {
    status, source: file.path, source_name: file.name, size: file.size || 0,
    target: plan.videoTarget, meta_dir: plan.metaDir, base: plan.base, in_place: Boolean(plan.inPlace),
    ...metaFields(meta),
    flags: parsed.flags || {}, part: parsed.part || 0,
    method: result.method, score: result.score,
    files: { ...written.files, subtitles }, cover: written.cover || '',
    note, duration_ms: Date.now() - started, logs: logs.slice(-20),
  }
}

function addHistory(state, item) {
  state.history.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...item })
  // 记录裁剪时连带清理插件目录里的封面缓存由页面"清理"操作负责，这里只控制条数。
  state.history.length = Math.min(state.history.length, HISTORY_LIMIT)
}

function statusLabel(status) {
  return { success: '已整理', skipped: '目标已存在，跳过', pending: '留在待处理', failed_moved: '已移到失败目录' }[status] || status
}

function methodText(result) {
  const score = result.score === null || result.score === undefined ? '' : `，匹配度 ${result.score}`
  return { loose: '宽松番号', fuzzy: '模糊搜索', manual: '指定番号', exact: '精确番号' }[result.method] + score
}

// ---------- 网络 ----------

export async function scrapeEnv(ctx, settings, extraDefs = []) {
  const bases = Object.fromEntries(sourcePlan(settings, extraDefs).map(item => [item.def.id, item.base]))
  const session = 'scrape'
  // CookieCloud 只读、只导入本插件私有会话：域名由用户在设置里显式填写，留空即完全不读；
  // 读到的 Cookie 不进日志、不落盘、不外发，也不回写 CookieCloud。
  // 本机自用场景下这是"用户授权给自己插件"的能力；对外分发时该字段默认留空。
  if (settings.cookiecloud_domains.length) {
    try {
      const snapshot = await ctx.cookiecloud('read', { domains: settings.cookiecloud_domains })
      if (snapshot?.cookies?.length) await ctx.http.importCookies({ session, cookies: snapshot.cookies })
    } catch (error) {
      await ctx.task?.log?.(`CookieCloud 导入失败：${error.message || error}`)
    }
  }
  await prepareSourceCookies(ctx, settings, session, message => ctx.task?.log?.(message), extraDefs)
  return {
    html: ctx.html,
    ageConfirm: settings.age_confirm === true,
    extraDefs,
    base: (id, fallback) => bases[id] || fallback || '',
    // 限速按站点计算：同一站点的请求间隔 request_delay_ms，不同站点并发进行。
    throttle: createThrottle(settings.request_delay_ms, ms => ctx.sleep(ms)),
    pause: () => Promise.resolve(),
    scrapes: new Map(),
    get: async (url, options = {}) => {
      let last
      const retries = Math.min(3, Math.max(0, Number(options.retry ?? settings.source_retry) || 0))
      const {retry, ...requestOptions} = options
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await ctx.http.request({ url, session, timeout_seconds: settings.request_timeout || 30, ...(settings.proxy ? { proxy: settings.proxy } : {}), ...requestOptions })
          if (settings.flaresolverr_endpoint && (!options.method || options.method === 'GET') && isChallengePage(response) && [200, 403, 503].includes(response.status)) {
            return await solveChallenge(ctx, settings, url, session, response, message => ctx.task?.log?.(message))
          }
          if (response.status < 500 && response.status !== 429) return response
          last = new Error(`HTTP ${response.status}`)
          if (attempt === retries) return response
        } catch (e) {
          // 宿主调用失败（带错误码）不在脚本里重试：交给任务级重试与 recover，
          // 避免与宿主的重试叠加，导致外部写操作被重复执行。
          if (e?.code) throw e
          last = e
        }
        if (attempt < retries) await ctx.sleep(Math.min(8000, 1000 * 2 ** attempt))
      }
      throw last
    },
  }
}

async function subtitleLibraryFiles(ctx, settings) {
  if (!String(settings.subtitle_library).startsWith('/')) throw new Error('字幕库必须是本地绝对路径')
  return await ctx.files.call({ operation: 'walk', path: settings.subtitle_library, limit: 20000 })
}
function matchSubtitles(entries, settings, number) {
  return entries.filter(item => !item.is_dir && ['srt', 'ass', 'ssa', 'vtt', 'sup', 'sub', 'idx'].includes(splitExtension(item.name).ext) && parseWithSettings({ ...item, name: item.name.replace(/\.(srt|ass|ssa|vtt|sup|sub|idx)$/i, '.mp4') }, '', settings).number === number)
}

async function removeEmptyParents(ctx, start, root) {
  for (let path = start; path !== root && isWithin(root, path); path = dirname(path)) {
    try {
      const children = await ctx.files.call({ operation: 'list', path })
      if (children.length) break
      // Host rmdir is non-recursive and fails if anything arrived since list.
      await ctx.files.call({ operation: 'rmdir', path })
    } catch { break }
  }
}

async function organizeExtra(ctx,file,parsed,state,settings,runtime,log) {
  const main=state.history.find(e=>e.status==='success' && e.number===parsed.number && dirname(e.source)===dirname(file.path) && !e.extra)
  if(!main)return markPending(state,file,'FC2 特典等待同目录主影片完成整理',{number:parsed.number})
  const dir=joinPath(dirname(main.target),String(settings.fc2_extras_folder || 'extras').replace(/[\\/]/g,''))
  const target=joinPath(dir,`${parsed.number}-extra${parsed.extra.index}.${splitExtension(file.name).ext}`)
  return runtime.lock(target,async()=>{
    if(await exists(ctx,target))return {status:'skipped',number:parsed.number,target}
    runtime.inflight.set(file.path,{path:file.path,videoTarget:target,retained:settings.transfer_mode!=='move',transfer_mode:settings.transfer_mode,expected_size:Number(file.size) < 2147483648 ? Number(file.size) : 0,signature:signature(file),number:parsed.number})
    await runtime.checkpoint()
    try{
      await ctx.files.call({operation:'mkdir',path:dir})
      await ctx.files.call({operation:settings.transfer_mode,path:file.path,destination:target,overwrite:false,progress:false})
      runtime.inflight.get(file.path).transfer_complete=true;await runtime.checkpoint()
      if(settings.transfer_mode!=='move')state.done[file.path]=signature(file)
      delete state.pending[file.path]
      addHistory(state,{status:'success',source:file.path,target,number:parsed.number,title:'特典',extra:true,note:'作为主影片附加内容，不写独立影片 NFO'})
      await log('特典已整理到主影片 extras 目录')
      return {status:'success',number:parsed.number,target,category:'fc2'}
    }finally{runtime.inflight.delete(file.path)}
  })
}
