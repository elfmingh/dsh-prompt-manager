# dsh-prompt-manager

DeepSeek Harness 的提示词管理器。管理四类提示词：

1. **档案条目** —— 长期保存的提示词片段，可全局或按工作区启用
2. **会话临时条目** —— 只在某个会话生效，走后注入
3. **内置段落改写** —— 对 Harness 与其他插件注册的 section / context 做禁用或覆盖
4. **只读观察** —— 工具描述、运行时 context 的枚举

## 安装

前置：DSH `>= 0.2.1-rc.2`，Node `^22.19.0 || >=24.0.0`。没有构建步骤 —— 包里的 `index.js` / `client.js` 就是运行时产物。

**从源码装**（当前形态：包名带 `@local/`，只在本地有意义）：

```powershell
dsh plugin --profile web add link:D:\dsh-dev\plugins\dsh-prompt-manager
dsh web
```

`dsh plugin` 是 pnpm 的转发器，但它多做一步关键动作：把包名 reconcile 进 profile `package.json` 的 `dsh.profile.bundles`。**那个列表才是启用开关** —— 包装了但没进 bundles 就不会被加载。

**发布到 npm 之后**：

```powershell
dsh plugin --profile web add <your-scope>/dsh-prompt-manager
```

**卸载**：

```powershell
dsh plugin --profile web remove dsh-prompt-manager
```

### 发布前需要改的

包名目前是 `@local/dsh-prompt-manager`（本地 scope，npm 上不存在）。发布前把 `name` 换成自己的 scope，其余元数据已经齐备：

- `publishConfig.access: "public"`、`license: MIT`、`keywords` 已设置
- `engines.node` / `engines.dsh` 声明了支持范围
- `peerDependencies`：`@deepseek-ai/cordis`（必需）、`react`（可选，只有 Web 端用）
- `files` 白名单只含运行时文件，`research/`、`test/`、`scripts/` 不会进包

## 目录

```
dsh-prompt-manager/
├─ index.js              Host 端插件（工具 + HTTP + 注入逻辑）
├─ client.js             Web 客户端（侧边栏面板 + 会话页签）
├─ package.json          包声明（dsh.client 配置在 dsh 字段）
├─ cordis.patch.yml      插入到 profile 的 bundle patch
├─ icon.svg              侧边栏图标
├─ locale/               面板文案（zh / en）
├─ test/                 测试（不随包发布）
│  ├─ *.test.mjs             node --test 用例
│  ├─ harness.mjs            假 ctx 与临时 DSH_HOME
│  ├─ check-client.mjs       客户端工厂加载自检
│  └─ check-diff.mjs         diff 算法断言
├─ scripts/              维护脚本（不随包发布）
│  ├─ snapshot-sections.mjs   抓一次装配快照落盘
│  └─ find-in-asar.mjs        在 app.asar 里按字面量搜文本
├─ docs/snapshots/       装配快照（已在 .gitignore 中，含本地环境信息）
└─ research/             开发期调研产物（已在 .gitignore 中）
```

## 三种注入方式

| 方式 | 实现 | 生效时机 | 用于 |
|---|---|---|---|
| 静态 | `systemPrompt.section()` | agent 创建时注册 | 全局/工作区条目（默认） |
| 后注入 | `system-prompt/assemble` waterfall 追加 | 每轮装配 | 临时条目、开了 `hotReload` 的工作区条目 |
| 覆盖 | 同一个 waterfall 里改 `sections` / `contexts` | 每轮装配 | 内置段落 disable / replace |

**为什么需要后注入**：`section()` 是一次性注册，agent 创建之后再加的段落不会进入它已经装配好的提示词。会话临时条目必须走 waterfall 才能在下一轮出现。

**为什么覆盖也走 waterfall**：`assemble()` 返回的 assembly 是权威结果，在这里删段或换文本才能影响真实提示词。注意 `complete` 段落会在 waterfall 之后被框架还原，那种情况下改写无效（当前环境未观测到）。

## 数据文件

`$DSH_HOME/prompt-manager.json`

```jsonc
{
  "version": 2,
  "entries": [{ "id": "...", "title": "...", "text": "...", "order": 9000, "agentScope": "inherit" }],
  "applications": {
    "global": { "enabled": ["entry-id"] },
    "workspaces": {
      "d:/longerunderstanding": {
        "enabled": [], "disabled": [], "default": [],
        "hotReload": false        // true = 该工作区条目走后注入
      }
    }
  },
  "temporary": [{ "id": "temp-...", "sessionId": "...", "title": "...", "text": "...", "order": 9000, "agentScope": "inherit", "createdAt": "..." }],
  "overrides": {
    "enabled": true,              // 总开关，关闭时所有规则存着但不生效（立即生效）
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

工作区键是**归一化路径**（小写、正斜杠）。`saved` 是覆盖文本归档：恢复默认或一键恢复时自动写入，可在面板点「应用」重新装上；来自某个会话的覆盖会带上 `sessionId`，应用时回到那个会话。

`agentScope` 决定条目注入给哪类代理：`inherit`（默认，主代理和子代理都注入）、`main`（只有主代理）、`subagent`（只有子代理）。判定依据是 `SessionHeader` 的 `origin` / `parentSession` / `delegationDepth`，由框架写入，插件不需要自己猜。

## 改动什么时候生效

提示词是服务端的**前缀缓存**：只要前缀变了，整段缓存就作废。所以这套规则故意分成两条路：

| 你在哪改 | 写进哪里 | 生效时机 | 影响范围 |
|---|---|---|---|
| 主页 | `sections` / `contexts` | **新建会话** | 全局 |
| 会话页 | `sessionSections` / `sessionContexts` | **立即** | 只那个会话 |
| 主页总开关 | `enabled` | **立即** | 全局 |

主页是配置，改完等下一个会话；会话页是当场的精细操作，你清楚自己在动缓存，就立即给你看到效果。会话第一次装配时会冻结当时的全局规则（`freezeBaseline`），之后主页再改不追杀它。

反过来，主页禁用了某个段落，运行中的会话要恢复它，就在会话页点「重新开启」——那会写一条会话级 `{"mode": "enable"}`，推翻基线里的 `disable`，而不是去动全局规则。

`override.set` 的 `mode` 因此有三种：`disable`（禁用）、`replace`（覆盖，需 `text`）、`enable`（在会话层恢复原文）。

## 工具

工具名 `prompt_manager`，action：

```
list | preview | library.add | library.update | library.remove
apply.toggle | apply.default | apply.hotReload
override.set | override.clear | override.toggle | override.reset | override.restore | override.forget
temp.add | temp.remove | reload | path
```

`override.set` 需要 `name` + `mode`（`disable` / `replace` / `enable`），可带 `layer`（`section` / `context`，默认 section）；replace 模式还需 `text`。带 `sessionId` 只写该会话的规则（立即生效），不带则写全局基线（新建会话生效）。

## HTTP 端点

挂载在 `/prompt-manager/api`，都支持 `sessionId` 参数：

| 查询 | 返回 |
|---|---|
| 无参数 / `?view=snapshot` | 档案、应用、临时条目、overrides 全文 |
| `?view=session` | 某会话当前解析出的条目（静态 + 后注入） |
| `?view=system` | ⚠️ **已废弃**（响应带 `deprecated: true`），仅宿主作用域调试用 |
| `?view=assembled` | **真实装配快照**，含 agent 作用域段落、全部 context 与 52 个工具 |

`?view=system` 拿不到 agent 作用域的内容（`assemble({})` 不传 scope，waterfall 不派发给 scoped listener），返回的宿主段落与真实提示词不一致，容易误导，已标记废弃。面板一律用 `?view=assembled` —— 后者由 waterfall 每轮记录，未产生过装配的会话会返回 `ok:false` + 原因。

## 界面

侧边栏面板（order 40）两个页签：

- **提示词档案** —— 左侧档案列表（可搜索、拖拽），右侧全局/工作区应用区
- **内置与其他插件** —— 真实装配出的 **sections** 与 **tools**；段可开关、可覆盖，tool 只读（tools 有五十多项，默认折叠，搜索时自动展开）

顶部左边是改写状态徽章（绿「改写生效中」/ 红「改写已停用」），右边是独立的动作按钮（生效时「停用改写」，停用时「启用改写」）和「全部恢复」，后面跟规则计数。被禁用的条目仍留在列表里标红划线，点「重新开启」即可恢复；被覆盖的条目用**逐行 diff** 展示：行级 LCS 只标出真正变化的行，未变的段落只留前后一行上下文、其余折叠成「⋯ N 段未变」，同一行内再用公共前后缀剥离把改动落到具体那几个字上。这样改一个词不会淹没在整段文本里。

配色约定：**红** = 禁用/被移除，**黄** = 覆盖（`--dsw-alias-state-warn-primary`），**绿** = 正常生效。diff 里的新增行是黄色、删除行是红色；行内高亮用 `color-mix` 混合该 token，跟随明暗主题。

**会话页**（每个会话的「提示词」页签）额外展示：

- 本会话最终生效的条目（全局 + 工作区 + 临时条目合并结果）
- **系统提示词段落**（默认折叠）—— 和主页同一套内置段落管理，但这里的改动**立即生效、只影响本会话**；主页禁用的段落可以在这里点「重新开启」单独立刻恢复
- **本会话上下文（contexts）** —— 该会话动态生成的运行时信息，禁用/覆盖同样只作用于本会话、立即生效
- **本会话的子代理** —— 本次会话拉起过的子代理，各自继承了哪些条目；「仅主代理」「仅子代理」的标签会显示在这里
- 临时条目管理（可选择注入给主代理还是子代理）

## 脚本

```powershell
node scripts/snapshot-sections.mjs http://127.0.0.1:<port> [sessionId]
node scripts/find-in-asar.mjs "要搜的文本" [前后字符数]
```

前者把 `?view=assembled` 的结果写成 `docs/snapshots/sections-<时间戳>.{json,md}`，用于版本对比。

## 测试

```powershell
npm test        # 或 node --test --test-isolation=none "test/*.test.mjs"
```

41 个用例，用 mock ctx 在进程内跑真实 `apply()`，不需要起 DSH 进程：

| 文件 | 覆盖面 |
|---|---|
| `test/library.test.mjs` | 存储读写与 v2 结构、档案 CRUD、应用开关、工作区键归一化、静态注册、临时条目后注入、HTTP 端点 |
| `test/overrides.test.mjs` | 内置段落 disable / replace / enable、快照保留原始段落、**基线冻结（主页改动只对新会话生效）**、context 与 section 的会话隔离、会话规则优先级、归档 / 恢复 / 遗忘、总开关立即生效 |
| `test/subagent.test.mjs` | `agentScope` 三种取值的注入差异、临时条目的作用域过滤、`delegationDepth` 判定、preview / list / `?view=session` / `?view=assembled` 的子代理标记 |

`test/harness.mjs` 提供假 `ctx`（`tools.register`、`systemPrompt.section`、`on(event)`、`webServer.register`、`get('workingDirectory')`），并把 `$DSH_HOME` 指向临时目录，所以测试不碰真实存储和日志。

`--test-isolation=none` 是必需的：在受限沙箱里，`node --test` 默认给每个文件开子进程会被 EPERM 拒绝。

## 已知限制

- 静态注册的条目改不到已经在运行的 agent，只能靠重建会话
- 后注入只能追加，要「撤掉」已注入的内容必须用 override disable
- `required: true` 的 context 被移除后是否恢复，由框架决定
- 工具描述只读：改它需要动 `assembly.tools`，风险过高，未开放
- 面板显示的 tools 数量取决于目标会话是否产生过装配