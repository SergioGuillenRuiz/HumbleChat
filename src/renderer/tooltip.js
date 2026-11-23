// Tooltips oscuros como los de Discord: cualquier elemento con data-tip="texto" (prop `tip` en h()).
import { h } from './util.js'

export function initTooltips() {
  const tip = h('div#tooltip')
  document.body.append(tip)
  let cur = null
  let timer = null

  const hide = () => { clearTimeout(timer); cur = null; tip.classList.remove('show') }

  function show(el) {
    tip.textContent = el.dataset.tip
    tip.dataset.pos = el.dataset.tipPos || 'top'
    tip.style.left = '0px'
    tip.style.top = '0px'
    tip.classList.add('show')
    const r = el.getBoundingClientRect()
    const t = tip.getBoundingClientRect()
    let x, y
    switch (tip.dataset.pos) {
      case 'right': x = r.right + 10; y = r.top + (r.height - t.height) / 2; break
      case 'bottom': x = r.left + (r.width - t.width) / 2; y = r.bottom + 8; break
      case 'left': x = r.left - t.width - 10; y = r.top + (r.height - t.height) / 2; break
      default: x = r.left + (r.width - t.width) / 2; y = r.top - t.height - 8
    }
    tip.style.left = Math.max(6, Math.min(x, innerWidth - t.width - 6)) + 'px'
    tip.style.top = Math.max(6, Math.min(y, innerHeight - t.height - 6)) + 'px'
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]')
    if (el === cur) return
    hide()
    if (!el) return
    cur = el
    timer = setTimeout(() => cur === el && el.isConnected && show(el), 350)
  })
  for (const evt of ['mousedown', 'wheel', 'keydown', 'blur']) addEventListener(evt, hide, true)
}
