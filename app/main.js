'use strict'

// MAX Desktop — чистая Electron-обёртка над веб-клиентом web.max.ru.
// Только встроенные модули Electron, без внешних npm-зависимостей:
// весь код аудируем (в этом смысл проекта).

const { app, BrowserWindow, Tray, Menu, MenuItem, NativeImage, shell, session, ipcMain } = require('electron')
const { join } = require('path')
const fs = require('fs')

const WEB_URL = 'https://web.max.ru/'
const APP_NAME = 'MAX'

// Пользовательский агент: десктопный Chrome. Важно: web.max.ru по мобильному UA
// предлагает скачать приложение, а по UA с "Electron" может отдать урезанную
// версию — поэтому подменяем на чистый Chrome.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Конфигурация: ~/.config/max-electron/config.json (geometry + настройки)
// ---------------------------------------------------------------------------
const CONFIG_PATH = join(app.getPath('userData'), 'config.json')
const DEFAULTS = {
  tray: true,              // иконка в трее
  startMinimized: false,   // старт свёрнутым в трей
  closeToTray: true,       // крестик прячет окно, а не выходит
  notifications: true,     // показывать системные уведомления
  quietMode: false,        // не мигать рамкой при новых сообщениях
  proxy: '',               // напр. 'http://127.0.0.1:8080' или 'socks5://...'
  bounds: null             // {x,y,width,height,maximized}
}

function loadConfig () {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  } catch (e) {
    return Object.assign({}, DEFAULTS)
  }
}

function saveConfig () {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(state.config, null, 2))
  } catch (e) { /* конфиг не критичен */ }
}

const state = {
  config: loadConfig(),
  win: null,
  tray: null,
  unread: 0,
  forceQuit: false
}

// ---------------------------------------------------------------------------
// Единый экземпляр: второй запуск поднимает существующее окно
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => showWindow())

// ---------------------------------------------------------------------------
// Иконки
// ---------------------------------------------------------------------------
const ICONS = {
  app: join(__dirname, 'assets', 'icon.png'),
  tray: join(__dirname, 'assets', 'tray.png'),
  tray2x: join(__dirname, 'assets', 'tray@2x.png'),
  trayUnread: join(__dirname, 'assets', 'tray-unread.png'),
  trayUnread2x: join(__dirname, 'assets', 'tray-unread@2x.png'),
  overlay: join(__dirname, 'assets', 'badges', 'dot.png')
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------
function createWindow () {
  const b = state.config.bounds || { width: 1200, height: 800 }
  state.win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 420, minHeight: 400,
    title: APP_NAME,
    icon: ICONS.app,
    show: !state.config.startMinimized,
    autoHideMenuBar: true,
    // --- CSD: собственный титлбар, не зависим от WM (Compiz/Emerald) ---
    // frame:false убирает нативную рамку полностью; полосу заголовка рисуем
    // сами (inject), контент страницы опускаем ниже через обёртку.
    // titleBarOverlay НЕ используем: он рисует кнопки ПОВЕРХ контента,
    // а web.max.ru имеет собственную шапку на всю ширину — получался
    // «инородный кусок внутри окна».
    frame: false,
    backgroundColor: '#F4F6F9',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
      spellcheck: true
    }
  })

  // Инъекция титлбара: на dom-ready и на каждом finish-load (SPA-переходы,
  // reload). Функция идемпотентна — повторный вызов ничего не дублирует.
  const inject = () => injectTitlebar(state.win)
  state.win.webContents.on('dom-ready', inject)
  state.win.webContents.on('did-finish-load', inject)
  state.win.webContents.on('render-process-gone', (e, d) => {
    console.error('[max-electron] renderer gone:', d && d.reason)
  })

  if (state.config.bounds && state.config.bounds.maximized) {
    state.win.maximize()
  }

  // Внешние ссылки — в браузер, не в новое окно Electron.
  state.win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Запрет навигации на чужие домены (только *.max.ru / *.vk.ru / *.vk.com).
  state.win.webContents.on('will-navigate', (e, url) => {
    if (!isTrusted(url)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  state.win.loadURL(WEB_URL, { userAgent: USER_AGENT })

  // Запоминание геометрии
  const remember = () => {
    if (!state.win || !state.win.isVisible()) return
    const bb = state.win.getBounds()
    state.config.bounds = Object.assign(bb, { maximized: state.win.isMaximized() })
    saveConfig()
  }
  state.win.on('moved', remember)
  state.win.on('resized', remember)
  state.win.on('maximize', () => { remember(); tbMaximized(true) })
  state.win.on('unmaximize', () => { remember(); tbMaximized(false) })

  // Закрытие -> трей (иначе настоящий выход из меню трея)
  state.win.on('close', (e) => {
    if (!state.forceQuit && state.config.closeToTray && state.tray) {
      e.preventDefault()
      state.win.hide()
    }
  })

  state.win.on('page-title-updated', (e, title) => onTitle(title))
  state.win.on('focus', () => { state.win.flashFrame(false) })
  state.win.on('show', () => { state.win.focus(); state.win.flashFrame(false) })
}

function isTrusted (url) {
  try {
    const h = new URL(url).hostname
    return ['max.ru', 'web.max.ru'].includes(h) || h.endsWith('.max.ru') ||
           h.endsWith('.vk.ru') || h.endsWith('.vk.com') || h === 'vk.com'
  } catch (e) { return false }
}

// ---------------------------------------------------------------------------
// Собственный титлбар (CSD)
//
// Полоса 38px зафиксирована сверху, контент страницы переносится в обёртку
// под неё. Обёртка нужна вместо padding на html/body: web.max.ru использует
// height:100vh на корневом контейнере, и padding сдвинул бы контент, но
// оставил бы 38px мёртвой зоны снизу. Перенос детей body в fixed-обёртку с
// height:100% !important корректно гасит 100vh.
// ---------------------------------------------------------------------------
const TB_HEIGHT = 38

const TB_CSS = `
#max-shell-titlebar {
  position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
  height: ${TB_HEIGHT}px !important; z-index: 2147483647 !important;
  display: flex !important; align-items: center !important; justify-content: space-between !important;
  background: #F4F6F9 !important; color: #1B2430 !important;
  border-bottom: 1px solid #DCE1E8 !important;
  font: 500 13px/1 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif !important;
  user-select: none !important; -webkit-user-select: none !important;
  -webkit-app-region: drag !important; app-region: drag !important;
}
#max-shell-title { display: flex !important; align-items: center !important; gap: 8px !important; padding-left: 10px !important; }
#max-shell-dot { width: 10px !important; height: 10px !important; border-radius: 50% !important; background: #2C7BE5 !important; }
#max-shell-badge {
  display: none !important; min-width: 18px !important; height: 18px !important; padding: 0 5px !important;
  border-radius: 9px !important; background: #DD2C00 !important; color: #fff !important;
  font-size: 11px !important; align-items: center !important; justify-content: center !important;
}
#max-shell-badge.on { display: inline-flex !important; }
#max-shell-actions { display: flex !important; height: 100% !important; -webkit-app-region: no-drag !important; app-region: no-drag !important; }
#max-shell-actions button {
  all: unset !important; box-sizing: border-box !important;
  width: 46px !important; height: 100% !important; display: flex !important;
  align-items: center !important; justify-content: center !important;
  color: #3A4656 !important; cursor: default !important;
  border-left: 1px solid transparent !important;
}
#max-shell-actions button:hover { background: #E2E7EE !important; color: #0E141B !important; }
#max-shell-actions button:active { background: #D3DAE3 !important; }
#max-shell-close:hover { background: #E8503C !important; color: #fff !important; border-left-color: #E8503C !important; }
#max-shell-actions svg { width: 14px !important; height: 14px !important; display: block !important; stroke: currentColor !important; stroke-width: 1.4 !important; fill: none !important; }
#max-shell-content {
  position: fixed !important; top: ${TB_HEIGHT}px !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
  overflow: hidden !important;
}
#max-shell-content > * { height: 100% !important; }
`

// Инъекция выполняется в главном мире страницы (executeJavaScript), поэтому
// работает даже при contextIsolation: детям body придаётся обёртка, вешается
// MutationObserver на случай портальных модалок, кнопки wired на preload-API.
const TB_JS = `(async () => {
  if (document.getElementById('max-shell-titlebar')) return 'exists'
  if (!document.body) return 'no-body'

  // 1. переносим весь контент body в фиксированную обёртку под титлбар
  let wrap = document.getElementById('max-shell-content')
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.id = 'max-shell-content'
    while (document.body.firstChild) wrap.appendChild(document.body.firstChild)
    document.body.appendChild(wrap)
  }

  // 2. титлбар (вне обёртки, поверх всего)
  const tb = document.createElement('div')
  tb.id = 'max-shell-titlebar'
  tb.innerHTML =
    '<div id="max-shell-title"><span id="max-shell-dot"></span><span>MAX</span><span id="max-shell-badge"></span></div>' +
    '<div id="max-shell-actions">' +
      '<button id="max-shell-min" title="\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c"><svg viewBox="0 0 14 14"><path d="M2 7h10"/></svg></button>' +
      '<button id="max-shell-max" title="\u0420\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c"><svg viewBox="0 0 14 14"><rect x="2.5" y="2.5" width="9" height="9" rx="1"/></svg></button>' +
      '<button id="max-shell-close" title="\u0417\u0430\u043a\u0440\u044b\u0442\u044c"><svg viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8"/></svg></button>' +
    '</div>'
  document.body.appendChild(tb)

  // 3. кнопки -> preload API (window.maxShell)
  const S = window.maxShell
  const bind = (id, fn) => { const el = document.getElementById(id); if (el && S) el.addEventListener('click', fn) }
  bind('max-shell-min', () => S.minimize())
  bind('max-shell-max', () => S.toggleMaximize())
  bind('max-shell-close', () => S.close())
  tb.addEventListener('dblclick', (e) => { if (!e.target.closest('#max-shell-actions') && S) S.toggleMaximize() })
  const setMaxGlyph = (max) => {
    const b = document.getElementById('max-shell-max')
    if (!b) return
    b.innerHTML = max
      ? '<svg viewBox="0 0 14 14"><rect x="2" y="4.5" width="7.5" height="7.5" rx="1"/><path d="M4.5 4.5v-2h7.5v7.5h-2"/></svg>'
      : '<svg viewBox="0 0 14 14"><rect x="2.5" y="2.5" width="9" height="9" rx="1"/></svg>'
    b.title = max ? '\u0412\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c' : '\u0420\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c'
  }
  if (S && S.onMaximizeChanged) S.onMaximizeChanged(setMaxGlyph)
  if (S && S.isMaximized) S.isMaximized().then(setMaxGlyph).catch(() => {})

  // 4. портальные вставки (модалки, прикрепляемые к body) держим под титлбаром
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.id !== 'max-shell-titlebar' && n.parentElement === document.body) wrap.appendChild(n)
    }
  }).observe(document.body, { childList: true })

  return 'ok'
})()`

function injectTitlebar (win) {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  Promise.resolve()
    .then(() => wc.insertCSS(TB_CSS))
    .then(() => wc.executeJavaScript(TB_JS, false))
    .then((r) => { if (r === 'no-body') setTimeout(() => injectTitlebar(win), 150) })
    .catch((e) => console.error('[max-electron] inject titlebar:', e && e.message))
}

// Обновление счётчика в титлбаре (вызывается из updateBadge)
function setTbBadge (count) {
  if (!state.win || state.win.isDestroyed()) return
  state.win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('max-shell-badge')
    if (!b) return
    b.textContent = ${JSON.stringify(String(count))}
    b.classList.toggle('on', ${count > 0})
  })()`, false).catch(() => {})
}

// Синхронизация иконки кнопки «развернуть» с реальным состоянием окна
function tbMaximized (max) {
  if (!state.win || state.win.isDestroyed()) return
  state.win.webContents.send('shell:maximize-changed', max)
}

// IPC для кнопок титлбара (preload отдаёт странице только window.maxShell с
// этими четырьмя вызовами — никакой другой поверхности не экспортируется)
function setupTitlebarIpc () {
  ipcMain.on('shell:minimize', () => { if (state.win) state.win.minimize() })
  ipcMain.on('shell:toggle-maximize', () => {
    if (!state.win) return
    if (state.win.isMaximized()) state.win.unmaximize()
    else state.win.maximize()
  })
  ipcMain.on('shell:close', () => { if (state.win) state.win.close() })
  ipcMain.handle('shell:is-maximized', () => !!(state.win && state.win.isMaximized()))
}

function showWindow () {
  if (!state.win) return
  if (!state.win.isVisible()) state.win.show()
  if (state.win.isMinimized()) state.win.restore()
  state.win.focus()
  state.win.flashFrame(false)
}

// ---------------------------------------------------------------------------
// Непрочитанные: счёт из заголовка вкладки "(N)" — как в веб-версии.
// Отсюда: оверлей на иконке в таскбаре, мигание рамки, смена иконки трея.
// ---------------------------------------------------------------------------
function onTitle (title) {
  const m = /\((\d+)\)/.exec(title)
  const count = m ? parseInt(m[1], 10) : 0
  if (count === state.unread) return
  state.unread = count
  updateBadge()
  updateTrayIcon()
}

function updateBadge () {
  if (!state.win) return
  setTbBadge(state.unread)
  if (state.unread > 0) {
    const badge = NativeImage.createFromPath(ICONS.overlay)
    state.win.setOverlayIcon(badge, `Непрочитанных: ${state.unread}`)
    if (!state.win.isFocused() && !state.config.quietMode) {
      state.win.flashFrame(true)
    }
  } else {
    state.win.setOverlayIcon(null, '')
    state.win.flashFrame(false)
  }
  app.setBadgeCount(state.unread)  // счётчик в доке/панели (где поддерживается)
}

function updateTrayIcon () {
  if (!state.tray) return
  const img = state.unread > 0 ? ICONS.trayUnread : ICONS.tray
  state.tray.setImage(img)
  state.tray.setToolTip(state.unread > 0 ? `${APP_NAME} — ${state.unread} новых` : APP_NAME)
}

// ---------------------------------------------------------------------------
// Трей (SNI: Electron 44 использует собственную реализацию StatusIconLinuxDbus,
// libayatana-appindicator не требуется)
// ---------------------------------------------------------------------------
function createTray () {
  if (state.tray || !state.config.tray) return
  state.tray = new Tray(ICONS.tray)
  state.tray.setContextMenu(buildTrayMenu())
  state.tray.setToolTip(APP_NAME)
  // Левый клик — показать/спрятать (правый — меню)
  state.tray.on('click', () => {
    if (state.win && state.win.isVisible() && state.win.isFocused()) state.win.hide()
    else showWindow()
  })
  updateTrayIcon()
}

function destroyTray () {
  if (!state.tray) return
  state.tray.destroy()
  state.tray = null
}

function buildTrayMenu () {
  const c = state.config
  const item = (label, checked, fn) => new MenuItem({ label, type: 'checkbox', checked: !!checked, click: fn })
  return Menu.buildFromTemplate([
    new MenuItem({ label: 'Показать MAX', click: showWindow }),
    { type: 'separator' },
    item('Иконка в трее', c.tray, (mi) => {
      c.tray = mi.checked; saveConfig()
      mi.checked ? createTray() : destroyTray()
    }),
    item('Сворачивать в трей при закрытии', c.closeToTray, (mi) => { c.closeToTray = mi.checked; saveConfig() }),
    item('Запускать свёрнутым', c.startMinimized, (mi) => { c.startMinimized = mi.checked; saveConfig() }),
    item('Уведомления', c.notifications, (mi) => { c.notifications = mi.checked; saveConfig() }),
    item('Тихий режим (без мигания)', c.quietMode, (mi) => { c.quietMode = mi.checked; saveConfig() }),
    { type: 'separator' },
    new MenuItem({ label: 'Обновить', click: () => { if (state.win) state.win.reload() } }),
    new MenuItem({ label: 'Выйти', click: quit })
  ])
}

function quit () {
  state.forceQuit = true
  app.quit()
}

// ---------------------------------------------------------------------------
// Меню приложения (минимум: правка/вид/окно)
// ---------------------------------------------------------------------------
function buildAppMenu () {
  const roles = (list) => list.map(role => ({ role }))
  const template = [
    { label: APP_NAME, submenu: [ { role: 'about' }, { role: 'separator' }, { role: 'quit' } ] },
    { label: 'Правка', submenu: roles(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll']) },
    { label: 'Вид', submenu: roles(['reload', 'forceReload', 'toggleDevTools', 'separator', 'resetZoom', 'zoomIn', 'zoomOut', 'separator', 'togglefullscreen']) },
    { label: 'Окно', submenu: roles(['minimize', 'zoom', 'close']) }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Разрешения: уведомления — да, остальное — по умолчанию
// ---------------------------------------------------------------------------
function setupPermissions () {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'notifications') return callback(state.config.notifications)
    if (permission === 'media') {
      // микрофон/камера для звонков — только если источник доверенный
      return callback(isTrusted(details.requestingUrl || ''))
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (permission === 'notifications') return state.config.notifications
    if (permission === 'media') return isTrusted(requestingOrigin)
    return false
  })
}

// ---------------------------------------------------------------------------
// Прокси (опционально; пустая строка = без прокси). ВНИМАНИЕ: в джейле
// прокси-переменные не наследуются — здесь только явная настройка из конфига.
// ---------------------------------------------------------------------------
function applyProxy () {
  const p = (state.config.proxy || '').trim()
  if (!p) {
    // По умолчанию — ПРЯМОЕ соединение. Критично: иначе Chromium наследует
    // HTTP(S)_PROXY/ALL_PROXY из окружения (на этой машине — xray
    // 127.0.0.1:10809). MAX — российский, неблокируемый мессенджер; пускать
    // его трафик через обход блокировок нельзя: это и утечка, и палево
    // самой инфраструктуры обхода.
    session.defaultSession.setProxy({ mode: 'direct' })
    return
  }
  const scheme = /^socks/i.test(p) ? 'socks5' : 'http'
  const rules = p.includes('://') ? p : `${scheme}://${p}`
  session.defaultSession.setProxy({ proxyRules: rules })
}

// ---------------------------------------------------------------------------
// Жизненный цикл
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  app.setName(APP_NAME)
  buildAppMenu()
  setupPermissions()
  setupTitlebarIpc()
  applyProxy()
  createWindow()
  createTray()

  app.on('activate', () => {           // macOS-совместимость
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('window-all-closed', () => {
  // на Linux не выходим при закрытии окна — живём в трее
  if (process.platform !== 'linux' || !state.config.tray) quit()
})

app.on('before-quit', () => { state.forceQuit = true })
