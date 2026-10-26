/**
 * 针对 codex 审查（2026-10-26）指出的几处修复的回归测试。
 *
 * 每个用例都对应一个「旧代码会挂、新代码才过」的具体路径，写测试前先在旧版
 * 实现上确认过它确实是红的 —— 否则只是给已经正确的代码再加一道装饰。
 */
import { mkdirSync, rmSync } from 'node:fs'
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

  // 重载成 B
  await harness.callTool({ action: 'reload' })

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
  let oldHookDisposed = false
  // 模拟旧版本留下的状态：cleanups 里混着 section 和 hook 的 disposer。
  agent.agent[AGENT_STATE] = {
    cleanups: [() => { oldHookDisposed = true }],
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

  await harness.callTool({ action: 'library.add', id: 'hot', text: '热点条目' })
  await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: true })
  await harness.callTool({ action: 'apply.toggle', id: 'hot', scope: 'workspace', workspacePath: 'D:/work', enabled: true })
  await harness.callTool({ action: 'reload' })

  const names = (await agent.assemble(fixture())).sections.map((s) => s.name)
  assert.ok(
    names.includes('prompt-manager:hot'),
    `重载后新增的工作区条目应当出现在旧 agent 的装配里，实际：${names.join(',')}`,
  )
}))