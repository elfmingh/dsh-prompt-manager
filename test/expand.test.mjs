/**
 * ClampedText 的行为测试。
 *
 * 纯静态分析证明不了「点了按钮真能看到全文」，所以这里把函数体从 client.js
 * 里抠出来，用假的 h / React 真跑一遍渲染树。
 *
 * 假 React 的 useState 用外部变量存状态，setter 直接写它 —— 每次重新调用组件
 * 函数就能看到「点击后」的渲染结果，等于手写了一遍最小重渲染。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 按花括号配对抠出一个函数声明。模板字符串里的 ${...} 是平衡的，不影响计数。 */
function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `client.js 里应当有 function ${name}(`)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号不配对`)
}

/** 深度优先找第一个指定 tag 的节点。 */
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null
  if (tree.type === type) return tree
  for (const child of tree.children || []) {
    const hit = find(child, type)
    if (hit) return hit
  }
  return null
}

/** 深度优先收集所有指定 tag 的节点。 */
function findAll(tree, type) {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === type) out.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  return out
}

/** 每次 render() 都从头调用组件，状态由外层变量承载，模拟一次重渲染。 */
function harness(body) {
  let open = false
  const React = {
    useState: () => [
      open,
      (next) => {
        open = typeof next === 'function' ? next(open) : next
      },
    ],
  }
  const S = { buttonTiny: { fontSize: '12px' }, text: { margin: 0 } }
  // t() 在这里只用来断言按钮文案，真实翻译由 i18n 测试覆盖。
  const t = (text) => text
  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  const Component = new Function('h', 'React', 'S', 't', `${body}\nreturn ${body.match(/function (\w+)/)[1]}`)(h, React, S, t)
  return { render: (props) => Component(props), find, findAll }
}

const body = extractFunction(source, 'ClampedText')

test('ClampedText：短文本原样显示，不给多余控件', () => {
  const ui = harness(body)
  const tree = ui.render({ text: '短内容', limit: 10, style: {} })
  assert.equal(ui.find(tree, 'p').children[0], '短内容')
  assert.deepEqual(ui.findAll(tree, 'button'), [], '没被截断就不该出现展开按钮')
})

test('ClampedText：刚好等于上限时不截断', () => {
  const ui = harness(body)
  const text = 'a'.repeat(10)
  const tree = ui.render({ text, limit: 10, style: {} })
  assert.equal(ui.find(tree, 'p').children[0], text, '等于上限不算超长，不该切')
  assert.deepEqual(ui.findAll(tree, 'button'), [])
})

test('ClampedText：超长时截断，并给出展开控件', () => {
  const ui = harness(body)
  const text = 'x'.repeat(200)
  const tree = ui.render({ text, limit: 160, style: {} })
  const shown = ui.find(tree, 'p').children[0]
  assert.equal(shown, `${'x'.repeat(160)}…`, '初始应截到 limit 并加省略号')
  const buttons = ui.findAll(tree, 'button')
  assert.equal(buttons.length, 1, '应当恰好有一个展开控件')
  assert.equal(buttons[0].children[0], '展开全文')
  assert.equal(buttons[0].props['aria-expanded'], false)
})

test('ClampedText：点开后显示完整原文，再点收起', () => {
  const ui = harness(body)
  const text = 'x'.repeat(200)

  // 初始（收起）
  ui.render({ text, limit: 160, style: {} })

  // 点「展开全文」
  const collapsed = ui.render({ text, limit: 160, style: {} })
  ui.find(collapsed, 'button').props.onClick()
  const opened = ui.render({ text, limit: 160, style: {} })
  assert.equal(ui.find(opened, 'p').children[0], text, '展开后必须是完整原文，一字不少')
  const openButton = ui.find(opened, 'button')
  assert.equal(openButton.children[0], '收起')
  assert.equal(openButton.props['aria-expanded'], true)

  // 再点「收起」
  openButton.props.onClick()
  const again = ui.render({ text, limit: 160, style: {} })
  assert.equal(ui.find(again, 'p').children[0], `${'x'.repeat(160)}…`)
  assert.equal(ui.find(again, 'button').children[0], '展开全文')
})

test('ClampedText：截断只是显示层，展开内容与原文完全一致', () => {
  const ui = harness(body)
  // 带换行、中文、花括号占位符 —— 都是 pre-wrap 下会真的换行的内容
  const text = `第一行 {name}\n${'长'.repeat(300)}\n最后一行`
  ui.render({ text, limit: 160, style: {} })
  const collapsed = ui.render({ text, limit: 160, style: {} })
  ui.find(collapsed, 'button').props.onClick()
  const opened = ui.render({ text, limit: 160, style: {} })
  assert.equal(ui.find(opened, 'p').children[0], text)
})

test('client.js：四处长正文都走 ClampedText，没有残留的手工 slice', () => {
  // 防回归：以后加新列表别又写回 `${text.slice(0, 160)}…`。
  const manual = source.match(/text\.length > \d+ \?/g) || []
  assert.deepEqual(manual, [], `还有手工截断没换掉：${manual.join(', ')}`)
  const uses = source.match(/h\(ClampedText, \{/g) || []
  assert.equal(uses.length, 4, '四处长正文都应当走 ClampedText')
})
