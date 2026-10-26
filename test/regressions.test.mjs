/**
 * 针对 codex 审查（2026-10-26）指出的修复的回归测试。
 *
 * 每个用例都用 `harness.reapply()` 造出**真正的新实例**（宿主热重载做的事）。
 * #13 / #14 / #16 / #17 都在旧实现上实测过是红的：撤掉对应的修复再跑，它们就会挂
 * （已逐个验证）。#15 是补充保护 —— 旧版本就记录了 tool disposer，它通过是正常的，
 * 加它是为了防止以后再次退化。
 *
 * 早前这一组用的是 `reload`，而 reload 只重读文件、实例没换，跨实例的 bug 一个都
 * 测不出来，所以那几条当时是假通过的。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fixture } from './harness.mjs'

const AGENT_STATE = Symbol.for('vertixara.dsh-prompt-manager/agent-state')

const withHarness = async (fn) => {
  const harness = await createHarness()
  try {
    return await fn(harness)
  } finally {
    harness.cleanup()
  }
}

/**
 * 读失败 ≠ 文件损坏。
 *
 * 把正式文件换成一个同名目录，readFile 会抛 EISDIR —— 一个纯粹的 I/O 错误。
 * 旧实现把「读」和「解析」放在同一个 catch 里，只按 ENOENT 分流，于是 EISDIR
 * 也走进了隔离分支：把目录 rename 成 .corrupt-*，再把内存文档清空。结果是
 * 一份完好的配置被一次读失败搬走，接下来的任何保存只写得出空文档。
 */
test('#13 读失败不会隔离正常配置，也不会清空内存文档', () => withHarness(async (harness) => {
  await harness.callTool({ action: 'library.add', id: 'keep', text: '内容' })
  assert.equal(harness.readStore().entries.length, 1, '前置条件：确实写进了一条档案')

  // 用目录顶替文件：readFile 得到 EISDIR，不是 ENOENT，也不是解析错误。
  rmSync(harness.storeFile, { force: true })
  mkdirSync(harness.storeFile)

  await harness.callTool({ action: 'reload' })

  const listed = await harness.callTool({ action: 'list' })
  assert.match(listed, /1 个档案条目/, `读失败后应保留最后一份有效文档，实际输出：${listed}`)

  // 那次目录也不是「被解析坏的文件」，不该被 rename 走。
  rmSync(harness.storeFile, { recursive: true, force: true })
}))

/**
 * 卸载后旧 hook 不能回落到更早实例的文档。
 *
 * 时间线：实例 A 建 agent 并禁掉 harness:identity → 重载成 B → B 恢复该段落 →
 * 卸载 B。旧 hook 还挂在 agent 上，它的 currentState 依次看 registry.state（已
 * 置空）和闭包里那份 A 的 state。没有 lastDocument 兜底时它就一路退回到 A，
 * 把 B 已经恢复的段落重新禁掉 —— 插件停了，提示词却还在被改。
 */
test('#14 卸载后旧 hook 不会回落到更早实例的文档', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await agent.assemble(fixture())

  // A：禁用
  await harness.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable', sessionId: 's1' })
  const disabled = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(!disabled.includes('harness:identity'), 'A 实例下该段落应当被禁用')

  // 重载成 B —— 必须是真换实例，否则旧 hook 的闭包还是 A 的，测不出回落。
  await harness.reapply()

  // B：恢复
  await harness.callTool({ action: 'override.reset', name: 'harness:identity', sessionId: 's1' })
  const restored = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(restored.includes('harness:identity'), 'B 实例下该段落应当被恢复')

  // 卸载：此时 registry.state 被清空，只能靠 lastDocument 兜底。
  harness.emit('dispose')

  const afterDispose = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(
    afterDispose.includes('harness:identity'),
    '卸载后应当保持 B 的最后状态，不能倒退回 A 的禁用规则',
  )
}))

/**
 * 卸载要连工具一起释放。
 *
 * 旧的 #11 标题写着「路由与工具都释放」，实际只断言了路由 —— 工具没释放也能过。
 * 这里把两件都断言上，工具那条才是真的。
 */
test('#15 卸载后路由和工具都被释放', () => withHarness(async (harness) => {
  assert.ok(harness.getRoute(), '前置条件：路由已注册')
  assert.ok(harness.getTool(), '前置条件：工具已注册')

  harness.emit('dispose')

  assert.equal(harness.getRoute(), null, '卸载后路由必须摘掉，否则它一直应答且没有鉴权')
  assert.equal(harness.getTool(), null, '卸载后工具也必须摘掉，否则宿主里会留下两份同名工具')
}))

/**
 * 从 0.2.4 热重载上来时，agent 上挂的是旧结构 { cleanups, hookAttached }。
 *
 * 新代码按 sectionDisposers 操作，直接拿旧结构用会在 .splice 上抛 ReferenceError /
 * TypeError。而且 0.2.4 把 hook 的 disposer 也 push 进了 cleanups —— 那正是
 * 「一改文档 hook 就被摘掉」的 bug 本身，所以迁移要把它们全部执行掉再重来，
 * 不能把 cleanups 当 sectionDisposers 继承。
 */
test('#16 0.2.4 的旧 agent state 会被迁移，而不是在同步时抛错', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await agent.assemble(fixture())

  // 0.2.4 把 hook 的 disposer 和 section 的混在同一个 cleanups 里。这里直接取
  // 插件自己挂的那个**真** disposer 放进去 —— 要证明的正是迁移会执行它们，
  // 手工删 listener 只能证明测试自己删得掉。
  const realHookDispose = agent.agent[AGENT_STATE]?.hookDispose
  assert.equal(typeof realHookDispose, 'function', '前置条件：插件此时应当已经挂上 hook')

  let oldHookDisposed = false
  agent.agent[AGENT_STATE] = {
    cleanups: [
      () => { oldHookDisposed = true },
      realHookDispose,
    ],
    hookAttached: true,
  }

  // 任何一次文档变更都会触发 syncAgentSections —— 旧结构下这行会抛。
  // 用 sessionId 走会话级规则：全局规则被 freezeBaseline 冻结，只对新会话生效，
  // 在已存在的 agent 上验证不出 hook 是否还活着。
  await assert.doesNotReject(
    () => harness.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable', sessionId: 's1' }),
    '迁移后同步不应抛错',
  )

  const migrated = agent.agent[AGENT_STATE]
  assert.ok(Array.isArray(migrated.sectionDisposers), '迁移后必须是新结构')
  assert.equal(oldHookDisposed, true, '旧 cleanups 里的 disposer 应被执行掉，而不是被继承')

  // 迁移后 hook 要能重挂，否则这个会话的动态层永久消失。
  assert.equal(migrated.hookAttached, true, '同步后 hook 应当重新挂上')
  // 而且只能有一个：迁移把旧 hook 摘掉、又挂上新的，多挂一份会让规则跑两遍。
  assert.equal(agent.listenerCount('system-prompt/assemble'), 1, '迁移后不应出现重复的 assemble hook')
  const names = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(!names.includes('harness:identity'), '迁移后 hook 仍然有效，规则照常生效')
}))

/**
 * 一次装配只能用一份文档。
 *
 * 早先 assemble hook 把新文档传给了 resolveDynamicItems，但后者内部调
 * matchWorkspaceKey 时又回头读闭包里的 state —— 规则来自新文档、工作区匹配
 * 来自旧文档，热重载后「新加的工作区条目在旧会话里不生效」。
 */
test('#17 热重载后新配置的工作区对旧 agent 也生效', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1', 'D:/work')
  await agent.assemble(fixture())

  // 真换实例：旧 hook 的闭包停在 A 的文档上，这正是要测的东西。
  await harness.reapply()

  await harness.callTool({ action: 'library.add', id: 'hot', text: '热点条目' })
  await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: true })
  await harness.callTool({ action: 'apply.toggle', id: 'hot', scope: 'workspace', workspacePath: 'D:/work', enabled: true })

  const names = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(
    names.includes('prompt-manager:hot'),
    `重载后新增的工作区条目应当出现在旧 agent 的装配里，实际：${names.join(',')}`,
  )
}))

test('#18 升级时从 0.2.4 的 agent Set 收编已有会话', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1', 'D:/work')
  await agent.assemble(fixture())

  // 造出 0.2.4 的升级现场：state 是旧形状、hook 记作已挂，agent 只留在旧版那个
  // 全局 Set 里，而新版的 agents 表是空的（旧版根本没有这张表）。
  agent.agent[AGENT_STATE] = { cleanups: [], hookAttached: true }
  harness.simulateLegacyUpgrade([agent.agent])

  await harness.reapply()

  // 被收编的证据：之后应用到全局的库条目要**重新注册**到这个旧 agent 上。
  // 只看装配结果不够 —— 动态 hook 靠 currentState 本来就能读到新文档，但静态段落
  // 是注册制，agent 不在 runningAgents 里就永远停在旧内容上。
  await harness.callTool({ action: 'library.add', id: 'after', text: '升级后新增' })
  await harness.callTool({ action: 'apply.toggle', id: 'after', scope: 'global', enabled: true })
  const registered = [...(agent.staticSections ?? [])].map((s) => s?.name)
  assert.ok(
    registered.includes('prompt-manager:after'),
    `旧 agent 应当被新实例接管并重新注册静态段落，实际：${registered.join(',') || '(空)'}`,
  )
}))

test('#19 首次读取失败时不迁移，保住旧 agent 注册表', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await agent.assemble(fixture())
  const hooksBefore = agent.listenerCount('system-prompt/assemble')

  agent.agent[AGENT_STATE] = { cleanups: [], hookAttached: true }
  harness.simulateLegacyUpgrade([agent.agent])

  // 让首次加载失败。用坏 JSON 而不是把 storeFile 换成目录：两者都走「没拿到
  // 可信文档」的回落分支，但后者在 Windows 上会让 watcher 和 cleanup 互相卡住，
  // 测试直接挂死（已验证过）。
  writeFileSync(harness.storeFile, '{ 这不是合法 JSON', 'utf8')

  await harness.reapply()

  // 读失败时不许迁移。迁移要按新文档重注册静态段落、还会冻结一份基线；
  // 如果此刻手里只有回落出来的空文档，这些动作会把会话永久压成空配置 ——
  // 之后文件恢复正常也不会自己回来。所以旧注册表要留着，等下次成功加载再接管。
  assert.equal(
    globalThis[Symbol.for('vertixara.dsh-prompt-manager/agents')]?.size,
    1,
    '读取失败时应当保留 0.2.4 的 agent 注册表，留给下一次成功的加载',
  )
  assert.equal(
    agent.listenerCount('system-prompt/assemble'),
    hooksBefore,
    '加载失败时不应摘掉或重挂 hook',
  )
}))

test('#20 旧版 registry 缺少后来新增的字段时自动补齐', () => withHarness(async (harness) => {
  harness.createAgent('s1')

  // 3b6ce18 留下的 entry：存在，但没有 agents / lastDocument。
  harness.simulateLegacyRegistryShape()

  // 热升级。不补齐的话 runningAgents 是 undefined，紧接着的 .set / .entries
  // 会抛 TypeError —— 而 agent/created 的监听有 try/catch，异常被记成日志，
  // 于是「会话建不起来但没人报错」。所以这里直接断言表结构，不靠行为反推。
  await harness.reapply()

  const entry = globalThis[Symbol.for(`vertixara.dsh-prompt-manager/disposers:${harness.storeFile}`)]
  assert.ok(entry, '热重载后 registry 应当仍然存在')
  assert.ok(entry.agents instanceof Map, '缺的 agents 字段应当被补成 Map')
  assert.ok(entry.all instanceof Set, '缺的 all 字段应当被补成 Set')
  assert.ok('lastDocument' in entry, '缺的 lastDocument 字段应当被补上')

  // 补完之后这些路径要能真的走通，而不是靠 catch 吞掉异常。
  const agent = harness.createAgent('s2')
  const result = await agent.assemble(fixture())
  assert.ok(Array.isArray(result.sections), '新实例在补过字段的表上应当正常装配')
}))