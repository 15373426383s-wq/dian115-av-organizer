import {createFileBrowser} from './file-browser.js'
// 页面通用组件：元素构建、图标、按钮、提示、对话框、抽屉、路径浏览器、格式化。

const ICONS = {
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  film: '<path d="M4 5h16v14H4z"/><path d="M8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  move: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M12 13h6M15 10l3 3-3 3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h.01M11 15h6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
}

export function createUI(root) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  let theme='light'
  const dialogs=new Set(),timers=new Set()
  const later=(fn,ms)=>{const id=win.setTimeout(()=>{timers.delete(id);fn()},ms);timers.add(id);return id}
  const setTheme=mode=>{theme=mode;for(const node of [toastBox,...[...dialogs].map(d=>d.overlay)])if(node)node.dataset.theme=mode}
  const dispose=()=>{for(const d of [...dialogs])d.close();for(const id of timers)win.clearTimeout(id);toastBox?.remove()}

  function el(tag, props = {}, ...children) {
    const node = doc.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
      else if (key in node && typeof value !== 'string') node[key] = value
      else if (key in node && ['value', 'checked', 'disabled', 'hidden', 'textContent', 'title', 'type', 'placeholder', 'min', 'max', 'step', 'src', 'href', 'alt', 'selected', 'htmlFor'].includes(key)) node[key] = value
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof win.Node ? child : String(child))
    }
    return node
  }

  function icon(name, size = 16) {
    const span = doc.createElement('span')
    span.style.display = 'inline-flex'
    span.setAttribute('aria-hidden', 'true')
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`
    return span
  }

  // 按钮：传入异步 action 时，执行期间禁用并显示加载状态，错误交给 toast。
  function button(label, options = {}) {
    const node = el('button', { type: 'button', class: ['avo-btn', options.kind, options.size].filter(Boolean).join(' '), title: options.title, disabled: options.disabled },
      options.icon ? icon(options.icon, options.size === 'sm' ? 14 : 16) : null, label ? el('span', {}, label) : null)
    if (options.onClick) {
      node.addEventListener('click', async event => {
        event.stopPropagation()
        if (node.disabled) return
        node.disabled = true
        const original = node.firstChild
        let spinner = null
        if (options.icon) { spinner = icon('refresh', options.size === 'sm' ? 14 : 16); spinner.firstChild.classList.add('spin'); node.replaceChild(spinner, original) }
        try {
          await options.onClick(event)
        } catch (error) {
          toast(errorText(error), 'error')
        } finally {
          if (node.isConnected || spinner) { if (spinner) node.replaceChild(original, spinner); node.disabled = Boolean(options.disabled) }
        }
      })
    }
    return node
  }

  let toastBox = null
  function toast(message, kind = 'info', timeout = 4200) {
    if (!toastBox || !toastBox.isConnected) { toastBox = el('div', { class: 'avo-toasts avo',dataset:{theme} }); doc.body.append(toastBox) }
    const node = el('div', { class: `avo-toast avo-toast--${kind}`, role: 'status' }, message)
    toastBox.append(node)
    later(() => node.remove(), timeout)
  }

  // 对话框 / 抽屉。返回 {close, body, foot}；ESC 与点击遮罩关闭。
  function dialog(title, options = {}) {
    const body = el('div', { class: 'avo-dialog-body' })
    const foot = el('div', { class: 'avo-dialog-foot' })
    const overlay = el('div', { class: `avo avo-overlay${options.drawer ? ' drawer' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title })
    const previous=doc.activeElement
    let closed=false
    const entry={overlay,close:()=>close()}
    overlay.dataset.theme=theme
    const close = () => {if(closed)return;closed=true;dialogs.delete(entry);overlay.remove();doc.removeEventListener('keydown',onKey);options.onClose?.();if(previous?.isConnected)previous.focus()}
    const onKey = event => {
      if([...dialogs].at(-1)!==entry)return
      if(event.key==='Escape'){event.preventDefault();close()}
      if(event.key==='Tab'){
        const nodes=[...overlay.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(n=>!n.disabled&&!n.closest('[hidden]'))
        const first=nodes[0],last=nodes.at(-1)
        if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last?.focus()}
        else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus()}
      }
    }
    const heading = el('div', { class: 'avo-dialog-heading' },
      options.icon ? el('span', { class: `avo-dialog-icon ${options.tone || ''}` }, icon(options.icon, 18)) : null,
      el('div', { class: 'avo-dialog-titles' }, el('h3', {}, title), options.subtitle ? el('div', { class: 'avo-dialog-sub' }, options.subtitle) : null))
    const head = el('div', { class: 'avo-dialog-head' }, heading, button('', { kind: 'ghost', icon: 'close', size: 'sm', title: '关闭', onClick: close }))
    const box = el('div', { class: 'avo-dialog', style: options.width ? { width: `min(${options.width}px,100%)` } : null }, head, body)
    if (!options.noFoot) box.append(foot)
    overlay.append(box)
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close() })
    doc.addEventListener('keydown', onKey)
    doc.body.append(overlay)
    dialogs.add(entry)
    later(()=>{if(!closed)overlay.querySelector('button,input,select')?.focus()},0)
    return { close, body, foot, head }
  }

  // 输入框对话框：替代 window.prompt（不少手机 App 内嵌网页会屏蔽原生弹框）。
  function prompt(title, label, initial = '', help = '') {
    return new Promise(resolve => {
      let done = false
      const d = dialog(title, { width: 460, icon: 'edit', onClose: () => { if (!done) resolve(null) } })
      const input = el('input', { class: 'avo-input', value: initial })
      const ok = () => { done = true; const value = input.value.trim(); d.close(); resolve(value) }
      input.addEventListener('keydown', event => { if (event.key === 'Enter') ok() })
      d.body.append(field(label, input, help))
      d.foot.append(button('取消', { onClick: () => d.close() }), button('确定', { kind: 'primary', onClick: ok }))
      later(() => input.focus(), 50)
    })
  }

  function confirm(title, message, okLabel = '确定', kind = 'primary') {
    return new Promise(resolve => {
      let done = false
      const d = dialog(title, { width: 460, icon: 'alert', tone: kind === 'danger' ? 'danger' : 'warning', onClose: () => { if (!done) resolve(false) } })
      d.body.append(el('p', { style: { margin: 0 } }, message))
      d.foot.append(button('取消', { onClick: () => d.close() }), button(okLabel, { kind, onClick: () => { done = true; d.close(); resolve(true) } }))
    })
  }

  function pathPicker(ctx, initial = '', options = {}) {
    return new Promise(resolve => {
      let picked = false, browser
      const d = dialog(options.title || '选择目录', {width: 780, icon: 'folder', onClose: () => {browser?.dispose(); if (!picked) resolve(null)}})
      const select = button('选择此目录', {kind: 'primary', icon: 'check', onClick: () => {
        if (!browser.ready) throw new Error('请先打开一个可读取的目录')
        picked = true; const value = browser.path; d.close(); resolve(value)
      }})
      browser = createFileBrowser({el, button, icon, prompt, empty, formatSize, formatTime, errorText}, ctx, {
        initial, only: options.only, directoriesOnly: true, onReady: ready => {select.disabled = !ready},
      })
      d.body.append(browser.root)
      d.foot.append(button('取消', {onClick: () => d.close()}), select)
    })
  }

  async function copyText(text) {
    try {
      await win.navigator.clipboard.writeText(text)
      toast('已复制', 'success', 1600)
    } catch {
      const area = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } })
      doc.body.append(area); area.select()
      try { doc.execCommand('copy'); toast('已复制', 'success', 1600) } catch { toast('复制失败，请手动选择', 'warning') }
      area.remove()
    }
  }

  function pathLine(path, label) {
    if (!path) return null
    return el('div', { class: 'avo-row', style: { gap: '4px', flexWrap: 'nowrap' } },
      label ? el('span', { class: 'avo-hint', style: { minWidth: '64px' } }, label) : null,
      el('span', { class: 'avo-path' }, path),
      el('button', { class: 'avo-copy', title: '复制', onclick: event => { event.stopPropagation(); copyText(path) } }, icon('copy', 13)))
  }

  let fieldIndex = 0
  function field(label, control, help, error) {
    const input = control?.matches?.('input,select,textarea') ? control : control?.querySelector?.('input,select,textarea')
    if (input && !input.id) input.id = `avo-field-${++fieldIndex}`
    return el('div', { class: 'avo-field' }, el('label', {htmlFor: input?.id}, label), control, help ? el('div', { class: 'help' }, help) : null, error || null)
  }

  function switchInput(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked: Boolean(checked) })
    input.addEventListener('change', () => onChange(input.checked))
    return el('label', { class: 'avo-switch' }, input, el('span', {}, label))
  }

  function empty(message, iconName = 'film') {
    return el('div', { class: 'avo-empty' }, icon(iconName, 40), el('div', {}, message))
  }

  return { el, icon, button, toast, dialog, confirm, prompt, pathPicker, copyText, pathLine, field, switchInput, empty, doc, win, formatSize, formatTime, errorText, setTheme, dispose }
}

export function errorText(error) {
  return error?.response?.data?.error || error?.data?.error || error?.message || String(error || '未知错误')
}

export function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = Date.now()
  const diff = now - date.getTime()
  if (diff >= 0 && diff < 60000) return '刚刚'
  if (diff >= 0 && diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff >= 0 && diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 0 && diff > -86400000) return `${Math.ceil(-diff / 3600000)} 小时后`
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`
}

export function formatDuration(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return `${n} 毫秒`
  if (n < 60000) return `${(n / 1000).toFixed(1)} 秒`
  return `${Math.floor(n / 60000)} 分 ${Math.round((n % 60000) / 1000)} 秒`
}

export const METHOD_LABEL = { exact: '精确番号', loose: '宽松番号', fuzzy: '模糊匹配', manual: '指定番号' }
export const STATUS_LABEL = { success: '已整理', skipped: '已跳过', failed_moved: '移到失败目录' }
export const STATUS_KIND = { success: 'success', skipped: 'warning', failed_moved: 'danger' }
