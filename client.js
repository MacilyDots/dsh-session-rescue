/* dsh-session-rescue — client half.
 *
 * 只做一件事：Ctrl+Shift+R 重载渲染进程。运行中的 agent、会话和任务都在宿主
 * 进程，reload 不影响它们。这是正文被隐藏时的快速恢复入口，不预防底层 UI 故障。
 *
 * 刻意不引入 render-probe 的定时扫描 / CSS 自愈 / SSE 上报：整合包只宣传这一个
 * 已实现的能力，不碰 React 管理的 DOM，也不制造额外磁盘与网络流量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-rescue',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    function reloadShortcut(event) {
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
          !event.repeat && event.code === 'KeyR') {
        event.preventDefault()
        window.location.reload()
      }
    }

    function apply(ctx) {
      ctx.effect(function () {
        window.addEventListener('keydown', reloadShortcut, true)
        return function () {
          window.removeEventListener('keydown', reloadShortcut, true)
        }
      }, 'dsh-session-rescue: renderer refresh shortcut')
    }

    exports.name = 'dsh-session-rescue'
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
