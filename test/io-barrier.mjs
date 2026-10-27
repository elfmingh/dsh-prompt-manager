/**
 * I/O 屏障：把某一次文件操作精确地暂停在半路。
 *
 * 为什么需要它：这轮要证明的几件事都是「两个操作交错时会发生什么」——
 * 延迟的坏读取与一次成功保存交错、两个写事务交错、加载失败时工具仍然写盘。
 * 靠 `setTimeout` 猜时序写出来的测试既不稳定（慢机器上就红）也证明不了什么
 * （恰好在那个间隔里跑到了，不代表逻辑对）。
 *
 * 屏障的做法是把 apply 的 io 替换掉：需要卡住的那个操作会停在一个 Promise 上，
 * 测试确认「它真的到了」，放行之后才继续。这样交错点是**确定的**。
 *
 * 用法：
 *   const barrier = createIoBarrier()
 *   const harness = await createHarness({ io: barrier.io })
 *   const gate = barrier.pause('rename')
 *   const pending = harness.callTool({ action: 'add', ... })   // 会卡在 rename 前
 *   await gate.arrived()                                        // 确认已卡住
 *   // …此时可以断言「另一个操作看到了什么」…
 *   gate.release()
 *   await pending
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const OPS = ['readFile', 'writeFile', 'rename', 'unlink']
const REAL_IO = { readFile, writeFile, rename, unlink }

export function createIoBarrier(baseIo = REAL_IO) {
  const real = baseIo
  const gates = new Map()

  const io = {}
  for (const op of OPS) {
    io[op] = async (...args) => {
      const gate = gates.get(op)
      // 只拦够 times 次就放行。不这样做的话，屏障会把**后续所有**同类调用一起
      // 卡住，测试里那些本该跑起来的操作全停在那里，「它没发生」就成了假象 ——
      // 反向验证时会看到测试照样绿。
      if (gate && gate.hits < gate.times) {
        gate.hits += 1
        // 唤醒所有等在 arrived() 上的调用方
        for (const resolve of gate.waiters.splice(0)) resolve()
        await gate.promise
      }
      if (typeof real?.[op] !== 'function') {
        throw new Error(`io-barrier: 没有可用的 ${op} 实现`)
      }
      return real[op](...args)
    }
  }

  return {
    io,

    /**
     * 让下一次 `op` 调用停住。
     *
     * 只拦**一次**：命中之后屏障自动摘除，后续调用直通。需要连续拦多次就再调一次
     * pause —— 显式比「一直拦着」更好排错，也避免忘了释放导致整个测试挂死。
     */
    pause(op, { timeoutMs = 3000, times = 1 } = {}) {
      if (!OPS.includes(op)) throw new Error(`io-barrier: 未知操作 ${op}`)
      let release
      const promise = new Promise((resolve) => {
        release = resolve
      })
      const gate = { promise, hits: 0, times, waiters: [], released: false }
      gates.set(op, gate)

      return {
        get hits() {
          return gate.hits
        },
        /** 这一次调用是否已经卡在屏障上。 */
        get arrivedAlready() {
          return gate.hits > 0
        },
        /**
         * 等到这次调用真的到达屏障。超时抛错而不是永远等 —— 测试挂死比失败更难查。
         */
        async arrived() {
          if (gate.hits > 0) return gate.hits
          await new Promise((resolve, reject) => {
            gate.waiters.push(resolve)
            const timer = setTimeout(
              () => reject(new Error(`io-barrier: ${op} 在 ${timeoutMs}ms 内没有被触发`)),
              timeoutMs,
            )
            timer.unref?.()
          })
          return gate.hits
        },
        release() {
          if (gate.released) return
          gate.released = true
          gates.delete(op)
          release()
        },
      }
    },
  }
}