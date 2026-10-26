/**
 * @vertixara/dsh-prompt-manager  (0.2.4，数据模型 v2)
 *
 * 数据模型 v2 —— "档案 / 应用 / 临时"三分：
 *   entries      长期条目档案：只存定义 { id, title, text, order }，不带作用域
 *   applications 应用关系：
 *                  global.enabled[]                              全局启用的条目
 *                  workspaces[<cwd>] = { enabled[], disabled[], default[] }
 *                                                                每个工作区独立的启用 / 禁用 / 默认组
 *   temporary    临时条目：直接绑定 sessionId，不进档案
 *
 * 生效解析（对某个 agent）：
 *   全局启用 ∪ 工作区启用 − 工作区禁用 ∪ 该会话临时条目，按 order 排序。
 *   全部注册在 agent 作用域，所以"某工作区禁用某全局条目"能真正生效。
 *
 * 存储：$DSH_HOME/prompt-manager.json（v1 文档在加载时自动迁移并回写）
 * 管理：模型工具 `prompt_manager` + Web UI + HTTP 路由 /prompt-manager/api
 */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { watch, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STORE_VERSION = 2
const DEFAULT_ORDER = 9000
const SECTION_PREFIX = 'prompt-manager:'

export const inject = ['systemPrompt', 'tools', 'webServer']

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function nowIso() {
  return new Date().toISOString()
}

function normalizePathValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function sectionName(id, source) {
  return source === 'temporary' ? `${SECTION_PREFIX}temporary:${id}` : `${SECTION_PREFIX}${id}`
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/**
 * 跨 apply 实例的 disposer 注册表，挂在 globalThis 上。
 *
 * 宿主不会替我们管理这条路由的生命周期：`webServer.register()` 返回的删除函数
 * 如果丢掉，热卸载或重新 apply 之后，旧 handler 会一直持有旧 state 继续应答，
 * 而新 host 注册同一路径会撞上 duplicate route。
 *
 * 关键点是这个注册表**不能放模块作用域**：文件一改，宿主热重载会重新求值整个模块，
 * 模块级变量跟着换成新的空表，旧实例的 route / watcher / 定时器就再也够不着了 ——
 * 日志里那两条 "duplicate exact route" 就是这么来的。globalThis 在重载前后是同一个
 * 对象，新模块能看见旧实例留下的清理函数。
 *
 * 键里带 scope（用 storeFile 当实例标识）：同一进程里挂着两份插件时（两个 profile、
 * 或测试里两个 harness 同时活着），它们各用各的槽，后一个不会把前一个的 route /
 * tool / watcher 一起摘掉。热重载前后 storeFile 不变，所以仍然能共享同一个槽 ——
 * 这正是我们需要的那一半。固定的单一 Symbol 键做不到这件事。
 */
const DISPOSER_REGISTRY_PREFIX = 'vertixara.dsh-prompt-manager/disposers:'

function registry(scope) {
  const key = Symbol.for(`${DISPOSER_REGISTRY_PREFIX}${scope}`)
  let entry = globalThis[key]
  if (!entry) {
    entry = { current: null, all: new Set(), state: null, lastDocument: null, agents: new Map(), scope }
    globalThis[key] = entry
  }
  // 补齐字段。热重载时这张表是**上一个版本**留下的：3b6ce18 的 entry 就没有
  // agents。只在整个 entry 不存在时才初始化，等于假设「表要么在且完整、要么
  // 不在」—— 升级那一刻它恰恰是「在但不完整」，于是 runningAgents.set / .entries
  // 直接抛 TypeError，新实例一启动就哑掉。逐字段补，绝不覆盖已有的。
  if (!(entry.all instanceof Set)) entry.all = new Set()
  if (!(entry.agents instanceof Map)) entry.agents = new Map()
  if (!('lastDocument' in entry)) entry.lastDocument = null
  if (!('state' in entry)) entry.state = null
  if (!('current' in entry)) entry.current = null
  return entry
}

/**
 * 把表里继承下来的**裸 agent** 就地包成 WeakRef。
 *
 * 更早的版本（6c98aca 及之前）存的是裸对象；只把它当 WeakRef 解引用而不回写，
 * 等于强引用照旧攥着，WeakRef 要解决的泄漏一点没变。
 *
 * 只在 `apply` 初始化时调一次，**不要**放进 `registry()`：那个函数每次读取
 * registry 都会走一遍（`currentState` → 每次提示词装配），塞进去就变成每次装配
 * 全表扫描一次 —— 会话越多越慢，而且这份迁移本质上只需要在上电时跑一次。
 */
function migrateAgentTable(entry) {
  if (!(entry?.agents instanceof Map)) return
  for (const [sessionId, value] of [...entry.agents]) {
    if (!value || typeof value.deref === 'function') continue
    try {
      entry.agents.set(sessionId, new WeakRef(value))
    } catch {
      // 不可弱引用的值（原始类型之类）留着也没有意义。
      entry.agents.delete(sessionId)
    }
  }
}

/**
 * 0.2.4 及更早用的是不带实例后缀的固定 Symbol 键。
 *
 * 从那些版本热重载上来时，旧实例的 route / tool / watcher 清理函数还躺在旧键里，
 * 而新实例只认带后缀的键 —— 那群清理函数从此没有人调用，等于永久泄漏：路由一直
 * 应答、watcher 一直在跑、同一路径再注册就抛 duplicate route。这里把它们执行一遍。
 */
const LEGACY_DISPOSER_REGISTRY = Symbol.for('vertixara.dsh-prompt-manager/disposers')

function drainLegacyRegistry() {
  const legacy = globalThis[LEGACY_DISPOSER_REGISTRY]
  if (!legacy || typeof legacy !== 'object') return
  try {
    // 0.2.4 的 all 是 **Set**，不是数组。用 Array.isArray 判断会永远为假 ——
    // 结果是「一个 disposer 都没执行，却把注册表删掉了」，比不迁移更糟：既没清掉
    // 旧实例的 route/tool/watcher，又丢掉了以后找回它们的唯一入口。
    const lists = legacy.all
    if (lists && typeof lists[Symbol.iterator] === 'function') {
      for (const list of lists) {
        while (Array.isArray(list) && list.length) {
          const dispose = list.pop()
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 清理失败不应阻断后续清理 */
          }
        }
      }
    }
    if (lists && typeof lists.clear === 'function') lists.clear()
    legacy.current = null
    legacy.state = null
  } catch {
    /* 结构对不上就算了，不能因为一次迁移失败让插件起不来 */
  }
  try {
    delete globalThis[LEGACY_DISPOSER_REGISTRY]
  } catch {
    /* 删不掉也无所谓，下一次 apply 会再清一遍 */
  }
}

/**
 * 0.2.4 把每个建过的 agent 都塞进了 `globalThis[AGENT_REGISTRY]`（一个 Set）。
 *
 * 那个 Set 当时是为「记录还活着的 agent」而写的，没有任何读者，后来在本轮重构里
 * 被删掉了。对**升级**来说它恰好是唯一入口：新实例的 runningAgents 是空的，
 * 而 agent/created 不会因为插件重新加载而再发一次 —— 升级前就活着的 agent 永远
 * 等不到迁移，它们的旧 hook 会一直停留在旧代码上。
 */
const LEGACY_AGENT_REGISTRY = Symbol.for('vertixara.dsh-prompt-manager/agents')

function trackDisposer(scope, dispose) {
  if (typeof dispose !== 'function') return
  const entry = registry(scope)
  if (!entry.current) {
    entry.current = []
    entry.all.add(entry.current)
  }
  entry.current.push(dispose)
}

function disposeAll(scope) {
  const entry = registry(scope)
  for (const list of entry.all) {
    while (list.length) {
      const dispose = list.pop()
      try {
        dispose()
      } catch {
        /* 清理失败不应阻断后续清理 */
      }
    }
  }
  entry.all.clear()
  entry.current = null
  // 把最后一份有效文档留下来再清 state。
  //
  // 卸载摘不掉已经挂在 agent 上的旧 hook，它下次装配还会走 currentState。如果这时
  // 只剩「回落到自己闭包里那份 state」一条路，回落到的就是**更旧**的文档：实例 A
  // 建 agent → 重载成 B → B 删掉某条临时提示词 → 卸载 B，旧 hook 回落到 A 的文档，
  // 那条已经删掉的提示词就复活了。保留 B 的文档做兜底，语义是「插件停了，保持在
  // 它停之前的最后状态」，而不是「倒退到更早的某次装配」。
  if (entry.state) entry.lastDocument = entry.state
  entry.state = null
}

/**
 * 当前 apply 实例的 store 快照入口。
 *
 * assemble hook 注册在 agent 的 ctx 上，热重载能摘掉宿主那边的注册，却摘不掉已经
 * 挂到 agent 上的那一个。于是旧 hook 会继续被调用 —— 如果它读的是自己闭包里的
 * state，那份 state 已经不再被 watcher 更新，面板改什么都看不见。
 * 让它每次现取最新的 state，旧 hook 就自动跟上了新实例的数据。
 */
function currentState(scope, fallback) {
  const entry = registry(scope)
  // 顺序：本实例的 state → 上一个实例卸载时留下的最后一份文档 → 调用方闭包里的
  // 那份。中间的 lastDocument 不能省：没有它，卸载后旧 hook 会一路回落到更早的
  // 实例，把已经删掉的内容重新装配回来。
  return entry.state ?? entry.lastDocument ?? fallback
}

/**
 * 把临时文件挪到正式位置。
 *
 * Windows 上目标被杀软、搜索索引或另一个句柄短暂占用时，rename 会抛
 * EPERM/EBUSY/EACCES —— 而这时内容其实已经完整落进临时文件了。这类占用多半是
 * 毫秒级的，所以先短暂重试几次再说，原来一次失败就放弃太急。
 *
 * **不能**在重试耗尽后退化成「直接覆盖写」。那等于把原子替换降级成截断 + 顺序写：
 * 崩溃就留下半截 JSON，而 loadStore 解析失败会退回空文档，用户下一次操作再拿空
 * 文档整份写回，把坏文件连同可能还能抢救的内容一起覆盖 —— 一次写失败变成整份
 * 配置永久丢失。宁可这次保存失败、保留完好的临时文件。
 *
 * 放在模块级是为了能被测试直接调用：这层重试的分支（第几次成功、非瞬时错误、
 * 重试耗尽）在真实文件系统上几乎撞不到，只能靠注入假的 rename 覆盖。
 */
async function commitTemp(tempFile, targetFile, renameImpl = rename) {
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await renameImpl(tempFile, targetFile)
      return
    } catch (error) {
      lastError = error
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!transient) throw error
      // 最后一次失败就没必要再等了，直接收工。
      if (attempt === 3) break
      // 25ms、50ms、75ms —— 够杀软扫完一个小 JSON，又不会让界面明显卡住。
      await sleep(25 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * per-agent 状态的载体。
 *
 * 挂在 agent 对象上（Symbol 键）而不是 apply 闭包里：热重载会重新求值整个模块，
 * 闭包和模块级 Map 全部重建，而 agent 活在宿主里、跨重载存活。状态放在 agent 上，
 * 新 apply 就能认出「这个 agent 已经注册过 section 和 assemble hook」，既不重复挂，
 * 也能先把旧的那份摘干净。
 */
const AGENT_STATE = Symbol.for('vertixara.dsh-prompt-manager/agent-state')

/**
 * 把各种形态的「可释放句柄」统一成一个函数。
 *
 * Cordis 4 的 `ctx.on()` 返回函数，但它的类型里 Disposable / AsyncDisposable 都合法，
 * 宿主哪天换成 `{ dispose() }` 或 `Symbol.dispose`，只判函数就会漏记，而漏记的后果
 * 是 hook 摘不掉、`hookAttached` 却已经是 true —— 之后重挂会挂第二份，段落重复。
 */
function asDisposer(value) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  if (value && typeof value[Symbol.dispose] === 'function') return () => value[Symbol.dispose]()
  return null
}

function agentStateOf(agent) {
  if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null
  let state
  try {
    state = agent[AGENT_STATE]
  } catch {
    // 只读 Proxy 的 getter 会抛，别让它冒到 agent/created 的 catch 里变成莫名一条。
    return null
  }
  // 认的只有「带 sectionDisposers 数组」的新结构。
  if (state && Array.isArray(state.sectionDisposers)) return state
  if (!state) {
    // section 的 disposers 和 assemble hook 的 disposer **必须分开放**。
    // 放同一个数组里的话，任何一次文档变更触发的 syncAgentSections 会把 hook
    // 一起 splice 掉，而 hookAttached 仍是 true、不会重挂 —— 那个会话的动态层
    // 就永久消失了。这是 bfcaaeb 引入的回归，之前两者是分池的。
    state = { sectionDisposers: [], hookDispose: null, hookAttached: false }
  } else if (Array.isArray(state.cleanups)) {
    // 从 0.2.4 升级上来：旧 cleanups 里**混着** hook 的 disposer（0.2.4 是
    // `state.cleanups.push(disposeHook)` 直接塞进去的）。不能把它们当成
    // sectionDisposers 继承 —— 那等于把 hook 的摘除权交给 syncAgentSections，
    // 一改文档就重演同一个 bug。全部执行掉：它们摘的正是旧实例留下的 section
    // 和旧 hook，然后按「什么都没挂」重新来过。
    try {
      for (const dispose of state.cleanups.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 旧 disposer 抛错不该阻断迁移 */
        }
      }
      if (typeof state.hookDispose === 'function') state.hookDispose()
    } catch {
      /* 同上 */
    }
    state = { sectionDisposers: [], hookDispose: null, hookAttached: false }
  } else {
    // 认不出来的形状。**不要**去执行它里面的东西，也不要覆盖它的字段：
    // 不知道那些 disposer 是谁挂的，执行了可能把别人的注册摘掉；擅自把
    // hookAttached 置 false 又会让 hook 被重挂，变成两份。就地补齐缺的字段，
    // 按「已经挂了」对待，让调用方别重挂。
    state.sectionDisposers = []
    state.hookDispose = typeof state.hookDispose === 'function' ? state.hookDispose : null
    // 注意不能写 `=== true`：那会把 undefined 变成 false，于是 syncAgentSections
    // 末尾判定「没挂」又重挂一份，而原来那个 hook 的 disposer 还被覆盖掉 ——
    // 两份 hook、一份丢掉清理入口。未知形状下唯一安全的方向是「当作已经挂了」。
    state.hookAttached = state.hookAttached !== false
  }
  try {
    agent[AGENT_STATE] = state
  } catch {
    // agent 被冻结：拿不到状态就不挂，宁可不生效也不要抛错。
    return null
  }
  return state
}

/**
 * 摘掉这个 agent 上的全部注册；hookAttached 复位，允许重新挂。
 *
 * 这个方法只给 agent/disposed 和「实例真的被替换掉」用。日常的文档变更走
 * syncAgentSections，那条路**不碰 hook** —— 见下面的分池说明。
 */
function releaseAgent(agent) {
  let agentState
  try {
    agentState = agent?.[AGENT_STATE]
  } catch {
    return
  }
  if (!agentState) return
  const disposers = agentState.sectionDisposers.splice(0)
  if (agentState.hookDispose) disposers.push(agentState.hookDispose)
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* 单个清理失败不影响其余 */
    }
  }
  agentState.hookDispose = null
  agentState.hookAttached = false
}

export function apply(ctx, config = {}) {
  // 实例标识要在清理之前算出来：注册表按它分槽，不同实例互不干扰。
  const storeFile = (config && config.storeFile) || join(dshHome(), 'prompt-manager.json')
  // 上一次 apply 的残留先摘掉，否则注册同一路径会抛 duplicate route。
  disposeAll(storeFile)
  // 从 0.2.4 热重载上来时，旧实例的清理函数在另一张（无后缀的）表里，只清本实例
  // 的槽会把它们漏掉。见 drainLegacyRegistry。
  drainLegacyRegistry()
  trackDisposer(storeFile, () => {}) // 建立本次 apply 的列表，后续 trackDisposer 归到这里
  // 清理钩子必须挂在开头，而不是 apply 末尾：后面任何一步抛错，末尾那行就执行不到，
  // 这一次 apply 注册的东西就会永久留在宿主里。
  //
  // 用 ctx.effect 而不是 ctx.on('dispose')：Cordis 4 没有 dispose / teardown 事件，
  // 插件的卸载走的是 fiber effect 回收（cordis/src/events.ts 的 emit 点只有
  // internal/* 那几个）。挂不存在的事件名不会报错，只会静默变成一段永远不执行的
  // 死代码 —— 后果是插件被禁用后路由还在应答、watcher 还在跑。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => disposeAll(storeFile))
    } else {
      for (const event of ['dispose', 'teardown']) {
        try {
          ctx.on(event, () => disposeAll(storeFile))
        } catch {
          /* 老宿主：没有这个事件就跳过 */
        }
      }
    }
  } catch (error) {
    diag(`dispose-hook-failed ${error?.message ?? error}`)
  }
  const state = { document: emptyDocument() }
  // 已建立的 agent 表挂在 registry 上，而不是每次 apply 新建一个空 Map。
  //
  // 热重载不会为重开的会话再发 agent/created，新实例如果从空表开始，就永远不
  // 知道前一实例还管着哪些 agent：静态 section 停在旧文档上（动态层靠 currentState
  // 还能读到新文档，但这只掩盖了症状），refreshRunningAgents 也刷不到它们。
  // 早先 0.2.4 用一个 globalThis Set 兜这件事，但它是只写不读的，删掉之后就断开
  // 了这条唯一线索 —— 现在用 registry 里这张 Map 代替，它天然跨重载存活。
  const runningAgents = registry(storeFile).agents
  // 只在启动时做一次裸值 → WeakRef 的迁移，不要放进 registry()（那儿是热路径）。
  migrateAgentTable(registry(storeFile))

  /**
   * 表里存的是 WeakRef 而不是 agent 本身。
   *
   * 这张表现在跨热重载存活，真实持有 agent 就变成了跨实例的强引用：插件停用期间
   * 宿主销毁某个 agent，那个 agent/disposed 监听已经随插件一起被摘掉，Map 永远不会
   * 收到通知 —— 于是内存里一直攥着一个已经死掉的会话对象。WeakRef 让宿主回收之后
   * 这里自然落空，deref 不出东西就等于「不在了」。
   */
  const liveAgent = (ref) => {
    if (!ref) return null
    // 必须是「是 WeakRef 就只信 deref」。写成 `ref?.deref?.() ?? ref` 是错的：
    // Agent 被回收后 deref() 返回 undefined，`??` 会回落到 ref 本身，于是把一个
    // WeakRef 对象当成 agent 传给 syncAgentSections / assemble 逻辑。
    if (typeof ref.deref === 'function') return ref.deref() ?? null
    // 不是 WeakRef 就是老数据（或测试里直接塞的对象），原样返回。
    return ref
  }

  const sessionFacts = new Map()
  // 最近一次真实装配的内容，按 sessionId 存放，供面板枚举 agent 作用域的段落。
  const assemblySnapshots = new Map()
  // 每个会话启动时冻结的全局规则：主页的改动只对新会话生效，避免中途改动把缓存前缀打掉。
  const sessionBaselines = new Map()
  let watcher = null
  let reloadTimer = null
  /**
   * 写事务队列。
   *
   * 每次修改都是「读整份文档 → 改 → 整份写回」。两个调用并发时，它们各自读到
   * 同一个旧版本，先后写回，后写的那次把先写的成果整个抹掉，而两边都拿到成功
   * 响应。做法是把整个事务串起来，且在锁内重新读盘，保证基于最新状态修改。
   */
  let writeChain = Promise.resolve()

  function withWriteLock(task) {
    const run = writeChain.then(() => task())
    // 队列本身不能被 rejection 打断，否则一个失败会毒化后续所有写。
    writeChain = run.then(() => {}, () => {})
    return run
  }

  // ------------------------------------------------------------ diagnostics

  function diag(message) {
    try {
      appendFileSync(join(dshHome(), 'prompt-manager-debug.log'), `${nowIso()} ${message}\n`)
    } catch {
      /* diagnostics are best effort */
    }
  }

  function log(message) {
    diag(message)
  }

  // --------------------------------------------------------- document model

  function emptyDocument() {
    return {
      version: STORE_VERSION,
      entries: [],
      applications: { global: { enabled: [] }, workspaces: {} },
      temporary: [],
      // 内置段落改写：enabled 是总开关，sections 按段落名存放 disable / replace 规则。
      overrides: {
        enabled: false,
        sections: {},
        contexts: {},
        sessionSections: {},
        sessionContexts: {},
        saved: [],
      },
    }
  }

  function normalizeOrder(value) {
    return Number.isFinite(value) ? value : DEFAULT_ORDER
  }

  /** 条目对哪类代理生效：inherit（都注入）/ main（仅主代理）/ subagent（仅子代理）。 */
  function normalizeAgentScope(value) {
    return value === 'main' || value === 'subagent' ? value : 'inherit'
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return undefined
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
    if (!id) return undefined
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (!text.trim()) return undefined
    return {
      id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
      text,
      order: normalizeOrder(raw.order),
      agentScope: normalizeAgentScope(raw.agentScope),
    }
  }

  function normalizeTemporary(raw) {
    if (!raw || typeof raw !== 'object') return undefined
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (!id || !text.trim()) return undefined
    return {
      id,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '',
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
      text,
      order: normalizeOrder(raw.order),
      agentScope: normalizeAgentScope(raw.agentScope),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    }
  }

  function normalizeWorkspaceConfig(raw) {
    return {
      enabled: stringList(raw?.enabled),
      disabled: stringList(raw?.disabled),
      default: stringList(raw?.default),
      hotReload: raw?.hotReload === true,
    }
  }

  function normalizeApplications(raw) {
    const applications = { global: { enabled: stringList(raw?.global?.enabled) }, workspaces: {} }
    const workspaces = raw && typeof raw.workspaces === 'object' && raw.workspaces ? raw.workspaces : {}
    for (const [key, value] of Object.entries(workspaces)) {
      const path = normalizePathValue(key)
      if (!path) continue
      const config = normalizeWorkspaceConfig(value)
      // 丢弃空配置：删除档案后不留空壳，避免工作区下拉里出现幽灵项。
      if (!config.enabled.length && !config.disabled.length && !config.default.length && !config.hotReload) continue
      applications.workspaces[path] = config
    }
    return applications
  }

  /**
   * v1 → v2。v1 每条记录自带 scope：
   *   global    → 档案 + applications.global.enabled
   *   workspace → 档案 + workspaces[workspacePath].enabled
   *   context   → 档案 + workspaces[match.cwdPrefix].enabled（cwd 条件并入工作区语义）
   *   session   → 档案 + temporary（保留 sessionId 绑定）
   */
  function migrateV1(raw) {
    const document = emptyDocument()
    const legacy = Array.isArray(raw?.entries) ? raw.entries : []
    for (const item of legacy) {
      const entry = normalizeEntry(item)
      if (!entry) continue
      document.entries.push(entry)
      const active = item?.enabled !== false
      if (!active) continue
      if (item?.scope === 'session' && typeof item?.sessionId === 'string' && item.sessionId.trim()) {
        const temporary = normalizeTemporary({
          id: entry.id,
          sessionId: item.sessionId,
          title: entry.title,
          text: entry.text,
          order: entry.order,
        })
        if (temporary) document.temporary.push(temporary)
        continue
      }
      const workspaceKey = item?.scope === 'workspace'
        ? normalizePathValue(item?.workspacePath)
        : item?.scope === 'context'
          ? normalizePathValue(item?.match?.cwdPrefix)
          : ''
      if (workspaceKey) {
        const config = document.applications.workspaces[workspaceKey] ?? { enabled: [], disabled: [], default: [] }
        if (!config.enabled.includes(entry.id)) config.enabled.push(entry.id)
        document.applications.workspaces[workspaceKey] = config
        continue
      }
      if (!document.applications.global.enabled.includes(entry.id)) {
        document.applications.global.enabled.push(entry.id)
      }
    }
    return document
  }

  function normalizeDocument(raw) {
    if (!raw || typeof raw !== 'object') return emptyDocument()
    const version = Number(raw.version ?? 1)
    if (version < STORE_VERSION) return migrateV1(raw)
    const document = emptyDocument()
    const seen = new Set()
    for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
      const entry = normalizeEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      document.entries.push(entry)
    }
    document.applications = normalizeApplications(raw.applications)
    document.overrides = normalizeOverrides(raw.overrides)
    for (const item of Array.isArray(raw.temporary) ? raw.temporary : []) {
      const temporary = normalizeTemporary(item)
      if (temporary) document.temporary.push(temporary)
    }
    return document
  }

  function normalizeRuleMap(raw) {
    const result = {}
    const source = raw && typeof raw === 'object' ? raw : {}
    for (const [name, value] of Object.entries(source)) {
      const key = String(name ?? '').trim()
      if (!key) continue
      const mode = value?.mode === 'disable' ? 'disable'
        : value?.mode === 'replace' ? 'replace'
          : value?.mode === 'enable' ? 'enable'
            : ''
      if (!mode) continue
      if (mode === 'replace') {
        const text = typeof value?.text === 'string' ? value.text : ''
        if (!text.trim()) continue
        result[key] = { mode, text }
        continue
      }
      // enable 用来在会话层推翻全局基线的 disable，恢复原文。
      result[key] = { mode }
    }
    return result
  }

  function normalizeSavedOverrides(raw) {
    const result = []
    const seen = new Set()
    for (const item of Array.isArray(raw) ? raw : []) {
      const name = typeof item?.name === 'string' ? item.name.trim() : ''
      const text = typeof item?.text === 'string' ? item.text : ''
      const id = typeof item?.id === 'string' ? item.id.trim() : ''
      if (!name || !text.trim() || !id || seen.has(id)) continue
      seen.add(id)
      const entry = {
        id,
        name,
        layer: item?.layer === 'contexts' ? 'contexts' : 'sections',
        text,
        createdAt: typeof item?.createdAt === 'string' ? item.createdAt : nowIso(),
      }
      const sessionId = typeof item?.sessionId === 'string' ? item.sessionId.trim() : ''
      if (sessionId) entry.sessionId = sessionId
      result.push(entry)
    }
    return result.slice(0, 100)
  }

  /** 按会话的改写规则：{ [sessionId]: { [name]: rule } }，sections 与 contexts 共用同一形状。 */
  function normalizeSessionRules(raw) {
    const result = {}
    for (const [key, rules] of Object.entries(raw ?? {})) {
      const sessionId = String(key || '').trim()
      if (!sessionId) continue
      const normalized = normalizeRuleMap(rules)
      if (Object.keys(normalized).length) result[sessionId] = normalized
    }
    return result
  }

  function normalizeOverrides(raw) {
    return {
      enabled: raw?.enabled === true,
      // sections / contexts 是全局基线，只在会话启动时读一次（见 freezeBaseline）。
      sections: normalizeRuleMap(raw?.sections),
      contexts: normalizeRuleMap(raw?.contexts),
      // session* 是会话页的即时规则，每次装配都重新读，且只影响那一个会话。
      sessionSections: normalizeSessionRules(raw?.sessionSections),
      sessionContexts: normalizeSessionRules(raw?.sessionContexts),
      saved: normalizeSavedOverrides(raw?.saved),
    }
  }

  /** 把一条 replace 规则的文本归档，供之后重新应用。 */
  function appendSaved(overrides, layer, name, rule, sessionId) {
    const saved = [...(overrides?.saved ?? [])]
    const text = typeof rule?.text === 'string' ? rule.text : ''
    if (rule?.mode !== 'replace' || !text.trim()) return saved
    const entry = {
      id: `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      layer,
      text,
      createdAt: nowIso(),
    }
    if (sessionId) entry.sessionId = String(sessionId)
    saved.unshift(entry)
    return saved.slice(0, 100)
  }

  // -------------------------------------------------------------- store i/o

  async function loadStore() {
    // 返回 { document, ok }，ok 表示**这一次**加载是否真的拿到了可信文档。
    //
    // 不能用实例级变量记这个：首次加载、watcher、工具动作会并发跑，一次失败
    // 就能把另一次刚置上的成功标志抹掉（或者反过来），于是「该不该做迁移」取决于
    // 谁后写的，而不是这次加载自己的结果。
    // 读、解析、归一化拆成三段 try。只有「解析」失败才说明文件内容坏了；
    // 早先三者共用一个 catch，于是 EACCES / EIO 这类读取错误也会落进隔离分支，
    // 把一份刚刚保存成功的配置从正式文件上 rename 走 —— 读一次失败就能毁掉
    // 正常运行的配置，这比它想防的问题严重得多。
    let text
    try {
      text = await readFile(storeFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 没有文件是正常状态（全新安装），算成功读到一个空仓库。
        state.document = emptyDocument()
        return { document: state.document, ok: true }
      }
      // 读不到不等于内容坏了。没有证据就不许动用户的数据：保留最后一次有效
      // 文档继续装配（比退回空配置安全），把失败留在日志里。
      log(`load-failed(io) code=${error?.code ?? '-'} ${error?.message ?? error}`)
      return { document: state.document, ok: false }
    }

    let parsed
    try {
      parsed = text.trim() ? JSON.parse(text) : null
    } catch (error) {
      // 到这里才是真的解析不了。不能静默退回空文档：插件会带着空配置继续跑，
      // 用户下一次点任何东西都拿空文档整份写回，把那个坏掉、但可能还抢救得
      // 出来的文件彻底覆盖。先把原文件挪到一边留证据，再退回空文档。
      const backup = `${storeFile}.corrupt-${Date.now().toString(36)}`
      try {
        await rename(storeFile, backup)
        log(`store-corrupt ${error?.message ?? error}；原文件已保留为 ${backup}`)
      } catch (moveError) {
        log(`store-corrupt ${error?.message ?? error}；隔离原文件失败 ${moveError?.message ?? moveError}`)
      }
      state.document = emptyDocument()
      return { document: state.document, ok: false }
    }

    let document
    try {
      document = normalizeDocument(parsed)
    } catch (error) {
      // 归一化是纯函数，它抛错说明代码有问题，不是文件有问题 —— 同样不许动数据。
      log(`store-normalize-failed ${error?.message ?? error}`)
      return { document: state.document, ok: false }
    }
    state.document = document
    if (!parsed || Number(parsed?.version ?? 1) < STORE_VERSION) {
      try {
        // 走 saveStore 而不是裸 writeFile：迁移同样是「覆盖用户的正式文件」，
        // 必须有原子写与 rename 重试。
        await saveStore(document)
        diag('migrated-to-v2')
      } catch (error) {
        diag(`migrate-write-failed ${error?.message ?? error}`)
      }
    }
    return { document: state.document, ok: true }
  }

  async function saveStore(document) {
    const normalized = normalizeDocument(document)
    const payload = `${JSON.stringify(normalized, null, 2)}\n`
    // 先写临时文件再原子替换：直接覆盖的话，写到一半出错会留下半截 JSON，
    // 下次启动就整份读不出来。rename 在同一个卷上是原子的。
    // 文件名带随机段：热重载时新旧两个实例的 pid 相同，光靠毫秒时间戳可能撞名，
    // 撞上就是一方把另一方的临时文件 rename 走，结果「报失败其实已经落盘」。
    const nonce = Math.random().toString(36).slice(2, 8)
    const tempFile = `${storeFile}.${process.pid}-${Date.now().toString(36)}-${nonce}.tmp`
    try {
      await writeFile(tempFile, payload, 'utf8')
    } catch (error) {
      // 连临时文件都没写完整，留着没用。
      try {
        await unlink(tempFile)
      } catch {
        /* 可能根本没建立起来 */
      }
      throw error
    }
    try {
      await commitTemp(tempFile, storeFile)
    } catch (error) {
      // 特意不删临时文件：rename 失败时它是一份**完整可用**的内容，删掉等于把用户
      // 手动恢复的唯一材料也销毁了。日志写明路径，用户照着改回正式文件即可。
      log(`store-write-failed ${error?.code ?? ''} ${error?.message ?? error}；内容保留在 ${tempFile}`)
      throw error
    }
    try {
      await unlink(tempFile)
    } catch {
      /* rename 成功后它已经不在了 */
    }
    state.document = normalized
    return normalized
  }

  // ------------------------------------------------------------- resolution

  /**
 * 复制一个工作区配置，连同它的三个数组。
 *
 * 这些数组必须复制：`{ ...document.applications.workspaces }` 只是浅拷贝外层对象，
 * 拿到的 `target` 仍然指向当前文档里的那个对象，`target.enabled.push(...)` 改的是
 * **已经发布的内存文档**。saveStore 失败时没有回滚 —— 结果是 HTTP 返回 500、磁盘
 * 还是旧的，但内存已经改了，下一次装配就按新规则走，和界面显示完全对不上。
 */
function cloneWorkspace(workspace) {
  const source = workspace ?? { enabled: [], disabled: [], default: [] }
  return {
    ...source,
    enabled: [...(source.enabled ?? [])],
    disabled: [...(source.disabled ?? [])],
    default: [...(source.default ?? [])],
  }
}

function workspaceEntries(document = state.document) {
    return Object.entries(document.applications.workspaces)
  }

  /**
   * @param cwd 会话的工作目录
   * @param document 要匹配的那份文档。装配时必须把当前这份传进来：默认参数读的是
   *   `state.document`，而 hook 可能属于上一个实例（热重载摘不掉），闭包里的
   *   state 是旧文档 —— 那就是「规则用新的、条目用旧的」老问题换了个位置复发。
   */
  function matchWorkspaceKey(cwd, document = state.document) {
    const current = normalizePathValue(cwd)
    if (!current) return ''
    let best = ''
    for (const [key] of workspaceEntries(document)) {
      if (!key) continue
      if (current === key || current.startsWith(`${key}/`)) {
        if (key.length > best.length) best = key
      }
    }
    return best
  }

  function layerItem(entry, source) {
    return {
      source,
      id: entry.id,
      title: entry.title,
      text: entry.text,
      order: entry.order,
      agentScope: normalizeAgentScope(entry.agentScope),
    }
  }

  /**
   * 子代理判定：框架在 SessionHeader 里已经标好了，不需要自己推断。
   * 优先看 origin，其次 parentSession，最后看委派深度。
   */
  function agentFacts(agent) {
    try {
      const header = agent?.session?.header
      const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : ''
      const subagent = header?.origin === 'subagent'
        || Boolean(parentSessionId)
        || Number(header?.delegationDepth ?? 0) > 0
      return { subagent, parentSessionId }
    } catch {
      return { subagent: false, parentSessionId: '' }
    }
  }

  /**
   * 会话的祖先链（含自身）。
   *
   * 临时条目写在「打开它的那个会话」名下，但那个会话派生的子代理、孙代理
   * 也应当看得到 —— 否则 UI 里选「仅子代理」的临时条目永远到不了任何子代理。
   * 链上每一节的 parentSessionId 由框架写进 SessionHeader，这里顺着走即可。
   */
  function sessionLineage(sessionId) {
    const chain = new Set()
    let current = sessionId
    while (current && !chain.has(current)) {
      chain.add(current)
      current = sessionFacts.get(current)?.parentSessionId ?? ''
    }
    return chain
  }

  /** agentScope 过滤：inherit 总是注入，main 只给主代理，subagent 只给子代理。 */
  function allowForScope(item, facts) {
    const scope = normalizeAgentScope(item?.agentScope)
    if (scope === 'inherit') return true
    const isSubagent = facts?.subagent === true
    return scope === 'subagent' ? isSubagent : !isSubagent
  }

  /**
   * 冻结一个会话的全局规则基线。
   *
   * 主页改的是全局规则，它只影响之后新建的会话：提示词前缀一变，服务端缓存就整段失效，
   * 所以不让它追杀正在跑的会话。会话页改的是 sessionSections / sessionContexts，
   * 那些不冻结，每次装配实时读取 —— 用户明确要求"即时生效、会话间隔离"。
   * 总开关也不冻结：它是全局刹车，必须立刻有效。
   */
  function freezeBaseline(sessionId) {
    if (!sessionId || sessionBaselines.has(sessionId)) return
    const overrides = state.document.overrides ?? {}
    sessionBaselines.set(sessionId, {
      sections: { ...(overrides.sections ?? {}) },
      contexts: { ...(overrides.contexts ?? {}) },
    })
  }

  /**
   * 静态层：全局应用 + 未开启后注入的工作区应用。
   * 会话创建时注册一次，之后不再变化 —— 对应"系统提示词不需要后注入"。
   */
  function resolveStaticItems(facts) {
    const document = state.document
    const workspaceKey = matchWorkspaceKey(facts?.cwd, document)
    const workspace = workspaceKey ? document.applications.workspaces[workspaceKey] : undefined
    const disabled = new Set(workspace?.disabled ?? [])
    const hot = workspace?.hotReload === true
    const globalEnabled = new Set(document.applications.global.enabled)
    const items = []
    for (const entry of document.entries) {
      if (!allowForScope(entry, facts)) continue
      if (disabled.has(entry.id)) continue
      const inWorkspace = workspace
        ? workspace.enabled.includes(entry.id) || workspace.default.includes(entry.id)
        : false
      // 开了后注入的工作区，其条目一律交给动态层，避免同一段落被两条路径各注入一次。
      if (inWorkspace && hot) continue
      if (globalEnabled.has(entry.id) || inWorkspace) items.push(layerItem(entry, 'library'))
    }
    return items.sort((left, right) => left.order - right.order)
  }

  /**
   * 后注入层：会话临时条目（必须每轮生效）+ 开启了后注入的工作区条目。
   * 每次 system-prompt/assemble 都重新解析，所以改完下一轮立即生效。
   */
  /**
   * 动态层条目。`document` 默认取本实例的 store，但 assemble hook 会显式传入它
   * 现取到的那份 —— 否则一次装配里规则来自新文档、条目来自旧文档，会出现
   * 「新文档已经删掉的临时条目还在被注入，新 replace 规则作用在旧文本上」。
   */
  function resolveDynamicItems(facts, document = state.document) {
    const workspaceKey = matchWorkspaceKey(facts?.cwd, document)
    const workspace = workspaceKey ? document.applications.workspaces[workspaceKey] : undefined
    const disabled = new Set(workspace?.disabled ?? [])
    const lineage = sessionLineage(facts?.sessionId)
    const items = []
    if (workspace?.hotReload === true) {
      for (const entry of document.entries) {
        if (!allowForScope(entry, facts)) continue
        if (disabled.has(entry.id)) continue
        if (!workspace.enabled.includes(entry.id) && !workspace.default.includes(entry.id)) continue
        items.push(layerItem(entry, 'library'))
      }
    }
    for (const temporary of document.temporary) {
      if (!allowForScope(temporary, facts)) continue
      // 按祖先链判定可见范围：主会话写的临时条目，它派生的子代理也看得到。
      if (temporary.sessionId && !lineage.has(temporary.sessionId)) continue
      items.push({
        source: 'temporary',
        id: temporary.id,
        title: temporary.title,
        text: temporary.text,
        order: temporary.order,
        agentScope: normalizeAgentScope(temporary.agentScope),
      })
    }
    return items.sort((left, right) => left.order - right.order)
  }

  /** 预览 / 排查用：静态层 + 后注入层合并，按 section name 去重，并标注注入方式。 */
  function resolveItems(facts) {
    const seen = new Set()
    const merged = []
    const push = (items, injection) => {
      for (const item of items) {
        const name = sectionName(item.id, item.source)
        if (seen.has(name)) continue
        seen.add(name)
        merged.push({ ...item, injection })
      }
    }
    push(resolveStaticItems(facts), 'static')
    push(resolveDynamicItems(facts), 'hot')
    return merged.sort((left, right) => left.order - right.order)
  }

  // ----------------------------------------------------------- agent wiring

  function sessionIdOf(agent) {
    try {
      const value = agent?.session?.id ?? agent?.sessionId
      return typeof value === 'string' && value.trim() ? value.trim() : ''
    } catch {
      return ''
    }
  }

  function workingDirectoryOf(agent) {
    try {
      const value = ctx.get('workingDirectory')?.get?.(agent?.session)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  function cleanupAgentSections(agent) {
    releaseAgent(agent)
  }

  function syncAgentSections(agent) {
    if (!agent?.ctx?.systemPrompt?.section) return
    const sessionId = sessionIdOf(agent)
    const facts = { sessionId, cwd: workingDirectoryOf(agent), ...agentFacts(agent) }
    if (sessionId) {
      sessionFacts.set(sessionId, facts)
      freezeBaseline(sessionId)
    }
    // 起名 agentState 而不是 state：这个函数在 apply 作用域里，外层已经有一个
    // `state`（store 文档）。同名会把 store 遮住，将来在这里读 state.document 就会
    // 静默拿到错误的对象。
    const agentState = agentStateOf(agent)
    if (!agentState) {
      // 拿不到状态槽说明 agent 被冻结或是只读 Proxy。这时这个会话完全拿不到注入，
      // 必须留下痕迹 —— 否则用户只看到「这个会话的规则没生效」，日志里一个字都没有。
      diag(`agent-state-unavailable sid=${sessionId || '-'}`)
      return
    }
    // 只摘 section 的注册，**绝不碰 hook**：hook 是一次性的、生命周期跟 agent 走的
    // 注册，条目变了不代表 hook 该重挂。两者分池存放就是为了这条 —— 早先它们共用
    // 一个数组，任何一次文档变更都会把 hook 一起摘掉，而 hookAttached 还是 true，
    // 于是那个会话的动态层永久消失。
    for (const dispose of agentState.sectionDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
    // 静态层：全局 + 未开启后注入的工作区条目。动态层交给 assemble waterfall。
    const items = resolveStaticItems(facts)
    for (const item of items) {
      try {
        agentState.sectionDisposers.push(agent.ctx.systemPrompt.section({
          name: sectionName(item.id, item.source),
          order: item.order,
          text: item.text,
          // 用户文本原样注入：不声明这一项，宿主会把 {{name}} 当变量引用，
          // 遇到未知变量直接抛异常，让整个会话装配失败。
          interpolate: false,
        }))
      } catch (error) {
        log(`register-failed ${item.id}: ${error?.message ?? error}`)
      }
    }
    diag(`agent-sections sid=${sessionId || '-'} cwd=${facts.cwd || '-'} items=${items.length}`)

    // 从 0.2.4 迁移过来的 agent：agentStateOf 已经把旧 hook 摘掉了（旧 hook 读的是
    // 无后缀的固定键，留着也读不到新实例的文档），但摘完没有任何地方重挂它 ——
    // 已存在的会话不会再来一次 agent/created。漏了这一步，升级那一刻还活着的会话
    // 动态层就永久消失，只能靠重开会话才恢复。
    if (!agentState.hookAttached) attachAssembleHook(agent)
  }

  /**
   * 静态 section 只在注册那一刻进入装配结果：对已经在运行的 agent，之后再
   * 追加的条目不会进入它的系统提示。system-prompt/assemble 是每次装配都会
   * 调用的 waterfall，且按 scope 分发，挂在 agent ctx 上就只在该 agent 装配
   * 时触发 —— 这是会话临时条目与"开启了后注入"的工作区条目的注入点。
   * 只注入动态层，并与静态注册按 name 去重，避免同一段落出现两次。
   */
  /** 记录最近一次真实装配，供面板枚举 agent 作用域的内容。 */
  function recordSnapshot(sessionId, snapshot) {
    try {
      const key = sessionId || '-'
      const previous = assemblySnapshots.get(key)
      assemblySnapshots.set(key, {
        at: Date.now(),
        revision: (previous?.revision ?? 0) + 1,
        sections: snapshot?.sections ?? [],
        contexts: snapshot?.contexts ?? [],
        tools: snapshot?.tools ?? [],
        injected: snapshot?.injected ?? [],
      })
      if (assemblySnapshots.size > 20) {
        const oldest = [...assemblySnapshots.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))[0]
        if (oldest) assemblySnapshots.delete(oldest[0])
      }
    } catch (error) {
      diag(`snapshot-failed ${error?.message ?? error}`)
    }
  }

  function attachAssembleHook(agent) {
    if (!agent?.ctx?.on) return
    const agentState = agentStateOf(agent)
    if (!agentState) {
      // 同 syncAgentSections：状态槽拿不到就没法挂 hook，得留下痕迹。
      diag(`agent-state-unavailable attach sid=${sessionIdOf(agent) || '-'}`)
      return
    }
    if (agentState.hookAttached) return
    const sessionId = sessionIdOf(agent)
    const facts = { sessionId, cwd: workingDirectoryOf(agent), ...agentFacts(agent) }
    if (sessionId) {
      sessionFacts.set(sessionId, facts)
      freezeBaseline(sessionId)
    }
    try {
      const disposeHook = agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        // waterfall 契约：不调 next 就等于独占了整条装配链，排在我们后面的
        // listener 一个都不会执行。这个 hook 原先只声明 (assembly) 一个参数、
        // 从不调 next —— 现在没出事只是因为还没有别的插件监听这个事件。
        //
        // 顺序选「先 next 再加工」：用户的覆盖规则是最终裁决，必须作用在下游的
        // 结果之上；反过来先改再 next，下游就能把它们盖掉。宿主契约里 `assembly`
        // 虽然允许原地修改，但返回值才是权威的，所以这里一律构造新对象。
        //
        // next() 放在 try **外面**：下游抛错要原样冒给宿主。包在里面的话，下游
        // 装配失败会被这里吞掉、再返回一份原始 assembly —— 调用方拿到的是「成功」
        // 结果，永远不知道下游挂了。
        const downstream = (await next()) ?? assembly
        try {
          // 现取最新 store：这个 hook 可能属于上一个 apply 实例（热重载摘不掉它），
          // 读闭包里的 state 会永远停在重载前那份文档上。整段装配必须统一用这一份，
          // 不能规则取新的、条目取旧的。
          const live = currentState(storeFile, state)
          const overrides = live.document.overrides
          // 总开关不冻结：它是全局刹车，要立刻有效。
          const active = overrides?.enabled === true
          // 全局规则取会话启动时的基线（主页改动只对新会话生效）；
          // 会话级规则实时读取（会话页改动立刻生效，且只影响本会话）。
          const baseline = sessionBaselines.get(sessionId) ?? {
            sections: overrides?.sections ?? {},
            contexts: overrides?.contexts ?? {},
          }
          const sessionSectionRules = active && sessionId ? (overrides.sessionSections?.[sessionId] ?? {}) : {}
          const sessionContextRules = active && sessionId ? (overrides.sessionContexts?.[sessionId] ?? {}) : {}
          const sectionRules = active ? { ...baseline.sections, ...sessionSectionRules } : {}
          const contextRules = active ? { ...baseline.contexts, ...sessionContextRules } : {}
          const items = resolveDynamicItems(facts, live.document)
          const hasRules = Object.keys(sectionRules).length > 0 || Object.keys(contextRules).length > 0

          // 先留一份规则应用之前的原始装配：面板必须能看到被禁用的条目，
          // 否则一旦禁用就没有入口把它重新打开。
          const toEntry = (entry) => ({
            name: String(entry?.name ?? ''),
            text: typeof entry?.text === 'string' ? entry.text : String(entry?.text ?? ''),
          })
          const rawSections = (Array.isArray(downstream?.sections) ? downstream.sections : []).map(toEntry)
          const rawContexts = (Array.isArray(downstream?.contexts) ? downstream.contexts : []).map(toEntry)
          const rawTools = (downstream?.tools ?? []).map((tool) => ({
            name: String(tool?.name ?? ''),
            description: String(tool?.description ?? ''),
            parameterKeys: Object.keys(tool?.parameters?.properties ?? {}),
          }))

          if (!hasRules && !items.length) {
            recordSnapshot(sessionId, { sections: rawSections, contexts: rawContexts, tools: rawTools, injected: [] })
            return downstream
          }

          // 1) 内置段落：disable 直接移除，replace 换文本。
          const sections = []
          for (const section of Array.isArray(downstream?.sections) ? downstream.sections : []) {
            const rule = sectionRules[section?.name]
            if (rule?.mode === 'disable') continue
            if (rule?.mode === 'replace') {
              // 覆盖文本同样是用户输入，不能当模板解析。
              sections.push({ ...section, text: rule.text, interpolate: false })
              continue
            }
            sections.push(section)
          }

          // 2) contexts 同样处理；required 的 context 若被移除，由框架决定是否恢复。
          const contexts = []
          for (const entry of Array.isArray(downstream?.contexts) ? downstream.contexts : []) {
            const rule = contextRules[entry?.name]
            if (rule?.mode === 'disable') continue
            if (rule?.mode === 'replace') {
              contexts.push({ ...entry, text: rule.text, interpolate: false })
              continue
            }
            contexts.push(entry)
          }

          // 3) 再追加动态层；已被 disable 的段落不再追加回来。
          //    动态条目在装配开始时还不存在，所以 replace 只能在这里应用——
          //    上面那一轮只覆盖宿主已装配的段落，漏了这里规则就等于白存。
          const existing = new Set(sections.map((section) => section?.name))
          const allExtras = []
          for (const item of items) {
            const name = sectionName(item.id, item.source)
            if (existing.has(name)) continue
            const rule = sectionRules[name]
            const text = rule?.mode === 'replace' ? rule.text : item.text
            allExtras.push({ name, text, interpolate: false })
          }
          // 被禁用的动态条目仍要记进快照，否则面板上没有入口把它打开。
          const extras = allExtras.filter((entry) => sectionRules[entry.name]?.mode !== 'disable')

          recordSnapshot(sessionId, {
            sections: rawSections,
            contexts: rawContexts,
            tools: rawTools,
            injected: allExtras,
          })
          return { ...downstream, sections: [...sections, ...extras], contexts }
        } catch (error) {
          log(`assemble-hook-failed ${error?.message ?? error}`)
          // 本地加工失败时退回**下游的结果**，不是原始的 assembly —— 下游的加工
          // 已经做完了，丢掉它等于把别人的工作一并抹掉。
          return downstream
        }
      })
      // 只在真拿到 disposer 之后才置 hookAttached：如果宿主返回的形态无法识别，
      // 标记成「已挂」会让以后所有重挂都跳过，反而把 hook 永久钉死在那儿。
      const hookDispose = asDisposer(disposeHook)
      if (!hookDispose) {
        diag(`assemble-hook-undisposable type=${typeof disposeHook}`)
        return
      }
      agentState.hookDispose = hookDispose
      agentState.hookAttached = true
      diag(`assemble-hook-attached sid=${sessionId || '-'}`)
    } catch (error) {
      agentState.hookDispose = null
      agentState.hookAttached = false
      diag(`assemble-hook-attach-failed ${error?.message ?? error}`)
    }
  }

  /** 档案/应用变更后，对仍在运行的会话重新解析。 */
  function refreshRunningAgents() {
    for (const [sessionId, ref] of [...runningAgents.entries()]) {
      // 存的是 WeakRef：被宿主回收掉的 agent 在这里落空，顺手把空条目删掉。
      const agent = liveAgent(ref)
      if (!agent) {
        runningAgents.delete(sessionId)
        continue
      }
      try {
        syncAgentSections(agent)
      } catch (error) {
        log(`refresh-failed ${sessionId}: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * 收编 0.2.4 留下的 agent。
   *
   * 热重载不会为已经存在的会话再发一次 agent/created，所以新实例的 runningAgents
   * 是空的：升级前就活着的 agent 既不会迁移 state（仍是 {cleanups, hookAttached}），
   * 也不会重挂 hook，它们的 hook 一直停在旧代码上 —— 旧代码不调 next、读的是旧
   * 注册表键。放进 runningAgents 之后再走一次 syncAgentSections，迁移和重挂都在
   * 那条路上。0.2.4 的 AGENT_REGISTRY 是唯一能找回这些 agent 的入口。
   */
  function adoptLegacyAgents() {
    // 实例有效性检查放在函数里，而不是每个调用点各写一遍 —— 三个入口（bootstrap、
    // watcher、工具动作）里漏掉任何一个，过期实例就能执行不可逆的接管：把旧 Set
    // 吃掉、跑掉旧 cleanup、按**它自己**那份文档注册静态段落并冻结基线。之后真正
    // 活着的实例再怎么刷新也不会重新冻结基线，规则永久错位。
    if (registry(storeFile).state !== state) {
      diag('legacy-adopt-skipped stale-instance')
      return
    }
    let agents
    try {
      agents = globalThis[LEGACY_AGENT_REGISTRY]
    } catch {
      return
    }
    if (!agents || typeof agents[Symbol.iterator] !== 'function') return
    let adopted = 0
    try {
      for (const agent of [...agents]) {
        try {
          const sessionId = sessionIdOf(agent)
          if (sessionId) runningAgents.set(sessionId, new WeakRef(agent))
          syncAgentSections(agent)
          adopted += 1
        } catch (error) {
          diag(`legacy-agent-adopt-failed ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      diag(`legacy-agent-scan-failed ${error?.message ?? error}`)
    }
    if (adopted) diag(`legacy-agents-adopted ${adopted}`)
    try {
      delete globalThis[LEGACY_AGENT_REGISTRY]
    } catch {
      /* 删不掉不影响功能，下次 apply 会再扫一遍 */
    }
  }

  // ---------------------------------------------------------------- watcher

  function startWatcher() {
    try {
      watcher = watch(storeFile, { persistent: false }, () => {
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
          reloadTimer = null
          loadStore()
            .then(({ ok }) => {
              // 首次加载失败时跳过了迁移；之后任何一次成功加载都该把这次接管补上，
              // 否则旧 agent 要一直等到下一次 apply 才被收编（期间它们的静态段落
              // 停在旧文档上）。adoptLegacyAgents 自己幂等：Set 已经消费过就是空转。
              if (ok) adoptLegacyAgents()
              refreshRunningAgents()
              diag(`store-reloaded entries=${state.document.entries.length}`)
            })
            .catch((error) => log(`watch-reload-failed ${error?.message ?? error}`))
        }, 150)
      })
      watcher.on?.('error', () => {})
      trackDisposer(storeFile, () => {
        watcher?.close?.()
        watcher = null
        if (reloadTimer) {
          clearTimeout(reloadTimer)
          reloadTimer = null
        }
      })
    } catch (error) {
      watcher = null
      diag(`watcher-create-failed ${error?.message ?? error}`)
    }
  }

  // ------------------------------------------------------------------- tool

  function summary() {
    const document = state.document
    return `${document.entries.length} 个档案条目，全局启用 ${document.applications.global.enabled.length} 个，` +
      `${Object.keys(document.applications.workspaces).length} 个工作区有应用配置，${document.temporary.length} 条临时条目`
  }

  const toolDefinition = {
    name: 'prompt_manager',
    description:
      'Manage the prompt library stored in $DSH_HOME/prompt-manager.json. ' +
      'The model is library / application / temporary: "library" holds long-lived prompt entries ' +
      '(id, title, text, order); "application" binds entries to the global scope or to one workspace ' +
      'directory via enabled / disabled / default sets; "temporary" entries bind to a session id and ' +
      'never enter the library. Injection is layered: global entries are registered statically when a ' +
      'session is created; session temporary entries are hot-injected on every assembly; a workspace ' +
      'becomes hot-injected too when apply.hotReload is on for it. ' +
      'Built-in sections (Harness and other plugins) can be turned off or replaced via ' +
      'override.set / override.clear / override.toggle; overrides only apply while the master switch is on. ' +
      'Actions: list, preview, library.add, library.update, library.remove, ' +
      'apply.toggle, apply.default, apply.hotReload, override.set, override.clear, override.toggle, ' +
      'override.reset, override.restore, override.forget, ' +
      'temp.add, temp.remove, reload, path.',
    // register() takes an already-compiled raw JSON Schema.
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'list | preview | library.add | library.update | library.remove | apply.toggle | apply.default | apply.hotReload | override.set | override.clear | override.toggle | override.reset | override.restore | override.forget | temp.add | temp.remove | reload | path',
        },
        id: { type: 'string', description: 'Entry id for library/temp entries, or saved-override id for override.restore / override.forget' },
        title: { type: 'string', description: 'Human-readable title' },
        text: { type: 'string', description: 'Prompt text inserted verbatim; for override.set with mode=replace it is the replacement text' },
        order: { type: 'number', description: 'Prompt section order (default 9000; persona suffix is 10200)' },
        scope: { type: 'string', description: 'For apply.toggle: global | workspace (default global)' },
        workspacePath: { type: 'string', description: 'Workspace directory for scope=workspace or apply.default' },
        enabled: { type: 'boolean', description: 'For apply.toggle, apply.hotReload, override.toggle: true enables, false disables' },
        isDefault: { type: 'boolean', description: 'For apply.default: mark or unmark as a workspace default entry' },
        sessionId: { type: 'string', description: 'Session id: temp.add / preview, or per-session context overrides (override.set / override.clear / override.reset)' },
        name: { type: 'string', description: 'For override.set / override.clear: exact section or context name, e.g. harness:identity' },
        mode: { type: 'string', description: 'For override.set: disable | replace' },
        layer: { type: 'string', description: 'For override.set / override.clear: section | context (default section)' },
        agentScope: {
          type: 'string',
          description:
            "Target agent kind for library.add / library.update / temp.add: 'inherit' (default, both kinds), " +
            "'main' (main agents only), or 'subagent' (subagents only). Subagent status comes from SessionHeader.",
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      // 所有 action 串行执行，并在锁内重新读盘：并发调用若各自基于内存里的同一份
      // 旧文档修改再写回，就会互相覆盖——两边都返回成功，却只剩一个结果。
      return withWriteLock(async () => {
        const { ok } = await loadStore()
        // 首次加载失败时会跳过升级迁移；之后任何一次成功加载都该把这次接管补上，
        // 否则旧 agent 的静态段落一直停在旧文档上，直到下一次 apply 才恢复。
        // adoptLegacyAgents 幂等：旧 Set 消费过之后就是空转。
        if (ok) adoptLegacyAgents()
        return runAction(args)
      })
    },
  }

  async function runAction(args) {
    const action = String(args?.action ?? 'list').toLowerCase()

      if (action === 'path') {
        return `${storeFile}\n(${summary()})`
      }
      if (action === 'reload') {
        const { ok } = await loadStore()
        if (ok) adoptLegacyAgents()
        refreshRunningAgents()
        return `已重新载入：${summary()}`
      }
      if (action === 'list') {
        const document = state.document
        const lines = [summary()]
        const scopeLabel = (value) =>
            value === 'main' ? '仅主代理' : value === 'subagent' ? '仅子代理' : ''
          for (const entry of document.entries) {
            const glob = document.applications.global.enabled.includes(entry.id) ? '全局启用' : '未全局启用'
            const scope = scopeLabel(entry.agentScope)
            const spaces = Object.entries(document.applications.workspaces)
              .filter(([, config]) => config.enabled.includes(entry.id))
              .map(([key]) => key)
            lines.push(`- ${entry.id} | ${entry.title} | order ${entry.order} | ${glob}${scope ? ` | ${scope}` : ''}${spaces.length ? ` | 工作区: ${spaces.join(', ')}` : ''}`)
          }
          for (const temporary of document.temporary) {
            const scope = scopeLabel(temporary.agentScope)
            lines.push(`- [临时] ${temporary.id} | ${temporary.title} | session ${temporary.sessionId || '(任意)'}${scope ? ` | ${scope}` : ''}`)
          }
        return lines.join('\n')
      }
      if (action === 'preview') {
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
        const facts = sessionId ? sessionFacts.get(sessionId) ?? { sessionId, cwd: '' } : { sessionId: '', cwd: '' }
        const items = resolveItems(facts)
        return [
          `cwd=${facts.cwd || '(未知)'} session=${facts.sessionId || '(未指定)'} [${facts.subagent ? '子代理' : '主代理'}] → ${items.length} 段`,
          ...items.map((item) => `--- ${item.source}:${item.id} (order ${item.order}${item.agentScope !== 'inherit' ? `, ${item.agentScope}` : ''}) ---\n${item.text}`),
        ].join('\n\n')
      }
      if (action === 'library.add' || action === 'library.update') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) return 'error: id 不能为空'
        const existing = document.entries.find((entry) => entry.id === id)
        if (action === 'library.add' && existing) return `error: 档案已存在 ${id}`
        if (action === 'library.update' && !existing) return `error: 档案不存在 ${id}`
        const normalized = normalizeEntry({
          id,
          title: args?.title ?? existing?.title ?? id,
          text: args?.text ?? existing?.text ?? '',
          order: args?.order ?? existing?.order ?? DEFAULT_ORDER,
          agentScope: args?.agentScope ?? existing?.agentScope ?? 'inherit',
        })
        if (!normalized) return 'error: text 不能为空'
        const entries = document.entries.filter((entry) => entry.id !== id)
        entries.push(normalized)
        await saveStore({ ...document, entries })
        refreshRunningAgents()
        return `${action === 'library.add' ? '已创建' : '已更新'}档案 ${id}`
      }
      if (action === 'library.remove') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id || !document.entries.some((entry) => entry.id === id)) return `error: 档案不存在 ${id}`
        const applications = {
          global: { enabled: document.applications.global.enabled.filter((value) => value !== id) },
          workspaces: {},
        }
        for (const [key, value] of workspaceEntries()) {
          const next = {
            enabled: value.enabled.filter((item) => item !== id),
            disabled: value.disabled.filter((item) => item !== id),
            default: value.default.filter((item) => item !== id),
            // hotReload 属于工作区自己，与删哪条档案无关；重建时漏掉它，
            // 会让删除一条无关条目顺手关掉别处配置好的后注入。
            hotReload: value.hotReload === true,
          }
          if (next.enabled.length || next.disabled.length || next.default.length || next.hotReload) {
            applications.workspaces[key] = next
          }
        }
        await saveStore({
          ...document,
          entries: document.entries.filter((entry) => entry.id !== id),
          applications,
        })
        refreshRunningAgents()
        return `已删除档案 ${id}（并清理其全部应用关系）`
      }
      if (action === 'apply.toggle') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id || !document.entries.some((entry) => entry.id === id)) return `error: 档案不存在 ${id}`
        const enabled = args?.enabled !== false
        if ((args?.scope ?? 'global') !== 'workspace') {
          const list = document.applications.global.enabled.filter((value) => value !== id)
          if (enabled) list.push(id)
          await saveStore({
            ...document,
            applications: { ...document.applications, global: { enabled: list } },
          })
          refreshRunningAgents()
          return `全局${enabled ? '启用' : '禁用'} ${id}`
        }
        const key = normalizePathValue(args?.workspacePath)
        if (!key) return 'error: scope=workspace 需要 workspacePath'
        const workspaces = { ...document.applications.workspaces }
        const target = cloneWorkspace(workspaces[key])
        target.enabled = target.enabled.filter((value) => value !== id)
        target.disabled = target.disabled.filter((value) => value !== id)
        if (enabled) target.enabled.push(id)
        else target.disabled.push(id)
        if (!enabled) target.default = target.default.filter((value) => value !== id)
        workspaces[key] = target
        await saveStore({ ...document, applications: { ...document.applications, workspaces } })
        refreshRunningAgents()
        return `工作区 ${key} ${enabled ? '启用' : '禁用'} ${id}`
      }
      if (action === 'apply.default') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        const key = normalizePathValue(args?.workspacePath)
        if (!id || !document.entries.some((entry) => entry.id === id)) return `error: 档案不存在 ${id}`
        if (!key) return 'error: apply.default 需要 workspacePath'
        const workspaces = { ...document.applications.workspaces }
        const target = cloneWorkspace(workspaces[key])
        if (args?.isDefault === false) {
          target.default = target.default.filter((value) => value !== id)
        } else {
          if (!target.enabled.includes(id)) target.enabled.push(id)
          target.disabled = target.disabled.filter((value) => value !== id)
          if (!target.default.includes(id)) target.default.push(id)
        }
        workspaces[key] = target
        await saveStore({ ...document, applications: { ...document.applications, workspaces } })
        refreshRunningAgents()
        return `${key} 的默认条目${args?.isDefault === false ? '取消' : '设为'} ${id}`
      }
      // action 在上面统一转成小写，这里必须用全小写的规范形式比较，
      // 否则分支永远匹配不上（历史 bug：写的是 apply.hotReload）。
      if (action === 'apply.hotreload') {
        const document = state.document
        const key = normalizePathValue(args?.workspacePath)
        if (!key) return 'error: apply.hotReload 需要 workspacePath'
        const workspaces = { ...document.applications.workspaces }
        const target = cloneWorkspace(workspaces[key])
        target.hotReload = args?.enabled !== false
        workspaces[key] = target
        await saveStore({ ...document, applications: { ...document.applications, workspaces } })
        refreshRunningAgents()
        return `${key} 后注入${target.hotReload ? '已开启' : '已关闭'}`
      }
      if (action === 'override.set') {
        const document = state.document
        const name = typeof args?.name === 'string' ? args.name.trim() : ''
        if (!name) return 'error: override.set 需要 name'
        const layer = args?.layer === 'context' ? 'contexts' : 'sections'
        const mode = args?.mode === 'disable' ? 'disable'
          : args?.mode === 'replace' ? 'replace'
            : args?.mode === 'enable' ? 'enable'
              : ''
        if (!mode) return 'error: mode 必须是 disable / replace / enable'
        const current = document.overrides ?? {
          enabled: false,
          sections: {},
          contexts: {},
          sessionSections: {},
          sessionContexts: {},
          saved: [],
        }

        let rule = { mode }
        if (mode === 'replace') {
          const text = typeof args?.text === 'string' ? args.text : ''
          if (!text.trim()) return 'error: replace 模式需要非空 text'
          rule = { mode, text }
        }
        const verb = mode === 'disable' ? '禁用' : mode === 'enable' ? '恢复原文' : '覆盖'

        // 带 sessionId 只影响那个会话（立即生效）；不带则写全局基线（新建会话生效）。
        const label = layer === 'contexts' ? 'context' : 'section'
        const targetSession = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
        if (targetSession) {
          const bucketKey = layer === 'contexts' ? 'sessionContexts' : 'sessionSections'
          const bucket = { ...(current[bucketKey] ?? {}) }
          const sessionRules = { ...(bucket[targetSession] ?? {}) }
          sessionRules[name] = rule
          bucket[targetSession] = sessionRules
          await saveStore({ ...document, overrides: { ...current, enabled: true, [bucketKey]: bucket } })
          refreshRunningAgents()
          return `${label} ${name} 已${verb}（仅会话 ${targetSession}，立即生效）`
        }

        const rules = { ...(current[layer] ?? {}) }
        rules[name] = rule
        await saveStore({
          ...document,
          // 点开关即视为要用改写，顺手把总开关打开；总开关只用来一键全停。
          overrides: { ...current, enabled: true, [layer]: rules },
        })
        refreshRunningAgents()
        return `${label} ${name} 已${verb}（全局，新建会话生效；运行中的会话可在会话页单独调整）`
      }
      if (action === 'override.clear') {
        const document = state.document
        const name = typeof args?.name === 'string' ? args.name.trim() : ''
        if (!name) return 'error: override.clear 需要 name'
        const layer = args?.layer === 'context' ? 'contexts' : 'sections'
        const current = document.overrides ?? {
          enabled: false,
          sections: {},
          contexts: {},
          sessionSections: {},
          sessionContexts: {},
          saved: [],
        }
        const targetSession = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
        const label = layer === 'contexts' ? 'context' : 'section'

        if (targetSession) {
          const bucketKey = layer === 'contexts' ? 'sessionContexts' : 'sessionSections'
          const bucket = { ...(current[bucketKey] ?? {}) }
          const sessionRules = { ...(bucket[targetSession] ?? {}) }
          if (!sessionRules[name]) return `error: 会话 ${targetSession} 没有条目 ${name} 的改写记录`
          const rule = sessionRules[name]
          delete sessionRules[name]
          if (Object.keys(sessionRules).length) bucket[targetSession] = sessionRules
          else delete bucket[targetSession]
          const saved = appendSaved(current, layer, name, rule, targetSession)
          await saveStore({ ...document, overrides: { ...current, [bucketKey]: bucket, saved } })
          refreshRunningAgents()
          return `${label} ${name} 已在会话 ${targetSession} 恢复默认`
        }

        const rules = { ...(current[layer] ?? {}) }
        if (!rules[name]) return `error: 没有条目 ${name} 的改写记录`
        const rule = rules[name]
        delete rules[name]
        // 恢复默认时把覆盖文本归档，之后还能再应用回来。
        const saved = appendSaved(current, layer, name, rule)
        await saveStore({ ...document, overrides: { ...current, [layer]: rules, saved } })
        refreshRunningAgents()
        return `${label} ${name} 已恢复默认（全局，新建会话生效）`
      }
      if (action === 'override.toggle') {
        const document = state.document
        const enabled = args?.enabled !== false
        const current = document.overrides ?? { enabled: false, sections: {}, contexts: {}, saved: [] }
        await saveStore({ ...document, overrides: { ...current, enabled } })
        refreshRunningAgents()
        return `内置提示词改写总开关${enabled ? '已开启' : '已关闭'}`
      }
      if (action === 'override.reset') {
        const document = state.document
        const current = document.overrides ?? {
          enabled: false,
          sections: {},
          contexts: {},
          sessionSections: {},
          sessionContexts: {},
          saved: [],
        }
        const targetSession = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''

        // 带 sessionId：只清那个会话的 sections + contexts 规则，立即生效。
        if (targetSession) {
          const next = { ...current }
          let saved = [...(current.saved ?? [])]
          let count = 0
          for (const [bucketKey, layer] of [['sessionSections', 'sections'], ['sessionContexts', 'contexts']]) {
            const bucket = { ...(current[bucketKey] ?? {}) }
            for (const [name, rule] of Object.entries(bucket[targetSession] ?? {})) {
              saved = appendSaved({ saved }, layer, name, rule, targetSession)
              count += 1
            }
            delete bucket[targetSession]
            next[bucketKey] = bucket
          }
          await saveStore({ ...document, overrides: { ...next, saved: saved.slice(0, 100) } })
          refreshRunningAgents()
          return `已恢复会话 ${targetSession} 的 ${count} 条规则（立即生效，覆盖文本已归档）`
        }

        let saved = [...(current.saved ?? [])]
        let count = 0
        for (const layer of ['sections', 'contexts']) {
          for (const [name, rule] of Object.entries(current[layer] ?? {})) {
            saved = appendSaved({ saved }, layer, name, rule)
            count += 1
          }
        }
        for (const [bucketKey, layer] of [['sessionSections', 'sections'], ['sessionContexts', 'contexts']]) {
          for (const [sessionId, rules] of Object.entries(current[bucketKey] ?? {})) {
            for (const [name, rule] of Object.entries(rules ?? {})) {
              saved = appendSaved({ saved }, layer, name, rule, sessionId)
              count += 1
            }
          }
        }
        // 基线是「会话开始那一刻的全局规则」副本。全量恢复若只清磁盘不清它，
        // 运行中的会话会在下次打开总开关时把刚清掉的旧规则复活。
        // 但这一步本身会改变实际提示词 —— 必须放在保存成功之后，否则一次写盘
        // 失败就变成「界面报错、磁盘没变、运行中的提示词已经变了」。
        await saveStore({
          ...document,
          overrides: {
            enabled: false,
            sections: {},
            contexts: {},
            sessionSections: {},
            sessionContexts: {},
            saved: saved.slice(0, 100),
          },
        })
        // 保存成功后再清基线 —— 顺序反过来就会在写盘失败时提前改变运行中的提示词。
        sessionBaselines.clear()
        refreshRunningAgents()
        return `已恢复全部内置提示词，清除 ${count} 项规则（覆盖文本已归档 ${saved.length} 条）`
      }
      if (action === 'override.restore') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) return 'error: override.restore 需要 id'
        const current = document.overrides ?? {
          enabled: false,
          sections: {},
          contexts: {},
          sessionSections: {},
          sessionContexts: {},
          saved: [],
        }
        const item = (current.saved ?? []).find((entry) => entry.id === id)
        if (!item) return `error: 找不到已保存的覆盖 ${id}`

        // 来自某会话的覆盖，装回那个会话，不污染全局。
        if (item.sessionId) {
          const bucketKey = item.layer === 'contexts' ? 'sessionContexts' : 'sessionSections'
          const bucket = { ...(current[bucketKey] ?? {}) }
          const sessionRules = { ...(bucket[item.sessionId] ?? {}) }
          sessionRules[item.name] = { mode: 'replace', text: item.text }
          bucket[item.sessionId] = sessionRules
          await saveStore({ ...document, overrides: { ...current, enabled: true, [bucketKey]: bucket } })
          refreshRunningAgents()
          return `已应用保存的覆盖：${item.name}（仅会话 ${item.sessionId}，立即生效）`
        }

        const rules = { ...(current[item.layer] ?? {}) }
        rules[item.name] = { mode: 'replace', text: item.text }
        await saveStore({ ...document, overrides: { ...current, enabled: true, [item.layer]: rules } })
        refreshRunningAgents()
        return `已应用保存的覆盖：${item.name}`
      }
      if (action === 'override.forget') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) return 'error: override.forget 需要 id'
        const current = document.overrides ?? { enabled: false, sections: {}, contexts: {}, saved: [] }
        const saved = (current.saved ?? []).filter((entry) => entry.id !== id)
        if (saved.length === (current.saved ?? []).length) return `error: 找不到已保存的覆盖 ${id}`
        await saveStore({ ...document, overrides: { ...current, saved } })
        return `已删除保存的覆盖 ${id}`
      }
      if (action === 'temp.add') {
        const document = state.document
        const text = typeof args?.text === 'string' ? args.text : ''
        if (!text.trim()) return 'error: text 不能为空'
        const temporary = normalizeTemporary({
          id: typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : `temp-${Date.now().toString(36)}`,
          sessionId: args?.sessionId,
          title: args?.title ?? '临时条目',
          text,
          order: args?.order,
          agentScope: args?.agentScope,
        })
        if (!temporary) return 'error: 临时条目无效'
        const rest = document.temporary.filter((item) => item.id !== temporary.id)
        await saveStore({ ...document, temporary: [...rest, temporary] })
        refreshRunningAgents()
        return `已添加临时条目 ${temporary.id}（session=${temporary.sessionId || '任意'}）`
      }
      if (action === 'temp.remove') {
        const document = state.document
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) return 'error: id 不能为空'
        const rest = document.temporary.filter((item) => item.id !== id)
        if (rest.length === document.temporary.length) return `error: 临时条目不存在 ${id}`
        await saveStore({ ...document, temporary: rest })
        refreshRunningAgents()
        return `已删除临时条目 ${id}`
      }
      return `error: 未知 action ${action}`
  }

  // ------------------------------------------------------------- http route

  function listWorkspaces() {
    try {
      const registry = ctx.get('workspaceRegistry')
      const list = registry?.list?.() ?? []
      return list.map((workspace) => ({
        id: String(workspace?.id ?? ''),
        title: String(workspace?.title ?? workspace?.id ?? ''),
        path: String(workspace?.directory ?? workspace?.path ?? ''),
      }))
    } catch {
      return []
    }
  }

  function snapshot() {
    const document = state.document
    return {
      ok: true,
      file: storeFile,
      summary: summary(),
      entries: document.entries,
      applications: document.applications,
      temporary: document.temporary,
      workspaces: listWorkspaces(),
    }
  }

  /**
   * 请求体上限。提示词是文本，1 MB 已经远超正常用例。
   */
  const MAX_BODY_BYTES = 1024 * 1024

  /**
   * 路由守卫。
   *
   * 这条路由直接挂在宿主的 webServer 上，宿主不提供统一的认证或来源策略，
   * 所以能连到这个端口的东西都能读写提示词。主要威胁来自浏览器：别的站点可以
   * 用「简单请求」（text/plain 表单）向本机端口发 POST —— 这类请求不触发预检，
   * 也就绕过了 CORS。因此：
   *
   *   1. 带 Origin 且与 Host 不同源的一律拒绝（正常前端是同源页面）；
   *   2. POST 必须是 application/json —— 简单请求发不出这个类型，浏览器会先
   *      预检，而本路由不返回任何 CORS 响应头，预检必然失败；
   *   3. 限制请求体大小。
   *
   * 本机任意进程挡不住（它本来就能直接读 store 文件），这里防的是跨站。
   */
  function guardRequest(request) {
    const origin = request.headers?.origin
    if (typeof origin === 'string' && origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        return { status: 403, error: 'malformed origin' }
      }
      if (originHost !== String(request.headers?.host ?? '')) {
        return { status: 403, error: 'cross-origin request rejected' }
      }
    }
    if (request.method === 'POST') {
      const type = String(request.headers?.['content-type'] ?? '').toLowerCase()
      if (!type.startsWith('application/json')) {
        return { status: 415, error: 'POST requires content-type: application/json' }
      }
      const length = Number(request.headers?.['content-length'] ?? 0)
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        return { status: 413, error: 'request body too large' }
      }
    }
    return null
  }

  try {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/prompt-manager/api',
      handler: async (request, response) => {
        const send = (status, value) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.setHeader('cache-control', 'no-store')
          response.end(JSON.stringify(value))
        }
        try {
          const rejection = guardRequest(request)
          if (rejection) {
            send(rejection.status, { ok: false, error: rejection.error })
            return
          }
          if (request.method === 'GET') {
            await loadStore()
            const url = new URL(request.url || '/', 'http://127.0.0.1')
            const view = url.searchParams.get('view') ?? ''
            if (view === 'assembled') {
              // 真实装配快照：waterfall 每轮触发时记录，因此包含 agent 作用域的
              // 段落、context 与全部工具，这是 assemble({}) 拿不到的部分。
              const requested = url.searchParams.get('sessionId') ?? ''
              const overrides = state.document.overrides ?? { enabled: false, sections: {}, contexts: {} }
              let key = requested
              if (!key) {
                const newest = [...assemblySnapshots.entries()].sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0]
                key = newest?.[0] ?? ''
              }
              const snapshot = key ? assemblySnapshots.get(key) : undefined
              const active = overrides.enabled === true
              // 全局规则取该会话的基线（主页改动只对新会话生效）；会话级规则实时读取。
              const baseline = sessionBaselines.get(key) ?? {
                sections: overrides.sections ?? {},
                contexts: overrides.contexts ?? {},
              }
              const sessionSectionRules = active && key ? (overrides.sessionSections?.[key] ?? {}) : {}
              const sessionContextRules = active && key ? (overrides.sessionContexts?.[key] ?? {}) : {}
              const effectiveSectionRules = active ? { ...baseline.sections, ...sessionSectionRules } : {}
              const effectiveContextRules = active ? { ...baseline.contexts, ...sessionContextRules } : {}
              const disabledSections = Object.entries(effectiveSectionRules)
                .filter(([, rule]) => rule?.mode === 'disable')
                .map(([name]) => name)
              const disabledContexts = Object.entries(effectiveContextRules)
                .filter(([, rule]) => rule?.mode === 'disable')
                .map(([name]) => name)
              if (!snapshot) {
                send(200, {
                  ok: false,
                  sessionId: key,
                  reason: '本进程内还没有该会话的装配记录：等目标会话产生一轮回复后再刷新。',
                  subagent: sessionFacts.get(key)?.subagent === true,
                  overrides,
                  sectionRules: effectiveSectionRules,
                  contextRules: effectiveContextRules,
                  disabledSections,
                  disabledContexts,
                })
                return
              }
              send(200, {
                ok: true,
                sessionId: key,
                subagent: sessionFacts.get(key)?.subagent === true,
                at: snapshot.at,
                revision: snapshot.revision,
                sections: snapshot.sections,
                contexts: snapshot.contexts,
                tools: snapshot.tools,
                injected: snapshot.injected ?? [],
                overrides,
                sectionRules: effectiveSectionRules,
                contextRules: effectiveContextRules,
                disabledSections,
                disabledContexts,
              })
              return
            }
            if (view === 'system') {
              // 用运行中 agent 的 scoped systemPrompt 装配，才能看到注册在 agent 作用域上的
              // prompt-manager 段落；用插件根 ctx 装配只会返回宿主/插件段落。
              const sessionId = url.searchParams.get('sessionId') ?? ''
              const agent = sessionId
                ? liveAgent(runningAgents.get(sessionId))
                : liveAgent([...runningAgents.values()][0])
              const target = agent?.ctx?.systemPrompt ?? ctx.systemPrompt
              let sections = []
              let contexts = []
              let tools = []
              let scope = agent ? 'agent' : 'host'
              try {
                const assembly = await target.assemble({})
                sections = (assembly?.sections ?? []).map((section) => ({
                  name: String(section?.name ?? ''),
                  text: typeof section?.text === 'string' ? section.text : String(section?.text ?? ''),
                }))
                contexts = (assembly?.contexts ?? []).map((context) => ({
                  name: String(context?.name ?? ''),
                  text: typeof context?.text === 'string' ? context.text : String(context?.text ?? ''),
                }))
                tools = (assembly?.tools ?? []).map((tool) => ({
                  name: String(tool?.name ?? ''),
                  description: String(tool?.description ?? ''),
                  parameterKeys: Object.keys(tool?.parameters?.properties ?? {}),
                }))
              } catch (error) {
                scope = 'error'
                diag(`assemble-failed ${error?.stack ?? error}`)
              }
              // assemble({}) 不带 scope，不会触发 scoped 的 waterfall 监听器，
              // 所以这里手工重放一次改写，面板显示的才是运行时真正生效的内容。
              const overrides = state.document.overrides ?? { enabled: false, sections: {} }
              const rules = overrides.enabled === true ? (overrides.sections ?? {}) : {}
              const disabledSections = []
              const ruled = []
              for (const section of sections) {
                const rule = rules[section.name]
                if (rule?.mode === 'disable') {
                  disabledSections.push(section.name)
                  continue
                }
                if (rule?.mode === 'replace') {
                  ruled.push({ ...section, text: rule.text, overridden: true })
                  continue
                }
                ruled.push({ ...section, overridden: false })
              }
              sections = ruled
              const facts = sessionId
                ? sessionFacts.get(sessionId) ?? { sessionId, cwd: '' }
                : { sessionId: '', cwd: '' }
              const injected = resolveItems(facts).map((item) => ({
                name: sectionName(item.id, item.source),
                text: item.text,
                source: item.source,
                injection: item.injection,
              }))
              send(200, {
                ok: true,
                deprecated: true,
                deprecation:
                  '?view=system 已废弃：assemble({}) 不携带 scope，不会派发给 agent 作用域的 waterfall 监听器，'
                  + '因此看不到 team:policy、tool:* 等 agent 级段落，结果与真实提示词不一致。请改用 ?view=assembled。',
                sessionId,
                scope,
                sections,
                contexts,
                tools,
                overrides,
                injected,
                disabledSections,
              })
              return
            }
            if (view === 'session') {
              const sessionId = url.searchParams.get('sessionId') ?? ''
              const facts = sessionId
                ? sessionFacts.get(sessionId) ?? { sessionId, cwd: '' }
                : { sessionId: '', cwd: '' }
              const items = resolveItems(facts)
              // 这个会话在本进程内拉起的子代理。
              const children = []
              for (const [childId, childFacts] of sessionFacts.entries()) {
                if (childFacts.parentSessionId && childFacts.parentSessionId === sessionId) {
                  children.push({
                    sessionId: childId,
                    cwd: childFacts.cwd || '',
                    items: resolveItems(childFacts).map((item) => ({
                      source: item.source,
                      id: item.id,
                      title: item.title,
                      agentScope: item.agentScope,
                    })),
                  })
                }
              }
              send(200, {
                ok: true,
                sessionId,
                cwd: facts.cwd || '',
                subagent: facts.subagent === true,
                parentSessionId: facts.parentSessionId || '',
                matchedWorkspace: matchWorkspaceKey(facts.cwd),
                items,
                children,
                text: items.map((item) => item.text).join('\n\n'),
              })
              return
            }
            send(200, snapshot())
            return
          }
          if (request.method !== 'POST') {
            send(405, { ok: false, error: 'method not allowed' })
            return
          }
          let raw = ''
          for await (const chunk of request) {
            raw += chunk
            // chunked 编码没有 content-length，必须边读边挡。
            if (raw.length > MAX_BODY_BYTES) {
              send(413, { ok: false, error: 'request body too large' })
              return
            }
          }
          const args = raw ? JSON.parse(raw) : {}
          const result = await toolDefinition.execute(args)
          if (String(result).startsWith('error:')) {
            send(400, { ok: false, error: String(result).slice(6).trim() })
            return
          }
          send(200, { ok: true, message: String(result), ...snapshot() })
        } catch (error) {
          diag(`http-handler-failed ${error?.stack ?? error}`)
          send(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    trackDisposer(storeFile, disposeRoute)
    diag('http-route-registered')
  } catch (error) {
    diag(`http-route-failed ${error?.stack ?? error}`)
  }

  // -------------------------------------------------------------- bootstrap

  diag(`apply-enter v2 tools=${typeof ctx.tools} systemPrompt=${typeof ctx.systemPrompt} webServer=${typeof ctx.webServer}`)

  try {
    // 工具的 disposer 同样要留：热重载后旧工具不摘，宿主里就会出现两份同名工具。
    trackDisposer(storeFile, ctx.tools.register(toolDefinition))
    diag('tool-registered')
  } catch (error) {
    diag(`tool-register-failed ${error?.stack ?? error}`)
  }

  loadStore()
    .then(({ document, ok }) => {
      diag(`initial-load-ok entries=${document.entries.length} temporary=${document.temporary.length}`)
      // 没读到可信文档就不许迁移：这时 state.document 是回落值（全新安装时是空壳），
      // 拿它去同步会把旧 agent 的静态段落按空文档重注册、再冻结一份空基线，
      // 之后文件恢复正常也回不来 —— 磁盘上的规则还在，但没人再读它了。
      // 保留旧的 agent 注册表，等下一次成功的加载再接（watcher 和工具里的加载
      // 成功后都会补一次这步）。
      if (!ok) {
        diag('legacy-adopt-skipped load-failed')
        return
      }
      // 文档就绪之后才收编旧 agent：syncAgentSections 要按新文档算静态层，
      // 在文档还是空壳时同步会把它们的段落注册成一份空的。
      // 实例有效性检查在 adoptLegacyAgents 内部统一做。
      adoptLegacyAgents()
    })
    .catch((error) => diag(`initial-load-failed ${error?.stack ?? error}`))

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId) runningAgents.set(sessionId, new WeakRef(agent))
      syncAgentSections(agent)
      attachAssembleHook(agent)
    } catch (error) {
      diag(`agent-created-failed ${error?.stack ?? error}`)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId) {
        runningAgents.delete(sessionId)
        sessionFacts.delete(sessionId)
      }
      cleanupAgentSections(agent)
      // agent 已经没了，把状态槽一起清掉：它上面挂着的是本次 apply 的闭包，
      // 留在对象上只会延长这一整份实例的寿命。
      if (agent) {
        try {
          delete agent[AGENT_STATE]
        } catch {
          /* agent 可能被冻结，忽略 */
        }
      }
    } catch {
      /* best effort */
    }
  })

  try {
    startWatcher()
    diag('watcher-started')
  } catch (error) {
    diag(`watcher-failed ${error?.stack ?? error}`)
  }

  // 最后才把这份 store 登记给 globalThis。上面任何一步抛错时，registry 仍然指向上
  // 一个实例的文档 —— 那份虽然旧，但至少完整。如果早早就换成这次刚建的空壳，一次
  // 半途失败的 apply 会让所有还挂着的旧 hook 突然读到空文档，规则全部失效。
  const live = registry(storeFile)
  live.state = state
  live.lastDocument = state

  diag('apply-ready v2')
}

/**
 * 测试入口。`commitTemp` 的重试分支在真实文件系统上几乎撞不到（要刚好有另一个
 * 句柄占着目标文件），只能靠注入假的 rename 来覆盖。只暴露这一个函数，不导出
 * 任何运行时状态。
 */
export const __test = { commitTemp }