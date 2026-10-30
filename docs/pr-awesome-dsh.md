# 收录提交：awesome-dsh-plugin

准备好于 2026-10-30。对应版本 `@vertixara/dsh-prompt-manager@0.4.1`。

## 目标仓库

**[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**

这份文件之前推荐的是 `awesome-deepseekharness/awesome-deepseek-harness`，那是错的：
那个仓库要改两份 README 的表格行，PR 之间会互相冲突，而且要手工编 README。
这个仓库把列表拆成了 `data/plugins/` 下的一千多个 YAML，一个插件一个文件 ——
**一个文件就是全部投稿**，README 在合并后由 `main` 自动重新生成。条目文件永不
相撞，所以 PR 不会因为别人先合并而失效。规模也更大（3000+ 条目）。

## 要提交的东西

只有两个文件在本目录，第一个是投稿内容，第二个是 PR 正文（`gh` 可以直接吃）：

| 本地文件 | 提交到 |
|---|---|
| `docs/awesome-dsh/elfmingh__dsh-prompt-manager.yml` | `data/plugins/elfmingh__dsh-prompt-manager.yml` |
| `docs/awesome-dsh/pr-body.md` | PR 正文，不是仓库文件 |

条目内容：

```yaml
url: https://github.com/elfmingh/dsh-prompt-manager
name: elfmingh/dsh-prompt-manager
category: identity
description:
  en: ...
  zh: ...
```

字段只有 `url` / `name` / `category` / `description.{en,zh}`。
`description.en` 是唯一必填项，`zh` 可选（缺了维护者会补）。
**不要**写 `npm:` —— 那个字段会被校验直接拒绝，npm 映射是从 registry 自动采集的，
前提是包的 `repository` 字段指回本仓库（我们的已指向）。

分类选 `identity` 的理由：列表里做「提示词注入 / agent 指令」的插件都在这一类
（`dsh-prompt-inject`、`dsh-agent-instructions`）。规范明说分类选得不够准由维护者
直接改、不会打回，所以不必纠结。

## PR 标题

```
Add elfmingh/dsh-prompt-manager
```

这个仓库的 `contributing.md` 没有规定标题格式（`Add owner/repo to Category` 那条是
另一个仓库的规矩）。保持上面的形式即可。

## 提交流程

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-elfmingh-dsh-prompt-manager

cp /path/to/dsh-prompt-manager/docs/awesome-dsh/elfmingh__dsh-prompt-manager.yml \
   data/plugins/elfmingh__dsh-prompt-manager.yml

git add data/plugins/elfmingh__dsh-prompt-manager.yml
git commit -m "Add elfmingh/dsh-prompt-manager"
git push -u origin add-elfmingh-dsh-prompt-manager

gh pr create \
  --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add elfmingh/dsh-prompt-manager" \
  --body-file /path/to/dsh-prompt-manager/docs/awesome-dsh/pr-body.md
```

## 逐条核对

| CI 检查 | 我们的状态 |
|---|---|
| 一个 PR 最多 3 条 | 1 条 |
| `package.json` 声明 `dsh.bundle` | ✅ `{ "bundle": { "patch": "./cordis.patch.yml" } }`，`cordis.patch.yml` 在仓库根 |
| 仓库创建满 1 天 | ✅ 2026-10-23，已 7 天 |
| `awesome-lint` / 站点构建 | 字段用最小集，YAML 已用 `yaml` 包解析验证 |
| `category` 在允许集内 | ✅ `identity` |
| `dsh-plugin` topic | ✅（另有 `cordis-plugin` `deepseek-harness` `prompt-management` `system-prompt`） |
| 无重复条目 | ✅ 三页 `data/plugins/` 全查过，无 `elfmingh` |
| 描述属实、无营销词 | 见下 |

**描述会是评审最认真核对的一项**，规范写得很直白：它被当作对插件的声明，并与代码
对照；夸大是让一个本来不错的插件被打回的主要原因。所以 PR 正文里主动列了一张
「每条声明对应代码的哪个位置」的表 —— 能省掉评审一轮来回。

## 各条声明的出处

| 声明 | 位置 |
|---|---|
| 全局 / 工作区 / 会话 三级档案 | `index.js` 的 library 层与 `applications.workspaces` |
| 按 `order` 注入 | 条目 `order` 字段，装配时排序 |
| 禁用 / 覆盖内置段落与运行期 context | `override.set` / `override.clear`，`layer` 取 `section` 或 `context` |
| 覆盖的逐行 diff | `client.js` 的 `diffBlocks` / `renderDiffView` |
| 子代理作用域 | 条目 `agentScope`：`main` / `subagent` / `inherit` |
| Web 面板 + `prompt_manager` 工具 | `sidebar.panellist` / `conversation.view` 槽位；工具定义 |

## 可选但没做

- **`icon:`** —— 需要 GitHub 托管的位图（png/jpg/webp），约 96px 方形最清楚，
  SVG 会被拒。我们仓库的 `icon.svg` 用不了，`docs/screenshot-panel.png` 是 2175×731
  的长条。不写则回退到作者头像，先空着。
- **`screenshots.json`** —— 规范推荐放在我们仓库 `package.json` 旁边，1–8 张图。
  不写也没关系，市场会从 README 自动抽取（我们 README 顶部就有截图）。
  想要更好的展示效果再加，这不属于本 PR 的内容。
- **`tarball:`** —— 只在自己不发 npm 时才需要，我们发了 0.4.1。

## 其他候选仓库（格式各不相同，别照抄这份）

| 仓库 | 条目格式 |
|---|---|
| awesome-deepseekharness/awesome-deepseek-harness | 两份 README 表格行 + PR 模板 |
| kejixiaoliang/awesome-dsh-plugins | `plugins/*.md` 分类文件 |
| beancookie/awesome-dsh-plugin | `data/*.json` |
| ysr666/awesome-dsh-plugin-1 | `CATALOG.md` + `data/` |
| billliao/awesome-dsh-plugin | `categories/*.md` + `data/plugins.json` |

投别家的话，标题和描述可以复用，但**格式要重新按对方规范写** —— 没有一个是
`data/plugins/*.yml`。一次一 PR、一次一条目。
