<!-- Thanks for contributing! Quick checklist / 提交前快速自查 -->

- [x] I added **one file** at `data/plugins/elfmingh__dsh-prompt-manager.yml` — that single file is the whole submission. The READMEs are untouched.
- [x] My repo's `package.json` declares **`dsh.bundle`**: `{ "bundle": { "patch": "./cordis.patch.yml" } }`, and `cordis.patch.yml` is at the repo root.
- [x] My repo is at least **1 day old** (created 2026-10-23).
- [x] `category: identity`
- [x] The description states what the plugin does, with no superlatives.
- [x] My repo has the `dsh-plugin` topic (also `cordis-plugin`, `deepseek-harness`, `prompt-management`, `system-prompt`).

**Recommended (not required) / 推荐但不强制：**

- 📦 Published to npm as `@vertixara/dsh-prompt-manager@0.4.1`; the package's `repository` field points back at this repo.
- 🔗 Official `@deepseek-ai/*` packages are declared as `peerDependencies` (`@deepseek-ai/cordis`), not `dependencies`.
- 🖼️ `docs/screenshot-panel.png` lives in the repo and is referenced from the README. No `screenshots.json` yet, so storefronts can extract from the README.

---

## Where each description claim lives / 描述与代码的对应

The entry makes four claims. Reviewing them against the source:

| Claim | Where |
| --- | --- |
| Three profile levels — global, per-workspace, per-session | `index.js`: library layers plus `applications.workspaces`; surfaced in the panel's apply tab |
| Entries injected in order | every entry carries `order`, honoured when the prompt is assembled |
| Individual builtin sections and runtime contexts can be disabled or overridden | `override.set` / `override.clear`, with `layer` set to `section` or `context` |
| A line-level diff of what an override changed | `client.js`: `diffBlocks` and `renderDiffView`, computed against the original text |
| A subagent scope per entry | `agentScope`, one of `main` / `subagent` / `inherit` |
| Managed from a Web panel and a `prompt_manager` tool | seats on `sidebar.panellist` and `conversation.view`; the `prompt_manager` tool definition |

## Not a duplicate / 与既有条目的区别

There are already prompt-related entries on the list. The differences are not cosmetic:

- `379385796-sys/dsh-prompt-inject` (and its upstream `H1a3x/dsh-prompt-inject`) manages templates at **global and workspace level**. This one adds a **session level**, **disabling or overriding builtin sections and runtime contexts**, a **subagent scope**, and a **line-level diff** for each override.
- `BrambleXu/dsh-prompt-profile` is reusable Markdown template invocation — argument substitution, per-turn model choice. This is standing injection plus rewriting of what the harness assembled.
- `Aliboder/dsh-prompt-forge` rewrites the composer draft, `Bay-Zeddie/dsh-agent-instructions` edits AGENTS.md, and `1010231693/dsh-prompt-bar` pins the first prompt above the conversation. Different jobs.

## A note on the category / 关于分类

The plugin ships a Web panel, but what it actually does is prompt delivery and rewriting at the assembly layer, so `identity` rather than `ui`. Move it if you see a closer fit — I would rather it be found than be mine.
