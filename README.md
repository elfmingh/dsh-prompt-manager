# dsh-prompt-manager

[![Release](https://img.shields.io/github/v/release/elfmingh/dsh-prompt-manager?label=release)](https://github.com/elfmingh/dsh-prompt-manager/releases)
[![License](https://img.shields.io/github/license/elfmingh/dsh-prompt-manager)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-4D6BFE)](package.json)

**DeepSeek Harness 的分层提示词管理器** —— 档案条目按「全局 / 工作区 / 会话」三级投放，内置段落与运行时上下文可以禁用或覆盖，每次改动都能看到逐行 diff。没有构建步骤，改完刷新页面。

它解决的是这几件事：

- 想给所有会话固定加一段指令，但又不想动 DSH 源码或每次手动粘贴
- 想只在某个项目里关掉某条内置约定，别的地方保持原样
- 想知道这一轮真实的系统提示词长什么样 —— 包括子代理拿到的那一份

## ✨ 功能

- **三级投放** —— 一条条目可以只给当前工作区、只给某个会话，或者全局。工作区按归一化路径识别，换目录自动切换。
- **内置段落改写** —— Harness 和其他插件注册的 section 都能禁用或替换全文。列表是真实装配出来的，不是硬编码清单。
- **运行时上下文改写** —— `working-directory:current`、`sandbox:policy`、`team:identity` 这类每轮动态生成的 context 同样可禁用或覆盖。
- **逐行 diff** —— 被覆盖的段落用行级 LCS 标出真正变化的行，未变段落折叠成「⋯ N 段未变」，同一行内再用公共前后缀剥离定位到具体那几个字。
- **父子智能体作用域** —— 条目可选「主+子代理 / 仅主代理 / 仅子代理」，判定依据是框架写入的 `origin` / `parentSession` / `delegationDepth`。
- **改动时机分两条路** —— 全局改完等下一个会话，会话页改完立即生效且只影响那一个会话。原因是提示词前缀缓存：前缀一动，整段缓存作废。
- **真实装配快照** —— 每轮记录 `system-prompt/assemble` 的结果，可枚举 agent 作用域的段落和全部工具，是唯一能看到子代理提示词的地方。
- **工具 + HTTP 接口** —— 全部能力都能从 `prompt_manager` 工具或 `/prompt-manager/api` 调用，Web 界面只是其中一层壳。

## 🚀 安装

前置：DSH `>= 0.2.1-rc.2`，Node `^22.19.0 || >=24.0.0`。

**从 npm 装**（发布后可用）：

```sh
dsh plugin --profile web add @vertixara/dsh-prompt-manager
```

**从源码装**（当前形态，包还没发布）：

```powershell
dsh plugin --profile web add link:D:\dsh-dev\plugins\dsh-prompt-manager
dsh web
```

`dsh plugin` 是 pnpm 的转发器，但它多做一步关键动作：把包名写进 profile `package.json` 的 `dsh.profile.bundles`。**那个列表才是启用开关** —— 包装上了但没进 bundles，DSH 不会加载它。

**卸载**：

```sh
dsh plugin --profile web remove @vertixara/dsh-prompt-manager
```

**更新**（发布后）：

```sh
dsh plugin --profile web update @vertixara/dsh-prompt-manager@latest
```

## 🎯 五分钟上手

1. 打开左侧边栏的**提示词**面板
2. 在「提示词档案」页签新建一条：填标题和正文
3. 右侧「全局」区块里把它的开关打开
4. 新开一个会话 —— 条目会出现在那个会话的系统提示词里，会话页签的「本会话生效条目」能看到它

想临时试一段话不想留档？直接在**会话页签**里加临时条目，下一轮就注入，只影响这个会话。

## ⏱️ 改动什么时候生效

这是这个插件最需要理解的一点。提示词是服务端的前缀缓存，前缀一变整段缓存就作废，所以规则故意分成两条路：

| 你在哪改 | 写进哪里 | 生效时机 | 影响范围 |
|---|---|---|---|
| 主页 | `sections` / `contexts` | **新建会话** | 全局 |
| 会话页 | `sessionSections` / `sessionContexts` | **立即** | 只那个会话 |
| 主页总开关 | `enabled` | **立即** | 全局 |

主页是配置，改完等下一个会话；会话页是当场的精细操作，你清楚自己在动缓存，就立即给你看到效果。

会话第一次装配时会**冻结**当时的全局规则（`freezeBaseline`），之后主页再改不会追杀已经在跑的会话。反过来说，主页禁用了某个段落、你想让当前会话恢复它，就在会话页点「重新开启」—— 那会写一条会话级 `{"mode":"enable"}` 推翻基线，而不是去动全局规则。

因此 `override.set` 的 `mode` 有三种：`disable`、`replace`（需 `text`）、`enable`。

## 👪 谁能看到什么

档案条目和临时条目都能标作用域：

| 标记 | 注入给 |
|---|---|
| 主代理 + 子代理（默认） | 两者都注入 |
| 仅主代理 | 只有主会话 |
| 仅子代理 | 只有它派生的子代理 |

判定依据是框架写进 `SessionHeader` 的 `origin` / `parentSession` / `delegationDepth`，插件不自己推断。

临时条目写在「打开它的那个会话」名下，但会沿父链传给该会话派生的子代理、孙代理 —— 否则在会话页给子代理写的东西永远到不了子代理。无关会话之间照旧隔离。

所有提示词都按**字面量**注入：`{{...}}` 不会被当成变量解析。宿主默认会解析，遇到未定义的变量直接抛异常让整轮装配失败，写一句模板示例就能搞坏一个会话。

## 🧭 核心概念

| 概念 | 是什么 | 存在哪 |
|---|---|---|
| **档案条目** | 长期保存的提示词片段，只存内容不存作用域 | `entries[]` |
| **应用关系** | 哪个条目在哪个范围里启用/禁用/设为默认 | `applications` |
| **临时条目** | 绑定单个会话、走后注入、可随时删 | `temporary[]` |
| **改写规则** | 对 section / context 的 disable 或 replace | `overrides` |

拆开「条目」和「应用」的原因：同一条指令往往既想在全局生效、又想在某个项目里例外，合并成一个对象就没法表达了。

## 🖥️ 界面

### 侧边栏面板

两个页签：

- **提示词档案** —— 左侧档案列表（可搜索），右侧全局 / 工作区应用区
- **内置与其他插件** —— 真实装配出的 sections 与 tools；段落可开关、可覆盖，工具只读（五十多项，默认折叠，搜索时自动展开）

顶部左侧是**改写状态徽章**（绿「改写生效中」/ 灰「改写已停用」标注状态），右侧是独立的动作按钮（生效时「停用改写」、停用时「启用改写」）加「全部恢复」和规则计数。状态和动作分开，一眼能看出现在是哪种。

### 会话页签

每个会话的「提示词」页签额外展示：

- **本会话生效条目** —— 全局 + 工作区 + 临时合并后的最终结果
- **系统提示词段落**（默认折叠）—— 和主页同一套管理，但改动立即生效、只影响本会话
- **本会话上下文** —— 该会话动态生成的运行时信息，同样只作用于本会话
- **本会话的子代理** —— 拉起过的子代理各自继承了哪些条目，「仅主代理」「仅子代理」标签会显示在这里
- **临时条目管理** —— 可选择注入给主代理还是子代理

### 颜色语言

| 颜色 | 含义 |
|---|---|
| 红 | 禁用 / 被移除 |
| 黄 | 覆盖（`--dsw-alias-state-warn-primary`） |
| 绿 | 正常生效 |

diff 里新增行是黄色、删除行是红色，行内高亮用 `color-mix` 混合该 token，跟随明暗主题。被禁用的条目仍留在列表里标红划线，点「重新开启」就能恢复。

## 🗂️ 数据

`$DSH_HOME/prompt-manager.json`

```jsonc
{
  "version": 2,
  "entries": [{ "id": "...", "title": "...", "text": "...", "order": 9000, "agentScope": "inherit" }],
  "applications": {
    "global": { "enabled": ["entry-id"] },
    "workspaces": {
      "d:/my-project": {
        "enabled": [], "disabled": [], "default": [],
        "hotReload": false        // true = 该工作区条目走后注入
      }
    }
  },
  "temporary": [{ "id": "temp-...", "sessionId": "...", "title": "...", "text": "...", "order": 9000, "agentScope": "inherit", "createdAt": "..." }],
  "overrides": {
    "enabled": true,              // 总开关，关闭时规则留着但不生效（立即生效）
    "sections": { "harness:identity": { "mode": "disable" },
                  "ui:deliverable-file-references": { "mode": "replace", "text": "..." } },
    "contexts": { "team:identity": { "mode": "disable" } },   // 全局基线，新建会话生效
    "sessionSections": {                                     // 按会话隔离，立即生效
      "session-abc": { "plan:policy": { "mode": "disable" } }
    },
    "sessionContexts": {
      "session-abc": { "app:web-surface": { "mode": "disable" } }
    },
    "saved": [{ "id": "saved-...", "name": "...", "layer": "sections", "text": "...", "createdAt": "..." }]
  }
}
```

工作区键是**归一化路径**（小写、正斜杠）。`saved` 是覆盖文本归档：恢复默认或一键恢复时自动写入，可在面板点「应用」重新装上，最多保留 100 条；来自某个会话的覆盖会带上 `sessionId`，应用时回到那个会话。

`version` 是**数据格式版本**，跟包版本无关。旧 store 会自动补齐缺失字段。

## 🧰 工具与 HTTP

工具名 `prompt_manager`：

```
list | preview | library.add | library.update | library.remove
apply.toggle | apply.default | apply.hotReload
override.set | override.clear | override.toggle | override.reset | override.restore | override.forget
temp.add | temp.remove | reload | path
```

`override.set` 需要 `name` + `mode`（`disable` / `replace` / `enable`），可带 `layer`（`section` / `context`，默认 section）。带 `sessionId` 只写该会话的规则（立即生效），不带则写全局基线（新建会话生效）。

HTTP 端点挂在 `/prompt-manager/api`，都接受 `sessionId`：

| 查询 | 返回 |
|---|---|
| 无参数 / `?view=snapshot` | 档案、应用、临时条目、overrides 全文 |
| `?view=session` | 某会话当前解析出的条目（静态 + 后注入） |
| `?view=assembled` | **真实装配快照**，含 agent 作用域段落、全部 context 与工具 |
| `?view=system` | ⚠️ **已废弃**，响应带 `deprecated: true`，仅宿主作用域调试用 |

`?view=system` 拿不到 agent 作用域的内容（`assemble({})` 不传 scope，waterfall 不派发给 scoped listener），返回的宿主段落与真实提示词不一致，容易误导。面板一律用 `?view=assembled` —— 后者由 waterfall 每轮记录，没产生过装配的会话会返回 `ok:false` 加原因。

### 端点安全

路由直接挂在宿主的 `webServer` 上，宿主不提供统一的认证或来源策略，所以由插件自己守：

- 带 `Origin` 且与 `Host` 不同源 → `403`
- 写操作必须是 `content-type: application/json` —— 跨站的「简单请求」发不出这个类型，浏览器会先预检，而本路由不返回任何 CORS 响应头，预检必然失败
- 请求体上限 1 MB

挡不住的是本机任意进程：它本来就能直接读 `$DSH_HOME/prompt-manager.json`。这里防的是浏览器跨站。

## 🛠️ 开发

```
dsh-prompt-manager/
├─ index.js              Host 端插件（工具 + HTTP + 注入逻辑）
├─ client.js             Web 客户端（侧边栏面板 + 会话页签）
├─ cordis.patch.yml      插入到 profile 的 bundle patch
├─ locale/               面板文案（zh / en）
├─ test/                 测试（不随包发布）
└─ scripts/              维护脚本（不随包发布）
```

有两种注入路径，理解它们的差别才能看懂代码：

| 方式 | 实现 | 生效时机 |
|---|---|---|
| 静态 | `systemPrompt.section()` | agent 创建时注册 |
| 后注入 | `system-prompt/assemble` waterfall 追加 | 每轮装配 |
| 覆盖 | 同一个 waterfall 里改 `sections` / `contexts` | 每轮装配 |

`section()` 是一次性注册，agent 创建之后再加的段落不会进入它已经装配好的提示词 —— 临时条目必须走 waterfall 才能在下一轮出现。

```powershell
npm test                 # 41 个用例
npm run check:diff       # diff 算法 10 项断言
npm run check:client     # 客户端工厂能否被 ModuleLoader 加载
```

测试用 mock ctx 在进程内跑真实 `apply()`，不需要起 DSH 进程；`$DSH_HOME` 指向临时目录，不碰真实存储。`--experimental-test-isolation=none` 是必需的：受限沙箱里 `node --test` 默认给每个文件开子进程会被 EPERM 拒绝。

CI 在 Node 22 和 24 上各跑一遍，推 `v*` 标签会自动跑测试、打包并发布 release。

维护脚本：

```powershell
node scripts/snapshot-sections.mjs http://127.0.0.1:<port> [sessionId]   # 抓一次装配快照
node scripts/find-in-asar.mjs "要搜的文本" [前后字符数]                    # 在 app.asar 里按字面量搜
```

前者把 `?view=assembled` 的结果写成 `docs/snapshots/sections-<时间戳>.{json,md}`，用于版本对比。`docs/snapshots/` 和 `research/` 已在 `.gitignore` 中 —— 它们含本机路径与会话内容，不进公开仓库。

发布：在 npm 上认领 `@vertixara` scope，然后 `npm publish`（`publishConfig.access` 已是 `public`，`files` 白名单只含运行时文件）。

## ⚠️ 已知限制

- 静态注册的条目改不到已经在运行的 agent，只能靠重建会话
- 后注入只能追加，要撤掉已注入的内容必须用 override disable
- `required: true` 的 context 被移除后是否恢复，由框架决定
- 工具描述只读：改它需要动 `assembly.tools`，风险过高，未开放
- 面板显示的 tools 数量取决于目标会话是否产生过装配
- `complete` 段落会在 waterfall 之后被框架还原，对它做改写无效（当前环境未观测到）

## 👤 作者

| 参与者 | 负责 |
|---|---|
| **Vertixara** | 需求、设计取舍与验收 |
| **DeepSeek 4.1 Flash** | 实现、核查、测试与文档 |
| **GPT 6.1 Sol** | 独立代码审计（[审计报告](docs/audit-2026-10-23.md)）：查出 2 项 P1、8 项 P2 |

- 邮箱：<public@vertixara.com>
- 仓库：<https://github.com/elfmingh/dsh-prompt-manager>
- 问题反馈：<https://github.com/elfmingh/dsh-prompt-manager/issues>
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

发现安全问题请直接发邮件，不要开公开 issue。

## 🤖 关于这份代码

Host 端、Web 客户端、测试与 CI 绝大多数是由 DeepSeek 4.1 Flash 与 Vertixara 结对写成的：需求、取舍和验收由 Vertixara 拍板，实现、核查与修复由 DeepSeek 4.1 Flash 执行，审计由 GPT 6.1 Sol 独立完成。

写下这一点是为了让后来者知道按什么标准读它 —— 哪些结论经过了真机验证、哪些只有单元测试覆盖，都写在下面这段历史里：

- 0.2.1 的十项修复来自 GPT 6.1 Sol 的独立审计（报告保留在 [`docs/audit-2026-10-23.md`](docs/audit-2026-10-23.md)），每条都回到代码和宿主源码逐条复核后才动手，未发现误报；其中鉴权、并发写入、路由生命周期三项在真实运行的 DSH 上做过验证。
- 剩下七项由 59 个用例覆盖，每条用例名带审计编号。测试全部在进程内用 mock ctx 跑真实 `apply()`，不需要起 DSH 进程。
- README 里关于宿主行为的断言（`interpolate: false` 的语义、`register()` 没有鉴权层、`section()` 只在创建时注册）都读过宿主安装包里的实际实现，不是推测。

## 📄 License

[MIT](LICENSE)