/**
 * 校验 client.js 里的 diff 算法。
 *
 * client.js 是 IIFE，不能直接 import，所以算法放在显式的 `--- diff:start/end ---` 标记之间，
 * 这里按标记切出来用 new Function 求值。这样测试跑的是真实源码，不是复制品。
 *
 * 跑：node research/check-diff.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')
const start = source.indexOf('// --- diff:start ---')
const end = source.indexOf('// --- diff:end ---')
assert.ok(start >= 0 && end > start, '在 client.js 里找不到 diff 区块标记')

const block = source.slice(start, end)
// renderDiffView 依赖 h/S，只取纯函数部分求值。
const { diffLines, diffInline, diffBlocks } = new Function(
  `${block}\nreturn { diffLines, diffInline, diffBlocks }`,
)()

let passed = 0
const check = (label, run) => {
  run()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

check('文本相同时全部是 same', () => {
  const rows = diffLines('a\nb\nc', 'a\nb\nc')
  assert.deepEqual(rows, [
    { type: 'same', text: 'a' },
    { type: 'same', text: 'b' },
    { type: 'same', text: 'c' },
  ])
})

check('只改中间一行时，只有那一行是 del + add', () => {
  const rows = diffLines('line one\nline two\nline three', 'line one\nline 2\nline three')
  assert.deepEqual(rows.map((row) => row.type), ['same', 'del', 'add', 'same'])
  assert.equal(rows[1].text, 'line two')
  assert.equal(rows[2].text, 'line 2')
})

check('未变的行不会被标成变化（不是全文替换）', () => {
  const before = Array.from({ length: 20 }, (_, index) => `row ${index}`).join('\n')
  const after = before.replace('row 7', 'row 7 changed')
  const rows = diffLines(before, after)
  const changed = rows.filter((row) => row.type !== 'same')
  assert.equal(changed.length, 2, '只应有 1 行删 + 1 行增')
  assert.equal(rows.filter((row) => row.type === 'same').length, 19)
})

check('纯追加行', () => {
  const rows = diffLines('a', 'a\nb')
  assert.deepEqual(rows, [
    { type: 'same', text: 'a' },
    { type: 'add', text: 'b' },
  ])
})

check('纯删除行', () => {
  const rows = diffLines('a\nb', 'a')
  assert.deepEqual(rows, [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
  ])
})

check('行内 diff：剥掉公共前后缀，只留改动中段', () => {
  const parts = diffInline('the quick brown fox', 'the quick red fox')
  assert.deepEqual(parts, [
    { type: 'same', text: 'the quick ' },
    { type: 'del', text: 'brown' },
    { type: 'add', text: 'red' },
    { type: 'same', text: ' fox' },
  ])
})

check('行内 diff：纯追加文字', () => {
  const parts = diffInline('abc', 'abcd')
  assert.deepEqual(parts, [
    { type: 'same', text: 'abc' },
    { type: 'add', text: 'd' },
  ])
})

check('行内 diff：完全不同时不产生空的公共段', () => {
  const parts = diffInline('abc', 'xyz')
  assert.deepEqual(parts, [
    { type: 'del', text: 'abc' },
    { type: 'add', text: 'xyz' },
  ])
  assert.equal(parts.every((part) => part.text.length > 0), true)
})

check('diffBlocks 把连续增删收成一个替换块', () => {
  const blocks = diffBlocks([
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'del', text: 'c' },
    { type: 'add', text: 'B' },
    { type: 'same', text: 'd' },
  ])
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[0], { type: 'same', text: 'a' })
  assert.deepEqual(blocks[1], { type: 'change', del: ['b', 'c'], add: ['B'] })
  assert.deepEqual(blocks[2], { type: 'same', text: 'd' })
})

check('超大规模退化成整段替换，不卡界面', () => {
  const big = Array.from({ length: 700 }, (_, index) => `x${index}`).join('\n')
  const other = Array.from({ length: 700 }, (_, index) => `y${index}`).join('\n')
  const rows = diffLines(big, other)
  assert.equal(rows.filter((row) => row.type === 'del').length, 700)
  assert.equal(rows.filter((row) => row.type === 'add').length, 700)
})

console.log(`\n${passed} 项全部通过`)