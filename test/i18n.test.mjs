/**
 * i18n 一致性测试。
 *
 * client.js 跑在宿主的模块加载器里（window.__ModuleLoader__.load），没有可直接
 * import 的导出面，所以这里做**静态分析**：从源码里把 t() 用到的 key 和 EN 表的
 * 键都抠出来对比。
 *
 * 这不是偷懒 —— 恰恰是这类改动最容易坏的地方都在静态层面：
 *   - 新加了一处 t('…') 却忘了写英文 → 英文用户看到中文
 *   - 改了中文原文却没改 EN 的键 → 译文失配，静默回退成中文
 *   - 占位符两边对不上 → 界面上显示 {n} 这种字面量
 * 这三条都能用文本比对测出来，不需要真的渲染 React 组件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = new URL('../client.js', import.meta.url)
const source = readFileSync(CLIENT, 'utf8')

const CJK = /[\u4e00-\u9fff]/
const PLACEHOLDER = /\{[a-zA-Z_]+\}/g

/** 抠出代码里 t('…') 的中文 key（去重）。 */
function collectKeys(text) {
  const keys = new Set()
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (CJK.test(m[2])) keys.add(m[2])
  }
  return keys
}

/** 抠出 `const EN = { … }` 里的键值对。 */
function collectTable(text) {
  const start = text.indexOf('const EN = {')
  assert.notEqual(start, -1, 'client.js 里应当有 const EN = { … } 翻译表')

  // 从 { 开始配对括号，避免被字符串里的花括号干扰
  let depth = 0
  let end = -1
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.notEqual(end, -1, '翻译表的大括号应当闭合')

  const body = text.slice(text.indexOf('{', start) + 1, end)
  const table = new Map()
  const re = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g
  let m
  while ((m = re.exec(body)) !== null) {
    // JSON.stringify 生成的键值，反转义
    const key = JSON.parse(`"${m[1]}"`)
    const value = JSON.parse(`"${m[2]}"`)
    table.set(key, value)
  }
  return table
}

const keys = collectKeys(source)
const table = collectTable(source)

test('i18n: 每条 t() 文案都有英文译文', () => {
  assert.ok(keys.size > 100, `应当收集到上百条文案，实际 ${keys.size}`)
  const missing = [...keys].filter((k) => !table.has(k))
  assert.deepEqual(missing, [], `以下文案缺英文译文:\n${missing.join('\n')}`)
})

test('i18n: 翻译表里没有已经用不到的条目', () => {
  const unused = [...table.keys()].filter((k) => !keys.has(k))
  assert.deepEqual(unused, [], `以下译文对应的原文已经不在代码里:\n${unused.join('\n')}`)
})

test('i18n: 译文里不残留中文', () => {
  const dirty = []
  for (const [key, value] of table) {
    if (CJK.test(value)) dirty.push(`${key} => ${value}`)
  }
  assert.deepEqual(dirty, [], `以下译文还含中文:\n${dirty.join('\n')}`)
})

test('i18n: 占位符两边必须一致', () => {
  const problems = []
  for (const [key, value] of table) {
    const a = new Set(key.match(PLACEHOLDER) ?? [])
    const b = new Set(value.match(PLACEHOLDER) ?? [])
    const onlyKey = [...a].filter((x) => !b.has(x))
    const onlyValue = [...b].filter((x) => !a.has(x))
    if (onlyKey.length || onlyValue.length) {
      problems.push(`${key} => ${value}  原文独有 [${onlyKey}] 译文独有 [${onlyValue}]`)
    }
  }
  assert.deepEqual(problems, [], `占位符不匹配（界面会显示成字面量 {x}）:\n${problems.join('\n')}`)
})

test('i18n: 回退逻辑不会把 key 本身显示出来', () => {
  // t() 的实现必须是 EN[text] ?? text —— 即"缺译文回退中文原文"，
  // 而不是 EN[text] ?? text 的某个变体去拼一个假 key。
  const snippet = source.slice(source.indexOf('function t('), source.indexOf('function t(') + 400)
  assert.match(snippet, /EN\[text\]\s*\?\?\s*text/, 't() 必须在缺译文时回退到中文原文')
})

test('i18n: 语言来源按可信度排序，且同步可读', () => {
  // 这条不是风格偏好，是行为契约。
  //
  // 优先级必须是：宿主 locale 服务 → <html lang> → navigator.language。
  //
  // - `ctx.locale.getLocale().active` 是权威值，同步可读，而且它的快照在通知
  //   订阅者之前就已经更新 —— 宿主侧边栏在语言一变就重算 label()，那时拿到的
  //   已经是新语言。
  // - `<html lang="…">` 同样是同步可读的退路。
  // - `navigator.language` 是**系统/浏览器**语言，跟 DSH 的设置无关。系统中文 +
  //   DSH 英文时，用它会把界面判成中文。只能垫底。
  const start = source.indexOf('function detectLocale(')
  assert.notEqual(start, -1, 'client.js 里应当有 detectLocale()')

  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end + 6)
  const hostAt = body.indexOf('getLocale')
  const langAt = body.indexOf('documentElement')
  const navAt = body.indexOf('navigator.language')

  assert.notEqual(hostAt, -1, 'detectLocale() 必须先问宿主 locale 服务')
  assert.notEqual(langAt, -1, 'detectLocale() 必须读 document.documentElement.lang')
  assert.notEqual(navAt, -1, 'detectLocale() 应当保留 navigator.language 兜底')
  assert.ok(hostAt < langAt, '宿主 locale 服务必须排在 <html lang> 之前')
  assert.ok(langAt < navAt, 'document.documentElement.lang 必须在 navigator.language 之前判断')
})

test('i18n: t() 现场读语言，不许读缓存', () => {
  // 这是「标题慢一拍」那个 bug 的防回归。
  //
  // 早先的写法是 t() 读 localeStore.value（一份缓存），靠订阅回调去刷新缓存。
  // 但宿主侧边栏自己有一个订阅回调，它注册得更早、跑得更早，于是它重算 label()
  // 时缓存还是上一轮的语言，算出来的标题和上一轮一样，被它的去重逻辑挡掉 ——
  // 标题就永远比界面慢一拍。切几次就看起来「又反了」。
  //
  // 现场读没有任何时序问题，所以这条必须锁住。
  const start = source.indexOf('function t(')
  assert.notEqual(start, -1, 'client.js 里应当有 t()')
  const body = source.slice(start, source.indexOf('\n    }', start) + 6)

  assert.match(body, /detectLocale\(\)/, 't() 必须现场调用 detectLocale()')
  assert.doesNotMatch(body, /localeStore\.value/, 't() 不许读 localeStore.value 这个缓存')
})

test('i18n: 插件声明 locale 依赖，别在它到位之前注册槽位', () => {
  // 不声明的话 apply 可能先于 locale 就位，label() 首次被取用时就拿不到权威值。
  assert.match(source, /inject:\s*\[\s*'slots'\s*,\s*'locale'\s*\]/, "inject 必须同时声明 'slots' 和 'locale'")
})

test('i18n: localeStore 初值同步取自 detectLocale，不等接口', () => {
  // 初值若来自异步结果，标题类文案（宿主在挂载前就取）必然错。
  assert.match(
    source,
    /const localeStore = \{\s*value: detectLocale\(\)/,
    'localeStore 的初值必须同步取自 detectLocale()',
  )
})
