// 抓取一次系统提示词装配快照，落盘成 JSON + Markdown。
//
// 用法：
//   node scripts/snapshot-sections.mjs <baseUrl> [sessionId]
//   node scripts/snapshot-sections.mjs http://127.0.0.1:56994
//   node scripts/snapshot-sections.mjs http://127.0.0.1:56994 session-xxxx
//
// 不传 sessionId 时后端会借用任意运行中的 agent；若一个都没有，则回退到宿主作用域，
// 此时快照里不会出现人工注入的段落，scope 字段会标为 host。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const base = (process.argv[2] || 'http://127.0.0.1:56994').replace(/\/+$/, '')
const sessionId = process.argv[3] || ''

const url = `${base}/prompt-manager/api?view=system${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const docs = join(root, 'docs')
await mkdir(docs, { recursive: true })

const jsonPath = join(docs, `sections-${stamp}.json`)
await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const firstLine = (text) => {
  const line = String(text ?? '').split('\n').find((item) => item.trim()) || ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

const table = (items, describe) => [
  '| # | name | 字数 | 摘要 |',
  '|---|---|---|---|',
  ...(items ?? []).map((item, index) => `| ${index + 1} | \`${cell(item.name)}\` | ${describe(item).length} | ${cell(firstLine(describe(item)))} |`),
]

const lines = [
  '# 系统提示词装配快照',
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 请求：${url}`,
  `- scope：${data.scope ?? '(unknown)'}`,
  `- session：${data.sessionId || '(未指定)'}`,
  '',
  `## sections（${data.sections?.length ?? 0} 段）`,
  '',
  ...table(data.sections, (item) => String(item.text ?? '')),
  '',
  `## contexts（${data.contexts?.length ?? 0} 段）`,
  '',
  ...table(data.contexts, (item) => String(item.text ?? '')),
  '',
  `## tools（${data.tools?.length ?? 0} 个）`,
  '',
  '| # | name | 参数 | 描述首行 |',
  '|---|---|---|---|',
  ...(data.tools ?? []).map((tool, index) => (
    `| ${index + 1} | \`${cell(tool.name)}\` | ${cell((tool.parameterKeys ?? []).join(', '))} | ${cell(firstLine(tool.description))} |`
  )),
  '',
]

const mdPath = join(docs, `sections-${stamp}.md`)
await writeFile(mdPath, lines.join('\n'), 'utf8')

console.log(`json: ${jsonPath}`)
console.log(`md:   ${mdPath}`)
console.log(
  `sections=${data.sections?.length ?? 0} contexts=${data.contexts?.length ?? 0} tools=${data.tools?.length ?? 0} scope=${data.scope}`,
)