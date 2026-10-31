// 宿主内置整理失败事件（library_organize_fail）。开启"接手"后，能认出番号的视频
// 被移进插件收件目录，由插件自己的流程从头整理；不会交回宿主整理。

import { parseMedia, isVideoFile } from '../ui/lib/number.js'
import { joinPath, basename, dirname, isWithin } from '../ui/lib/naming.js'
import { normalizeSettings } from './lib/plan.js'

export async function run(ctx, event = {}) {
  const settings = normalizeSettings(await ctx.settings.get())
  if (!settings.takeover_failed || !settings.inbox) return { skipped: '未开启接手' }
  const source = String(event?.data?.source_path || '').trim()
  if (!source.startsWith('/') || !isVideoFile(source)) return { skipped: '事件没有可用的视频路径' }
  if (isWithin(settings.inbox, source)) return { skipped: '已在收件目录' }
  const parsed = parseMedia(basename(source), basename(dirname(source)))
  if (!parsed.number) return { skipped: '没有认出番号，保持原样' }
  const target = joinPath(settings.inbox, basename(source))
  if (await ctx.files.call({ operation: 'exists', path: target }).catch(() => false)) return { skipped: '收件目录已有同名文件' }
  await ctx.files.call({ operation: 'move', path: source, destination: target, overwrite: false })
  await ctx.task.log(`接手内置整理失败的 ${parsed.number}：${source} → ${target}`)
  return { moved: target, number: parsed.number }
}
