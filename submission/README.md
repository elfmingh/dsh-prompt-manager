# 投稿 awesome-dsh-plugin 的素材

这里放的是向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交收录 PR 所需的文件。

**这个目录不会进 npm 包** —— `package.json` 的 `files` 白名单只列了运行时文件。

---

## 文件

| 文件 | 用途 |
|---|---|
| `elfmingh__dsh-prompt-manager.yml` | 直接复制到 PR 里的条目文件，目标路径 `data/plugins/elfmingh__dsh-prompt-manager.yml` |
| `../assets/icon.png` | 列表卡片图标，512×512，`icon:` 字段指向它的 raw URL |

条目文件已按对方要求写好：`description.en` 含 `: ` 所以加了引号（否则 YAML 会把冒号读成嵌套键）；`icon` 是 GitHub 托管的位图（SVG 会被拒）。

---

## 提交前必须完成的三件事

### 1. 仓库满 24 小时

对方 CI **自动检查**，无人工豁免：

```
仓库创建: 2026-10-23 01:29 (UTC+8)
可提交时间: 2026-10-24 01:29 起
```

早于这个时间提 PR 一定失败，重提不影响，但没必要浪费一次。

### 2. 给仓库加 `dsh-plugin` topic

GitHub 仓库首页 → 右侧 About 区域齿轮图标 → **Topics** 填：

```
dsh-plugin
deepseek-harness
prompt-engineering
cordis
prompt-manager
```

`dsh-plugin` 是硬性要求，其余是顺带补的（现在 topics 是空的）。

### 3. 填 About 描述

同一个面板里的 **Description**，建议：

```
Layered prompt manager for DeepSeek Harness: reusable entries per workspace or session, built-in section overrides with line-level diff, and real assembly snapshots.
```

这是列表页访客点进来第一眼看到的东西，现在也是空的。

---

## 提 PR 的步骤

1. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 把 `elfmingh__dsh-prompt-manager.yml` 放到 fork 的 `data/plugins/` 下
3. **不要动任何 README** —— 它们由脚本从 `data/plugins/*.yml` 生成
4. 提 PR，标题类似 `Add elfmingh/dsh-prompt-manager`
5. 一个 PR 只加这一条（对方限制最多 3 条）

合并后 README 和网站会自动重建，不需要跑任何命令。

---

## 为什么 `icon:` 现在就能用

`assets/icon.png` 已提交到 `main`，raw URL 即刻有效：

```
https://raw.githubusercontent.com/elfmingh/dsh-prompt-manager/main/assets/icon.png
```

如果先提 PR 后加图标，那个 URL 会在合并时 404 —— 所以图标必须先上线。

---

## 可选：截图

市场详情页会展示 App Store 式截图。要控制展示，在仓库根放 `screenshots.json`：

```json
[
  "assets/screenshot-1.png",
  "assets/screenshot-2.png"
]
```

规则：1-8 张、相对路径不能跳出插件目录、也接受 GitHub 托管的绝对 URL，第三方图床会被拒。

不写也行——市场会从 README 自动抽取图片，只是无法控制顺序和取舍。

---

## 描述措辞的依据

对方的评审会**对着代码核验描述里的每一句话**，夸大是打回的主要原因。当前描述的每一句都有实现对应：

| 描述里的说法 | 代码出处 |
|---|---|
| entries applied globally, per workspace, or per session | `applications.global` / `applications.workspaces` / `temporary[].sessionId` |
| built-in sections and runtime contexts disabled or replaced | `overrides.sections` / `overrides.contexts`，`mode: disable \| replace` |
| line-level diff | 行级 LCS + 公共前后缀剥离 |
| assembly snapshots, including subagents | `?view=assembled`，由 `system-prompt/assemble` waterfall 每轮记录 |

没有写工具数量。实际是 18 个动作（`list` … `path`），但如果写上，维护者会去数——一行描述里塞不下 18 个名字，不如不写。