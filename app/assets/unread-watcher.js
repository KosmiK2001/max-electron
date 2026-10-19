// Непрочитанные СООБЩЕНИЯ (не чаты). Выполняется в главном мире страницы
// (инжект из main.js), поэтому видит реальный DOM web.max.ru и window.maxShell.
//
// Источник числа: у каждого чата в сайдбаре есть бейдж непрочитанных —
// div.badgeIcon.badgeIcon--20.badgeIcon--themed-regular, внутри span.text с
// числом сообщений в этом чате. Сумма по всем бейджам = общее число
// непрочитанных сообщений. Счётчики папок («Все 2», «Новые 2») — это число
// ЧАТОВ, класс counter (не badgeIcon), их НЕ считаем. Время «14:22» — не число,
// отметки/пины — без числового текста, parseInt отбрасывает и их.
//
// Рендер иконки трея: на canvas рисуем базовую иконку (передана из main как
// dataURL) + красный кружок с числом справа-сверху, отдаём dataURL в main.
(() => {
  if (window.__maxUnreadWatcherInstalled) return
  window.__maxUnreadWatcherInstalled = true

  const BASE = window.__MAX_TRAY_BASE__ || {}

  function countMessages () {
    let total = 0
    // Только badgeIcon--20: это бейдж непрочитанных СООБЩЕНИЙ на строке чата.
    // badgeIcon--16 — счётчики ВКЛАДОК папок («Все 1», «Новые 1», «Каналы 1» =
    // число непрочитанных чатов), их не считаем — иначе сумма врала (7 вместо 4).
    document.querySelectorAll('div[class*="badgeIcon--20"]').forEach((b) => {
      const t = (b.textContent || '').trim()
      const n = parseInt(t, 10)
      if (Number.isInteger(n) && n >= 1) total += n
    })
    return total
  }

  function renderTray (n, size) {
    const base = BASE[String(size)]
    if (!base) return Promise.resolve(null)
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        ctx.clearRect(0, 0, size, size)
        ctx.drawImage(img, 0, 0, size, size)
        if (n > 0) {
          // бейдж — компактный кружок в правом верхнем углу (~1/3 значка),
          // а не на весь значок
          const r = Math.round(size * 0.34)
          const cx = size - r
          const cy = r
          ctx.fillStyle = '#DD2C00'
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.lineWidth = Math.max(1, Math.round(size * 0.05))
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
          const label = n > 99 ? '99+' : String(n)
          // шрифт по числу символов: 1 цифра крупнее, 3 — мельче
          const scale = label.length === 1 ? 0.5 : (label.length === 2 ? 0.44 : 0.34)
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold ' + Math.round(size * scale) + 'px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, cx, cy + Math.round(size * 0.015))
        }
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = () => resolve(null)
      img.src = base
    })
  }

  let last = -1
  async function tick () {
    const n = countMessages()
    if (n === last) return
    last = n
    const icon24 = await renderTray(n, 24)
    const icon48 = await renderTray(n, 48)
    if (window.maxShell && typeof window.maxShell.setUnread === 'function') {
      window.maxShell.setUnread({ n, icon24, icon48 })
    }
  }

  // Svelte пересоздаёт узлы списка — следим за DOM + страховочный полл
  new MutationObserver(tick).observe(document.body, {
    childList: true, subtree: true, characterData: true
  })
  setInterval(tick, 2000)
  tick()
})()
