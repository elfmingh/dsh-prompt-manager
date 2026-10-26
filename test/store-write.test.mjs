import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

const { commitTemp } = __test

/** 模拟 Windows 上被杀软/索引器占住目标文件时 rename 抛的错。 */
const locked = () => Object.assign(new Error('resource busy or locked'), { code: 'EPERM' })
const other = (code) => Object.assign(new Error(`mock ${code}`), { code })

test('rename 一次成功：不发生重试', async () => {
  const calls = []
  await commitTemp('tmp', 'target', async (...args) => {
    calls.push(args)
  })
  assert.deepEqual(calls, [['tmp', 'target']])
})

test('前两次被占用、第三次成功', async () => {
  let calls = 0
  await commitTemp('tmp', 'target', async () => {
    calls += 1
    if (calls < 3) throw locked()
  })
  assert.equal(calls, 3, '应当在第三次停下来，不多也不少')
})

test('非瞬时错误立即抛出，不做重试', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      commitTemp('tmp', 'target', async () => {
        calls += 1
        throw other('ENOENT')
      }),
    /mock ENOENT/,
  )
  assert.equal(calls, 1, 'ENOENT 不属于瞬时占用，重试没有意义')
})

test('EBUSY 和 EACCES 同样按瞬时错误处理', async () => {
  for (const code of ['EBUSY', 'EACCES']) {
    let calls = 0
    await assert.rejects(
      () =>
        commitTemp('tmp', 'target', async () => {
          calls += 1
          throw other(code)
        }),
      new RegExp(`mock ${code}`),
    )
    assert.equal(calls, 4, `${code} 应当走满四次重试`)
  }
})

test('四次都被占用：抛出最后一次的错误，不退化直接写', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      commitTemp('tmp', 'target', async () => {
        calls += 1
        throw locked()
      }),
    /resource busy or locked/,
  )
  assert.equal(calls, 4, '重试次数上限是四，不是无限')
})

test('重试间隔是 25/50/75 毫秒，最后一次失败不再空等', async () => {
  const started = Date.now()
  let calls = 0
  await assert.rejects(() =>
    commitTemp('tmp', 'target', async () => {
      calls += 1
      throw locked()
    }),
  )
  const elapsed = Date.now() - started
  assert.equal(calls, 4)
  // 25 + 50 + 75 = 150ms。旧实现会在最后一次失败后多睡 100ms，跑到 250ms 以上。
  // 下限压住「至少睡满」，上限压住「多睡那 100ms」。
  assert.ok(elapsed >= 140, `总耗时 ${elapsed}ms，比预期短，间隔算式可能被改坏了`)
  assert.ok(elapsed < 240, `总耗时 ${elapsed}ms，最后一次失败后仍在空等`)
})