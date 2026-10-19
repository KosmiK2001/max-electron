'use strict'

// Preload работает в изолированном контексте (contextIsolation: true,
// sandbox: true). Наружу отдаётся ровно ОДНА вещь: window.maxShell — четыре
// вызова кнопок титлбара плюс подписка на смену состояния «развернуто».
// Ни require, ни ipcRenderer, ни fs веб-странице MAX недоступны.
//
// Любая добавка сюда — новая поверхность атаки недоверенной страницы на наш
// процесс, поэтому список намеренно минимальный и не расширяется «про запас».

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maxShell', {
  minimize: () => ipcRenderer.send('shell:minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-maximize'),
  close: () => ipcRenderer.send('shell:close'),
  isMaximized: () => ipcRenderer.invoke('shell:is-maximized'),
  onMaximizeChanged: (cb) => {
    ipcRenderer.on('shell:maximize-changed', (_e, max) => cb(!!max))
  },
  // Непрочитанные СООБЩЕНИЯ (считает инжект в странице) + готовые иконки трея.
  // Только приём числа внутрь; страница не может ничего запросить/сделать.
  setUnread: (payload) => ipcRenderer.send('shell:unread-messages', payload)
})
