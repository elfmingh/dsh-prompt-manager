/**
 * 0.3.0 加固测试。
 *
 * 这一批针对的是「并发与持久化」边界，测试方式也和前几批不同：
 *   - 用 io-barrier 精确控制交错点，不靠 sleep 猜时序
 *   - 每个测试都要能反向验证（撤掉对应修复就转红），否则它证明不了什么
 *   - 断言落在**可观察的行为**上（文件在不在、内容是什么、谁先谁后），
 *     而不是「调用了某个函数」
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from './harness.mjs'

async function withHarness(fn, options) {
  const harness = await createHarness(options)
  try {
    return await fn(harness)
  } finally {
    await harness.cleanup?.()
  }
}

const textsOf = (harness) => harness.readStore().entries.map((entry) => entry.text)

// ---------------------------------------------------------------- 第 1 项
// 加载不是纯读：解析失败可能整份挪走文件，格式升级会整份重写。

test('#22a 运行中读到坏 JSON 只记日志，不挪走文件', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  const broken = '{ 这不是 JSON'
  writeFileSync(harness.storeFile, broken)

  // HTTP GET 走的是 loadStore()：这才是「运行中加载」的真实入口
  // （工具动作走 loadStoreInner，测试它证明不了这条路径）。
  await harness.callHttp('/prompt-manager/api')

  assert.ok(existsSync(harness.storeFile), '正式文件必须还在原地')
  assert.equal(readFileSync(harness.storeFile, 'utf8'), broken, '内容不得被改动')
  const stray = readdirSync(harness.dir).filter((name) => name.includes('.corrupt-'))
  assert.deepEqual(stray, [], '运行中的加载不得产生隔离文件')
}))

test('#22b 启动时读到坏 JSON 才允许隔离，并留下证据', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  const broken = '{ 启动时坏掉'
  writeFileSync(harness.storeFile, broken)

  // reapply 会重走一遍 apply，其中的首次加载是唯一允许隔离的入口。
  await harness.reapply()

  const backups = readdirSync(harness.dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, '启动抢救应当把坏文件挪到一边')
  assert.equal(readFileSync(join(harness.dir, backups[0]), 'utf8'), broken, '备份内容必须与原文一致')
}))

// ---------------------------------------------------------------- 第 1 项
// 加载与写在同一条队列上：一次加载卡在 I/O 里时，写事务必须排队等待。

test('#23 加载持锁期间，写事务排队等待', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'a', text: '原有一条' })

  // 让下一次 readFile 卡住 —— 它属于 GET 触发的 loadStore()，走的是队列。
  const gate = harness.barrier.pause('readFile')
  const loading = harness.callHttp('/prompt-manager/api')
  await gate.arrived()

  // 此时加载占着队列。写事务必须还没开始。
  let wrote = false
  const writing = harness.callTool({ action: 'library.add', id: 'b', text: '并发新增' })
    .then(() => { wrote = true })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(wrote, false, '加载持锁期间写事务不得开始')

  gate.release()
  await loading
  await writing
  assert.equal(wrote, true, '加载完成后写事务应当继续')
  assert.ok(textsOf(harness).includes('并发新增'), '写事务的结果必须落盘')
}))

// ---------------------------------------------------------------- 第 6 项
// 队列必须跨 apply 共用：旧实例的排队任务在新实例接管后不得开始，
// 否则它会拿自己那份旧文档覆盖新实例刚保存的内容。

test('#29 热重载后，旧实例的写事务不再开始', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'c', text: '重载前' })
  const before = readFileSync(harness.storeFile, 'utf8')

  // 抓住旧实例的工具句柄：reapply 之后 harness.callTool 会指向新实例，
  // 那样就测不到「旧实例还想写」这件事了。
  const oldTool = harness.getTool()
  assert.ok(oldTool, '应当能拿到旧实例的工具')

  await harness.reapply()

  let outcome = 'ok'
  try {
    await oldTool.execute({ action: 'library.add', id: 'd', text: '旧实例的写入' })
  } catch (error) {
    outcome = error?.code ?? error?.message ?? 'error'
  }

  assert.equal(outcome, 'STALE_INSTANCE', '旧实例的写事务必须被明确拒绝')
  assert.equal(readFileSync(harness.storeFile, 'utf8'), before, '被拒绝的事务不得改动磁盘')
  assert.ok(!textsOf(harness).includes('旧实例的写入'), '被拒绝的事务不得落盘')
}))

// ---------------------------------------------------------------- 第 7 项
// 读取失败时：只读展示可以继续用旧快照，修改动作必须拒绝提交。

test('#30 加载失败后，修改动作拒绝写盘', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'e', title: '成功的一条', text: '成功的一条' })
  const before = readFileSync(harness.storeFile, 'utf8')

  // 让所有 readFile 都失败：模拟磁盘/权限故障。
  const realRead = harness.barrier.io.readFile
  harness.barrier.io.readFile = async () => {
    const error = new Error('模拟 I/O 失败')
    error.code = 'EIO'
    throw error
  }

  try {
    // 只读动作应当还能用旧快照作答。
    const listed = await harness.callTool({ action: 'list' })
    assert.match(String(listed), /成功的一条/, '加载失败时仍应能展示旧快照')

    // 修改动作必须拒绝。
    let rejected = null
    try {
      await harness.callTool({ action: 'library.add', id: 'f', title: '不该写进去', text: '不该写进去' })
    } catch (error) {
      rejected = error
    }
    assert.ok(rejected, '加载失败后修改动作必须失败')
  } finally {
    harness.barrier.io.readFile = realRead
  }

  assert.equal(readFileSync(harness.storeFile, 'utf8'), before, '磁盘内容不得变化')
  assert.ok(!textsOf(harness).includes('不该写进去'), '失败的修改不得落盘')
}))

// ---------------------------------------------------------------- 第 5 项
// 排队超时。最危险的不是「超时没生效」，而是「调用方收到了失败，任务却照样执行」：
// 用户看到报错，文件却变了，比不设超时更糟。

test('#28a 排队超时后，该事务绝不执行（即便后来轮到它）', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'a', text: '基线', title: '基线' })

  // 第一个事务卡在 rename 上：它已经拿到队列，正在真正写盘。
  const gate = harness.barrier.pause('rename')
  const first = harness.callTool({ action: 'library.add', id: 'b', text: '第一个', title: '第一个' })
  await gate.arrived()

  // 第二个只能排队，等超过 waitMs 后应当失败。
  let timeoutError = null
  await harness.callTool({ action: 'library.add', id: 'c', text: '不该出现', title: '不该出现' })
    .catch((error) => { timeoutError = error })
  assert.equal(timeoutError?.code, 'WRITE_QUEUE_TIMEOUT', '排队超时应当报 WRITE_QUEUE_TIMEOUT')

  // 关键一步：把第一个放行，让队列继续转。超时的那个绝不能借这个机会执行。
  gate.release()
  await first
  // 必须等队列真的排空：「此刻还没执行」和「永远不会执行」是两件不同的事，
  // 只等 first 结束的话，超时任务只是还没轮到，断言会假绿。
  await new Promise((resolve) => setTimeout(resolve, 200))

  const texts = textsOf(harness)
  assert.ok(texts.includes('第一个'), '第一个事务必须完成')
  assert.ok(!texts.includes('不该出现'), '超时的事务绝不能执行')

  // 队列不能被超时毒化。
  await harness.callTool({ action: 'library.add', id: 'd', text: '第三个', title: '第三个' })
  assert.ok(textsOf(harness).includes('第三个'), '超时不得毒化队列')
}, { config: { writeQueueWaitMs: 80 } }))

test('#28b 已经开始的事务不受排队超时约束', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'a', text: '基线', title: '基线' })

  const gate = harness.barrier.pause('rename')
  const slow = harness.callTool({ action: 'library.add', id: 'b', text: '慢但合法', title: '慢但合法' })
  await gate.arrived()

  // 故意等过 waitMs 再放行：它已经开始了，慢不等于该被掐掉。
  await new Promise((resolve) => setTimeout(resolve, 200))
  gate.release()
  await slow

  assert.ok(textsOf(harness).includes('慢但合法'), '已开始的事务必须跑完')
}, { config: { writeQueueWaitMs: 80 } }))

// ---------------------------------------------------------------- 第 2 项
// 文件同步。物理断电的持久性没法用单测证明（杀进程也不等于断电），这里验证的
// 是协议：确实请求了刷新，且刷新失败时什么都没提交。

test('#24a 写临时文件失败时，正式文件与内存状态都不变', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  await harness.callTool({ action: 'library.add', id: 'a', text: '基线', title: '基线' })
  const before = readFileSync(harness.storeFile, 'utf8')

  const realWrite = harness.barrier.io.writeFile
  harness.barrier.io.writeFile = async () => {
    const error = new Error('模拟落盘失败')
    error.code = 'EIO'
    throw error
  }
  let failed = false
  try {
    await harness.callTool({ action: 'library.add', id: 'b', text: '不该出现', title: '不该出现' })
  } catch {
    failed = true
  } finally {
    harness.barrier.io.writeFile = realWrite
  }

  assert.equal(failed, true, '写失败必须报错，不能静默成功')
  assert.equal(readFileSync(harness.storeFile, 'utf8'), before, '正式文件不得变化')
  assert.ok(!textsOf(harness).includes('不该出现'), '不得发布未落盘的新文档')
}))

test('#24b 写临时文件时请求刷新到存储设备', () => withHarness(async (harness) => {
  harness.createAgent('s1')
  const calls = []
  const realWrite = harness.barrier.io.writeFile
  harness.barrier.io.writeFile = async (path, data, options) => {
    calls.push({ path: String(path), options })
    return realWrite(path, data, options)
  }
  try {
    await harness.callTool({ action: 'library.add', id: 'a', text: '内容', title: '内容' })
  } finally {
    harness.barrier.io.writeFile = realWrite
  }

  const tempWrite = calls.find((call) => call.path.endsWith('.tmp'))
  assert.ok(tempWrite, '应当先写临时文件再 rename')
  assert.equal(tempWrite.options?.flush, true, '必须请求把内容刷到存储设备')
}))