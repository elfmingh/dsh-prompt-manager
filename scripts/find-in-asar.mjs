// 在 app.asar 里按字面量搜索一段文本，打印命中位置前后的上下文。
//
// 用法：node scripts/find-in-asar.mjs "要搜索的文本" [前后字符数] [app.asar 路径]
//
// asar 路径不打在代码里 —— 它是本机安装位置，写死会把用户名和目录结构带进仓库。
// 从第三个参数或 DSH_ASAR 环境变量拿。

import { readFileSync } from 'node:fs'

const needle = process.argv[2]
const span = Number(process.argv[3] ?? 600)
const asar = process.argv[4] || process.env.DSH_ASAR || ''
if (!needle || !asar) {
  console.error('用法：node scripts/find-in-asar.mjs "文本" [前后字符数] [app.asar 路径]')
  console.error('')
  console.error('  app.asar 路径也可以放在 DSH_ASAR 环境变量里。')
  console.error('  Windows 上一般在 <DeepSeek Harness 安装目录>\\resources\\app.asar，')
  console.error('  macOS 上在 /Applications/DeepSeek Harness.app/Contents/Resources/app.asar。')
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