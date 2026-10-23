import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHarness, fixture } from './harness.mjs'

const names = (list) => list.map((item) => item.name)

test('disable 内置段落：装配结果里移除', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  assert.equal(h.readStore().overrides.enabled, true, '点开关应顺手打开总开关')
  assert.deepEqual(h.readStore().overrides.sections['harness:identity'], { mode: 'disable' })

  const agent = h.createAgent('session-a')
  const result = agent.assemble(fixture())
  assert.deepEqual(names(result.sections), ['plan:policy', 'team:policy'])
})

test('replace 内置段落：文本被替换、顺序保留', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'plan:policy', mode: 'replace', text: 'REPLACED POLICY' })

  const agent = h.createAgent('session-a')
  const result = agent.assemble(fixture())
  const replaced = result.sections.find((section) => section.name === 'plan:policy')
  assert.equal(replaced.text, 'REPLACED POLICY')
  assert.deepEqual(names(result.sections), names(fixture().sections), '只换文本，不改顺序')
})

test('replace 需要非空 text', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const message = await h.callTool({ action: 'override.set', name: 'plan:policy', mode: 'replace', text: '   ' })
  assert.match(message, /非空/)
  assert.equal(existsSync(h.storeFile), false, '被拒绝的操作不应写盘')
})

test('禁用后装配快照仍保留原始段落（可重新开启）', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  const agent = h.createAgent('session-a')
  const assembled = agent.assemble(fixture())
  assert.equal(names(assembled.sections).includes('harness:identity'), false)

  const response = await h.callHttp('/prompt-manager/api?view=assembled&sessionId=session-a')
  assert.equal(response.body.ok, true)
  assert.equal(names(response.body.sections).includes('harness:identity'), true, '原始快照必须含被禁用的段落')
  assert.deepEqual(response.body.disabledSections, ['harness:identity'])

  // 面板据此把它重新打开：会话页写会话级 enable，推翻全局基线里的 disable。
  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'enable', sessionId: 'session-a' })
  const reopened = agent.assemble(fixture())
  assert.equal(names(reopened.sections).includes('harness:identity'), true)
})

test('主页改动只对新会话生效，运行中的会话不受影响', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const running = h.createAgent('session-running')
  assert.equal(names(running.assemble(fixture()).sections).includes('harness:identity'), true)

  // 中途在主页禁用：运行中的会话不该被动到（否则缓存前缀整段失效）。
  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  const stillThere = running.assemble(fixture())
  assert.equal(names(stillThere.sections).includes('harness:identity'), true, '运行中的会话保持原样')

  // 新建的会话才拿到新规则。
  const fresh = h.createAgent('session-fresh')
  assert.equal(names(fresh.assemble(fixture()).sections).includes('harness:identity'), false)
})

test('会话页的 section 改动立即生效且只影响本会话', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const a = h.createAgent('session-a')
  const b = h.createAgent('session-b')

  await h.callTool({ action: 'override.set', name: 'plan:policy', mode: 'disable', sessionId: 'session-a' })

  assert.equal(names(a.assemble(fixture()).sections).includes('plan:policy'), false, '立即生效')
  assert.equal(names(b.assemble(fixture()).sections).includes('plan:policy'), true, '另一个会话不受影响')

  const store = h.readStore()
  assert.deepEqual(store.overrides.sessionSections, { 'session-a': { 'plan:policy': { mode: 'disable' } } })
  assert.deepEqual(store.overrides.sections, {}, '不应写进全局规则')
})

test('总开关立即生效，不受基线冻结影响', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  const agent = h.createAgent('session-a')
  assert.equal(names(agent.assemble(fixture()).sections).includes('harness:identity'), false)

  // 总开关是全局刹车，必须立刻有效。
  await h.callTool({ action: 'override.toggle', enabled: false })
  const off = agent.assemble(fixture())
  assert.equal(names(off.sections).includes('harness:identity'), true)
})

test('全局 context 禁用影响所有会话', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'disable', layer: 'context' })

  const a = h.createAgent('session-a')
  const b = h.createAgent('session-b')
  assert.equal(names(a.assemble(fixture()).contexts).includes('app:web-surface'), false)
  assert.equal(names(b.assemble(fixture()).contexts).includes('app:web-surface'), false)
})

test('context 按会话隔离：只影响目标会话', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  const a = h.createAgent('session-a')
  const b = h.createAgent('session-b')

  await h.callTool({
    action: 'override.set',
    name: 'app:web-surface',
    mode: 'disable',
    layer: 'context',
    sessionId: 'session-a',
  })

  const store = h.readStore()
  assert.deepEqual(store.overrides.sessionContexts, {
    'session-a': { 'app:web-surface': { mode: 'disable' } },
  })
  assert.deepEqual(store.overrides.contexts, {}, '不应写进全局规则')

  assert.equal(names(a.assemble(fixture()).contexts).includes('app:web-surface'), false)
  assert.equal(names(b.assemble(fixture()).contexts).includes('app:web-surface'), true, '其他会话不受影响')
})

test('会话规则优先于全局规则', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  // 全局规则在会话启动时冻结，所以先写全局规则，再建会话。
  await h.callTool({ action: 'override.set', name: 'sandbox:policy', mode: 'replace', text: 'GLOBAL', layer: 'context' })

  const a = h.createAgent('session-a')
  const b = h.createAgent('session-b')

  await h.callTool({
    action: 'override.set',
    name: 'sandbox:policy',
    mode: 'replace',
    text: 'SESSION',
    layer: 'context',
    sessionId: 'session-a',
  })

  const textOf = (assembly) => assembly.contexts.find((item) => item.name === 'sandbox:policy')?.text
  assert.equal(textOf(a.assemble(fixture())), 'SESSION')
  assert.equal(textOf(b.assemble(fixture())), 'GLOBAL')
})

test('会话级 clear 只清本会话并归档归属', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  // disable 规则没有文本可归档，这里用 replace 规则验证"归档记住所属会话"。
  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'replace', text: 'A', layer: 'context', sessionId: 'session-a' })
  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'replace', text: 'B', layer: 'context', sessionId: 'session-b' })

  const message = await h.callTool({ action: 'override.clear', name: 'app:web-surface', layer: 'context', sessionId: 'session-a' })
  assert.match(message, /session-a/)

  const store = h.readStore()
  assert.deepEqual(Object.keys(store.overrides.sessionContexts), ['session-b'])
  assert.equal(store.overrides.saved.length, 1)
  assert.equal(store.overrides.saved[0].sessionId, 'session-a')
  assert.equal(store.overrides.saved[0].text, 'A')
})

test('clear 归档覆盖文本，restore 可重新装上', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'replace', text: 'REPLACED IDENTITY' })
  await h.callTool({ action: 'override.clear', name: 'harness:identity' })

  let store = h.readStore()
  assert.deepEqual(store.overrides.sections, {})
  assert.equal(store.overrides.saved.length, 1)
  assert.equal(store.overrides.saved[0].text, 'REPLACED IDENTITY')
  assert.equal(store.overrides.saved[0].layer, 'sections')

  const agent = h.createAgent('session-a')
  assert.equal(names(agent.assemble(fixture()).sections).includes('harness:identity'), true, '恢复默认后段落回来了')

  await h.callTool({ action: 'override.restore', id: store.overrides.saved[0].id })
  store = h.readStore()
  assert.deepEqual(store.overrides.sections['harness:identity'], { mode: 'replace', text: 'REPLACED IDENTITY' })
  assert.equal(store.overrides.enabled, true)

  // 全局规则只对新会话生效，所以用新会话验证装回效果。
  const fresh = h.createAgent('session-fresh')
  const restored = fresh.assemble(fixture())
  assert.equal(restored.sections.find((section) => section.name === 'harness:identity').text, 'REPLACED IDENTITY')
})

test('会话级归档 restore 装回原会话', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'sandbox:policy', mode: 'replace', text: 'SESSION TEXT', layer: 'context', sessionId: 'session-a' })
  await h.callTool({ action: 'override.clear', name: 'sandbox:policy', layer: 'context', sessionId: 'session-a' })

  const saved = h.readStore().overrides.saved[0]
  assert.equal(saved.sessionId, 'session-a')

  await h.callTool({ action: 'override.restore', id: saved.id })
  const store = h.readStore()
  assert.deepEqual(store.overrides.contexts, {}, '不应污染全局')
  assert.deepEqual(store.overrides.sessionContexts['session-a']['sandbox:policy'], {
    mode: 'replace',
    text: 'SESSION TEXT',
  })
})

test('forget 删除归档条目', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'replace', text: 'X' })
  await h.callTool({ action: 'override.clear', name: 'harness:identity' })
  const id = h.readStore().overrides.saved[0].id

  await h.callTool({ action: 'override.forget', id })
  assert.equal(h.readStore().overrides.saved.length, 0)
})

test('reset 清空全部规则并归档覆盖文本', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'replace', text: 'A' })
  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'replace', text: 'B', layer: 'context', sessionId: 'session-a' })

  const message = await h.callTool({ action: 'override.reset' })
  assert.match(message, /2 项规则/)

  const store = h.readStore()
  assert.equal(store.overrides.enabled, false)
  assert.deepEqual(store.overrides.sections, {})
  assert.deepEqual(store.overrides.contexts, {})
  assert.deepEqual(store.overrides.sessionContexts, {})
  assert.equal(store.overrides.saved.length, 2)

  const agent = h.createAgent('session-a')
  const result = agent.assemble(fixture())
  assert.deepEqual(names(result.sections), names(fixture().sections))
})

test('reset 带 sessionId 只清那个会话', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'disable', layer: 'context', sessionId: 'session-a' })
  await h.callTool({ action: 'override.set', name: 'sandbox:policy', mode: 'disable', layer: 'context', sessionId: 'session-b' })

  await h.callTool({ action: 'override.reset', sessionId: 'session-a' })

  const store = h.readStore()
  assert.deepEqual(Object.keys(store.overrides.sessionContexts), ['session-b'])
})

test('总开关关闭时规则不生效但保留', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  await h.callTool({ action: 'override.toggle', enabled: false })

  const agent = h.createAgent('session-a')
  const result = agent.assemble(fixture())
  assert.equal(names(result.sections).includes('harness:identity'), true, '总开关关 → 规则不生效')

  const store = h.readStore()
  assert.deepEqual(store.overrides.sections['harness:identity'], { mode: 'disable' }, '规则仍在')
})

test('assembled 端点返回合并后的 contextRules', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'sandbox:policy', mode: 'replace', text: 'GLOBAL', layer: 'context' })
  await h.callTool({ action: 'override.set', name: 'app:web-surface', mode: 'disable', layer: 'context', sessionId: 'session-a' })

  const agent = h.createAgent('session-a')
  agent.assemble(fixture())

  const response = await h.callHttp('/prompt-manager/api?view=assembled&sessionId=session-a')
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.contextRules, {
    'sandbox:policy': { mode: 'replace', text: 'GLOBAL' },
    'app:web-surface': { mode: 'disable' },
  })
  assert.deepEqual(response.body.disabledContexts, ['app:web-surface'])

  // 其他会话只看得到全局规则。
  const other = h.createAgent('session-b')
  other.assemble(fixture())
  const otherResponse = await h.callHttp('/prompt-manager/api?view=assembled&sessionId=session-b')
  assert.deepEqual(Object.keys(otherResponse.body.contextRules), ['sandbox:policy'])
})

test('工具列表只读：override 不影响 tools', async (t) => {
  const h = await createHarness()
  t.after(h.cleanup)

  await h.callTool({ action: 'override.set', name: 'harness:identity', mode: 'disable' })
  const agent = h.createAgent('session-a')
  const result = agent.assemble(fixture())
  assert.deepEqual(names(result.tools), ['shell', 'read'])
})