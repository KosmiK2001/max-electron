// Дедупликация системных уведомлений. web.max.ru иногда показывает ОДНО
// сообщение дважды (подтверждено D-Bus-мониторингом 2026-10-21: «❕Отбой
// беспилотной опасности» в 21:06 и снова в 21:07, 53 сек — ре-синк WebSocket
// повторно обрабатывает последнее сообщение как новое). PushMessaging/флаги
// это НЕ лечат — источник в логике самого клиента.
//
// Перехватываем глобальный Notification, запоминаем (title+body), подавляем
// точный повтор в окне DEDUPE_WINDOW_MS.
//
// Клиент использует только: new Notification(...), addEventListener('click'),
// close() (см. метод show в чанках). Поэтому подавленное уведомление заменяем
// лёгким фейком с этими методами; клик по ПЕРВОМУ (реальному) уведомлению
// работает как раньше.
//
// Лог SHOW/DUP уходит в main через window.maxShell.notifLog -> файл
// ~/.config/MAX/dedupe.log (тестовый, держим сутки и смотрим).
(() => {
  if (window.__maxNotifDedupeInstalled) return
  window.__maxNotifDedupeInstalled = true

  const DEDUPE_WINDOW_MS = 60 * 1000   // окно подавления повторов
  const MAX_SEEN = 200                 // не раздувать Map
  const seen = new Map()               // key -> timestamp первого показа
  const OriginalNotification = window.Notification

  function keyOf (title, body) {
    return (title || '') + '\u0001' + (body || '')
  }

  function log (type, title, body, delta) {
    try {
      if (window.maxShell && typeof window.maxShell.notifLog === 'function') {
        window.maxShell.notifLog({ type, title, body, delta })
      }
    } catch (e) { /* лог не критичен */ }
  }

  function fakeNotification () {
    return {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      close: () => {},
      onclick: null,
      onclose: null,
      onerror: null,
      onshow: null
    }
  }

  function WrappedNotification (title, opts) {
    const body = (opts && opts.body) || ''
    const key = keyOf(title, body)
    const now = Date.now()
    const first = seen.get(key)
    if (first !== undefined && (now - first) < DEDUPE_WINDOW_MS) {
      log('DUP', title, body, now - first)
      return fakeNotification()
    }
    seen.set(key, now)
    // прореживаем протухшие записи, чтобы Map не рос бесконечно
    if (seen.size > MAX_SEEN) {
      for (const [k, t] of seen) {
        if (now - t >= DEDUPE_WINDOW_MS) seen.delete(k)
      }
    }
    log('SHOW', title, body, 0)
    return new OriginalNotification(title, opts)
  }

  // Статика (permission/requestPermission) должна сохраниться — клиент её
  // читает через свой обёрточный класс fp.
  WrappedNotification.prototype = OriginalNotification.prototype
  try {
    Object.defineProperty(WrappedNotification, 'permission', {
      configurable: true,
      get: () => OriginalNotification.permission
    })
  } catch (e) {}
  try {
    WrappedNotification.requestPermission = (...a) => OriginalNotification.requestPermission(...a)
  } catch (e) {}
  try {
    WrappedNotification.maxActions = OriginalNotification.maxActions
  } catch (e) {}

  window.Notification = WrappedNotification

  // window.focus() НЕ показывает окно, скрытое в трей через hide()
  // (close-to-tray). Клиент по клику на уведомление делает window.focus() +
  // close() + openChat(...), поэтому при скрытом окне уведомление просто
  // закрывалось, а окно не появлялось. Подменяем focus() на показ окна через
  // IPC (showWindow идемпотентен: если окно видимо — просто фокус).
  try {
    const origFocus = window.focus.bind(window)
    window.focus = function () {
      try {
        if (window.maxShell && typeof window.maxShell.show === 'function') {
          window.maxShell.show()
          return
        }
      } catch (e) {}
      return origFocus()
    }
  } catch (e) {}
})()
