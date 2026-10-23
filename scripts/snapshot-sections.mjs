// 抓取一次真实系统提示词装配快照，落盘成 JSON + Markdown。
//
// 用法：
//   node scripts/snapshot-sections.mjs <baseUrl> [sessionId]
//   node scripts/snapshot-sections.mjs http://127.0.0.1:62654
//   node scripts/snapshot-sections.mjs http://127.0.0.1:62654 session-xxxx
//
// 数据来自 `?view=assembled`：waterfall 每轮装配时记录的真实结果，包含 agent
// 作用域的段落、运行时 context 与全部工具。`?view=system` 已废弃 —— 它不传
// scope，拿不到 agent 作用域的内容，返回的提示词和实际使用的不是一回事。
//
// 输出到 docs/snapshots/（已在 .gitignore 中：里面有本机路径和会话内容）。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const base = (process.argv[2] || 'http://127.0.0.1:62654').replace(/\/+$/, '')
const sessionId = process.argv[3] || ''

const url = `${base}/prompt-manager/api?view=assembled${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`

let data
try {
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`HTTP ${response.status} from ${url}`)
    process.exit(1)
  }
  data = await response.json()
} catch (error) {
  console.error(`请求失败：${error?.message ?? error}`)
  process.exit(1)
}

// assembled 在没有装配记录时返回 ok:false 加原因，不能当成空快照写盘。
if (!data.ok) {
  console.error(`没有可用快照：${data.reason ?? '(未知原因)'}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(root, 'docs', 'snapshots')
await mkdir(outDir, { recursive: true })

const jsonPath = join(outDir, `sections-${stamp}.json`)
await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const firstLine = (text) => {
  const line = String(text ?? '').split('\n').find((item) => item.trim()) || ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

const table = (items, describe, extra) => [
  `| # | name | 字数 | 摘要 |${extra ? ` ${extra.header} |` : ''}`,
  `|---|---|---|${extra ? '---|' : ''}`,
  ...(items ?? []).map((item, index) => {
    const text = describe(item)
    return `| ${index + 1} | \`${cell(item.name)}\` | ${text.length} | ${cell(firstLine(text))} |${extra ? ` ${cell(extra.value(item))} |` : ''}`
  }),
]

const disabledSections = new Set(data.disabledSections ?? [])
const disabledContexts = new Set(data.disabledContexts ?? [])

const lines = [
  '# 系统提示词装配快照',
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 请求：${url}`,
  `- session：${data.sessionId || '(未指定)'}${data.subagent ? '（子代理）' : ''}`,
  `- 装配轮次：${data.revision ?? '?'}`,
  `- 改写规则：sections ${Object.keys(data.sectionRules ?? {}).length} 条，contexts ${Object.keys(data.contextRules ?? {}).length} 条`,
  '',
  `## sections（${data.sections?.length ?? 0} 段）`,
  '',
  ...table(data.sections, (item) => String(item.text ?? ''), {
    header: '状态',
    value: (item) => (disabledSections.has(item.name) ? '已禁用' : ''),
  }),
  '',
  `## contexts（${data.contexts?.length ?? 0} 段）`,
  '',
  ...table(data.contexts, (item) => String(item.text ?? ''), {
    header: '状态',
    value: (item) => (disabledContexts.has(item.name) ? '已禁用' : ''),
  }),
  '',
  `## tools（${data.tools?.length ?? 0} 个）`,
  '',
  '| # | name | 参数 | 描述首行 |',
  '|---|---|---|---|',
  ...(data.tools ?? []).map((tool, index) => (
    `| ${index + 1} | \`${cell(tool.name)}\` | ${cell((tool.parameterKeys ?? []).join(', '))} | ${cell(firstLine(tool.description))} |`
  )),
  '',
  `## 插件注入的段落（${data.injected?.length ?? 0} 段）`,
  '',
  '| # | name | 字数 | 摘要 |',
  '|---|---|---|---|',
  ...(data.injected ?? []).map((item, index) => (
    `| ${index + 1} | \`${cell(item.name)}\` | ${String(item.text ?? '').length} | ${cell(firstLine(item.text))} |`
  )),
  '',
]

const mdPath = join(outDir, `sections-${stamp}.md`)
await writeFile(mdPath, lines.join('\n'), 'utf8')

console.log(`json: ${jsonPath}`)
console.log(`md:   ${mdPath}`)
console.log(
  `sections=${data.sections?.length ?? 0} contexts=${data.contexts?.length ?? 0} tools=${data.tools?.length ?? 0} injected=${data.injected?.length ?? 0}`,
)