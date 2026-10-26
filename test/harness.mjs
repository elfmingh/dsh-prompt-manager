/**
 * 测试基座：在进程内用 mock ctx 跑真实的 apply()。
 *
 * 插件只依赖很少的 ctx 面：tools.register / systemPrompt.section / on(event) /
 * webServer.register / get(name)。把这些替换成可控的假实现后，就能直接验证
 * 存储读写、静态注册、assemble waterfall 改写和 HTTP 端点，不需要起 DSH 进程。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一份典型的真实装配结果，用来喂给 assemble waterfall。 */
export function fixture() {
  return {
    sections: [
      { name: 'harness:identity', text: 'base identity' },
      { name: 'plan:policy', text: 'plan policy' },
      { name: 'team:policy', text: 'team policy' },
    ],
    contexts: [
      { name: 'app:web-surface', text: 'gui url' },
      { name: 'sandbox:policy', text: 'workspace-write' },
    ],
    tools: [
      { name: 'shell', description: 'run a shell command', parameters: { properties: { cmd: { type: 'string' } } } },
      { name: 'read', description: 'read a file', parameters: { properties: { path: { type: 'string' } } } },
    ],
    variables: {},
  }
}

export async function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prompt-manager-'))
  // diag() 会往 $DSH_HOME/prompt-manager-debug.log 追加，指到临时目录避免污染真实日志。
  process.env.DSH_HOME = dir
  const storeFile = join(dir, 'prompt-manager.json')

  const listeners = new Map()
  const cwdBySession = new Map()
  // Cordis 的插件卸载不是事件，而是 fiber effect 回收：ctx.effect(fn) 里的 fn 返回的
  // cleanup 在卸载时被调用。真要测「卸载时释放路由」就得模拟这条路径，光发一个
  // 'dispose' 事件是测不到的 —— 宿主里根本没有那个事件。
  const effects = []
  let tool = null
  let route = null

  const ctx = {
    tools: {
      register(definition) {
        tool = definition
        // 真宿主返回卸装函数。不返回的话「卸载后工具还在列表里」测不出来。
        return () => {
          if (tool === definition) tool = null
        }
      },
    },
    systemPrompt: {
      section() {
        return () => {}
      },
      context() {
        return () => {}
      },
    },
    webServer: {
      register(definition) {
        // 真宿主在重复注册同一路径时抛错，插件据此判断上一次有没有清理干净。
        if (route) throw new Error('webserver: duplicate exact route')
        route = definition
        return () => {
          if (route === definition) route = null
        }
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    get(name) {
      // 插件用 ctx.get('workingDirectory').get(session) 取会话的工作目录。
      if (name === 'workingDirectory') {
        return { get: (session) => cwdBySession.get(session?.id) ?? '' }
      }
      return undefined
    },
  }

  apply(ctx, { storeFile })
  // apply() 里的首次 loadStore 是异步的；reload 会 await 一次完整加载。
  try {
    await tool.execute({ action: 'reload' })
  } catch {
    await delay(50)
  }

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler(payload)
    // 模拟插件被卸载：真实宿主走 fiber effect 回收，这里用 'dispose' 事件触发。
    if (event === 'dispose') {
      while (effects.length) {
        try {
          effects.pop()()
        } catch {
          /* 单个 effect 清理失败不影响其余 */
        }
      }
    }
  }

  const callTool = async (args) => {
    if (!tool) throw new Error('prompt_manager tool was not registered')
    return tool.execute(args)
  }

  // 没有写入过的仓库文件不存在，读它就是「空仓库」，不该当成失败。
  const readStore = () => {
    try {
      return JSON.parse(readFileSync(storeFile, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { version: 2, entries: [], applications: { global: { enabled: [] }, workspaces: {} }, temporary: [], overrides: {} }
      }
      throw error
    }
  }

  /** 模拟一个会话：触发 agent/created，拿到它的静态注册与 assemble hook。 */
  const createAgent = (sessionId, cwd = '', header = {}) => {
    if (cwd) cwdBySession.set(sessionId, cwd)
    const handlers = new Map()
    const staticSections = []
    const agent = {
      session: { id: sessionId, header: { id: sessionId, isSeeded: false, ...header } },
      ctx: {
        systemPrompt: {
          section(spec) {
            staticSections.push(spec)
            // 真宿主返回的 disposer 会把这个 section 摘掉。返回空函数会让
            // 「静态段落没清理 / 重复注册」这类问题在测试里完全隐形。
            return () => {
              const index = staticSections.indexOf(spec)
              if (index >= 0) staticSections.splice(index, 1)
            }
          },
          context() {
            return () => {}
          },
        },
        on(event, handler) {
          // 真 Cordis 一个事件可以有多个 listener；用 Map<event, handler> 会让
          // 后挂的覆盖先挂的，重复挂 hook、监听顺序、waterfall 组合全都测不出来。
          const list = handlers.get(event) ?? []
          list.push(handler)
          handlers.set(event, list)
          return () => {
            const current = handlers.get(event) ?? []
            const index = current.indexOf(handler)
            if (index >= 0) current.splice(index, 1)
          }
        },
      },
    }
    emit('agent/created', { agent })
    return {
      sessionId,
      agent,
      staticSections,
      /** 这个 agent 上某个事件挂了多少个 listener —— assemble hook 就挂在这里。 */
      listenerCount: (event) => (handlers.get(event) ?? []).length,
      /** 模拟「这个注册已经被摘掉了」。0.2.4 的 hook disposer 存在 cleanups 里。 */
      dropListeners: (event) => {
        handlers.delete(event)
      },
      /**
       * 按 Cordis waterfall 语义装配：第 i 个 listener 的 `next()` 调第 i+1 个，
       * 最后由返回值决定结果。只有这样才测得出「listener 不调 next 就阻断后面」
       * 这类契约 bug —— 旧实现直接调单个 handler，等于替插件掩盖了它。
       */
      async assemble(assembly) {
        const list = handlers.get('system-prompt/assemble') ?? []
        const dispatch = (index, current) => {
          const handler = list[index]
          if (!handler) return current
          return Promise.resolve(handler(current, {}, () => dispatch(index + 1, current)))
        }
        return dispatch(0, assembly)
      },
    }
  }

  const callHttp = (path, init = {}) =>
    new Promise((resolve, reject) => {
      const response = {
        statusCode: 0,
        headers: {},
        setHeader(name, value) {
          this.headers[name] = value
        },
        end(body) {
          try {
            resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(body || '{}') })
          } catch (error) {
            reject(error)
          }
        },
      }
      const payload = init.body ?? ''
      const request = {
        method: init.method ?? 'GET',
        url: path,
        headers: { host: '127.0.0.1:62654', ...(init.headers ?? {}) },
        async *[Symbol.asyncIterator]() {
          if (payload) yield Buffer.from(payload, 'utf8')
        },
      }
      if (!route) {
        reject(new Error('route is not registered'))
        return
      }
      Promise.resolve(route.handler(request, response)).catch(reject)
    })

  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  /**
   * 再跑一次 apply(ctx, { storeFile }) —— 这就是宿主热重载真正做的事：整个模块
   * 重新求值，apply 再执行一遍，旧实例的清理函数被调掉、新实例重新注册路由与工具。
   *
   * 注意它和 `callTool({action:'reload'})` 不是一回事：reload 只是重新读一遍文件，
   * 实例没换、闭包没换，跨实例的问题（旧 hook 回落到旧文档、旧 agent 不迁移）
   * 用它根本测不出来 —— 以前几个用例就是这么假通过的。
   */
  const reapply = async () => {
    apply(ctx, { storeFile })
    // apply 里的首次 loadStore 是异步的，等它落地再往下走。
    await delay(40)
  }

  return {
    dir,
    storeFile,
    callTool,
    callHttp,
    createAgent,
    emit,
    readStore,
    reapply,
    cleanup,
    getTool: () => tool,
    getRoute: () => route,
    /**
     * 模拟「从 0.2.4 升级上来」的那一刻。
     *
     * 0.2.4 用一个全局 Set 记住所有建过的 agent，它没有 scope、全进程一份；新版
     * 改成 registry 里的 Map。升级时旧版根本没有这张 Map，所以这里把它清空，
     * 再把 agent 放进旧 Set —— 只有这样才真正测得到 adoptLegacyAgents 有没有干活
     * （否则 Map 里本来就有这些 agent，删掉迁移代码测试照样过）。
     */
    simulateLegacyUpgrade: (agentList) => {
      globalThis[Symbol.for('vertixara.dsh-prompt-manager/agents')] = new Set(agentList)
      const entry = globalThis[Symbol.for(`vertixara.dsh-prompt-manager/disposers:${storeFile}`)]
      if (entry?.agents) entry.agents.clear()
    },
    /** 顶层 ctx 上某个事件挂了多少个 listener（agent 自己的用 createAgent 返回值）。 */
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}