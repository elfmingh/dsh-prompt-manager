import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fixture } from './harness.mjs'

test('空存储：默认文档与路径', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const path = await h.callTool({ action: 'path' })
  assert.match(path, /prompt-manager\.json/)
  assert.match(path, /0 个档案条目/)

  const list = await h.callTool({ action: 'list' })
  assert.match(list, /0 个档案条目/)
})

test('library.add 落盘成 v2 文档', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', title: 'A', text: 'hello world' })

  const store = h.readStore()
  assert.equal(store.version, 2)
  assert.equal(store.entries.length, 1)
  assert.equal(store.entries[0].id, 'a')
  assert.equal(store.entries[0].text, 'hello world')
  assert.deepEqual(store.overrides, {
    enabled: false,
    sections: {},
    contexts: {},
    sessionSections: {},
    sessionContexts: {},
    saved: [],
  })
})

test('library.update 与 library.remove', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'first' })
  await h.callTool({ action: 'library.update', id: 'a', text: 'second' })
  assert.equal(h.readStore().entries[0].text, 'second')

  await h.callTool({ action: 'library.remove', id: 'a' })
  assert.equal(h.readStore().entries.length, 0)
})

test('apply.toggle 切换全局启用', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'x' })
  await h.callTool({ action: 'apply.toggle', id: 'a', enabled: true })
  assert.deepEqual(h.readStore().applications.global.enabled, ['a'])

  await h.callTool({ action: 'apply.toggle', id: 'a', enabled: false })
  assert.deepEqual(h.readStore().applications.global.enabled, [])
})

test('静态注册：新建会话在创建时就拿到全局启用条目', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', title: 'A', text: 'global text' })
  await h.callTool({ action: 'apply.toggle', id: 'a', enabled: true })

  const agent = h.createAgent('session-a')
  assert.equal(agent.staticSections.length, 1)
  assert.equal(agent.staticSections[0].name, 'prompt-manager:a')
  assert.equal(agent.staticSections[0].text, 'global text')
})

test('工作区条目默认静态注册', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'w', text: 'workspace text' })
  await h.callTool({ action: 'apply.toggle', id: 'w', enabled: true, scope: 'workspace', workspacePath: 'C:\\Work\\Demo' })
  await h.callTool({ action: 'apply.default', id: 'w', workspacePath: 'C:\\Work\\Demo', isDefault: true })

  const store = h.readStore()
  // 工作区键归一化：小写 + 正斜杠。
  assert.ok(store.applications.workspaces['c:/work/demo'])
  assert.deepEqual(store.applications.workspaces['c:/work/demo'].default, ['w'])

  const agent = h.createAgent('session-w', 'C:\\Work\\Demo')
  assert.equal(agent.staticSections.length, 1)
  assert.equal(agent.staticSections[0].text, 'workspace text')
})

test('temp.add 在每次装配时后注入', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const agent = h.createAgent('session-a')
  await h.callTool({ action: 'temp.add', sessionId: 'session-a', title: 'T', text: 'temp text' })

  const result = agent.assemble(fixture())
  const injected = result.sections.find((section) => String(section.name).includes('temporary'))
  assert.ok(injected, 'temporary section should be injected')
  assert.equal(injected.text, 'temp text')

  // 后注入只影响目标会话。
  const other = h.createAgent('session-b')
  const otherResult = other.assemble(fixture())
  assert.equal(otherResult.sections.some((section) => String(section.name).includes('temporary')), false)
})

test('temp.remove 移除后不再注入', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const agent = h.createAgent('session-a')
  const added = await h.callTool({ action: 'temp.add', sessionId: 'session-a', text: 'temp text' })
  const id = h.readStore().temporary[0].id
  assert.ok(added)

  let result = agent.assemble(fixture())
  assert.ok(result.sections.some((section) => String(section.name).includes('temporary')))

  await h.callTool({ action: 'temp.remove', id, sessionId: 'session-a' })
  result = agent.assemble(fixture())
  assert.equal(result.sections.some((section) => String(section.name).includes('temporary')), false)
})

test('未命中任何规则时装配结果原样返回', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const agent = h.createAgent('session-a')
  const input = fixture()
  const result = agent.assemble(input)
  assert.equal(result.sections.length, 3)
  assert.equal(result.contexts.length, 2)
  assert.equal(result.tools.length, 2)
})

test('HTTP：snapshot 端点返回文档与摘要', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'library.add', id: 'a', text: 'x' })
  const response = await h.callHttp('/prompt-manager/api')
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.length, 1)
  assert.match(String(response.body.summary), /1 个档案条目/)
})

test('HTTP：assembled 无快照时返回 ok:false 与原因', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const response = await h.callHttp('/prompt-manager/api?view=assembled')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, false)
  assert.match(String(response.body.reason), /装配记录/)
})