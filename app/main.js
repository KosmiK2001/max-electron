'use strict'

// MAX Desktop — чистая Electron-обёртка над веб-клиентом web.max.ru.
// Только встроенные модули Electron, без внешних npm-зависимостей:
// весь код аудируем (в этом смысл проекта).

const { app, BrowserWindow, Tray, Menu, MenuItem, NativeImage, shell, session, Notification, clipboard } = require('electron')
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
      spellcheck: true
    }
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
  state.win.on('maximize', remember)
  state.win.on('unmaximize', remember)

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
  const template = [
    { label: APP_NAME, submenu: [ { role: 'about' }, { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Правка', submenu: [ 'undo', 'redo', { type: 'separator' }, 'cut', 'copy', 'paste', 'selectAll' ].map(r => ({ role: r })) },
    { label: 'Вид', submenu: [ 'reload', 'forceReload', 'toggleDevTools', { type: 'separator' }, 'resetZoom', 'zoomIn', 'zoomOut', { type: 'separator' }, 'togglefullscreen' ].map(r => ({ role: r })) },
    { label: 'Окно', submenu: [ 'minimize', 'zoom', 'close' ].map(r => ({ role: r })) }
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
  if (!p) return
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
