# 提交清单：awesome-dsh-plugin 收录

准备于 2026-10-29。对应版本 `@vertixara/dsh-prompt-manager@0.3.1`。

## 一个前提要先说清

搜索下来**没有唯一权威的 "awesome-dsh-plugin"**，至少有六个仓库在做同类目录：

| 仓库 | 规模/特征 | 判断 |
|---|---|---|
| [awesome-deepseekharness/awesome-deepseek-harness](https://github.com/awesome-deepseekharness/awesome-deepseek-harness) | 有正式 CONTRIBUTING、双语 README、CI 检查双语一致性、24–48h 合并 | **主投这里** |
| [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | 号称 14 类 280+ 插件，最全 | 次选 |
| [beancookie/awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin) | — | 可选 |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 组织账号 | 可选 |
| [ysr666/awesome-dsh-plugin-1](https://github.com/ysr666/awesome-dsh-plugin-1) | — | 可选 |
| [billliao/awesome-dsh-plugin](https://github.com/billliao/awesome-dsh-plugin) | — | 可选 |

之前几轮对话里我一直笼统说"awesome-dsh-plugin 的 PR 没提"，其实没有确认过是哪一个。
下面是按最正规的那个（`awesome-deepseekharness`）准备的，其余可以照抄同一套行。

## 前置条件核对

| 要求 | 我们的状态 |
|---|---|
| DSH 相关性（README 说明安装方式） | ✅ `dsh plugin --profile web add` |
| 可安装、有版本 tag / npm 发布 | ✅ npm `0.3.1` + GitHub release `v0.3.1` |
| 开源 + LICENSE | ✅ MIT |
| `dsh-plugin` topic | ✅ 已设置（另有 `cordis-plugin` `deepseek-harness` `prompt-management` `system-prompt`）|
| 不重复 | ✅ 目录里没有我们的条目 |
| 一句话价值主张 | ✅ 见下 |
| UI 截图 / GIF | ❌ **待补**（见文末） |
| 双语（README + README.zh.md 都改） | 待提交时两处都加 |

## 分类

`🧩 Tools, Workflows & Presets`

理由：核心能力是「提示词档案的分层投放与覆盖」，属于预设/配置管理；虽然有 Web 面板，但面板只是操作界面，不是用途本身。放在 `🎨 Web UI` 分类反而会让想找提示词管理功能的人找不到。

## 位置

该分类表格按 star 降序排列（5839 / 1307 / 199 / 194 …）。我们 **1 star**，插在表格末尾。

---

## `README.md`（英文）— 插入一行

```markdown
| [elfmingh/dsh-prompt-manager](https://github.com/elfmingh/dsh-prompt-manager) | Layered prompt profiles (global / workspace / session) with builtin-section override, subagent scope and line-level diff; `dsh plugin --profile web add @vertixara/dsh-prompt-manager` | 1 |
```

## `README.zh.md`（中文）— 同一位置插入一行

```markdown
| [elfmingh/dsh-prompt-manager](https://github.com/elfmingh/dsh-prompt-manager) | 分层提示词档案（全局 / 工作区 / 会话），支持内置段落禁用与覆盖、子代理作用域、逐行 diff；`dsh plugin --profile web add @vertixara/dsh-prompt-manager` 安装 | 1 |
```

---

## PR 标题

```
Add elfmingh/dsh-prompt-manager to Tools, Workflows & Presets
```

## PR 正文

```markdown
**Relation to DSH**

DSH Web plugin. Registers a `prompt_manager` tool, a `/prompt-manager/api` route on the
host `webServer`, and hooks `system-prompt/assemble` to rewrite sections and contexts.
It also registers static sections via `systemPrompt.section()` for new agents.

What it does: prompt entries delivered at three levels (global / workspace / session),
plus the ability to disable or override any builtin section or runtime context that
Harness or other plugins registered — with a line-level diff for every change.

**Install (verified on 0.3.1)**

```
dsh plugin --profile web add @vertixara/dsh-prompt-manager
```

npm: `@vertixara/dsh-prompt-manager@0.3.1`
Release: https://github.com/elfmingh/dsh-prompt-manager/releases/tag/v0.3.1

**License**: MIT · **Topic**: `dsh-plugin` set (also `cordis-plugin`, `deepseek-harness`,
`prompt-management`, `system-prompt`) · **Stars**: 1 (as of 2026-10-29)

**Why this category rather than Web UI**

The panel is just a shell; the product is prompt profile management. Someone looking
for "how do I pin an instruction to every session" looks under tools/presets, not skins.

**No duplicate**: searched `elfmingh/dsh-prompt-manager` in both README.md and README.zh.md — absent.
```

---

## 待补：UI 截图

CONTRIBUTING 写的是「include GIF/screenshot for UI」。这条是**硬性的质量要求**，
但它是给人看的，不是 CI 检查。我们有两个面板（侧边栏档案列表、会话页签），
建议至少一张侧边栏截图，能看清三级投放和 diff 更好。

三条路，按推荐度排：

1. **手动截一张**（最快）。打开 `http://127.0.0.1:58806`，展开侧边栏面板截图，
   放进仓库 `docs/screenshot-panel.png`，README 里引用，PR 正文里贴 URL。
2. 我写一个脚本用 Playwright/Puppeteer 截，但项目零依赖、不想为截图引入 devDependency，
   得单独装。
3. 先不贴图提交，看维护者是否 `request changes` 再补。风险是白跑一轮。

## 其他五个目录

同一套标题/正文/行照抄即可，分类名可能不同（有的用 "Tools" 或 "工具"），
提交前各自读一遍它的 CONTRIBUTING。**一次一 PR、一次一条目**，别合在一起。
