// 页面数据访问：插件 KV、设置、任务与监听。页面只写自己的控制键，状态键由后台写入。
import { manualKey, ignoreKey } from './lib/keys.js'
import { withDefaults } from './lib/defaults.js'
import { SUBSCRIPTION_CONFIG, readSubscriptions, emptySubscriptions, subscriptionConfig } from './lib/subscriptions.js'

export function createStore(ctx) {
  const store = {
    settings: {},
    history: [],
    pending: {},
    ignored: new Set(),
    lastRun: null,
    watch: null,
    runs: [],
    subscriptions: emptySubscriptions(),
    subscriptionConfig: subscriptionConfig(),
    async loadSettings() {
      store.settings = withDefaults(await ctx.settings.get().catch(() => ({})))
      return store.settings
    },
    async saveSettings(value) {
      await ctx.settings.set(value)
      store.settings = withDefaults(await ctx.settings.get())
      return store.settings
    },
    async loadState() {
      const [history, pending, lastRun, watches, runs, subscriptions, subConfig] = await Promise.all([
        ctx.storage.get('history').catch(() => []),
        ctx.storage.get('pending').catch(() => ({})),
        ctx.storage.get('last_run').catch(() => null),
        ctx.watch.list().catch(() => []),
        ctx.tasks.list(30, 0).catch(() => []),
        readSubscriptions(ctx),
        ctx.storage.get(SUBSCRIPTION_CONFIG),
      ])
      store.history = Array.isArray(history) ? history : []
      store.pending = pending && typeof pending === 'object' ? pending : {}
      store.lastRun = lastRun
      store.watches = (watches || []).filter(item => item.job === 'organize')
      store.watch = store.watches[0] || null
      store.runs = runs || []
      store.subscriptions = subscriptions
      store.subscriptionConfig = subscriptionConfig(subConfig)
      const flags = await Promise.all(Object.keys(store.pending).map(async path => [path, await ctx.storage.get(ignoreKey(path)).catch(() => null)]))
      store.ignored = new Set(flags.filter(([, value]) => value).map(([path]) => path))
      return store
    },
    coverURL(path) {
      return path ? ctx.files.downloadURL(path, { inline: true }) : ''
    },
    async runOrganize(input = {}) {
      return ctx.tasks.run('organize', `page:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, input)
    },
    async setManual(path, number) {
      await ctx.storage.set(manualKey(path), { number, at: new Date().toISOString() })
    },
    async setIgnored(path, ignored) {
      if (ignored) await ctx.storage.set(ignoreKey(path), { at: new Date().toISOString() })
      else await ctx.storage.remove(ignoreKey(path))
      ignored ? store.ignored.add(path) : store.ignored.delete(path)
    },
    async waitRun(id, timeoutMs = 300000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const run = await ctx.tasks.get(id)
        if (['succeeded', 'failed', 'cancelled', 'attention_required'].includes(run.status)) return run
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      throw new Error('等待超时，请到任务队列查看结果')
    },
    organizeRuns() {
      return store.runs.filter(item => item.job_id === 'organize')
    },
  }
  return store
}
