// 在 app.asar 里按字面量搜索一段文本，打印命中位置前后的上下文。
//
// 用法：node scripts/find-in-asar.mjs "要搜索的文本" [前后字符数]

import { readFileSync } from 'node:fs'

const asar = 'C:\\Users\\admin\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const needle = process.argv[2]
const span = Number(process.argv[3] ?? 600)
if (!needle) {
  console.error('用法：node scripts/find-in-asar.mjs "文本" [前后字符数]')
  process.exit(1)
}

const buffer = readFileSync(asar)
const text = buffer.toString('utf8')
let index = text.indexOf(needle)
let count = 0
while (index >= 0 && count < 4) {
  console.log(`--- offset ${index}`)
  console.log(text.slice(Math.max(0, index - span), index + span).replace(/\r?\n/g, ' ⏎ '))
  console.log('')
  index = text.indexOf(needle, index + 1)
  count += 1
}
console.log(`hits=${count} sizeMB=${(buffer.length / 1048576).toFixed(1)}`)