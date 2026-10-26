/**
 * 审计（docs/audit-2026-10-23.md）修复的回归测试。
 *
 * 每个用例对应审计条目编号。这些路径此前没有覆盖，所以问题一直存在：
 * 并发写入、HTTP 鉴权、带 sessionId 的子代理继承、后注入开关、动态 replace、
 * 双花括号渲染、reset 后重新启用、路由释放。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHarness, fixture } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SAME_ORIGIN = {
  origin: 'http://127.0.0.1:62654',
  host: '127.0.0.1:62654',
  'content-type': 'application/json',
}

async function withHarness(fn) {
  const harness = await createHarness()
  try {
    return await fn(harness)
  } finally {
    harness.cleanup()
  }
}

const addEntry = (harness, id, text, extra = {}) =>
  harness.callTool({ action: 'library.add', id, title: id, text, ...extra })

// ---------------------------------------------------------------- 1 鉴权

test('#1 跨站 POST 被拒绝，且不留下任何数据', () => withHarness(async (harness) => {
  const response = await harness.callHttp('/prompt-manager/api', {
    method: 'POST',
    headers: { origin: 'https://untrusted.example', host: '127.0.0.1:62654', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'library.add', id: 'evil', text: 'pwned' }),
  })
  assert.equal(response.status, 403)
  assert.equal(harness.readStore().entries.length, 0)
}))

test('#1 text/plain 的「简单请求」被拒绝（那是绕过预检的路子）', () => withHarness(async (harness) => {
  const response = await harness.callHttp('/prompt-manager/api', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ action: 'library.add', id: 'evil', text: 'pwned' }),
  })
  assert.equal(response.status, 415)
  assert.equal(harness.readStore().entries.length, 0)
}))

test('#1 同源 JSON POST 正常放行', () => withHarness(async (harness) => {
  const response = await harness.callHttp('/prompt-manager/api', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ action: 'library.add', id: 'ok', title: 'ok', text: 'fine' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(harness.readStore().entries.length, 1)
}))

test('#1 跨站 GET 同样被拒绝', () => withHarness(async (harness) => {
  const response = await harness.callHttp('/prompt-manager/api', {
    headers: { origin: 'https://untrusted.example', host: '127.0.0.1:62654' },
  })
  assert.equal(response.status, 403)
}))

// ---------------------------------------------------------- 2 并发写入

test('#2 并发写入全部落盘，不再互相覆盖', () => withHarness(async (harness) => {
  await Promise.all([
    addEntry(harness, 'one', 'first'),
    addEntry(harness, 'two', 'second'),
    addEntry(harness, 'three', 'third'),
  ])
  const ids = harness.readStore().entries.map((entry) => entry.id).sort()
  assert.deepEqual(ids, ['one', 'three', 'two'])
}))

test('#2 并发改不同工作区都不丢失', () => withHarness(async (harness) => {
  await addEntry(harness, 'e1', 'x')
  await addEntry(harness, 'e2', 'y')
  await Promise.all([
    harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/w1', enabled: true }),
    harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/w2', enabled: true }),
  ])
  const workspaces = harness.readStore().applications.workspaces
  assert.equal(workspaces['d:/w1']?.hotReload, true)
  assert.equal(workspaces['d:/w2']?.hotReload, true)
}))

// -------------------------------------------------------- 3 后注入开关

test('#3 apply.hotReload 开关真的能改状态（此前永远返回未知 action）', () => withHarness(async (harness) => {
  const on = await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: true })
  assert.match(String(on), /已开启/)
  assert.equal(harness.readStore().applications.workspaces['d:/work'].hotReload, true)

  const off = await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: false })
  assert.match(String(off), /已关闭/)
  assert.equal(harness.readStore().applications.workspaces['d:/work']?.hotReload ?? false, false)
}))

test('#3 action 大小写混写也能识别', () => withHarness(async (harness) => {
  const message = await harness.callTool({ action: 'Apply.HotReload', workspacePath: 'D:/work', enabled: true })
  assert.match(String(message), /已开启/)
}))

// ------------------------------------------------------------ 7 hotReload

test('#7 删除档案不会顺手关掉其他工作区的后注入', () => withHarness(async (harness) => {
  await addEntry(harness, 'a', 'A')
  await addEntry(harness, 'b', 'B')
  await harness.callTool({ action: 'apply.toggle', id: 'b', enabled: true, scope: 'workspace', workspacePath: 'D:/work' })
  await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: true })

  await harness.callTool({ action: 'library.remove', id: 'a' })

  const workspace = harness.readStore().applications.workspaces['d:/work']
  assert.equal(workspace.hotReload, true)
  assert.deepEqual(workspace.enabled, ['b'])
}))

// --------------------------------------------------------- 4 父链继承

test('#4 主会话的「仅子代理」临时条目能到达子代理', () => withHarness(async (harness) => {
  harness.createAgent('main')
  await harness.callTool({
    action: 'temp.add',
    id: 'temp-child',
    text: 'for children only',
    sessionId: 'main',
    agentScope: 'subagent',
  })

  const child = harness.createAgent('child', '', { parentSession: 'main', origin: 'subagent' })
  const injected = child.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:temp-child')
  assert.ok(injected, '子代理应当收到父会话写的临时条目')
  assert.equal(injected.text, 'for children only')
}))

test('#4 多级子代理同样继承，无关会话看不到', () => withHarness(async (harness) => {
  harness.createAgent('main')
  await harness.callTool({ action: 'temp.add', id: 'temp-line', text: 'lineage', sessionId: 'main' })
  harness.createAgent('child', '', { parentSession: 'main', origin: 'subagent' })
  const grandchild = harness.createAgent('grandchild', '', { parentSession: 'child', origin: 'subagent' })

  const seen = grandchild.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:temp-line')
  assert.ok(seen, '孙代理也应当拿到')

  const stranger = harness.createAgent('stranger')
  const notSeen = stranger.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:temp-line')
  assert.equal(notSeen, undefined, '无关会话不应看到')
}))

// ------------------------------------------------------- 5 动态 replace

test('#5 临时条目的 replace 规则真的生效', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await harness.callTool({ action: 'temp.add', id: 'dyn', text: 'original dynamic', sessionId: 's1' })
  await harness.callTool({
    action: 'override.set',
    name: 'prompt-manager:temporary:dyn',
    mode: 'replace',
    text: 'REPLACEMENT',
    sessionId: 's1',
  })

  const section = agent.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:dyn')
  assert.ok(section)
  assert.equal(section.text, 'REPLACEMENT')
}))

test('#5 后注入工作区条目的 replace 同样生效', () => withHarness(async (harness) => {
  await addEntry(harness, 'hot', 'original hot')
  await harness.callTool({ action: 'apply.toggle', id: 'hot', enabled: true, scope: 'workspace', workspacePath: 'D:/work' })
  await harness.callTool({ action: 'apply.hotReload', workspacePath: 'D:/work', enabled: true })
  const agent = harness.createAgent('s1', 'D:/work')
  await harness.callTool({ action: 'override.set', name: 'prompt-manager:hot', mode: 'replace', text: 'HOT REPLACED', sessionId: 's1' })

  const section = agent.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:hot')
  assert.ok(section)
  assert.equal(section.text, 'HOT REPLACED')
}))

// ------------------------------------------------------- 6 字面量注入

test('#6 含双花括号的档案按字面量注入', () => withHarness(async (harness) => {
  await addEntry(harness, 'tpl', 'Keep the placeholder {{user_input}} literal.')
  await harness.callTool({ action: 'apply.toggle', id: 'tpl', enabled: true })
  const agent = harness.createAgent('s1')

  const spec = agent.staticSections.find((s) => s.name === 'prompt-manager:tpl')
  assert.ok(spec)
  assert.equal(spec.interpolate, false, '静态注册必须声明不插值')
  assert.equal(spec.text, 'Keep the placeholder {{user_input}} literal.')
}))

test('#6 动态条目与覆盖文本同样不触发插值', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await harness.callTool({ action: 'temp.add', id: 'dyn', text: 'temp {{user_input}} literal', sessionId: 's1' })

  const dynamic = agent.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:dyn')
  assert.equal(dynamic.interpolate, false)

  await harness.callTool({ action: 'override.set', name: 'harness:identity', mode: 'replace', text: 'over {{x}} text', sessionId: 's1' })
  const replaced = agent.assemble(fixture()).sections.find((s) => s.name === 'harness:identity')
  assert.equal(replaced.text, 'over {{x}} text')
  assert.equal(replaced.interpolate, false)
}))

// --------------------------------------------------- 8 reset 后重新启用

test('#8 全部恢复后重新启用，不会复活已清除的旧规则', () => withHarness(async (harness) => {
  await harness.callTool({ action: 'override.set', name: 'harness:identity', mode: 'replace', text: 'GLOBAL' })
  const agent = harness.createAgent('s1')
  // 会话建立时冻结了 GLOBAL 基线
  assert.equal(agent.assemble(fixture()).sections.find((s) => s.name === 'harness:identity').text, 'GLOBAL')

  await harness.callTool({ action: 'override.reset' })
  assert.equal(agent.assemble(fixture()).sections.find((s) => s.name === 'harness:identity').text, 'base identity')

  await harness.callTool({ action: 'override.toggle', enabled: true })
  assert.equal(
    agent.assemble(fixture()).sections.find((s) => s.name === 'harness:identity').text,
    'base identity',
    '重新打开总开关不应把冻结的旧基线带回来',
  )
}))

// ------------------------------------------------------- 10 生命周期

test('#10 卸载时释放路由，不残留旧 handler', () => withHarness(async (harness) => {
  assert.ok(harness.getRoute(), '注册后应有路由')
  harness.emit('dispose')
  assert.equal(harness.getRoute(), null, 'dispose 后路由应被摘掉')
}))

// ------------------------------------------- 11 hook 生命周期

test('#11 文档变更不会摘掉 assemble hook，动态层仍在', () => withHarness(async (harness) => {
  const agent = harness.createAgent('s1')
  await harness.callTool({ action: 'temp.add', id: 'keep', text: 'DYN KEEP', sessionId: 's1' })
  const before = agent.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:keep')
  assert.ok(before, '前置：临时条目应当通过 assemble hook 注入')

  // 下面这一步会走 refreshRunningAgents → syncAgentSections。
  // 早先 section 的 disposer 和 hook 的 disposer 共用一个 cleanups 数组，这里会把
  // hook 一起 splice 掉；而 hookAttached 仍是 true，之后不会再挂 —— 该会话的动态层
  // 就此永久消失（面板还照旧显示旧快照，看着像生效了）。
  await harness.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })

  const after = agent.assemble(fixture()).sections.find((s) => s.name === 'prompt-manager:temporary:keep')
  assert.ok(after, '同步静态 section 时不能连带摘掉 assemble hook')
}))

test('#11 卸载后路由与工具都被释放', () => withHarness(async (harness) => {
  assert.ok(harness.getRoute(), '注册后应有路由')
  assert.ok(harness.getTool(), '注册后应有工具')
  harness.emit('dispose')
  assert.equal(harness.getRoute(), null, '卸载后路由必须摘掉，否则它一直应答且没有鉴权')
}))

// ------------------------------------------------ 9 快照脚本（静态检查）

test('#9 快照脚本走 assembled 端点并写入被忽略的目录', () => {
  const script = readFileSync(join(here, '..', 'scripts', 'snapshot-sections.mjs'), 'utf8')
  // 注释里会提到「view=system 已废弃」，所以只检查真正构造请求的那一行。
  const urlLine = script.split('\n').find((line) => line.trim().startsWith('const url ='))
  assert.ok(urlLine, '脚本里应当有一处构造请求 URL')
  assert.match(urlLine, /view=assembled/)
  assert.doesNotMatch(urlLine, /view=system/)
  assert.match(script, /'snapshots'/)
  assert.match(script, /data\.ok/, '必须处理 ok:false，不能把失败当成空快照写盘')

  const gitignore = readFileSync(join(here, '..', '.gitignore'), 'utf8')
  assert.match(gitignore, /docs\/snapshots/)
})