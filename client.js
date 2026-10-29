// Prompt Manager — Web UI half (v2).
//
// Registers three seats:
//   * sidebar.panellist  → icon button in the left column
//   * main (keyed)       → two sub-pages: the long-lived entry library, and the
//                          global / per-workspace application matrix
//   * conversation.view  → a Session tab showing the resolved prompt preview
//                          plus temporary (non-library) entries
//
// No Harness Client package is imported: controls are drawn with
// React.createElement and styled only with --dsw-alias-* theme tokens.
window.__ModuleLoader__.load({
  id: '@vertixara/dsh-prompt-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/prompt-manager/api'
    const PANEL_ID = 'prompt-manager'

    // ---------------------------------------------------------------- i18n
    //
    // 界面文案用**中文原文当 key**，只额外维护一张英文对照表。这样做的理由：
    // 重命名 key 是这类改动最容易漏的地方（改一处忘一处，界面上就冒出一个
    // 陌生的 key），而中文原文既是 key 又是默认文案，漏翻一处只是显示中文，
    // 不会显示 "ui.cancel"。同时改动面也最小 —— 纯静态文案只要外面套一层 t()。
    //
    // ## 语言从哪来
    //
    // **DSH 的界面语言不等于浏览器语言。** DSH 自己有 locale 设置（它的
    // `@deepseek-ai/dsh-client-locale` 插件）；系统是中文而 DSH 设成英文时，
    // navigator.language 仍然是 zh —— 只信它的话，插件会一直显示中文。
    //
    // 三个来源，按可信度排：
    //
    // 1. **宿主的 locale 服务**（`ctx.locale.getLocale().active`）。这是权威值，
    //    同步可读，而且它的快照在通知订阅者之前就已经更新了 —— 宿主侧边栏在
    //    语言一变就重算 `label()`，那时 getLocale() 已经是新值。
    // 2. `<html lang="…">`。locale 服务拿不到时的退路，同样同步可读。
    // 3. `navigator.language`。系统语言，只能兜底。
    //
    // 关键在于 **`t()` 必须现场读，不许缓存**。早先的写法是把语言存进一个变量、
    // 靠订阅回调去刷新它，结果宿主侧边栏的回调先跑、读到上一轮的语言，算出来的
    // 标题又和上一轮一样，被它的去重挡掉 —— 标题就永远慢一拍（切几次又反了）。
    // 现场读没有任何时序问题。
    let hostLocale = null

    const normalizeLocale = (value) => {
      const tag = String(value ?? '').trim().toLowerCase()
      if (!tag) return ''
      return tag.startsWith('zh') ? 'zh' : 'en'
    }

    function detectLocale() {
      try {
        const active = hostLocale?.getLocale?.()?.active
        const tag = normalizeLocale(active)
        if (tag) return tag
      } catch {
        /* locale 服务不可用时走下面的退路 */
      }
      try {
        const tag = normalizeLocale(document?.documentElement?.lang)
        if (tag) return tag
      } catch {
        /* 没有 document 就再退一层 */
      }
      try {
        const raw = navigator.language || navigator.userLanguage || ''
        return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    const localeStore = {
      value: detectLocale(),
      listeners: new Set(),
      subscribe(listener) {
        localeStore.listeners.add(listener)
        return () => {
          localeStore.listeners.delete(listener)
        }
      },
      get() {
        return localeStore.value
      },
      /** 由 API 响应调用。值没变就不惊动组件。 */
      set(next) {
        const value = normalizeLocale(next)
        if (!value) return
        if (value === localeStore.value) return
        localeStore.value = value
        for (const listener of [...localeStore.listeners]) listener()
      },
      /** 重新读一次当前语言，变了就叫醒组件。纯通知用途，不参与 t() 的取值。 */
      sync() {
        localeStore.set(detectLocale())
      },
    }

    /** 订阅语言变化，让组件在语言确定后重渲染一次。 */
    function useLocale() {
      return React.useSyncExternalStore(localeStore.subscribe, localeStore.get, localeStore.get)
    }

    // 用户在上层切换界面语言时，DSH 会改写 <html lang="…">。监听这个属性，
    // 切换后界面文案立刻跟着变 —— 不该要求用户重启或刷新页面。
    // 这只是让 React 那边重渲染；Host 自己渲染的标题不靠它，因为 t() 现场读。
    try {
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        const observer = new MutationObserver(() => localeStore.sync())
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      }
    } catch {
      /* 没有 DOM 就跳过；detectLocale() 下次读取时仍会兜底 */
    }

    /**
     * 中文原文 → 英文译文。缺项时回退中文原文，绝不回退成 key。
     * 含插值的文案用 `{name}` 占位，翻译时可以调整语序。
     */
    const EN = {
      " {n} 项": " {n} items",
      "，已禁用 {n}": ", {n} disabled",
      "（仅主代理）": " (main only)",
      "（仅子代理）": " (subagent only)",
      "(未知)": "(unknown)",
      "(无)": "(none)",
      "{before} → {after} 字": "{before} → {after} chars",
      "{n} 条": "{n} entries",
      "{n} 条 · 静态注册": "{n} entries · static",
      "{n} 项": "{n} items",
      "{n} 字": "{n} chars",
      "{name} · 默认": "{name} · default",
      "＋ 新建条目": "+ New entry",
      "⋯ {n} 段未变": "⋯ {n} lines unchanged",
      "按名称或内容过滤…": "Filter by name or content…",
      "把左侧条目拖到这里": "Drag entries from the left here",
      "把左侧条目拖进下面任意区块即可投放；点 chip 上的 × 移除。全局与未开后注入的工作区在会话创建时生效，开了后注入的每轮生效。": "Drag an entry from the left into any block below to apply it; click × on a chip to remove it. Global and post-injection-off workspaces take effect when a session is created; with post-injection on, it applies every turn.",
      "保存覆盖": "Save override",
      "保存修改": "Save changes",
      "保存中…": "Saving…",
      "本插件": "this plugin",
      "本次会话拉起过的子代理。「仅主代理」的条目不会进入它们，「仅子代理」的条目只进入它们。": "Subagents spawned by this session. Entries marked \"main only\" never reach them; entries marked \"subagent only\" reach only them.",
      "本会话的子代理（{n}）": "Subagents in this session ({n})",
      "本会话还没有产生过装配记录，先对话一轮再刷新。": "This session has not assembled yet — send a message, then refresh.",
      "本会话没有内置段落": "No builtin sections in this session",
      "本会话没有上下文": "No contexts in this session",
      "本会话没有生效的提示词条目": "No prompt entries active in this session",
      "本会话上下文（{n}）": "Session contexts ({n})",
      "本会话最终生效（{n} 段）": "Effective in this session ({n} sections)",
      "编辑": "Edit",
      "编辑档案：{id}": "Editing entry: {id}",
      "标题": "Title",
      "操作失败：{msg}": "Action failed: {msg}",
      "插入到系统提示词中的文本…": "Text to insert into the system prompt…",
      "当前没有选中的会话。": "No session selected.",
      "档案": "saved",
      "档案还是空的，在下面新建一条": "The library is empty — create one below",
      "档案库（{n}）": "Library ({n})",
      "第 {n} 次装配": "Assembly #{n}",
      "点「刷新预览」查看": "Click \"Refresh preview\" to view",
      "点「刷新预览」加载": "Click \"Refresh preview\" to load",
      "点击切换默认": "Click to toggle default",
      "读取": "Load",
      "读取中…": "Loading…",
      "父会话 {id}": "Parent session {id}",
      "覆盖": "Override",
      "覆盖生效中": "Override active",
      "该工作区禁用": "Disabled in this workspace",
      "改写规则已暂停，下面的禁用/覆盖都不起作用": "Rewrite rules are paused — the disables and overrides below have no effect",
      "改写规则正在生效": "Rewrite rules are active",
      "改写生效中": "Rewrite active",
      "改写已停用": "Rewrite disabled",
      "改写已停用：下面 {n} 条规则当前不生效，点右上角「启用改写」恢复。": "Rewrite is disabled: the {n} rules below are inactive. Click \"Enable rewrite\" at the top right to restore.",
      "工作区": "Workspace",
      "工作区 {path}": "Workspace {path}",
      "规则 {n} 条": "{n} rules",
      "合并文本（{n} 字）": "Merged text ({n} chars)",
      "后注入": "Post-inject",
      "后注入：关": "Post-inject: off",
      "后注入：开": "Post-inject: on",
      "恢复全部内置提示词？将清除 {n} 项规则，覆盖文本会归档，之后还能再应用。": "Restore all builtin prompts? This clears {n} rules; override text is archived and can be reapplied later.",
      "恢复原文": "Restore original",
      "会话 {id}": "Session {id}",
      "会话提示词": "Session prompt",
      "继承 {n} 条": "inherits {n}",
      "加到本会话": "Add to this session",
      "加入档案": "Add to library",
      "仅会话": "session only",
      "仅主代理": "main only",
      "仅子代理": "subagent only",
      "禁用": "Disable",
      "静态": "static",
      "可选": "optional",
      "临时": "temp",
      "临时条目": "Temporary entries",
      "临时条目（{n}）": "Temporary entries ({n})",
      "临时条目只绑定本会话，不进长期档案；会话结束后可以删除。": "Temporary entries belong to this session only and never enter the library; they can be deleted once the session ends.",
      "没有从档案继承任何条目": "No entries inherited from the library",
      "没有匹配的条目": "No matching entries",
      "内置段落（Harness 与其他插件）。这里的改动立即生效、只影响本会话 —— 代价是本会话的提示词缓存前缀会失效。": "Builtin sections (Harness and other plugins). Changes here apply immediately and only to this session — at the cost of invalidating this session's prompt cache prefix.",
      "内置与其他插件": "Builtin & other plugins",
      "内置与其他插件提示词": "Builtin and third-party plugin prompts",
      "匹配工作区: {value}": "Matched workspace: {value}",
      "启用改写": "Enable rewrite",
      "切换中…": "Switching…",
      "取消": "Cancel",
      "全部恢复": "Restore all",
      "全局": "global",
      "全局启用": "Enabled globally",
      "全局启用、工作区启用/禁用、临时条目已经合并；这里看到的就是实际注入的提示词。": "Global, per-workspace enable/disable and temporary entries are already merged; what you see here is the prompt actually injected.",
      "全局未启用": "Not enabled globally",
      "删除": "Delete",
      "删除失败：{msg}": "Delete failed: {msg}",
      "尚无工作区": "No workspaces yet",
      "生效中": "Active",
      "刷新": "Refresh",
      "刷新预览": "Refresh preview",
      "顺序": "Order",
      "搜索 id / 标题 / 内容…": "Search id / title / content…",
      "提示词": "Prompt",
      "提示词档案": "Prompt library",
      "提示词管理": "Prompt Manager",
      "提示词内容": "Prompt text",
      "添加失败：{msg}": "Add failed: {msg}",
      "停用改写": "Disable rewrite",
      "投放区": "Apply to",
      "拖到右侧投放": "Drag right to apply",
      "拖到这里 = 全局启用": "Drop here = enable globally",
      "拖到这里 = 在该工作区启用": "Drop here = enable in this workspace",
      "未发现工作区": "No workspaces found",
      "未投放": "Not applied",
      "无": "none",
      "系统提示词段落（{n} 段{suffix}）": "System prompt sections ({n}{suffix})",
      "新临时条目内容": "New temporary entry content",
      "修改覆盖": "Edit override",
      "要在当前会话立刻看到效果，去会话页单独特调（那条路即时生效、且只影响那一个会话）。总开关例外，它会立即对全部会话生效。": "To take effect immediately in the current session, tune it on the session page — that path applies at once and only to that session. The master switch is the exception: it applies to every session immediately.",
      "移除": "Remove",
      "已保存": "Saved",
      "已保存的覆盖文本": "Saved override text",
      "已覆盖": "Overridden",
      "已覆盖 {n}": "Overridden {n}",
      "已禁用": "Disabled",
      "已禁用 {n}": "Disabled {n}",
      "已删除 {id}": "Deleted {id}",
      "已添加临时条目（不进档案）": "Temporary entry added (not saved to library)",
      "应用": "Apply",
      "预览失败：{msg}": "Preview failed: {msg}",
      "暂无临时条目": "No temporary entries",
      "这里的改动是全局的，只对新建会话生效 —— 中途改提示词会让服务端缓存前缀整段失效，所以不让它追杀运行中的会话。": "Changes here are global and only affect new sessions — editing prompts mid-flight invalidates the whole cached prefix, so running sessions are deliberately left alone.",
      "这里的禁用与覆盖只作用于本会话，不影响其他会话。": "Disables and overrides here apply to this session only and do not affect others.",
      "这里列的是 agent 真实装配出的内容：Harness 内置段落、其他插件注册的段落与 context、以及全部工具。每条可单独「禁用」或「覆盖」，覆盖会显示原文与应用文本的对照。": "These are the contents the agent actually assembled: Harness builtin sections, sections and contexts registered by other plugins, and every tool. Each one can be disabled or overridden individually; an override shows the original against the applied text.",
      "这些是随本次会话动态生成的运行时信息：工作目录、沙箱策略、审批策略、插件注入的会话窗口等。": "Runtime information generated per session: working directory, sandbox policy, approval policy, plugin-injected session windows and so on.",
      "只显示改动处": "Changed lines only",
      "只影响当前会话的一段提示词…": "A prompt spanning only the current session…",
      "只注入主代理会话，它派生的子代理看不到": "Injected into the main session only; subagents it spawns never see it",
      "只注入子代理会话，主代理看不到": "Injected into subagent sessions only; the main agent never sees it",
      "重新开启": "Re-enable",
      "主+子代理": "main + subagent",
      "主代理 + 子代理（默认）": "Main + subagent (default)",
      "主代理 = 当前这个会话；子代理 = 它派生的子任务": "Main = this session; subagent = sub-tasks it spawns",
      "主代理 = 你直接对话的会话；子代理 = 它派生的子任务": "Main = the session you talk to; subagent = sub-tasks it spawns",
      "主代理和它派生的子代理都会注入": "Injected into the main agent and every subagent it spawns",
      "主代理会话": "Main session",
      "主页的改动则只对新会话生效。": "Changes on the home page only affect new sessions.",
      "注入给谁": "Inject into",
      "子代理会话": "Subagent session",
      "contexts（工作目录、沙箱策略、插件注入的运行时信息等）每个会话都不同，改写规则也按会话隔离，已移到各会话的「提示词」页查看与改写。": "Contexts (working directory, sandbox policy, plugin-injected runtime info) differ per session and their rewrite rules are isolated per session; they moved to each session's \"Prompt\" page.",
      "sections {sections} 段 · {chars} 字": "sections {sections} · {chars} chars",
      "tools（只读）": "tools (read-only)",
      "展开全文": "Show full text",
      "收起": "Collapse",
    }

    function t(text, params) {
      // 现场读宿主当前的 locale，不读那份给 React 用的缓存 —— 见 detectLocale 的说明。
      let out = detectLocale() === 'en' ? (EN[text] ?? text) : text
      if (params) {
        for (const key of Object.keys(params)) {
          out = out.split(`{${key}}`).join(String(params[key]))
        }
      }
      return out
    }

    // ---------------------------------------------------------------- data

    async function requestJson(url, init) {
      const response = await fetch(url, init)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function loadBoard() {
      // 把当前语言带给 host：它要据此生成 summary 和各类错误消息。
      // 不传的话 host 只能从配置里猜，而用户在界面上切换语言并不会改配置文件。
      const url = `${API}?lang=${encodeURIComponent(detectLocale())}`
      return requestJson(url, { headers: { accept: 'application/json' } }).then((data) => {
        // **不要**用 data.locale 回写 localeStore。
        //
        // host 那个值来自 profile 的 cordis.patch.yml，是配置里写的偏好，不是
        // 用户此刻在界面上的选择 —— 用户在界面上切过语言之后，两者就会不一致，
        // 回写会把本地正确的检测覆盖成旧值（界面明明中文，侧边栏却显示 Prompt）。
        // locale 服务和 <html lang> 才是实时来源，只信它们。
        return data
      })
    }

    function mutate(payload) {
      // 同样带上语言：写操作的返回文案（已创建 / 各类错误）由 host 生成。
      const url = `${API}?lang=${encodeURIComponent(detectLocale())}`
      return requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    const EMPTY_APPLICATIONS = { global: { enabled: [] }, workspaces: {} }

    // 工作区配置的 key 在 Host 侧是归一化的小写正斜杠路径；UI 里显示的是原始
    // 目录字符串，查表前必须归一化，否则永远查不到（会误显示为"未设置"）。
    function normalizePath(value) {
      return String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
    }

    // --------------------------------------------------------------- styles

    const S = {
      page: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        height: '100%',
        overflowY: 'auto',
        padding: '24px 28px 40px',
        color: 'var(--dsw-alias-label-primary)',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.4 },
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: 1.6, margin: 0 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px', margin: 0 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      tabBar: {
        display: 'flex',
        gap: '6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        paddingBottom: '8px',
        flexWrap: 'wrap',
      },
      tab: (active) => ({
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: active ? 600 : 400,
        padding: '6px 12px',
      }),
      row: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 160px', minWidth: '140px' },
      label: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      summary: {
        cursor: 'pointer',
        padding: '2px 0',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        padding: '7px 9px',
        outline: 'none',
      },
      button: {
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        padding: '7px 14px',
      },
      buttonPrimary: {
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        padding: '7px 14px',
      },
      buttonTiny: {
        boxSizing: 'border-box',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 9px',
      },
      chip: (active) => ({
        boxSizing: 'border-box',
        borderRadius: '6px',
        border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: active ? 600 : 400,
        padding: '3px 9px',
      }),
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-base)',
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      itemHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      itemTitle: { fontSize: '13px', fontWeight: 600 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      text: {
        margin: 0,
        fontSize: '12.5px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      badge: (on) => ({
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        border: `1px solid ${on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'}`,
        color: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      tag: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tagOn: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      tagOff: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      tagOver: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      itemOff: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-base)',
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      strike: {
        textDecoration: 'line-through',
        opacity: 0.7,
      },
      textApplied: {
        margin: 0,
        fontSize: '12.5px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-state-warn-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      diffBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        padding: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '13px',
        textAlign: 'center',
      },
    }

    // ----------------------------------------------------------- components

    /**
     * 长正文 + 展开控件。
     *
     * 截断只发生在显示层：数据、提交、diff 用的都是原文，所以展开看到的就是真正
     * 存着的内容，不会因为「展开」而多出或少掉字符。
     *
     * 展开状态是组件内部的，切语言、重渲染、拖动都不会丢。展开后不设高度上限 ——
     * 套一个可滚动的容器就变成「换个地方截断」了，用户会以为内容只有这么多。
     */
    function ClampedText(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text ?? '')
      const limit = props.limit
      const truncated = text.length > limit
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 } },
        h('p', { style: props.style }, open || !truncated ? text : `${text.slice(0, limit)}…`),
        truncated
          ? h('button', {
            type: 'button',
            style: { ...S.buttonTiny, alignSelf: 'flex-start' },
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          }, open ? t('收起') : t('展开全文'))
          : null)
    }

    // 作用范围：三个值都给标签，列表上一眼能看出条目投给谁（选「继承」时也有标签，
    // 否则等于看不出来）。解释走 title tooltip，不占版面。
    //
    // 必须是函数而不是模块级常量：t() 在模块加载时求值的话，那时 DSH 的语言还没
    // 从 API 回来，标签会永久停在浏览器语言上 —— 界面其它地方都切英文了，只有
    // 这几个标签还是中文。
    function agentScopeMeta(scope) {
      const table = {
        inherit: { label: t('主+子代理'), title: t('主代理和它派生的子代理都会注入') },
        main: { label: t('仅主代理'), title: t('只注入主代理会话，它派生的子代理看不到') },
        subagent: { label: t('仅子代理'), title: t('只注入子代理会话，主代理看不到') },
      }
      return table[scope] ?? table.inherit
    }

    function scopeTag(scope) {
      const meta = agentScopeMeta(scope)
      return h('span', { style: S.tag, title: meta.title }, meta.label)
    }

    function Field(props) {
      return h('label', { style: S.field },
        h('span', {
          style: props.title
            ? { ...S.label, cursor: 'help', borderBottom: '1px dotted var(--dsw-alias-border-l2)' }
            : S.label,
          title: props.title,
        }, props.label),
        props.children)
    }

    function useBoard(options) {
      // 宿主把非活动的页**隐藏**而不是卸载，组件不会重新挂载，所以「打开面板」
      // 并不等于「重新执行加载」。只靠挂载时加载一次的话，面板会一直显示上一次
      // 的数据，直到用户切一次会话把它卸载重建 —— 用户看到一个过时的摘要，
      // 却没有任何提示。
      //
      // 两个补充时机：
      //   1. active 变成 true（宿主若提供这个 prop）
      //   2. 页面重新可见（从别的标签页/窗口切回来）
      const active = options?.active
      const initial = {
        loading: true,
        error: '',
        file: '',
        summary: '',
        entries: [],
        applications: EMPTY_APPLICATIONS,
        temporary: [],
        workspaces: [],
      }
      const [state, setState] = React.useState(initial)
      const apply = React.useCallback((data) => {
        setState({
          loading: false,
          error: '',
          file: data?.file || '',
          summary: data?.summary || '',
          entries: Array.isArray(data?.entries) ? data.entries : [],
          applications: data?.applications && data.applications.global
            ? data.applications
            : EMPTY_APPLICATIONS,
          temporary: Array.isArray(data?.temporary) ? data.temporary : [],
          workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
        })
      }, [])
      const refresh = React.useCallback(async () => {
        try {
          apply(await loadBoard())
        } catch (failure) {
          setState((previous) => ({ ...previous, loading: false, error: String(failure?.message ?? failure) }))
        }
      }, [apply])
      React.useEffect(() => {
        // active === false 表示这个页当前不可见，没必要拉数据。
        // active 变化（false → true）时会重新跑，这就是「切回面板就刷新」。
        if (active === false) return undefined
        let alive = true
        loadBoard()
          .then((data) => {
            if (alive) apply(data)
          })
          .catch((failure) => {
            if (alive) {
              setState((previous) => ({ ...previous, loading: false, error: String(failure?.message ?? failure) }))
            }
          })
        return () => {
          alive = false
        }
      }, [apply, active])

      // 从别的标签页/窗口切回来时也刷新一次。
      React.useEffect(() => {
        const onVisibility = () => {
          if (typeof document === 'undefined') return
          if (document.visibilityState === 'visible') refresh()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [refresh])

      // 面板真正出现在屏幕上时刷新。
      //
      // 宿主把非活动页隐藏而不是卸载，组件不重挂载，上面的挂载加载就不会重跑；
      // 而 `props.active` 是否传递取决于宿主实现（同 profile 的 task-board 也没用
      // 它）。IntersectionObserver 不依赖任何宿主契约 —— 元素真的显示出来了才算数，
      // 所以「切回这个面板」和「打开应用时它在默认页」两种情况都能覆盖。
      const containerRef = React.useRef(null)
      const wasVisible = React.useRef(false)
      React.useEffect(() => {
        const node = containerRef.current
        if (!node || typeof IntersectionObserver === 'undefined') return undefined
        const observer = new IntersectionObserver((records) => {
          const visible = records.some((record) => record.isIntersecting)
          // 只在「从不可见变为可见」时刷新，避免持续可见时反复拉数据。
          if (visible && !wasVisible.current) refresh()
          wasVisible.current = visible
        }, { threshold: 0.01 })
        observer.observe(node)
        return () => {
          observer.disconnect()
          wasVisible.current = false
        }
      }, [refresh])

      return [state, refresh, apply, containerRef]
    }

    function UsageTags(props) {
      const applications = props.applications || EMPTY_APPLICATIONS
      const globalOn = applications.global.enabled.includes(props.entryId)
      const spaces = Object.entries(applications.workspaces)
        .filter(([, config]) => config.enabled.includes(props.entryId) || config.default.includes(props.entryId))
        .map(([key]) => key)
      return h('span', { style: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' } },
        h('span', { style: S.badge(globalOn) }, globalOn ? t('全局启用') : t('全局未启用')),
        spaces.map((key) => h('span', { key, style: S.tag }, t('工作区 {path}', { path: key }))))
    }

    function LibraryForm(props) {
      const editing = props.entry || null
      const [id, setId] = React.useState(editing?.id || '')
      const [title, setTitle] = React.useState(editing?.title || '')
      const [order, setOrder] = React.useState(String(editing?.order ?? 9000))
      const [agentScope, setAgentScope] = React.useState(editing?.agentScope || 'inherit')
      const [text, setText] = React.useState(editing?.text || '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        setId(editing?.id || '')
        setTitle(editing?.title || '')
        setOrder(String(editing?.order ?? 9000))
        setAgentScope(editing?.agentScope || 'inherit')
        setText(editing?.text || '')
      }, [editing])

      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const data = await mutate({
            action: editing ? 'library.update' : 'library.add',
            id: id.trim(),
            title: title.trim() || undefined,
            order: Number(order),
            agentScope,
            text,
          })
          props.onSaved?.(data)
          if (!editing) {
            setId('')
            setTitle('')
            setText('')
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: S.row },
          h(Field, { label: 'ID' }, h('input', {
            style: S.input, value: id, disabled: Boolean(editing), placeholder: 'rule-id',
            onChange: (event) => setId(event.target.value),
          })),
          h(Field, { label: t('标题') }, h('input', {
            style: S.input, value: title, placeholder: t('可选'),
            onChange: (event) => setTitle(event.target.value),
          })),
          h(Field, { label: t('顺序') }, h('input', {
            style: S.input, value: order, inputMode: 'numeric',
            onChange: (event) => setOrder(event.target.value),
          })),
          h(Field, {
            label: t('注入给谁'),
            title: t('主代理 = 你直接对话的会话；子代理 = 它派生的子任务'),
          }, h('select', {
            style: S.input,
            value: agentScope,
            onChange: (event) => setAgentScope(event.target.value),
          },
            h('option', { value: 'inherit' }, t('主代理 + 子代理（默认）')),
            h('option', { value: 'main' }, t('仅主代理')),
            h('option', { value: 'subagent' }, t('仅子代理'))))),
        h(Field, { label: t('提示词内容') }, h('textarea', {
          style: { ...S.input, minHeight: '84px', resize: 'vertical', fontFamily: 'inherit' },
          value: text,
          placeholder: t('插入到系统提示词中的文本…'),
          onChange: (event) => setText(event.target.value),
        })),
        error ? h('p', { style: S.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', {
            type: 'button', style: S.buttonPrimary,
            disabled: busy || !id.trim() || !text.trim(),
            onClick: submit,
          }, busy ? t('保存中…') : editing ? t('保存修改') : t('加入档案')),
          props.onCancel
            ? h('button', { type: 'button', style: S.button, onClick: props.onCancel }, t('取消'))
            : null))
    }

    function Chip(props) {
      return h('span', {
        style: {
          alignItems: 'center',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '999px',
          color: 'var(--dsw-alias-label-primary)',
          display: 'inline-flex',
          fontSize: '12px',
          gap: '4px',
          padding: '2px 2px 2px 10px',
        },
      },
        h('span', {
          onClick: props.onActivate,
          title: props.hint || '',
          style: { cursor: props.onActivate ? 'pointer' : 'default' },
        }, props.label),
        h('button', {
          type: 'button',
          title: t('移除'),
          onClick: props.onRemove,
          style: {
            background: 'transparent',
            border: 'none',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: '13px',
            lineHeight: 1,
            padding: '0 5px',
          },
        }, '×'))
    }

    function DropZone(props) {
      const active = props.active === true
      const kids = Array.isArray(props.children) ? props.children : (props.children ? [props.children] : [])
      return h('div', {
        onDragOver: (event) => {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          props.onHover?.(true)
        },
        onDragLeave: () => props.onHover?.(false),
        onDrop: (event) => {
          event.preventDefault()
          props.onHover?.(false)
          const id = event.dataTransfer?.getData('text/plain') || ''
          if (id) props.onDrop?.(id)
        },
        style: {
          alignItems: 'center',
          background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          border: `1px dashed ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          borderRadius: '10px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          minHeight: '52px',
          padding: '12px',
          transition: 'border-color 120ms ease',
        },
      },
        kids.length ? kids : h('span', { style: S.meta }, props.empty || t('把左侧条目拖到这里')))
    }

    function LibraryPane(props) {
      const state = props.state
      const applications = state.applications || EMPTY_APPLICATIONS
      const [editing, setEditing] = React.useState(null)
      const [busyId, setBusyId] = React.useState('')
      const query = String(props.query || '').trim().toLowerCase()
      const visible = query
        ? state.entries.filter((entry) => (
          String(entry.id).toLowerCase().includes(query)
          || String(entry.title || '').toLowerCase().includes(query)
          || String(entry.text || '').toLowerCase().includes(query)))
        : state.entries

      const remove = async (entry) => {
        setBusyId(entry.id)
        try {
          props.apply(await mutate({ action: 'library.remove', id: entry.id }))
          props.notify(t('已删除 {id}', { id: entry.id }))
        } catch (failure) {
          props.notify(t('删除失败：{msg}', { msg: failure?.message ?? failure }))
        } finally {
          setBusyId('')
        }
      }

      const form = h(LibraryForm, {
        entry: editing,
        onSaved: (data) => {
          setEditing(null)
          props.apply(data)
          props.notify(data?.message || t('已保存'))
        },
        onCancel: editing ? () => setEditing(null) : undefined,
      })

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.cardTitle }, t('档案库（{n}）', { n: state.entries.length })),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.meta }, t('拖到右侧投放'))),

        h('input', {
          style: S.input,
          placeholder: t('搜索 id / 标题 / 内容…'),
          value: props.query,
          onChange: (event) => props.setQuery(event.target.value),
        }),

        state.entries.length === 0
          ? h('div', { style: S.empty }, state.loading ? t('读取中…') : t('档案还是空的，在下面新建一条'))
          : visible.length === 0
            ? h('div', { style: S.empty }, t('没有匹配的条目'))
            : h('div', { style: S.list }, visible.map((entry) => {
              const globalOn = applications.global.enabled.includes(entry.id)
              return h('div', {
                key: entry.id,
                draggable: true,
                onDragStart: (event) => {
                  event.dataTransfer?.setData('text/plain', entry.id)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
                },
                style: { ...S.item, cursor: 'grab' },
              },
                h('div', { style: S.itemHead },
                  h('span', { style: S.itemTitle }, entry.title || entry.id),
                  h('span', { style: S.mono }, entry.id),
                  h('span', { style: S.badge(globalOn) }, globalOn ? t('全局') : t('未投放')),
                  scopeTag(entry.agentScope),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', style: S.buttonTiny, onClick: () => setEditing(entry) }, t('编辑')),
                  h('button', {
                    type: 'button', style: S.buttonTiny,
                    disabled: busyId === entry.id,
                    onClick: () => remove(entry),
                  }, t('删除'))),
                h(ClampedText, { text: entry.text, limit: 160, style: S.text }))
            })),

        editing
          ? h('section', { style: { ...S.card, marginTop: '4px' } },
            h('h3', { style: S.cardTitle }, t('编辑档案：{id}', { id: editing.id })),
            form)
          : h('details', { style: S.item },
            h('summary', { style: { cursor: 'pointer', fontSize: '13px', fontWeight: 600 } }, t('＋ 新建条目')),
            h('div', { style: { paddingTop: '10px' } }, form)))
    }

    function ApplyPane(props) {
      const state = props.state
      const applications = state.applications || EMPTY_APPLICATIONS
      const configured = Object.keys(applications.workspaces)
      const candidates = []
      const seenPaths = new Set()
      const pushCandidate = (value) => {
        const key = normalizePath(value)
        if (!key || seenPaths.has(key)) return
        seenPaths.add(key)
        candidates.push(value)
      }
      for (const workspace of state.workspaces) pushCandidate(workspace.path)
      for (const key of configured) pushCandidate(key)
      const active = props.workspacePath || configured[0] || candidates[0] || ''
      const config = applications.workspaces[normalizePath(active)] || { enabled: [], disabled: [], default: [], hotReload: false }
      const byId = new Map(state.entries.map((entry) => [entry.id, entry]))
      const label = (id) => byId.get(id)?.title || id
      const globalIds = applications.global.enabled.slice()
      const workspaceIds = [...config.default, ...config.enabled.filter((id) => !config.default.includes(id))]

      const toggle = async (id, scope, enabled) => {
        try {
          props.apply(await mutate({
            action: 'apply.toggle',
            id,
            scope,
            workspacePath: scope === 'workspace' ? active : undefined,
            enabled,
          }))
        } catch (failure) {
          props.notify(t('操作失败：{msg}', { msg: failure?.message ?? failure }))
        }
      }

      const toggleHotReload = async (enabled) => {
        try {
          props.apply(await mutate({ action: 'apply.hotReload', workspacePath: active, enabled }))
        } catch (failure) {
          props.notify(t('操作失败：{msg}', { msg: failure?.message ?? failure }))
        }
      }

      // 点击工作区里的 chip 切换「默认」标记：默认组会随会话创建一起注入。
      const markDefault = async (id, isDefault) => {
        try {
          props.apply(await mutate({ action: 'apply.default', id, workspacePath: active, isDefault }))
        } catch (failure) {
          props.notify(t('操作失败：{msg}', { msg: failure?.message ?? failure }))
        }
      }

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.cardTitle }, t('投放区')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.buttonTiny, onClick: props.onRefresh }, t('刷新'))),

        h('p', { style: S.hint },
          t('把左侧条目拖进下面任意区块即可投放；点 chip 上的 × 移除。全局与未开后注入的工作区在会话创建时生效，开了后注入的每轮生效。')),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
          h('div', null,
            h('div', { style: S.itemHead },
              h('span', { style: S.label }, t('全局')),
              h('span', { style: S.meta }, t('{n} 条 · 静态注册', { n: globalIds.length }))),
            h(DropZone, {
              active: props.dragOver === 'global',
              empty: t('拖到这里 = 全局启用'),
              onHover: (on) => props.setDragOver(on ? 'global' : ''),
              onDrop: (id) => toggle(id, 'global', true),
            }, globalIds.map((id) => h(Chip, {
              key: id,
              label: label(id),
              onRemove: () => toggle(id, 'global', false),
            })))),

          h('div', null,
            h('div', { style: S.itemHead },
              h('span', { style: S.label }, t('工作区')),
              h('span', { style: { flex: 1 } }),
              h('select', {
                style: { ...S.input, width: 'auto', maxWidth: '320px' },
                value: active,
                onChange: (event) => props.setWorkspacePath(event.target.value),
              },
              candidates.length === 0
                ? h('option', { value: '' }, t('尚无工作区'))
                : candidates.map((path) => h('option', { key: path, value: path }, path))),
              h('button', {
                type: 'button',
                style: S.chip(config.hotReload === true),
                onClick: () => toggleHotReload(config.hotReload !== true),
              }, config.hotReload === true ? t('后注入：开') : t('后注入：关'))),

            active
              ? h(DropZone, {
                active: props.dragOver === 'workspace',
                empty: t('拖到这里 = 在该工作区启用'),
                onHover: (on) => props.setDragOver(on ? 'workspace' : ''),
                onDrop: (id) => toggle(id, 'workspace', true),
              }, workspaceIds.map((id) => h(Chip, {
                key: id,
                label: config.default.includes(id) ? t('{name} · 默认', { name: label(id) }) : label(id),
                hint: t('点击切换默认'),
                onActivate: () => markDefault(id, !config.default.includes(id)),
                onRemove: () => toggle(id, 'workspace', false),
              })))
              : h('div', { style: S.empty }, t('未发现工作区')),

            config.disabled.length > 0
              ? h('div', { style: { marginTop: '10px' } },
                h('span', { style: S.label }, t('该工作区禁用')),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
                  config.disabled.map((id) => h(Chip, {
                    key: id,
                    label: label(id),
                    onRemove: () => toggle(id, 'workspace', true),
                  }))))
              : null)))
    }

    const PROMOTED_PREFIX = 'prompt-manager:'
    const EMPTY_OVERRIDES = { enabled: false, sections: {}, contexts: {}, saved: [] }

    function BuiltinSectionsCard() {
      const [state, setState] = React.useState({
        loading: false,
        loaded: false,
        error: '',
        scope: '',
        sessionId: '',
        sections: [],
        contexts: [],
        tools: [],
        injected: [],
        overrides: EMPTY_OVERRIDES,
        disabledSections: [],
        disabledContexts: [],
        reason: '',
        revision: 0,
      })
      const [query, setQuery] = React.useState('')
      const [editing, setEditing] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, loading: true, error: '' }))
        try {
          const data = await requestJson(`${API}?view=assembled`, { headers: { accept: 'application/json' } })
          setState({
            loading: false,
            loaded: true,
            error: '',
            scope: String(data.scope || ''),
            sessionId: String(data.sessionId || ''),
            sections: (Array.isArray(data.sections) ? data.sections : []).map((item) => ({ ...item, layer: 'section' })),
            contexts: (Array.isArray(data.contexts) ? data.contexts : []).map((item) => ({ ...item, layer: 'context' })),
            tools: Array.isArray(data.tools) ? data.tools : [],
            injected: Array.isArray(data.injected) ? data.injected : [],
            overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : EMPTY_OVERRIDES,
            disabledSections: Array.isArray(data.disabledSections) ? data.disabledSections : [],
            disabledContexts: Array.isArray(data.disabledContexts) ? data.disabledContexts : [],
            reason: typeof data.reason === 'string' ? data.reason : '',
            revision: Number(data.revision ?? 0),
          })
        } catch (failure) {
          setState({
            loading: false,
            loaded: false,
            error: String(failure?.message ?? failure),
            scope: '',
            sessionId: '',
            sections: [],
            contexts: [],
            tools: [],
            injected: [],
            overrides: EMPTY_OVERRIDES,
            disabledSections: [],
            disabledContexts: [],
            reason: '',
            revision: 0,
          })
        }
      }, [])

      // 打开页签就自动读一次，避免用户看到空白以为坏了。
      React.useEffect(() => {
        load()
      }, [load])

      const overrides = state.overrides || EMPTY_OVERRIDES
      const rules = overrides.sections || {}
      const contextRules = overrides.contexts || {}
      const disabledNames = [...state.disabledSections]
      const savedOverrides = Array.isArray(overrides.saved) ? overrides.saved : []
      const allOverrideRules = { ...rules, ...contextRules }
      const offCount = Object.values(allOverrideRules).filter((entry) => entry?.mode === 'disable').length
      const overCount = Object.values(allOverrideRules).filter((entry) => entry?.mode === 'replace').length
      const rulesActive = overrides.enabled === true

      const run = async (label, payload) => {
        setBusy(label)
        try {
          await mutate(payload)
          await load()
        } catch (failure) {
          setState((previous) => ({ ...previous, error: String(failure?.message ?? failure) }))
        } finally {
          setBusy('')
        }
      }

      const q = query.trim().toLowerCase()
      const match = (item) => !q
        || String(item.name || '').toLowerCase().includes(q)
        || String(item.text ?? item.description ?? '').toLowerCase().includes(q)
      const allSections = [
        ...state.sections,
        ...state.injected.map((item) => ({ ...item, origin: 'injected' })),
      ]
      const sections = allSections.filter(match)
      const tools = state.tools.filter(match)
      const totalChars = allSections.reduce((sum, item) => sum + String(item.text || '').length, 0)

      const group = (title, items, render, collapsible) => {
        const head = h('div', { style: S.itemHead },
          h('span', { style: S.label }, title),
          h('span', { style: S.meta }, t('{n} 项', { n: items.length })))
        const body = items.length === 0
          ? h('div', { style: S.empty }, t('无'))
          : h('div', { style: S.list }, items.map(render))
        if (!collapsible) {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, head, body)
        }
        // 默认收起；有过滤词时强制展开，避免搜到了却看不见。
        return h('details', { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, open: query.trim() ? true : undefined },
          h('summary', { style: S.summary },
            h('span', { style: S.label }, title),
            h('span', { style: S.meta }, t(' {n} 项', { n: items.length })) ),
          body)
      }

      const renderEntry = (item, index) => renderPromptEntry(item, index, {
        layerRules: item.layer === 'context' ? contextRules : rules,
        layerArg: item.layer === 'context' ? 'context' : 'section',
        busy,
        editing,
        draft,
        setEditing,
        setDraft,
        run,
        sessionScoped: false,
      })

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.cardTitle }, t('内置与其他插件提示词')),
          state.loaded && state.revision ? h('span', { style: S.meta }, t('第 {n} 次装配', { n: state.revision })) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.buttonTiny, onClick: load }, state.loading ? t('读取中…') : state.loaded ? t('刷新') : t('读取'))),

        h('p', { style: S.hint },
          t('这里列的是 agent 真实装配出的内容：Harness 内置段落、其他插件注册的段落与 context、以及全部工具。每条可单独「禁用」或「覆盖」，覆盖会显示原文与应用文本的对照。')),
        h('p', { style: S.hint },
          t('这里的改动是全局的，只对新建会话生效 —— 中途改提示词会让服务端缓存前缀整段失效，所以不让它追杀运行中的会话。')
          + t('要在当前会话立刻看到效果，去会话页单独特调（那条路即时生效、且只影响那一个会话）。总开关例外，它会立即对全部会话生效。')),

        !rulesActive && (offCount + overCount) > 0
          ? h('p', { style: { ...S.error, fontWeight: 600 } },
            t('改写已停用：下面 {n} 条规则当前不生效，点右上角「启用改写」恢复。', { n: offCount + overCount }))
          : null,

        state.error ? h('p', { style: S.error }, state.error) : null,
        state.reason ? h('p', { style: S.hint }, state.reason) : null,

        state.loaded
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            h('div', { style: S.itemHead },
              h('span', { style: S.meta }, t('sections {sections} 段 · {chars} 字', { sections: allSections.length, chars: totalChars })),
              h('span', { style: S.meta }, `tools ${state.tools.length}`),
              offCount > 0 ? h('span', { style: S.tagOff }, t('已禁用 {n}', { n: offCount })) : null,
              overCount > 0 ? h('span', { style: S.tagOver }, t('已覆盖 {n}', { n: overCount })) : null,
              h('span', { style: { flex: 1 } }),
              h('span', {
                style: rulesActive ? S.tagOn : S.tagOff,
                title: rulesActive
                  ? t('改写规则正在生效')
                  : t('改写规则已暂停，下面的禁用/覆盖都不起作用'),
              }, rulesActive ? t('改写生效中') : t('改写已停用')),
              h('button', {
                type: 'button',
                style: rulesActive ? S.buttonTiny : S.buttonPrimary,
                disabled: busy === 'master',
                onClick: () => run('master', { action: 'override.toggle', enabled: !rulesActive }),
              }, busy === 'master' ? t('切换中…') : rulesActive ? t('停用改写') : t('启用改写')),
              h('span', { style: S.meta }, t('规则 {n} 条', { n: offCount + overCount })),
              h('button', {
                type: 'button',
                style: S.buttonTiny,
                disabled: busy === 'reset',
                onClick: () => {
                  const total = Object.keys(rules).length + Object.keys(contextRules).length
                  if (!total) return
                  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                    && !window.confirm(t('恢复全部内置提示词？将清除 {n} 项规则，覆盖文本会归档，之后还能再应用。', { n: total }))) return
                  run('reset', { action: 'override.reset' })
                },
              }, t('全部恢复'))),

            h('input', {
              style: S.input,
              placeholder: t('按名称或内容过滤…'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),

            group('sections', sections, renderEntry),

            h('p', { style: S.hint },
              t('contexts（工作目录、沙箱策略、插件注入的运行时信息等）每个会话都不同，改写规则也按会话隔离，已移到各会话的「提示词」页查看与改写。')),

            disabledNames.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('div', { style: S.itemHead },
                  h('span', { style: S.label }, t('已禁用')),
                  h('span', { style: S.meta }, t('{n} 项', { n: disabledNames.length }))),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                  disabledNames.map((name) => h('span', { key: name, style: S.tag }, name))))
              : null,

            savedOverrides.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: S.itemHead },
                  h('span', { style: S.label }, t('已保存的覆盖文本')),
                  h('span', { style: S.meta }, t('{n} 条', { n: savedOverrides.length }))),
                h('div', { style: S.list }, savedOverrides.map((item) => {
                  const text = String(item.text || '')
                  return h('div', { key: item.id, style: S.item },
                    h('div', { style: S.itemHead },
                      h('span', { style: S.itemTitle }, item.name),
                      h('span', { style: S.tag }, item.layer === 'contexts' ? 'context' : 'section'),
                      item.sessionId ? h('span', { style: S.tag }, t('仅会话')) : null,
                      h('span', { style: S.meta }, t('{n} 字', { n: text.length })),
                      h('span', { style: { flex: 1 } }),
                      h('button', {
                        type: 'button',
                        style: S.buttonTiny,
                        disabled: busy === item.id,
                        onClick: () => run(item.id, { action: 'override.restore', id: item.id }),
                      }, t('应用')),
                      h('button', {
                        type: 'button',
                        style: S.buttonTiny,
                        disabled: busy === item.id,
                        onClick: () => run(item.id, { action: 'override.forget', id: item.id }),
                      }, t('删除'))),
                    h(ClampedText, { text, limit: 160, style: S.text }))
                })))
              : null,

            group(t('tools（只读）'), tools, (item) => h('div', { key: item.name, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: S.itemTitle }, item.name),
                h('span', { style: S.mono }, (item.parameterKeys || []).join(', '))),
              h('p', { style: S.text }, item.description)), true))
          : null)
    }

    // --- diff:start ---
    // 覆盖效果的逐行比对。段落正文是自由文本，所以粒度做到"行 + 行内的那一段改动"：
    // 行级用 LCS 找出真正变化的行，行内用公共前后缀剥离出改动中段，未变的行折叠掉。
    function diffLines(before, after) {
      const a = String(before ?? '').split('\n')
      const b = String(after ?? '').split('\n')
      // 规模过大时退化成整段替换，避免 O(n*m) 把界面卡住。
      if (a.length * b.length > 400000) {
        return [
          ...a.map((text) => ({ type: 'del', text })),
          ...b.map((text) => ({ type: 'add', text })),
        ]
      }
      const lcs = []
      for (let i = 0; i <= a.length; i += 1) lcs.push(new Array(b.length + 1).fill(0))
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          lcs[i][j] = a[i] === b[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
      }
      const rows = []
      let i = 0
      let j = 0
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          rows.push({ type: 'same', text: a[i] })
          i += 1
          j += 1
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
          rows.push({ type: 'del', text: a[i] })
          i += 1
        } else {
          rows.push({ type: 'add', text: b[j] })
          j += 1
        }
      }
      while (i < a.length) {
        rows.push({ type: 'del', text: a[i] })
        i += 1
      }
      while (j < b.length) {
        rows.push({ type: 'add', text: b[j] })
        j += 1
      }
      return rows
    }

    /** 单行内的改动：剥掉公共前缀和后缀，只把中间真正变了的部分标出来。 */
    function diffInline(before, after) {
      const a = String(before ?? '')
      const b = String(after ?? '')
      let start = 0
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1
      let endA = a.length
      let endB = b.length
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1
        endB -= 1
      }
      return [
        { type: 'same', text: a.slice(0, start) },
        { type: 'del', text: a.slice(start, endA) },
        { type: 'add', text: b.slice(start, endB) },
        { type: 'same', text: a.slice(endA) },
      ].filter((part) => part.text.length > 0)
    }

    /** 把连续的增删行收成一个替换块，块内新旧行按位置配对。 */
    function diffBlocks(rows) {
      const blocks = []
      let current = null
      for (const row of rows) {
        if (row.type === 'same') {
          current = null
          blocks.push({ type: 'same', text: row.text })
          continue
        }
        if (!current) {
          current = { type: 'change', del: [], add: [] }
          blocks.push(current)
        }
        if (row.type === 'del') current.del.push(row.text)
        else current.add.push(row.text)
      }
      return blocks
    }
    /** 渲染逐行 diff：变化行标色并做行内高亮，未变的段落只留上下文、其余折叠。 */
    function renderDiffView(before, after) {
      const blocks = diffBlocks(diffLines(before, after))
      // 只保留变化块以及它们前后各一个未变块当上下文，其余折叠。
      const keep = new Set()
      blocks.forEach((block, index) => {
        if (block.type === 'same') return
        keep.add(index)
        if (index > 0) keep.add(index - 1)
        if (index + 1 < blocks.length) keep.add(index + 1)
      })

      const nodes = []
      let skipped = 0
      const flush = () => {
        if (!skipped) return
        nodes.push(h('div', {
          key: `gap-${nodes.length}`,
          style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', padding: '1px 8px' },
        }, t('⋯ {n} 段未变', { n: skipped })))
        skipped = 0
      }
      const row = (mark, children, tone, key) => h('div', {
        key,
        style: {
          // 新增内容用黄色（覆盖），删除内容用红色，都跟随主题 token。
          background: tone === 'add'
            ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent)'
            : tone === 'del'
              ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent)'
              : 'transparent',
          color: tone === 'same' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
          display: 'flex',
          fontSize: '11.5px',
          gap: '6px',
          lineHeight: '1.55',
          padding: '0 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      },
      h('span', { style: { flex: 'none', opacity: 0.55, width: '8px' } }, mark),
      h('span', { style: { flex: 1 } }, children))
      // 行内高亮：同一段原文保留淡色，真正改动的字符加底色。
      const segments = (parts, drop) => parts
        .filter((part) => part.type !== drop)
        .map((part, index) => h('span', {
          key: index,
          style: part.type === 'same'
            ? { opacity: 0.75 }
            : {
              background: part.type === 'add'
                ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)'
                : 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)',
              borderRadius: '2px',
            },
        }, part.text))

      blocks.forEach((block, index) => {
        if (!keep.has(index)) {
          skipped += 1
          return
        }
        flush()
        if (block.type === 'same') {
          nodes.push(row(' ', block.text, 'same', `same-${index}`))
          return
        }
        const total = Math.max(block.del.length, block.add.length)
        for (let i = 0; i < total; i += 1) {
          const oldLine = block.del[i]
          const newLine = block.add[i]
          if (oldLine !== undefined && newLine !== undefined) {
            const parts = diffInline(oldLine, newLine)
            nodes.push(row('−', segments(parts, 'add'), 'del', `del-${index}-${i}`))
            nodes.push(row('+', segments(parts, 'del'), 'add', `add-${index}-${i}`))
            continue
          }
          if (oldLine !== undefined) nodes.push(row('−', oldLine, 'del', `del-${index}-${i}`))
          else nodes.push(row('+', newLine, 'add', `add-${index}-${i}`))
        }
      })
      flush()
      return nodes
    }
    // --- diff:end ---

    // 统一的条目渲染：主页的 sections 与会话页的 contexts 共用同一套视觉与操作。
    function renderPromptEntry(item, index, api) {
      const { layerRules, layerArg, busy, editing, draft, setEditing, setDraft, run, sessionScoped } = api
      const rule = layerRules[item.name]
      const disabled = rule?.mode === 'disable'
      const replaced = rule?.mode === 'replace'
      const mine = item.origin === 'injected' || String(item.name || '').startsWith(PROMOTED_PREFIX)
      const text = String(item.text || '')
      const applied = replaced ? String(rule.text || '') : text
      const head = h('div', { style: S.itemHead },
        h('span', {
          style: {
            ...S.itemTitle,
            ...(disabled ? { ...S.strike, color: 'var(--dsw-alias-state-error-primary)' } : null),
          },
        }, item.name || '(unnamed)'),
        disabled
          ? h('span', { style: S.tagOff }, t('已禁用'))
          : replaced
            ? h('span', { style: S.tagOver }, t('已覆盖'))
            : h('span', { style: S.tagOn }, t('生效中')),
        h('span', { style: S.meta }, replaced ? t('{before} → {after} 字', { before: text.length, after: applied.length }) : t('{n} 字', { n: text.length })),
        mine ? h('span', { style: S.tag }, t('本插件')) : null,
        h('span', { style: { flex: 1 } }),
        h('button', {
          type: 'button',
          style: S.chip(disabled),
          disabled: busy === item.name,
          onClick: () => {
            // 会话页写的都是会话级规则：禁用写 disable，重新开启写 enable
            //（用来推翻可能来自全局基线的 disable）。主页没有会话概念，直接用 clear 删规则。
            if (!disabled) {
              run(item.name, { action: 'override.set', name: item.name, mode: 'disable', layer: layerArg })
              return
            }
            run(item.name, sessionScoped
              ? { action: 'override.set', name: item.name, mode: 'enable', layer: layerArg }
              : { action: 'override.clear', name: item.name, layer: layerArg })
          },
        }, disabled ? t('重新开启') : t('禁用')),
        h('button', {
          type: 'button',
          style: S.buttonTiny,
          disabled: busy === item.name,
          onClick: () => {
            setEditing(item.name)
            setDraft(replaced ? String(rule.text || '') : text)
          },
        }, replaced ? t('修改覆盖') : t('覆盖')),
        rule
          ? h('button', {
            type: 'button',
            style: S.buttonTiny,
            disabled: busy === item.name,
            onClick: () => run(item.name, { action: 'override.clear', name: item.name, layer: layerArg }),
          }, t('恢复原文'))
          : null)
      const body = editing === item.name
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
          h('textarea', {
            style: { ...S.input, minHeight: '120px', resize: 'vertical', fontFamily: 'inherit' },
            value: draft,
            onChange: (event) => setDraft(event.target.value),
          }),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button',
              style: S.buttonPrimary,
              onClick: () => run(item.name, { action: 'override.set', name: item.name, mode: 'replace', text: draft, layer: layerArg }),
            }, t('保存覆盖')),
            h('button', { type: 'button', style: S.button, onClick: () => setEditing('') }, t('取消'))))
        : disabled
          ? h(ClampedText, { text, limit: 240, style: { ...S.text, ...S.strike } })
          : replaced
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' } },
              h('div', { style: S.diffBar },
                h('span', { style: { ...S.mono, color: 'var(--dsw-alias-state-warn-primary)' } }, t('覆盖生效中')),
                h('span', {}, t('{before} → {after} 字', { before: text.length, after: applied.length })),
                h('span', { style: { flex: 1 } }),
                h('span', { style: S.meta }, t('只显示改动处'))),
              h('div', {
                style: {
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '6px',
                  overflow: 'hidden',
                },
              }, renderDiffView(text, applied)))
            : h(ClampedText, { text, limit: 240, style: S.text })
      return h('div', { key: `${item.name}-${index}`, style: disabled ? S.itemOff : S.item }, head, body)
    }

    function PanelPage(props) {
      // 订阅语言：DSH 的界面语言要等第一次 API 返回才知道，届时需要重渲染。
      useLocale()
      // 把宿主的 active 传下去：切回这个页时要重新拉数据，
      // 否则显示的是上一次挂载时的旧快照。
      const [state, refresh, apply] = useBoard({ active: props?.active })
      const [tab, setTab] = React.useState('library')
      const [query, setQuery] = React.useState('')
      const [workspacePath, setWorkspacePath] = React.useState('')
      const [dragOver, setDragOver] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const notify = (message) => setNotice(String(message || ''))

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('h2', { style: S.title }, t('提示词管理')),
          h('span', { style: S.meta }, state.summary),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.button, onClick: refresh }, t('刷新'))),

        state.error ? h('p', { style: S.error }, state.error) : null,

        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: S.chip(tab === 'library'),
            onClick: () => setTab('library'),
          }, t('提示词档案')),
          h('button', {
            type: 'button',
            style: S.chip(tab === 'builtin'),
            onClick: () => setTab('builtin'),
          }, t('内置与其他插件'))),

        tab === 'library'
          ? h('div', {
            style: {
              alignItems: 'start',
              display: 'grid',
              gap: '16px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            },
          },
          h(LibraryPane, { state, query, setQuery, apply, notify }),
          h(ApplyPane, {
            state,
            apply,
            notify,
            onRefresh: refresh,
            workspacePath,
            setWorkspacePath,
            dragOver,
            setDragOver,
          }))
          : h(BuiltinSectionsCard, { key: 'builtin-sections' }),

        notice ? h('p', { style: S.hint }, notice) : null,
        state.file ? h('p', { style: S.mono }, state.file) : null)
    }

    function SessionView(props) {
      useLocale()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [state, refresh, apply] = useBoard({ active: props?.active })
      const [preview, setPreview] = React.useState(null)
      const [assembly, setAssembly] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [editName, setEditName] = React.useState('')
      const [editDraft, setEditDraft] = React.useState('')
      const [tempScope, setTempScope] = React.useState('inherit')

      const loadPreview = async () => {
        setBusy(true)
        try {
          const encoded = encodeURIComponent(sessionId)
          const [sessionData, assemblyData] = await Promise.all([
            requestJson(`${API}?view=session&sessionId=${encoded}`, { headers: { accept: 'application/json' } }),
            requestJson(`${API}?view=assembled&sessionId=${encoded}`, { headers: { accept: 'application/json' } })
              .catch(() => null),
          ])
          setPreview(sessionData)
          setAssembly(assemblyData)
        } catch (failure) {
          setNotice(t('预览失败：{msg}', { msg: failure?.message ?? failure }))
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        if (sessionId) loadPreview()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      const addTemporary = async () => {
        if (!draft.trim()) return
        setBusy(true)
        try {
          const data = await mutate({ action: 'temp.add', sessionId, title: t('临时条目'), text: draft, agentScope: tempScope })
          apply(data)
          setDraft('')
          setNotice(t('已添加临时条目（不进档案）'))
          await loadPreview()
        } catch (failure) {
          setNotice(t('添加失败：{msg}', { msg: failure?.message ?? failure }))
        } finally {
          setBusy(false)
        }
      }

      const removeTemporary = async (id) => {
        setBusy(true)
        try {
          const data = await mutate({ action: 'temp.remove', id })
          apply(data)
          await loadPreview()
        } catch (failure) {
          setNotice(t('删除失败：{msg}', { msg: failure?.message ?? failure }))
        } finally {
          setBusy(false)
        }
      }

      const runOverride = async (label, payload) => {
        setBusy(true)
        try {
          // 会话页的 contexts 改写一律带上 sessionId，只影响本会话。
          await mutate({ ...payload, sessionId })
          await loadPreview()
        } catch (failure) {
          setNotice(t('操作失败：{msg}', { msg: failure?.message ?? failure }))
        } finally {
          setBusy(false)
        }
      }

      const overrides = state.overrides || EMPTY_OVERRIDES
      // 会话页用后端合并后的规则（全局默认 + 本会话覆盖），而不是全局规则。
      const contextRules = assembly?.contextRules || overrides.contexts || {}
      const contextItems = Array.isArray(assembly?.contexts) ? assembly.contexts : []
      const contextDisabled = Array.isArray(assembly?.disabledContexts) ? assembly.disabledContexts.length : 0
      const sectionItems = Array.isArray(assembly?.sections) ? assembly.sections : []
      const sectionRulesMerged = assembly?.sectionRules || overrides.sections || {}
      const sectionDisabled = Array.isArray(assembly?.disabledSections) ? assembly.disabledSections.length : 0
      const items = preview?.items ?? []
      const previewText = preview?.text ?? ''
      const temps = state.temporary.filter((item) => !item.sessionId || item.sessionId === sessionId)

      return h('div', { style: { ...S.page, paddingTop: '16px' } },
        h('div', { style: S.head },
          h('h2', { style: S.title }, t('会话提示词')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: loadPreview }, busy ? t('读取中…') : t('刷新预览'))),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: S.tag }, preview?.subagent ? t('子代理会话') : t('主代理会话')),
          preview?.parentSessionId
            ? h('span', { style: S.mono }, t('父会话 {id}', { id: preview.parentSessionId }))
            : null,
          h('span', { style: S.mono }, sessionId ? t('会话 {id}', { id: sessionId }) : t('当前没有选中的会话。'))),
        notice ? h('p', { style: S.hint }, notice) : null,
        state.error ? h('p', { style: S.error }, state.error) : null,

        h('section', { style: S.card },
          h('h3', { style: S.cardTitle }, t('本会话最终生效（{n} 段）', { n: items.length })),
          h('p', { style: S.hint },
            t('全局启用、工作区启用/禁用、临时条目已经合并；这里看到的就是实际注入的提示词。')),
          preview
            ? h('div', { style: S.list },
                h('div', { style: S.itemHead },
                  h('span', { style: S.mono }, t('cwd: {value}', { value: preview.cwd || t('(未知)') })),
                  h('span', { style: S.mono }, t('匹配工作区: {value}', { value: preview.matchedWorkspace || t('(无)') }))),
                items.length === 0
                  ? h('div', { style: S.empty }, t('本会话没有生效的提示词条目'))
                  : items.map((item) => h('div', { key: `${item.source}-${item.id}`, style: S.item },
                    h('div', { style: S.itemHead },
                      h('span', { style: S.itemTitle }, item.title || item.id),
                      h('span', { style: S.tag }, item.source === 'temporary' ? t('临时') : t('档案')),
                      h('span', { style: S.tag }, item.injection === 'hot' ? t('后注入') : t('静态')),
                      scopeTag(item.agentScope),
                      h('span', { style: S.mono }, item.id),
                      h('span', { style: S.mono }, `order ${item.order}`)),
                    h('p', { style: S.text }, item.text))),
                previewText
                  ? h('details', { style: S.item },
                      h('summary', { style: { cursor: 'pointer', fontSize: '12.5px' } },
                        t('合并文本（{n} 字）', { n: previewText.length })),
                      h('p', { style: S.text }, previewText))
                  : null)
            : h('div', { style: S.empty }, busy ? t('读取中…') : t('点「刷新预览」查看'))),

        (preview?.children?.length ?? 0) > 0
          ? h('section', { style: S.card },
            h('h3', { style: S.cardTitle }, t('本会话的子代理（{n}）', { n: preview.children.length })),
            h('p', { style: S.hint },
              t('本次会话拉起过的子代理。「仅主代理」的条目不会进入它们，「仅子代理」的条目只进入它们。')),
            h('div', { style: S.list }, preview.children.map((child) => h('div', { key: child.sessionId, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: S.mono }, child.sessionId),
                h('span', { style: S.tag }, t('继承 {n} 条', { n: child.items.length })),
                h('span', { style: { flex: 1 } }),
                h('span', { style: S.mono }, child.cwd || '')),
              h('p', { style: S.text }, child.items.length
                ? child.items
                  .map((item) => `${item.title || item.id}${item.agentScope && item.agentScope !== 'inherit' ? (item.agentScope === 'main' ? t('（仅主代理）') : t('（仅子代理）')) : ''}`)
                  .join(' · ')
                : t('没有从档案继承任何条目'))))))
          : null,

        h('details', { style: S.card },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: '13px' } },
            t('系统提示词段落（{n} 段{suffix}）', {
              n: sectionItems.length,
              suffix: sectionDisabled ? t('，已禁用 {n}', { n: sectionDisabled }) : '',
            })),
          h('p', { style: S.hint },
            t('内置段落（Harness 与其他插件）。这里的改动立即生效、只影响本会话 —— 代价是本会话的提示词缓存前缀会失效。')
            + t('主页的改动则只对新会话生效。')),
          !assembly
            ? h('div', { style: S.empty }, busy ? t('读取中…') : t('点「刷新预览」加载'))
            : assembly.ok === false
              ? h('div', { style: S.empty }, String(assembly.reason || t('本会话还没有产生过装配记录，先对话一轮再刷新。')))
              : sectionItems.length === 0
                ? h('div', { style: S.empty }, t('本会话没有内置段落'))
                : h('div', { style: S.list }, sectionItems.map((item, index) => renderPromptEntry(
                  { ...item, layer: 'section' },
                  index,
                  {
                    layerRules: sectionRulesMerged,
                    layerArg: 'section',
                    busy: busy ? item.name : '',
                    editing: editName,
                    draft: editDraft,
                    setEditing: setEditName,
                    setDraft: setEditDraft,
                    run: runOverride,
                    sessionScoped: true,
                  },
                )))),

        h('section', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.cardTitle }, t('本会话上下文（{n}）', { n: contextItems.length })),
            contextDisabled > 0 ? h('span', { style: S.tagOff }, t('已禁用 {n}', { n: contextDisabled })) : null),
          h('p', { style: S.hint },
            t('这些是随本次会话动态生成的运行时信息：工作目录、沙箱策略、审批策略、插件注入的会话窗口等。')
            + t('这里的禁用与覆盖只作用于本会话，不影响其他会话。')),
          !assembly
            ? h('div', { style: S.empty }, busy ? t('读取中…') : t('点「刷新预览」加载'))
            : assembly.ok === false
              ? h('div', { style: S.empty }, String(assembly.reason || t('本会话还没有产生过装配记录，先对话一轮再刷新。')))
              : contextItems.length === 0
                ? h('div', { style: S.empty }, t('本会话没有上下文'))
                : h('div', { style: S.list }, contextItems.map((item, index) => renderPromptEntry(
                  { ...item, layer: 'context' },
                  index,
                  {
                    layerRules: contextRules,
                    layerArg: 'context',
                    busy: busy ? item.name : '',
                    editing: editName,
                    draft: editDraft,
                    setEditing: setEditName,
                    setDraft: setEditDraft,
                    run: runOverride,
                    sessionScoped: true,
                  },
                )))),

        h('section', { style: S.card },
          h('h3', { style: S.cardTitle }, t('临时条目（{n}）', { n: temps.length })),
          h('p', { style: S.hint }, t('临时条目只绑定本会话，不进长期档案；会话结束后可以删除。')),
          temps.length === 0
            ? h('div', { style: S.empty }, t('暂无临时条目'))
            : h('div', { style: S.list }, temps.map((item) => h('div', { key: item.id, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: S.itemTitle }, item.title || item.id),
                h('span', { style: S.mono }, item.id),
                scopeTag(item.agentScope),
                h('span', { style: { flex: 1 } }),
                h('button', {
                  type: 'button', style: S.buttonTiny, disabled: busy,
                  onClick: () => removeTemporary(item.id),
                }, t('删除'))),
              h('p', { style: S.text }, item.text)))),
          h(Field, { label: t('新临时条目内容') }, h('textarea', {
            style: { ...S.input, minHeight: '64px', resize: 'vertical', fontFamily: 'inherit' },
            value: draft,
            placeholder: t('只影响当前会话的一段提示词…'),
            onChange: (event) => setDraft(event.target.value),
          })),
          h(Field, {
            label: t('注入给谁'),
            title: t('主代理 = 当前这个会话；子代理 = 它派生的子任务'),
          }, h('select', {
            style: S.input,
            value: tempScope,
            onChange: (event) => setTempScope(event.target.value),
          },
            h('option', { value: 'inherit' }, t('主代理 + 子代理（默认）')),
            h('option', { value: 'main' }, t('仅主代理')),
            h('option', { value: 'subagent' }, t('仅子代理')))),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button', style: S.buttonPrimary,
              disabled: busy || !draft.trim(),
              onClick: addTemporary,
            }, t('加到本会话')))))
    }

    function PanelIcon(props) {
      useLocale()
      const size = Number(props?.size) > 0 ? Number(props.size) : 20
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', { d: 'M7 3.5h6.5L18 8v12.5H7z' }),
      h('path', { d: 'M13.5 3.5V8H18' }),
      h('path', { d: 'M10 12.5h5M10 16h3' }))
    }

    // ------------------------------------------------------------ register

    return {
      // locale 是语言的第一来源，必须等它就位再注册槽位 —— 否则 label() 第一次
      // 被宿主取用时拿不到权威语言，只能退回 <html lang>。
      inject: ['slots', 'locale'],
      apply(ctx) {
        const slots = ctx.slots
        const disposers = []
        // slots.inject 的回调返回值不一定会被它接管。注册出来的 disposer 如果只交给
        // inject，热重载换成另一份 apply 时旧注册就留在 slot 表里，同一个 id 再注册
        // 一次会撞车 —— 面板上的表现就是那个页签凭空消失。两条都收，确保摘得掉。
        const track = (dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        const seat = (slot, spec, component) => {
          track(slots.inject(slot, () => {
            const dispose = slots.register(spec, component)
            track(dispose)
            return dispose
          }))
        }

        // 接上宿主的 locale 服务。这是语言的第一来源：它的快照同步可读，而且在
        // 通知订阅者之前就已经更新完了 —— 宿主侧边栏在语言一变就重算 label()，
        // 那一刻 getLocale() 反映的已经是新语言。
        //
        // 用 ctx.get 而不是硬依赖：locale 服务缺席时 detectLocale() 会退到
        // <html lang>，插件不该因此装不上。
        const localeFace = ctx.get('locale') ?? null
        if (localeFace) {
          hostLocale = localeFace
          // 让 React 那边知道语言变了。t() 本身不靠这条通知，它现场读。
          track(localeFace.subscribe(() => localeStore.sync()))
          // 装进来之后对齐一次：模块加载到 apply 之间语言可能已经确定下来了。
          localeStore.sync()
        }

        seat('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('提示词'),
        }, PanelIcon)

        seat('main', {
          name: 'main',
          key: PANEL_ID,
        }, PanelPage)

        seat('conversation.view', {
          name: 'conversation.view',
          id: PANEL_ID,
          order: 40,
          label: () => t('提示词'),
        }, SessionView)

        return () => {
          hostLocale = null
          for (const dispose of disposers.splice(0)) dispose()
        }
      },
    }
  },
})