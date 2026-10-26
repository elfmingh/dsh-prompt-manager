import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fixture } from './harness.mjs'

/** 子代理的 SessionHeader：区别于主代理的三个标记。 */
const subagentHeader = { origin: 'subagent', parentSession: 'session-main', delegationDepth: 1 }

test('inherit（默认）条目主代理与子代理都注入', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'shared', text: 'both kinds' })
  await h.callTool({ action: 'apply.toggle', id: 'shared', enabled: true })

  const main = h.createAgent('session-main')
  const sub = h.createAgent('session-sub', '', subagentHeader)
  assert.deepEqual(main.staticSections.map((item) => item.name), ['prompt-manager:shared'])
  assert.deepEqual(sub.staticSections.map((item) => item.name), ['prompt-manager:shared'])
})

test('agentScope=main：只注入主代理', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'solo', text: 'main only', agentScope: 'main' })
  await h.callTool({ action: 'apply.toggle', id: 'solo', enabled: true })

  const main = h.createAgent('session-main')
  const sub = h.createAgent('session-sub', '', subagentHeader)
  assert.equal(main.staticSections.length, 1)
  assert.equal(sub.staticSections.length, 0)
})

test('agentScope=subagent：只注入子代理', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'delegate', text: 'subagents only', agentScope: 'subagent' })
  await h.callTool({ action: 'apply.toggle', id: 'delegate', enabled: true })

  const main = h.createAgent('session-main')
  const sub = h.createAgent('session-sub', '', subagentHeader)
  assert.equal(main.staticSections.length, 0)
  assert.equal(sub.staticSections.length, 1)
  assert.equal(sub.staticSections[0].text, 'subagents only')
})

test('三种作用域可以并存，各取所需', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  for (const [id, agentScope] of [['a', 'inherit'], ['b', 'main'], ['c', 'subagent']]) {
    await h.callTool({ action: 'library.add', id, text: `${id} text`, agentScope })
    await h.callTool({ action: 'apply.toggle', id, enabled: true })
  }

  const main = h.createAgent('session-main')
  const sub = h.createAgent('session-sub', '', subagentHeader)
  assert.deepEqual(main.staticSections.map((item) => item.name).sort(), ['prompt-manager:a', 'prompt-manager:b'])
  assert.deepEqual(sub.staticSections.map((item) => item.name).sort(), ['prompt-manager:a', 'prompt-manager:c'])
})

test('临时条目同样按作用域过滤', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'temp.add', text: 'only subagents', agentScope: 'subagent' })

  const main = h.createAgent('session-main')
  const sub = h.createAgent('session-sub', '', subagentHeader)

  const mainResult = (await main.assemble(fixture()))
  assert.equal(mainResult.sections.some((section) => String(section.name).includes('temporary')), false)

  const subResult = (await sub.assemble(fixture()))
  assert.ok(subResult.sections.some((section) => String(section.name).includes('temporary')))
})

test('preview 标明当前是主代理还是子代理', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'x' })
  await h.callTool({ action: 'apply.toggle', id: 'a', enabled: true })
  h.createAgent('session-main')
  h.createAgent('session-sub', '', subagentHeader)

  const mainPreview = await h.callTool({ action: 'preview', sessionId: 'session-main' })
  assert.match(mainPreview, /\[主代理\]/)
  const subPreview = await h.callTool({ action: 'preview', sessionId: 'session-sub' })
  assert.match(subPreview, /\[子代理\]/)
})

test('list 显示作用范围标签', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'm', text: 'x', agentScope: 'main' })
  await h.callTool({ action: 'library.add', id: 's', text: 'y', agentScope: 'subagent' })
  const list = await h.callTool({ action: 'list' })
  assert.match(list, /仅主代理/)
  assert.match(list, /仅子代理/)
})

test('?view=session 返回子代理标记、父会话与子代理列表', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'x' })
  h.createAgent('session-main')
  h.createAgent('session-sub', '', subagentHeader)

  const mainResponse = await h.callHttp('/prompt-manager/api?view=session&sessionId=session-main')
  assert.equal(mainResponse.body.subagent, false)
  assert.equal(mainResponse.body.children.length, 1)
  assert.equal(mainResponse.body.children[0].sessionId, 'session-sub')

  const subResponse = await h.callHttp('/prompt-manager/api?view=session&sessionId=session-sub')
  assert.equal(subResponse.body.subagent, true)
  assert.equal(subResponse.body.parentSessionId, 'session-main')
  assert.equal(subResponse.body.children.length, 0)
})

test('?view=assembled 标明是不是子代理', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const main = h.createAgent('session-main')
  await main.assemble(fixture())
  const sub = h.createAgent('session-sub', '', subagentHeader)
  await sub.assemble(fixture())

  const mainResponse = await h.callHttp('/prompt-manager/api?view=assembled&sessionId=session-main')
  assert.equal(mainResponse.body.subagent, false)
  const subResponse = await h.callHttp('/prompt-manager/api?view=assembled&sessionId=session-sub')
  assert.equal(subResponse.body.subagent, true)
})

test('library.update 可以改作用范围', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'x' })
  assert.equal(h.readStore().entries[0].agentScope, 'inherit')

  await h.callTool({ action: 'library.update', id: 'a', agentScope: 'subagent' })
  assert.equal(h.readStore().entries[0].agentScope, 'subagent')

  // 未显式指定时保留原值。
  await h.callTool({ action: 'library.update', id: 'a', text: 'y' })
  assert.equal(h.readStore().entries[0].agentScope, 'subagent')
})

test('delegationDepth 也能识别子代理', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'm', text: 'main only', agentScope: 'main' })
  await h.callTool({ action: 'apply.toggle', id: 'm', enabled: true })

  const depthOnly = h.createAgent('session-depth', '', { delegationDepth: 2 })
  assert.equal(depthOnly.staticSections.length, 0)
})