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
        route = definition
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
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
  }

  const callTool = async (args) => {
    if (!tool) throw new Error('prompt_manager tool was not registered')
    return tool.execute(args)
  }

  const readStore = () => JSON.parse(readFileSync(storeFile, 'utf8'))

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

  const callHttp = (path) =>
    new Promise((resolve, reject) => {
      const response = {
        statusCode: 0,
        headers: {},
        setHeader(name, value) {
          this.headers[name] = value
        },
        end(body) {
          try {
            resolve({ status: this.statusCode, body: JSON.parse(body || '{}') })
          } catch (error) {
            reject(error)
          }
        },
      }
      route.handler({ method: 'GET', url: path, headers: {} }, response)
    })

  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  return {
    dir,
    storeFile,
    callTool,
    callHttp,
    createAgent,
    readStore,
    cleanup,
    getTool: () => tool,
    getRoute: () => route,
  }
}