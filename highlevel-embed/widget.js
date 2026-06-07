/**
 * Voice AI Observability Copilot — HighLevel Custom JS Widget
 *
 * Installs a floating "AI Copilot" button + slide-in sidebar iframe across the
 * HighLevel UI. Uses pushState/popstate hooks (NOT MutationObserver) to survive
 * HL's single-page navigation.
 *
 * Install path (agency-level):
 *   Agency View → Settings → Company → Custom JavaScript & Custom CSS
 *
 * Before pasting:
 *   1. Update BACKEND_URL below to your publicly-reachable backend URL
 *      (cloudflared tunnel, ngrok, or any HTTPS host serving this app).
 *   2. This widget contains no debug-logging calls (HL Custom JS guideline).
 */
;(function () {
  // ---- Configuration ----
  const BACKEND_URL = (window.__COPILOT_CONFIG__ && window.__COPILOT_CONFIG__.backendUrl)
    || 'https://steve-picks-eligibility-broadcasting.trycloudflare.com'
  const SIDEBAR_WIDTH = 440
  const BUTTON_ID = 'copilot-toggle'
  const SIDEBAR_ID = 'copilot-sidebar'
  const BACKDROP_ID = 'copilot-backdrop'

  // Defensive: don't double-install if the widget is re-loaded on SPA navigation
  if (window.__COPILOT_INSTALLED__) return
  window.__COPILOT_INSTALLED__ = true

  let isOpen = false

  // ---- Toggle button ----
  const btn = document.createElement('button')
  btn.id = BUTTON_ID
  btn.setAttribute('aria-label', 'Open Voice AI Copilot')
  btn.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
    'background:#0066FF', 'color:#fff', 'border:none', 'border-radius:9999px',
    'padding:12px 18px', 'font:600 13px/1 Inter,system-ui,sans-serif',
    'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,102,255,0.4)',
    'display:inline-flex', 'align-items:center', 'gap:6px', 'transition:transform 0.15s ease',
  ].join(';')
  btn.innerHTML = '<span style="font-size:14px">●</span> AI Copilot'
  btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)' })
  btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)' })

  // ---- Backdrop (click to close) ----
  const backdrop = document.createElement('div')
  backdrop.id = BACKDROP_ID
  backdrop.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.25)', 'z-index:99997',
    'opacity:0', 'pointer-events:none', 'transition:opacity 0.2s ease',
  ].join(';')

  // ---- Sidebar ----
  const sidebar = document.createElement('div')
  sidebar.id = SIDEBAR_ID
  sidebar.style.cssText = [
    'position:fixed', 'top:0', `right:-${SIDEBAR_WIDTH + 20}px`,
    `width:${SIDEBAR_WIDTH}px`, 'height:100vh', 'z-index:99998',
    'background:#fff', 'box-shadow:-4px 0 20px rgba(0,0,0,0.15)',
    'transition:right 0.25s ease', 'border-left:1px solid #E5E7EB',
    'display:flex', 'flex-direction:column',
  ].join(';')

  // Sidebar header (with close button)
  const header = document.createElement('div')
  header.style.cssText = [
    'flex:0 0 auto', 'padding:8px 12px', 'border-bottom:1px solid #E5E7EB',
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'background:#F5F6FA',
  ].join(';')
  header.innerHTML =
    '<span style="font:600 11px/1 Inter,system-ui;color:#0066FF;letter-spacing:0.5px;text-transform:uppercase">' +
    'AI Copilot</span>'

  const closeBtn = document.createElement('button')
  closeBtn.setAttribute('aria-label', 'Close Copilot')
  closeBtn.style.cssText = [
    'background:none', 'border:none', 'cursor:pointer',
    'font-size:18px', 'color:#6B7280', 'padding:4px 8px', 'line-height:1',
  ].join(';')
  closeBtn.textContent = '×'
  header.appendChild(closeBtn)

  // iframe — main dashboard
  const iframe = document.createElement('iframe')
  iframe.src = `${BACKEND_URL}/dashboard/`
  iframe.style.cssText = 'flex:1 1 auto;width:100%;border:none;background:#F5F6FA;'
  iframe.setAttribute('title', 'Voice AI Copilot Dashboard')

  sidebar.appendChild(header)
  sidebar.appendChild(iframe)

  // ---- Mount + open/close ----
  function mount() {
    if (!document.getElementById(BUTTON_ID))  document.body.appendChild(btn)
    if (!document.getElementById(BACKDROP_ID)) document.body.appendChild(backdrop)
    if (!document.getElementById(SIDEBAR_ID))  document.body.appendChild(sidebar)
  }

  function open() {
    isOpen = true
    sidebar.style.right = '0'
    backdrop.style.opacity = '1'
    backdrop.style.pointerEvents = 'auto'
    btn.style.display = 'none'
  }

  function close() {
    isOpen = false
    sidebar.style.right = `-${SIDEBAR_WIDTH + 20}px`
    backdrop.style.opacity = '0'
    backdrop.style.pointerEvents = 'none'
    btn.style.display = 'inline-flex'
  }

  btn.addEventListener('click', () => isOpen ? close() : open())
  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('click', close)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close() })

  // ---- SPA navigation survival ----
  // HL is a single-page app: it uses history.pushState which fires NO DOM mutation
  // event. MutationObserver alone is unreliable. We hook pushState + replaceState +
  // listen for popstate so the widget re-mounts after every HL route change.
  const origPush    = history.pushState.bind(history)
  const origReplace = history.replaceState.bind(history)
  history.pushState    = function (...args) { origPush(...args);    mount() }
  history.replaceState = function (...args) { origReplace(...args); mount() }
  window.addEventListener('popstate',   mount)
  window.addEventListener('pageshow',   mount)

  // Initial mount
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()
