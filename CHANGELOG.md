# Changelog

## 0.2.2 — 2026-10-23

署名与包元数据。无运行时代码改动。

- **版权主体明确为 Vertixara**。`LICENSE` 原先写的是占位的 `dsh-prompt-manager contributors`，现在改为 `Copyright (c) 2026 Vertixara`。
- **补齐 npm 元数据**。`author`、`repository`、`homepage`、`bugs` 此前全部缺失，npm 包页面因此没有作者与仓库信息。
- **README 增加作者与开发说明**。写明三方分工：Vertixara 负责需求与验收、DeepSeek 4.1 Flash 负责实现与核查、GPT 6.1 Sol 负责独立审计；并标注哪些结论经过真机验证、哪些只有单测覆盖。
- **审计报告标注审计方**。`docs/audit-2026-10-23.md` 头部写明由 GPT 独立审查（与实现方不是同一个模型）。

## 0.2.1 — 2026-10-23

按 GPT 出具的独立审计（[`docs/audit-2026-10-23.md`](docs/audit-2026-10-23.md)）修复：2 项 P1、8 项 P2。测试从 41 条增加到 59 条，每项修复都有对应的回归用例。

### 安全

- **HTTP 接口加来源校验**（P1）。`/prompt-manager/api` 之前完全无鉴权：任何能连到端口的调用方都能读写提示词，别的站点还可以用 `text/plain` 的「简单请求」向本机端口 POST，绕过 CORS 预检。现在带 `Origin` 且与 `Host` 不同源的请求直接拒绝，写操作必须是 `application/json`（简单请求发不出这个类型，浏览器会先预检，而本路由不返回任何 CORS 头），请求体上限 1 MB。
  - 威胁模型的边界：本机任意进程挡不住，它本来就能直接读 `$DSH_HOME/prompt-manager.json`。这里防的是浏览器跨站。
- **并发写入不再丢数据**（P1）。修改流程是「读整份文档 → 改 → 整份写回」，两个并发调用会各自基于同一份旧版本，后写的把先写的整个抹掉，而两边都返回成功。现在所有 action 串行执行，并在锁内重新读盘；保存改为写临时文件再原子替换，写到一半出错不会留下半截 JSON。

### 修复

- **后注入开关失效**。入口把 action 转成小写，分支却比较 `apply.hotReload`，永远匹配不上。UI 和模型工具都开不了工作区的后注入。
- **父会话的临时条目到不了子代理**。作用域过滤通过后还要求 `sessionId` 与子代理自身 ID 完全相等，而 UI 添加临时条目总是填当前主会话 ID——结果是选「仅子代理」的条目注入不到任何子代理。现在按可信父链解析可见范围，多级子代理同样继承，无关会话仍然隔离。
- **动态条目的 replace 不生效**。规则施加在宿主已装配的段落上，而临时条目和后注入条目的追加发生在那之后，追加阶段只处理 `disable`。现在追加时也应用 `replace`，面板上「覆盖生效中」不再与实际不一致。
- **含双花括号的提示词会让装配失败**。宿主默认把 `{{name}}` 当变量引用，遇到未知变量直接抛异常。档案条目、临时条目和覆盖文本现在都声明 `interpolate: false`，按字面量注入——写模板示例不会再炸掉整个会话。
- **删除档案会关掉其他工作区的后注入**。重建工作区配置时只复制 `enabled`/`disabled`/`default`，丢了 `hotReload`，只有 `hotReload` 的工作区还可能整个消失。
- **全部恢复后重新启用会复活旧规则**。`override.reset` 清了磁盘规则却没清运行中会话冻结的基线，再打开总开关时旧规则又生效了。
- **快照脚本写错目录**。脚本请求已废弃的 `?view=system`（拿不到 agent 作用域的内容），还写到未被忽略的 `docs/`——照着文档跑一次就可能把真实系统提示词提交进仓库。现在改用 `?view=assembled`，输出到 `docs/snapshots/`，`ok:false` 时报错退出而不是写一份空快照。
- **路由与 watcher 未纳入生命周期**。`webServer.register()` 的 disposer 被丢弃，热卸载后旧 handler 仍持有旧 state 继续应答，重新注册同一路径会撞 duplicate route。现在统一登记，`dispose` 时释放。

### 文档

- README 补安全模型、子代理继承规则与插值语义说明。

## 0.2.0 — 2026-10-22

首个公开版本。包名 `@vertixara/dsh-prompt-manager` —— 开发期一直用的 `@local/dsh-prompt-manager` 只是本机占位符，npm 上并不存在；改名同时换了 `cordis.patch.yml` 的插入名和客户端插件 id。

### 新增

- **真实装配快照**：在 `system-prompt/assemble` waterfall 里记录每轮装配结果，按 sessionId 保存（最多 20 个会话）。这是唯一能拿到 agent 作用域内容的位置，首次可以枚举 `team:policy`、`tool:*` 这类此前完全不可见的段落，以及全部 52 个工具。
- **「内置与其他插件」独立页签**：sections / contexts / tools 分组展示，段与 context 可开关、可覆盖，tool 只读。
- **contexts 级改写**：除 section 外，运行时 context（`working-directory:current`、`sandbox:policy`、`approval:policy`、`team:identity` 等）现在也可禁用或覆盖。
- **contexts 按会话隔离**：运行时上下文规则存放在 `overrides.sessionContexts[sessionId]`，只影响该会话；`overrides.contexts` 保留为全局默认（不带 `sessionId` 操作时写入）。会话页的改写一律带 `sessionId`，不会波及别的会话。归档条目也会记录所属会话。
- **一键恢复**：清除全部改写规则并关闭总开关，回到出厂状态。
- **覆盖文本归档**：恢复单条或一键恢复时，replace 的文本自动存入 `overrides.saved`；面板「已保存的覆盖文本」区可点「应用」重新装上、点「删除」移除，最多保留 100 条。
- **测试套件**：27 个用例（`npm test`），用 mock ctx 在进程内跑真实 `apply()`，覆盖存储读写、档案 CRUD、静态注册、后注入、override 的 disable/replace/会话隔离/归档/恢复、总开关与 HTTP 端点，不需要起 DSH 进程。
- **子代理作用域**：条目与临时条目新增 `agentScope`（`inherit` / `main` / `subagent`），主代理和子代理可以拿到不同的提示词。会话类型直接取自 `SessionHeader`（`origin` / `parentSession` / `delegationDepth`），不需要自己推断。会话页显示当前是主代理还是子代理、父会话，以及本次会话拉起过的子代理各自继承了哪些条目。测试增至 38 个用例。
- **改动的生效时机拆成两条路**：主页的 `sections` / `contexts` 是全局基线，会话启动时冻结（`freezeBaseline`），**只对新会话生效**，不会中途把运行中会话的缓存前缀打掉；会话页写 `sessionSections` / `sessionContexts`，**立即生效且只影响本会话**。总开关例外，立即对全部会话生效。
- **会话页补上系统提示词管理**：默认折叠，与主页同一套 disable / replace 操作，但走会话级规则。主页禁用的段落在会话页点「重新开启」会写一条会话级 `enable` 覆盖基线里的 `disable`，不需要动全局配置。
- `override.set` 新增 `mode: "enable"`；`?view=assembled` 增加 `sectionRules`（基线 + 会话级合并结果）。测试增至 41 个用例。
- **覆盖展示改成逐行 diff**：不再整段并列贴全文，而是行级 LCS 找出真正变化的行、未变段落折叠、行内再剥离公共前后缀把改动标到具体字符。段落正文是自由文本没有字段可拆，所以粒度是"行 + 行内改动中段"。算法在 `client.js` 的 `--- diff:start/end ---` 区块内，`node research/check-diff.mjs` 直接对源码求值跑 10 项断言。
- **配色语义化**：红 = 禁用/移除，黄 = 覆盖（`--dsw-alias-state-warn-primary`），绿 = 正常生效。「已覆盖」标签、diff 新增行、行内新增高亮、「覆盖生效中」统一改成黄色，用 `color-mix` 混 token 以跟随明暗主题。
- **补齐可发布元数据**：去掉 `private`，加 `publishConfig.access: public`、`license: MIT` 与 LICENSE 文件、`engines.node` / `engines.dsh`、`peerDependencies`（`@deepseek-ai/cordis` 必需，`react` 可选）、`keywords`；`exports` 补 `./package.json`；`files` 白名单精简为运行时文件，`research/` `test/` `scripts/` 不进包。删掉 `dsh.client.immediately` —— 其他插件都没有这个字段，asar 里也找不到对应语义，属于残留。README 增加安装与发布说明。

### 修复

- **被禁用的条目从面板消失，无法取消禁用**：快照改为记录规则应用**之前**的原始装配，所有条目始终留在列表里，带「已禁用」标记，可直接点回来。
- 覆盖或禁用后看不到实际效果：面板叠加规则状态渲染，显示覆盖后的文本。

### 变更

- 快照内容语义变化：从「过滤后的最终装配」改为「原始装配 + 规则状态」，面板负责叠加。
- `?view=system` 标记为废弃（响应带 `deprecated: true`），保留仅供宿主视角调试；请改用 `?view=assembled`。
- `overrides` 结构新增 `saved` 归档数组。
- **contexts 从主页移到会话页**：运行时上下文随会话变化（工作目录、沙箱策略等），放在全局主页会造成「这是全局配置」的误解。主页只保留 sections 与 tools；contexts 在会话页「本会话上下文」卡片中查看与改写，并注明改写规则是全局的。
- UI 状态更醒目：已禁用项红色边框 + 删除线，已覆盖项用「− 原文 / + 应用」两段对照，顶部增加禁用/覆盖计数角标，总开关关闭但存在规则时给出红色警告。
- **主开关拆成状态与动作两块**：原来那一个可点的 chip 同时承担「显示状态」和「切换」两件事，看不出是按钮还是标签。现在左边是只读状态徽章（绿「改写生效中」/ 红「改写已停用」，带悬浮说明），右边是独立动作按钮（生效时是灰色的「停用改写」，停用时是主色的「启用改写」—— 需要操作的那个才是醒目的）。
- **父子智能体作用范围改成始终可见的标签**：「作用范围」改叫「注入给谁」，默认项写成「主代理 + 子代理（默认）」。档案列表、会话页生效条目、临时条目这三处的范围标签，原来只在选「仅主代理 / 仅子代理」时才出现，选「继承」就等于看不出来 —— 现在三个值都有标签（`主+子代理` / `仅主代理` / `仅子代理`），尺寸与「全局」「临时」「后注入」一致。解释压进 title tooltip（字段名带虚线下划线，悬停显示），不再用一行常驻文字占版面。会话页子代理卡片的继承列表从英文 `(main)` / `(subagent)` 改成中文。
- **工具条目默认折叠**：tools 有五十多项，展开会把 sections 挤到看不见。改成 `<details>` 默认收起，只有带过滤词时自动展开，避免搜到了却看不见。
- 目录整理：调研产物移入 `research/`，快照移入 `docs/snapshots/`，新增 README。

### 数据迁移

旧 store 自动补齐 `overrides.saved: []`，无需手工处理。

## 0.1.1

- 工作区级应用：按目录启用/禁用/设为默认条目。
- 按工作区热重载：条目可选走后注入而非静态注册。
- 会话临时条目：只在指定会话生效。

## 0.1.0

- 初始版本：档案条目、全局应用、后注入、Web 面板。