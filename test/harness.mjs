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
            return () => {}
          },
          context() {
            return () => {}
          },
        },
        on(event, handler) {
          handlers.set(event, handler)
          // 真宿主（Cordis）的 ctx.on 返回 disposer，调用后监听就摘掉。
          // 这里必须照做，否则「hook 被 sync 误摘」这类 bug 在测试里永远看不见：
          // 返回 undefined 时插件侧记不到 disposer，也就无从被摘下。
          return () => {
            if (handlers.get(event) === handler) handlers.delete(event)
          }
        },
      },
    }
    emit('agent/created', { agent })
    return {
      sessionId,
      agent,
      staticSections,
      assemble(assembly) {
        const handler = handlers.get('system-prompt/assemble')
        return handler ? handler(assembly) : assembly
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

  return {
    dir,
    storeFile,
    callTool,
    callHttp,
    createAgent,
    emit,
    readStore,
    cleanup,
    getTool: () => tool,
    getRoute: () => route,
  }
}