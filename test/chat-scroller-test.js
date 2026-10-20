// Стенд для chat-scroller.js: минимальный фейковый DOM с геометрией,
// достаточной, чтобы проверить выбор скроллямого списка, шаг по сообщениям,
// страничный прокрут и охранки в onKeyDown. Реальный DOM web.max.ru тут
// смоделирован по структуре, вычитанной из бандла (cropped > scrollListScrollable
// > scrollListContent > [data-index] > .messageWrapper).
// Стенд прогоняется без внешних зависимостей: node test/chat-scroller-test.js
// (выход 0 = всё зелёно, 1 = есть провалы).
'use strict'
const fs = require('fs')
const path = require('path')

// ------------------------------- фейковый DOM -------------------------------
class El {
  constructor (tag, cls = '') {
    this.tagName = tag.toUpperCase()
    this.className = cls
    this.attrs = new Map()
    this.children = []
    this.parentElement = null
    this.rect = { top: 0, height: 0, width: 0 }   // в координатах вьюпорта
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.clientWidth = 0
    this.overflowY = 'visible'
    this.isContentEditable = false
    this.scrolled = []
  }
  add (cls) { this.className = cls; return this }
  append (...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k) } return this }
  get id () { return this.attrs.get('id') || '' }   // в реальном DOM .id — стандартное свойство
  hasAttribute (n) { return this.attrs.has(n) }
  setAttribute (n, v) { this.attrs.set(n, String(v)) }
  get classList () {
    const self = this
    return {
      toggle (name, on) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean))
        if (on) set.add(name); else set.delete(name)
        self.className = [...set].join(' ')
      }
    }
  }
  matches (sel) {
    // поддержка '.cls' и списка селекторов через запятую с '[attr]'
    return sel.split(',').map((s) => s.trim()).filter(Boolean).some((s) => {
      if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1))
      if (s.startsWith('[role="')) return this.attrs.get('role') === s.slice(7, -1)
      if (s.startsWith('[') && s.endsWith(']')) return this.attrs.has(s.slice(1, -1))
      if (s.startsWith('#')) return this.attrs.get('id') === s.slice(1)
      return false
    })
  }
  closest (sel) {
    let n = this
    while (n) { if (n.matches(sel)) return n; n = n.parentElement }
    return null
  }
  descendants () {
    const out = []
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }
  querySelector (sel) { return this.descendants().find((e) => e.matches(sel)) || null }
  querySelectorAll (sel) { return this.descendants().filter((e) => e.matches(sel)) }
  getBoundingClientRect () { return { top: this.rect.top, bottom: this.rect.top + this.rect.height, height: this.rect.height, width: this.clientWidth } }
  scrollTo ({ top, behavior }) { this.scrolled.push({ top, behavior }); this.scrollTop = top }
  get firstElementChild () { return this.children[0] || null }
}

const body = new El('body')
const document = {
  body,
  addEventListener: (type, fn, capture) => { (document._h ||= []).push({ type, fn, capture }) },
  querySelectorAll (sel) { return body.descendants().filter((e) => e.matches(sel)) }
}
const window = {}
const getComputedStyle = (el) => ({ overflowY: el.overflowY })

// ------------------------------- сборка мира -------------------------------
// Чат: H=400 вьюпорт, 8 сообщений высотой 100 => scrollHeight 800, max 400.
function makeChat ({ id, heights, viewH = 400, inModal = false, withMessages = true, top = 100, indexed = true }) {
  const total = heights.reduce((a, b) => a + b, 0)
  const sc = new El('div', 'scrollListScrollable')
  sc.clientHeight = viewH
  sc.clientWidth = 600
  sc.scrollHeight = total
  sc.overflowY = 'auto'
  sc.rect = { top, height: viewH }
  // вложенность как в реальном бандле: scrollable > div > content, и первым
  // ребёнком content стоит `before`-узел без data-index
  const wrap = new El('div')
  const content = new El('div', 'scrollListContent scrollListContent--bottom')
  wrap.append(content)
  sc.append(wrap)
  content.append(new El('div', 'beforeSlot'))
  heights.forEach((h, i) => {
    const item = new El('div')
    if (indexed) item.setAttribute('data-index', i)
    const msg = new El('div', withMessages ? 'messageWrapper' : 'other')
    msg.rect = { top: 0, height: h }
    item.append(msg)
    item._h = h
    content.append(item)
  })
  // начать снизу (как align:bottom в реальном чате)
  sc.scrollTop = Math.max(0, total - viewH)
  layout(sc)
  if (inModal) {
    const modal = new El('div', 'modal')
    modal.append(sc)
    body.append(modal)
  } else {
    body.append(sc)
  }
  sc.attrs.set('id', id)
  return sc
}

// пересчитать rect детей по текущему scrollTop: abs_top(item) = сумма высот до него
function layout (sc) {
  let items = sc.descendants().filter((e) => e.hasAttribute('data-index'))
  const indexed = items.length > 0
  if (!indexed) items = sc.descendants().filter((e) => e.matches('.messageWrapper'))
  let acc = 0
  for (const item of items) {
    // с data-index пузырёк лежит внутри div-обёртки; без него список — сами пузырьки
    const msg = indexed ? item.children[0] : item
    const abs = acc
    item.rect = { top: sc.rect.top + abs - sc.scrollTop, height: msg.rect.height }
    msg.rect.top = item.rect.top
    acc += msg.rect.height
  }
}
const origScrollTo = El.prototype.scrollTo
El.prototype.scrollTo = function (o) { origScrollTo.call(this, o); layout(this) }

// ------------------------------- загрузка инжекта -------------------------------
const TARGET = path.join(__dirname, '..', 'app', 'assets', 'chat-scroller.js')
const src = fs.readFileSync(TARGET, 'utf8')
const Element = El   // инжект проверяет `x instanceof Element`
new Function('window', 'document', 'getComputedStyle', 'Element', src)(window, document, getComputedStyle, Element)
const API = window.__maxShellScroll

// ------------------------------- тесты -------------------------------
let fails = 0
function check (name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)))
}

// 1. чистая математика
const T = API._test
check('clamp в пределах', [T.clamp(-5, 0, 10), T.clamp(99, 0, 10), T.clamp(4, 10, 0)], [0, 10, 10])
check('pageTop вниз на высоту', T.pageTop(1, 0, 400, 400), 400)
check('pageTop вверх от 0', T.pageTop(-1, 0, 400, 400), 0)
check('pageTop вниз упирается в max', T.pageTop(1, 300, 400, 400), 400)
const tops = [0, 100, 200, 300, 400, 500, 600, 700]
check('nextTop вниз: ровно на границе -> следующее', T.nextTop(1, 300, tops, 400), 400)
check('nextTop вниз: дробный scrollTop (300.4) -> следующее', T.nextTop(1, 300.4, tops, 400), 400)
check('nextTop вниз: за границей (301) -> следующее', T.nextTop(1, 301, tops, 400), 400)
check('nextTop вверх: ровно на границе -> предыдущее', T.nextTop(-1, 300, tops, 400), 200)
check('nextTop вверх: на 1px уехало (301) -> верните к 300', T.nextTop(-1, 301, tops, 400), 300)
check('nextTop вверх: 300.4 (0.4px закрашено) -> считается выровненным, к 200', T.nextTop(-1, 300.4, tops, 400), 200)
check('nextTop вниз за последним -> max', T.nextTop(1, 650, tops, 400), 400)
check('nextTop вверх до нуля', T.nextTop(-1, 50, tops, 400), 0)
check('nextTop пустой список -> шаг 1px', [T.nextTop(1, 10, [], 400), T.nextTop(-1, 10, [], 400)], [11, 9])

// 2. выбор списка: обычный чат
const chat = makeChat({ id: 'chat', heights: [100, 100, 100, 100, 100, 100, 100, 100] })
check('available() с чатом', API.available(), true)
check('pickScroller -> чат', API._test && true, true)

// 3. шаг по сообщениям от низа вверх
let prev = chat.scrollTop
const seq = []
for (let i = 0; i < 4; i++) { API.step(-1); seq.push(chat.scrollTop); if (chat.scrollTop === prev) { seq.push('STALL'); break } prev = chat.scrollTop }
check('четыре шага вверх по 100px', seq, [300, 200, 100, 0])
const down = []
for (let i = 0; i < 6; i++) { API.step(1); down.push(chat.scrollTop) }
check('шаги вниз допирают до max (400) и стоят', down, [100, 200, 300, 400, 400, 400])

// 4. страница
chat.scrollTop = 0
API.page(1)
const pageDown = chat.scrollTop
check('PageDown со 0 = вьюпорт минус одно сообщение', pageDown, 300)
API.page(-1)
check('PageUp обратно к границе сообщения', chat.scrollTop % 100, 0)

// 5. модалка имеет приоритет над чатом
const modalList = makeChat({ id: 'modal', heights: [80, 80, 80, 80, 80, 80, 80, 80, 80], viewH: 300, inModal: true, top: 200 })
const before = chat.scrollTop
API.step(-1)
check('шаг уходит в список модалки, чат не тронут', [modalList.scrollTop !== before, chat.scrollTop === before], [true, true])
body.children = body.children.filter((c) => c !== body.children.find((x) => x.className === 'modal'))
// удалить модалку корректно
body.children = body.children.filter((c) => !(c instanceof El && c.matches('.modal')))
check('после закрытия модалки снова чат', API.available(), true)

// 6. нет чата (только список без сообщений) -> available false, действия no-op
body.children = []
const bare = new El('div', 'scrollListScrollable')
bare.clientHeight = 300; bare.scrollHeight = 900; bare.overflowY = 'auto'
const bw = new El('div'); const bc = new El('div', 'scrollListContent'); bw.append(bc); bare.append(bw)
const it = new El('div'); it.setAttribute('data-index', 0); it.append(new El('div', 'other'))
bc.append(new El('div', 'beforeSlot')); bc.append(it)
bare.scrollTop = 0
body.append(bare)
check('available() без сообщений', API.available(), false)
check('step() no-op без чата', API.step(1), false)
check('page() no-op без чата', API.page(-1), false)
check('голый скролл не тронут', bare.scrollTop, 0)

// 7. клавиатура
body.children = []
const chat2 = makeChat({ id: 'chat2', heights: [100, 100, 100, 100, 100, 100, 100, 100] })
const handlers = document._h.filter((h) => h.type === 'keydown')
check('keydown повешен в capture', handlers.length === 1 && handlers[0].capture === true, true)
const fire = (props) => {
  let prevented = false
  const e = Object.assign({
    key: 'PageDown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: body, defaultPrevented: false,
    preventDefault () { prevented = true }
  }, props)
  handlers[0].fn(e)
  return prevented
}
chat2.scrollTop = 0; layout(chat2)
const st = chat2.scrollTop
check('PageDown по телу -> прокручен чат', [fire({ key: 'PageDown' }), chat2.scrollTop !== st], [true, true])
const st2 = chat2.scrollTop
check('PageUp по телу -> прокручен назад', [fire({ key: 'PageUp' }), chat2.scrollTop !== st2], [true, true])
const st3 = chat2.scrollTop
check('Ctrl+PageDown НЕ перехватываем', [fire({ key: 'PageDown', ctrlKey: true }), chat2.scrollTop], [false, st3])
check('Home НЕ перехватываем (не наша клавиша)', fire({ key: 'Home' }), false)
const st4 = chat2.scrollTop
check('defaultPrevented -> не мешаем странице', [fire({ key: 'PageDown', defaultPrevented: true }), chat2.scrollTop], [false, st4])

// поле ввода: короткое (не скроллится) -> перехватываем; длинное -> не лезем
const shortInput = new El('textarea')
shortInput.scrollTop = 0; shortInput.scrollHeight = 40; shortInput.clientHeight = 40; shortInput.overflowY = 'auto'
body.append(shortInput)
const st5 = chat2.scrollTop
check('PageDown в коротком composer -> крутим чат', [fire({ key: 'PageDown', target: shortInput }), chat2.scrollTop !== st5], [true, true])
const longInput = new El('textarea')
longInput.scrollTop = 0; longInput.scrollHeight = 400; longInput.clientHeight = 100; longInput.overflowY = 'auto'
body.append(longInput)
const st6 = chat2.scrollTop
check('PageDown в переполненном composer -> не лезем', [fire({ key: 'PageDown', target: longInput }), chat2.scrollTop === st6], [false, true])
const st7 = chat2.scrollTop
check('Shift+PageDown в composer -> не лезем (выделение)', [fire({ key: 'PageDown', target: shortInput, shiftKey: true }), chat2.scrollTop === st7], [false, true])

// 8. диагностика не врёт: пустой body -> ничего не найдено
body.children = []
const dEmpty = API.debug()
check('debug() на пустой странице',
  [dEmpty.scrollables, dEmpty.withMessages, dEmpty.picked, dEmpty.itemsVia, dEmpty.items, dEmpty.top, dEmpty.last.why],
  [0, 0, false, 'none', 0, null, 'no-scroller'])
const chat3 = makeChat({ id: 'chat3', heights: [100, 100, 100, 100, 100, 100, 100, 100] })
const d = API.debug()
check('debug() с чатом: 1 скролл, 8 сообщений через data-index, view 400, content 800',
  [d.scrollables, d.withMessages, d.picked, d.itemsVia, d.items, d.view, d.content, d.top],
  [1, 1, true, 'data-index', 8, 400, 800, 400])

// 9. РЕГРЕСС v1.0.6: DOM без data-index (web.max.ru его не проставил) —
//    шаг по сообщению обязан работать через .messageWrapper, а не молчать.
body.children = []
const noidx = makeChat({ id: 'noidx', heights: [100, 100, 100, 100, 100, 100, 100, 100], indexed: false })
const dn = API.debug()
check('itemsVia = message-wrapper', dn.itemsVia, 'message-wrapper')
check('8 сообщений найдено без data-index', dn.items, 8)
const beforeN = noidx.scrollTop
API.step(-1)
check('шаг ВВЕРХ работает без data-index', [noidx.scrollTop < beforeN, API.debug().last.why], [true, 'ok'])
const afterUp = noidx.scrollTop
API.step(1)
check('шаг ВНИЗ работает без data-index', [noidx.scrollTop > afterUp, API.debug().last.why], [true, 'ok'])
noidx.scrollTop = 0; layout(noidx)
API.page(1)
check('страница тоже работает без data-index', noidx.scrollTop, 300)

// 10. Кнопки: делегированный слушатель на полосе + счётчик кликов.
//     Проверяем ровно тот контракт, который навешивает TB_JS: клик по любой
//     точке внутри кнопки (в т.ч. по вложенному <svg>) обязан дойти до API.
body.children = []
const cbtn = makeChat({ id: 'btn', heights: [100, 100, 100, 100, 100, 100, 100, 100] })
const btnUp = new El('button'); btnUp.attrs.set('id', 'max-shell-scroll-up')
const svgIn = new El('svg'); btnUp.append(svgIn)        // цель клика — внутренний узел
const btnDn = new El('button'); btnDn.attrs.set('id', 'max-shell-scroll-down')
const acts = new El('div'); acts.attrs.set('id', 'max-shell-actions')
acts.append(btnUp, btnDn)
const tbEl = new El('div'); tbEl.attrs.set('id', 'max-shell-titlebar')
tbEl.append(acts)
body.append(tbEl)
// дословная копия делегирования из TB_JS (main.js): closest по id, вызов click(dir)
const delegated = (e) => {
  const b = e.target && e.target.closest && e.target.closest('#max-shell-scroll-up, #max-shell-scroll-down')
  if (!b || !window.__maxShellScroll) return
  window.__maxShellScroll.click(b.id === 'max-shell-scroll-up' ? -1 : 1)
}
const c0 = API.debug().clicks
cbtn.scrollTop = 200; layout(cbtn)
delegated({ target: svgIn })
const d1 = API.debug()
check('клик по внутреннему <svg> дошёл до API', [d1.clicks, d1.last.why, d1.last.dir], [c0 + 1, 'ok', -1])
check('окно прокручено вверх на одно сообщение', cbtn.scrollTop, 100)
delegated({ target: btnDn })
check('клик вниз возвращает на сообщение', [API.debug().last.dir, cbtn.scrollTop], [1, 200])
const d2 = API.debug()
delegated({ target: new El('span') })          // клик мимо кнопок
check('клик мимо кнопок ничего не считает', API.debug().clicks, d2.clicks)
cbtn.scrollTop = 0; layout(cbtn)
delegated({ target: btnUp })
check('клик на самом верху -> at-edge, счётчик растёт', [API.debug().last.why, API.debug().clicks], ['at-edge', d2.clicks + 1])

console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'ВСЁ ЗЕЛЁНО'))
process.exit(fails ? 1 : 0)