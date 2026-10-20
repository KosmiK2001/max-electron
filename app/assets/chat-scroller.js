// Прокрутка чата: PageUp/PageDown = страница видимого чата, кнопки титлбара
// «вверх/вниз» = одно сообщение. Выполняется в главном мире страницы (инжект
// из main.js), поэтому видит реальный DOM web.max.ru и window.__maxShellScroll.
//
// Где лежит список сообщений (вычитано из бандла web.max.ru, 2026-10-20):
// чат рендерится компонентом ScrollList (chunk CfBkgS-B) с align:'bottom',
// а сам список — обёртка base-компонента Ua (chunk D6e1cJjj):
//
//   <div class="cropped">            <- клип, ResizeObserver по нему
//     <div class="scrollListScrollable">      <- СКРОЛЛИМЫЙ узел (overflow-y)
//       <div class="scrollListContent scrollListContent--bottom">  <- flex-колонна
//         <div data-index="0"> ... <div class="messageWrapper">    <- СООБЩЕНИЕ
//
// Порядок детей = порядок сообщений в истории. Виртуализации нет: отрисованы
// все загруженные сообщения, история подгружается страницами по скроллу вверх
// (onAfterScroll: top < 1500 -> backwardMarker). Значит «одно сообщение» =
// соседний элемент списка, и его координата честная.
//
// Элементы списка ищем ДВУМЯ способами, по старшинству (v1.0.5 умел только
// первый и молча не двигался, если web.max.ru не проставил data-index):
//   1) дети контента с [data-index] — их проставляет ScrollList;
//   2) потомки .messageWrapper — это сам пузырёк сообщения, он обязателен
//      (на нём висит класс --isOut/--first/--last), поэтому надёжнее.
// Какой способ сработал, отдаёт debug().itemsVia.
//
// Сам web.max.ru PageUp/PageDown НЕ обрабатывает: в бандле нет ни одной
// строки `PageUp`/`PageDown` (есть ArrowUp/ArrowDown/Home/End/Escape/Enter —
// это навигация по composer и выделение). Браузерный фолбэк не работает,
// потому что скроллится не документ, а div внутри clip-обёртки, и фокус
// обычно в теле/composer => клавиша не делала ничего. Отсюда и фича.
(() => {
  if (window.__maxShellScroller) return

  // --- чистая математика (без DOM; покрыта стендом test/chat-scroller-test.js) ---

  // Страница: сдвиг ровно на stepPx, в пределах [0, max].
  function pageTop (dir, cur, stepPx, max) {
    return clamp(Math.round(cur + dir * Math.max(1, stepPx)), 0, max)
  }

  // Во время плавного скролла scrollTop дробный, поэтому границы ищем с
  // допуском в полпикселя: «ровно выровнено» (cur == top) — это НЕ шаг назад,
  // а «на 1px уехало» (cur == top + 1) — уже считается пройденным элементом.
  const EPS = 0.5

  // Одно сообщение: верхняя граница следующего/предыдущего элемента.
  // tops — абсолютные offsetTop детей контента, отсортированы по возрастанию.
  // Вниз: первый top строго ниже текущего. Вверх: последний top строго выше
  // текущего (если верх текущего элемента уже закрашен на 1px и более —
  // считаем, что он «пройден», и шагаем к предыдущему).
  function nextTop (dir, cur, tops, max) {
    if (!tops || !tops.length) return clamp(Math.round(cur + dir), 0, max)
    let target = null
    if (dir > 0) {
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] > cur + EPS) { target = tops[i]; break }
      }
      if (target === null) target = max
    } else {
      for (let i = tops.length - 1; i >= 0; i--) {
        if (tops[i] < cur - EPS) { target = tops[i]; break }
      }
      if (target === null) target = 0
    }
    return clamp(Math.round(target), 0, max)
  }

  function clamp (v, lo, hi) {
    if (!(hi >= lo)) return lo
    return v < lo ? lo : (v > hi ? hi : v)
  }

  // --- выбор скроллимого списка сообщений ---

  const MODAL = '.modal, [role="dialog"], [role="alertdialog"]'

  function visible (el) {
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  }

  function area (el) {
    return el.clientWidth * el.clientHeight
  }

  // Кандидаты: все живые scrollListScrollable, внутри которых есть
  // .messageWrapper. Модалки (multipins, поиск по чату) тоже рендерят
  // сообщения через ScrollList — при открытой модалке выбираем её список,
  // иначе прокрутка уходила бы в чат за спиной у диалога.
  function pickScroller () {
    const all = Array.prototype.slice.call(document.querySelectorAll('.scrollListScrollable'))
      .filter((el) => visible(el) && el.querySelector('.messageWrapper'))
    if (!all.length) return null
    const modal = all.filter((el) => el.closest(MODAL))
    const pool = modal.length ? modal : all
    // перекрывающиеся вложенные списки маловероятны, но выбираем самый
    // крупный по площади — это гарантированно главный чат, а не огрызок
    pool.sort((a, b) => area(b) - area(a))
    return pool[0]
  }

  // Элементы списка + имя способа, которым нашли. Возвращаем {list, via}.
  function itemsOf (sc) {
    // 1) [data-index]: контент = общий предок первых таких узлов (глубину
    //    вложенности не предполагаем — у ScrollList в слоте стоит ещё
    //    `before`-узел, так что «первый ребёнок скролла» ловушка).
    const indexed = Array.prototype.slice.call(sc.querySelectorAll('[data-index]'))
    if (indexed.length) {
      const content = indexed[0].parentElement
      const kids = Array.prototype.slice.call(content.children).filter((el) => el.hasAttribute('data-index'))
      if (kids.length) return { list: kids, via: 'data-index' }
    }
    // 2) .messageWrapper — сам пузырёк сообщения. querySelectorAll отдаёт
    //    документный порядок, он же порядок в истории.
    const wrappers = Array.prototype.slice.call(sc.querySelectorAll('.messageWrapper'))
    if (wrappers.length) return { list: wrappers, via: 'message-wrapper' }
    return { list: [], via: 'none' }
  }

  // Абсолютные offsetTop детей контента относительно верха скролла.
  // getBoundingClientRect, а не offsetTop: у ScrollList контент стоит в
  // flex-колонке с justify-content:flex-end, и offsetTop там считается от
  // offsetParent, которым может быть не скролл. Rect даёт честное расстояние.
  function topsOf (sc, items) {
    const base = sc.getBoundingClientRect().top
    return items.map((el) => Math.round(el.getBoundingClientRect().top - base + sc.scrollTop))
  }

  function scroll (sc, top, behavior) {
    if (typeof sc.scrollTo === 'function') sc.scrollTo({ top, behavior: behavior || 'instant' })
    else sc.scrollTop = top
  }

  function maxScroll (sc) {
    return Math.max(0, sc.scrollHeight - sc.clientHeight)
  }

  // --- публичные действия ---

  function page (dir) {
    const sc = pickScroller()
    if (!sc) return false
    const { list: items } = itemsOf(sc)
    const h = sc.clientHeight
    // страница = вьюпорт минус одно сообщение, чтобы следующая страница
    // начиналась с сообщения, которое было последним видимым (контекст не
    // теряется). Если сообщений меньше вьюпорта — просто до упора.
    let stepPx = h
    if (items.length > 1) {
      const tops = topsOf(sc, items)
      const first = Math.max(1, tops[1] - tops[0])
      stepPx = Math.max(1, h - Math.min(first, Math.round(h * 0.25)))
    }
    scroll(sc, pageTop(dir, sc.scrollTop, stepPx, maxScroll(sc)), 'instant')
    return true
  }

  // Журнал последних нажатий кнопок: позволяет одной строкой в DevTools
  // отличить «клик не дошёл до обработчика» (clicks не растёт) от «клик
  // дошёл, но список сообщений не найден» (last.why = 'no-items').
  const log = { clicks: 0, last: null }

  function step (dir) {
    const sc = pickScroller()
    if (!sc) { log.last = { dir, why: 'no-scroller' }; return false }
    const { list: items, via } = itemsOf(sc)
    if (!items.length) { log.last = { dir, why: 'no-items', via }; return false }
    // behavior=instant, а не smooth: клик «вверх» во время летящей анимации
    // читал бы дробный scrollTop середины пути и второй нажатие давало бы
    // скачок на полтора сообщения (или ничего). Мгновенный шаг детерминирован
    // при любом темпе нажатий.
    const from = sc.scrollTop
    const to = nextTop(dir, from, topsOf(sc, items), maxScroll(sc))
    scroll(sc, to, 'instant')
    log.last = { dir, why: to === from ? 'at-edge' : 'ok', via, items: items.length, from: Math.round(from), to }
    return true
  }

  // Точка входа кнопок титлбара. Отдельно от step() потому, что только так
  // можно по debug().clicks отличить «клик не дошёл» от «дошёл, но нечего крутить».
  function click (dir) {
    log.clicks++
    return step(dir)
  }

  function available () {
    return !!pickScroller()
  }

  // --- клавиатура ---

  function scrollableAncestor (el) {
    let n = el instanceof Element ? el : null
    while (n && n !== document.body) {
      const cs = getComputedStyle(n)
      if (/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n
      n = n.parentElement
    }
    return null
  }

  function onKeyDown (e) {
    if (e.defaultPrevented) return
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const dir = e.key === 'PageDown' ? 1 : -1
    const sc = pickScroller()
    if (!sc) return
    const t = e.target
    if (t instanceof Element && t !== document.body) {
      // У цели есть свой скроллимый предок (модалка, панель стикеров,
      // многострочное поле) — не лезем: клавиша должна крутить его.
      const own = scrollableAncestor(t)
      if (own && own !== sc) return
      // Shift+PageDown в поле ввода = расширение выделения, не прокрутка.
      if (e.shiftKey && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    }
    e.preventDefault()
    page(dir)
  }

  // capture: перехватываем раньше обработчиков страницы (у неё свои keydown
  // на composer и выделение), но только для PageUp/PageDown — их страница
  // не трогает вообще.
  document.addEventListener('keydown', onKeyDown, true)

  // Диагностика для живого DOM (DevTools -> __maxShellScroll.debug()): сколько
  // кандидатов-скроллов найдено, взят ли он, сколько в нём сообщений. Если
  // web.max.ru сменит разметку и фича «умрёт молча» — видно сразу, какой
  // предположительный селектор перестал совпадать.
  function debug () {
    const all = Array.prototype.slice.call(document.querySelectorAll('.scrollListScrollable'))
    const sc = pickScroller()
    const { list, via } = sc ? itemsOf(sc) : { list: [], via: 'none' }
    return {
      scrollables: all.length,
      withMessages: all.filter((el) => !!el.querySelector('.messageWrapper')).length,
      picked: !!sc,
      itemsVia: via,
      items: list.length,
      view: sc ? sc.clientHeight : 0,
      content: sc ? sc.scrollHeight : 0,
      top: sc ? Math.round(sc.scrollTop) : null,
      clicks: log.clicks,
      last: log.last
    }
  }

  window.__maxShellScroller = true
  window.__maxShellScroll = {
    page, step, click, available, debug,
    _log: log,
    _test: { pageTop, nextTop, clamp, itemsOf, pickScroller }
  }
})()
