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
  id: '@local/dsh-prompt-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/prompt-manager/api'
    const PANEL_ID = 'prompt-manager'

    // ---------------------------------------------------------------- data

    async function requestJson(url, init) {
      const response = await fetch(url, init)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function loadBoard() {
      return requestJson(API, { headers: { accept: 'application/json' } })
    }

    function mutate(payload) {
      return requestJson(API, {
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

    // 作用范围：三个值都给标签，列表上一眼能看出条目投给谁（选「继承」时也有标签，
    // 否则等于看不出来）。解释走 title tooltip，不占版面。
    const AGENT_SCOPE = {
      inherit: { label: '主+子代理', title: '主代理和它派生的子代理都会注入' },
      main: { label: '仅主代理', title: '只注入主代理会话，它派生的子代理看不到' },
      subagent: { label: '仅子代理', title: '只注入子代理会话，主代理看不到' },
    }

    function scopeTag(scope) {
      const meta = AGENT_SCOPE[scope] ?? AGENT_SCOPE.inherit
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

    function useBoard() {
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
      }, [apply])
      return [state, refresh, apply]
    }

    function UsageTags(props) {
      const applications = props.applications || EMPTY_APPLICATIONS
      const globalOn = applications.global.enabled.includes(props.entryId)
      const spaces = Object.entries(applications.workspaces)
        .filter(([, config]) => config.enabled.includes(props.entryId) || config.default.includes(props.entryId))
        .map(([key]) => key)
      return h('span', { style: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' } },
        h('span', { style: S.badge(globalOn) }, globalOn ? '全局启用' : '全局未启用'),
        spaces.map((key) => h('span', { key, style: S.tag }, `工作区 ${key}`)))
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
          h(Field, { label: '标题' }, h('input', {
            style: S.input, value: title, placeholder: '可选',
            onChange: (event) => setTitle(event.target.value),
          })),
          h(Field, { label: '顺序' }, h('input', {
            style: S.input, value: order, inputMode: 'numeric',
            onChange: (event) => setOrder(event.target.value),
          })),
          h(Field, {
            label: '注入给谁',
            title: '主代理 = 你直接对话的会话；子代理 = 它派生的子任务',
          }, h('select', {
            style: S.input,
            value: agentScope,
            onChange: (event) => setAgentScope(event.target.value),
          },
            h('option', { value: 'inherit' }, '主代理 + 子代理（默认）'),
            h('option', { value: 'main' }, '仅主代理'),
            h('option', { value: 'subagent' }, '仅子代理')))),
        h(Field, { label: '提示词内容' }, h('textarea', {
          style: { ...S.input, minHeight: '84px', resize: 'vertical', fontFamily: 'inherit' },
          value: text,
          placeholder: '插入到系统提示词中的文本…',
          onChange: (event) => setText(event.target.value),
        })),
        error ? h('p', { style: S.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', {
            type: 'button', style: S.buttonPrimary,
            disabled: busy || !id.trim() || !text.trim(),
            onClick: submit,
          }, busy ? '保存中…' : editing ? '保存修改' : '加入档案'),
          props.onCancel
            ? h('button', { type: 'button', style: S.button, onClick: props.onCancel }, '取消')
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
          title: '移除',
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
        kids.length ? kids : h('span', { style: S.meta }, props.empty || '把左侧条目拖到这里'))
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
          props.notify(`已删除 ${entry.id}`)
        } catch (failure) {
          props.notify(`删除失败：${failure?.message ?? failure}`)
        } finally {
          setBusyId('')
        }
      }

      const form = h(LibraryForm, {
        entry: editing,
        onSaved: (data) => {
          setEditing(null)
          props.apply(data)
          props.notify(data?.message || '已保存')
        },
        onCancel: editing ? () => setEditing(null) : undefined,
      })

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.cardTitle }, `档案库（${state.entries.length}）`),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.meta }, '拖到右侧投放')),

        h('input', {
          style: S.input,
          placeholder: '搜索 id / 标题 / 内容…',
          value: props.query,
          onChange: (event) => props.setQuery(event.target.value),
        }),

        state.entries.length === 0
          ? h('div', { style: S.empty }, state.loading ? '读取中…' : '档案还是空的，在下面新建一条')
          : visible.length === 0
            ? h('div', { style: S.empty }, '没有匹配的条目')
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
                  h('span', { style: S.badge(globalOn) }, globalOn ? '全局' : '未投放'),
                  scopeTag(entry.agentScope),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', style: S.buttonTiny, onClick: () => setEditing(entry) }, '编辑'),
                  h('button', {
                    type: 'button', style: S.buttonTiny,
                    disabled: busyId === entry.id,
                    onClick: () => remove(entry),
                  }, '删除')),
                h('p', { style: S.text }, entry.text.length > 160 ? `${entry.text.slice(0, 160)}…` : entry.text))
            })),

        editing
          ? h('section', { style: { ...S.card, marginTop: '4px' } },
            h('h3', { style: S.cardTitle }, `编辑档案：${editing.id}`),
            form)
          : h('details', { style: S.item },
            h('summary', { style: { cursor: 'pointer', fontSize: '13px', fontWeight: 600 } }, '＋ 新建条目'),
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
          props.notify(`操作失败：${failure?.message ?? failure}`)
        }
      }

      const toggleHotReload = async (enabled) => {
        try {
          props.apply(await mutate({ action: 'apply.hotReload', workspacePath: active, enabled }))
        } catch (failure) {
          props.notify(`操作失败：${failure?.message ?? failure}`)
        }
      }

      // 点击工作区里的 chip 切换「默认」标记：默认组会随会话创建一起注入。
      const markDefault = async (id, isDefault) => {
        try {
          props.apply(await mutate({ action: 'apply.default', id, workspacePath: active, isDefault }))
        } catch (failure) {
          props.notify(`操作失败：${failure?.message ?? failure}`)
        }
      }

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.cardTitle }, '投放区'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.buttonTiny, onClick: props.onRefresh }, '刷新')),

        h('p', { style: S.hint },
          '把左侧条目拖进下面任意区块即可投放；点 chip 上的 × 移除。全局与未开后注入的工作区在会话创建时生效，开了后注入的每轮生效。'),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
          h('div', null,
            h('div', { style: S.itemHead },
              h('span', { style: S.label }, '全局'),
              h('span', { style: S.meta }, `${globalIds.length} 条 · 静态注册`)),
            h(DropZone, {
              active: props.dragOver === 'global',
              empty: '拖到这里 = 全局启用',
              onHover: (on) => props.setDragOver(on ? 'global' : ''),
              onDrop: (id) => toggle(id, 'global', true),
            }, globalIds.map((id) => h(Chip, {
              key: id,
              label: label(id),
              onRemove: () => toggle(id, 'global', false),
            })))),

          h('div', null,
            h('div', { style: S.itemHead },
              h('span', { style: S.label }, '工作区'),
              h('span', { style: { flex: 1 } }),
              h('select', {
                style: { ...S.input, width: 'auto', maxWidth: '320px' },
                value: active,
                onChange: (event) => props.setWorkspacePath(event.target.value),
              },
              candidates.length === 0
                ? h('option', { value: '' }, '尚无工作区')
                : candidates.map((path) => h('option', { key: path, value: path }, path))),
              h('button', {
                type: 'button',
                style: S.chip(config.hotReload === true),
                onClick: () => toggleHotReload(config.hotReload !== true),
              }, config.hotReload === true ? '后注入：开' : '后注入：关')),

            active
              ? h(DropZone, {
                active: props.dragOver === 'workspace',
                empty: '拖到这里 = 在该工作区启用',
                onHover: (on) => props.setDragOver(on ? 'workspace' : ''),
                onDrop: (id) => toggle(id, 'workspace', true),
              }, workspaceIds.map((id) => h(Chip, {
                key: id,
                label: config.default.includes(id) ? `${label(id)} · 默认` : label(id),
                hint: '点击切换默认',
                onActivate: () => markDefault(id, !config.default.includes(id)),
                onRemove: () => toggle(id, 'workspace', false),
              })))
              : h('div', { style: S.empty }, '未发现工作区'),

            config.disabled.length > 0
              ? h('div', { style: { marginTop: '10px' } },
                h('span', { style: S.label }, '该工作区禁用'),
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
          h('span', { style: S.meta }, `${items.length} 项`))
        const body = items.length === 0
          ? h('div', { style: S.empty }, '无')
          : h('div', { style: S.list }, items.map(render))
        if (!collapsible) {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, head, body)
        }
        // 默认收起；有过滤词时强制展开，避免搜到了却看不见。
        return h('details', { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, open: query.trim() ? true : undefined },
          h('summary', { style: S.summary },
            h('span', { style: S.label }, title),
            h('span', { style: S.meta }, ` ${items.length} 项`) ),
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
          h('h3', { style: S.cardTitle }, '内置与其他插件提示词'),
          state.loaded && state.revision ? h('span', { style: S.meta }, `第 ${state.revision} 次装配`) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.buttonTiny, onClick: load }, state.loading ? '读取中…' : state.loaded ? '刷新' : '读取')),

        h('p', { style: S.hint },
          '这里列的是 agent 真实装配出的内容：Harness 内置段落、其他插件注册的段落与 context、以及全部工具。每条可单独「禁用」或「覆盖」，覆盖会显示原文与应用文本的对照。'),
        h('p', { style: S.hint },
          '这里的改动是全局的，只对新建会话生效 —— 中途改提示词会让服务端缓存前缀整段失效，所以不让它追杀运行中的会话。'
          + '要在当前会话立刻看到效果，去会话页单独特调（那条路即时生效、且只影响那一个会话）。总开关例外，它会立即对全部会话生效。'),

        !rulesActive && (offCount + overCount) > 0
          ? h('p', { style: { ...S.error, fontWeight: 600 } },
            `改写已停用：下面 ${offCount + overCount} 条规则当前不生效，点右上角「启用改写」恢复。`)
          : null,

        state.error ? h('p', { style: S.error }, state.error) : null,
        state.reason ? h('p', { style: S.hint }, state.reason) : null,

        state.loaded
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            h('div', { style: S.itemHead },
              h('span', { style: S.meta }, `sections ${allSections.length} 段 · ${totalChars} 字`),
              h('span', { style: S.meta }, `tools ${state.tools.length}`),
              offCount > 0 ? h('span', { style: S.tagOff }, `已禁用 ${offCount}`) : null,
              overCount > 0 ? h('span', { style: S.tagOver }, `已覆盖 ${overCount}`) : null,
              h('span', { style: { flex: 1 } }),
              h('span', {
                style: rulesActive ? S.tagOn : S.tagOff,
                title: rulesActive
                  ? '改写规则正在生效'
                  : '改写规则已暂停，下面的禁用/覆盖都不起作用',
              }, rulesActive ? '改写生效中' : '改写已停用'),
              h('button', {
                type: 'button',
                style: rulesActive ? S.buttonTiny : S.buttonPrimary,
                disabled: busy === 'master',
                onClick: () => run('master', { action: 'override.toggle', enabled: !rulesActive }),
              }, busy === 'master' ? '切换中…' : rulesActive ? '停用改写' : '启用改写'),
              h('span', { style: S.meta }, `规则 ${offCount + overCount} 条`),
              h('button', {
                type: 'button',
                style: S.buttonTiny,
                disabled: busy === 'reset',
                onClick: () => {
                  const total = Object.keys(rules).length + Object.keys(contextRules).length
                  if (!total) return
                  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                    && !window.confirm(`恢复全部内置提示词？将清除 ${total} 项规则，覆盖文本会归档，之后还能再应用。`)) return
                  run('reset', { action: 'override.reset' })
                },
              }, '全部恢复')),

            h('input', {
              style: S.input,
              placeholder: '按名称或内容过滤…',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),

            group('sections', sections, renderEntry),

            h('p', { style: S.hint },
              'contexts（工作目录、沙箱策略、插件注入的运行时信息等）每个会话都不同，改写规则也按会话隔离，已移到各会话的「提示词」页查看与改写。'),

            disabledNames.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('div', { style: S.itemHead },
                  h('span', { style: S.label }, '已禁用'),
                  h('span', { style: S.meta }, `${disabledNames.length} 项`)),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                  disabledNames.map((name) => h('span', { key: name, style: S.tag }, name))))
              : null,

            savedOverrides.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: S.itemHead },
                  h('span', { style: S.label }, '已保存的覆盖文本'),
                  h('span', { style: S.meta }, `${savedOverrides.length} 条`)),
                h('div', { style: S.list }, savedOverrides.map((item) => {
                  const text = String(item.text || '')
                  return h('div', { key: item.id, style: S.item },
                    h('div', { style: S.itemHead },
                      h('span', { style: S.itemTitle }, item.name),
                      h('span', { style: S.tag }, item.layer === 'contexts' ? 'context' : 'section'),
                      item.sessionId ? h('span', { style: S.tag }, '仅会话') : null,
                      h('span', { style: S.meta }, `${text.length} 字`),
                      h('span', { style: { flex: 1 } }),
                      h('button', {
                        type: 'button',
                        style: S.buttonTiny,
                        disabled: busy === item.id,
                        onClick: () => run(item.id, { action: 'override.restore', id: item.id }),
                      }, '应用'),
                      h('button', {
                        type: 'button',
                        style: S.buttonTiny,
                        disabled: busy === item.id,
                        onClick: () => run(item.id, { action: 'override.forget', id: item.id }),
                      }, '删除')),
                    h('p', { style: S.text }, text.length > 160 ? `${text.slice(0, 160)}…` : text))
                })))
              : null,

            group('tools（只读）', tools, (item) => h('div', { key: item.name, style: S.item },
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
        }, `⋯ ${skipped} 段未变`))
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
          ? h('span', { style: S.tagOff }, '已禁用')
          : replaced
            ? h('span', { style: S.tagOver }, '已覆盖')
            : h('span', { style: S.tagOn }, '生效中'),
        h('span', { style: S.meta }, replaced ? `${text.length} → ${applied.length} 字` : `${text.length} 字`),
        mine ? h('span', { style: S.tag }, '本插件') : null,
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
        }, disabled ? '重新开启' : '禁用'),
        h('button', {
          type: 'button',
          style: S.buttonTiny,
          disabled: busy === item.name,
          onClick: () => {
            setEditing(item.name)
            setDraft(replaced ? String(rule.text || '') : text)
          },
        }, replaced ? '修改覆盖' : '覆盖'),
        rule
          ? h('button', {
            type: 'button',
            style: S.buttonTiny,
            disabled: busy === item.name,
            onClick: () => run(item.name, { action: 'override.clear', name: item.name, layer: layerArg }),
          }, '恢复原文')
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
            }, '保存覆盖'),
            h('button', { type: 'button', style: S.button, onClick: () => setEditing('') }, '取消')))
        : disabled
          ? h('p', { style: { ...S.text, ...S.strike } }, text.length > 240 ? `${text.slice(0, 240)}…` : text)
          : replaced
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' } },
              h('div', { style: S.diffBar },
                h('span', { style: { ...S.mono, color: 'var(--dsw-alias-state-warn-primary)' } }, '覆盖生效中'),
                h('span', {}, `${text.length} → ${applied.length} 字`),
                h('span', { style: { flex: 1 } }),
                h('span', { style: S.meta }, '只显示改动处')),
              h('div', {
                style: {
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '6px',
                  overflow: 'hidden',
                },
              }, renderDiffView(text, applied)))
            : h('p', { style: S.text }, text.length > 240 ? `${text.slice(0, 240)}…` : text)
      return h('div', { key: `${item.name}-${index}`, style: disabled ? S.itemOff : S.item }, head, body)
    }

    function PanelPage() {
      const [state, refresh, apply] = useBoard()
      const [tab, setTab] = React.useState('library')
      const [query, setQuery] = React.useState('')
      const [workspacePath, setWorkspacePath] = React.useState('')
      const [dragOver, setDragOver] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const notify = (message) => setNotice(String(message || ''))

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('h2', { style: S.title }, '提示词管理'),
          h('span', { style: S.meta }, state.summary),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.button, onClick: refresh }, '刷新')),

        state.error ? h('p', { style: S.error }, state.error) : null,

        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: S.chip(tab === 'library'),
            onClick: () => setTab('library'),
          }, '提示词档案'),
          h('button', {
            type: 'button',
            style: S.chip(tab === 'builtin'),
            onClick: () => setTab('builtin'),
          }, '内置与其他插件')),

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
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [state, refresh, apply] = useBoard()
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
          setNotice(`预览失败：${failure?.message ?? failure}`)
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
          const data = await mutate({ action: 'temp.add', sessionId, title: '临时条目', text: draft, agentScope: tempScope })
          apply(data)
          setDraft('')
          setNotice('已添加临时条目（不进档案）')
          await loadPreview()
        } catch (failure) {
          setNotice(`添加失败：${failure?.message ?? failure}`)
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
          setNotice(`删除失败：${failure?.message ?? failure}`)
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
          setNotice(`操作失败：${failure?.message ?? failure}`)
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
          h('h2', { style: S.title }, '会话提示词'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: loadPreview }, busy ? '读取中…' : '刷新预览')),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: S.tag }, preview?.subagent ? '子代理会话' : '主代理会话'),
          preview?.parentSessionId
            ? h('span', { style: S.mono }, `父会话 ${preview.parentSessionId}`)
            : null,
          h('span', { style: S.mono }, sessionId ? `会话 ${sessionId}` : '当前没有选中的会话。')),
        notice ? h('p', { style: S.hint }, notice) : null,
        state.error ? h('p', { style: S.error }, state.error) : null,

        h('section', { style: S.card },
          h('h3', { style: S.cardTitle }, `本会话最终生效（${items.length} 段）`),
          h('p', { style: S.hint },
            '全局启用、工作区启用/禁用、临时条目已经合并；这里看到的就是实际注入的提示词。'),
          preview
            ? h('div', { style: S.list },
                h('div', { style: S.itemHead },
                  h('span', { style: S.mono }, `cwd: ${preview.cwd || '(未知)'}`),
                  h('span', { style: S.mono }, `匹配工作区: ${preview.matchedWorkspace || '(无)'}`)),
                items.length === 0
                  ? h('div', { style: S.empty }, '本会话没有生效的提示词条目')
                  : items.map((item) => h('div', { key: `${item.source}-${item.id}`, style: S.item },
                    h('div', { style: S.itemHead },
                      h('span', { style: S.itemTitle }, item.title || item.id),
                      h('span', { style: S.tag }, item.source === 'temporary' ? '临时' : '档案'),
                      h('span', { style: S.tag }, item.injection === 'hot' ? '后注入' : '静态'),
                      scopeTag(item.agentScope),
                      h('span', { style: S.mono }, item.id),
                      h('span', { style: S.mono }, `order ${item.order}`)),
                    h('p', { style: S.text }, item.text))),
                previewText
                  ? h('details', { style: S.item },
                      h('summary', { style: { cursor: 'pointer', fontSize: '12.5px' } },
                        `合并文本（${previewText.length} 字）`),
                      h('p', { style: S.text }, previewText))
                  : null)
            : h('div', { style: S.empty }, busy ? '读取中…' : '点「刷新预览」查看')),

        (preview?.children?.length ?? 0) > 0
          ? h('section', { style: S.card },
            h('h3', { style: S.cardTitle }, `本会话的子代理（${preview.children.length}）`),
            h('p', { style: S.hint },
              '本次会话拉起过的子代理。「仅主代理」的条目不会进入它们，「仅子代理」的条目只进入它们。'),
            h('div', { style: S.list }, preview.children.map((child) => h('div', { key: child.sessionId, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: S.mono }, child.sessionId),
                h('span', { style: S.tag }, `继承 ${child.items.length} 条`),
                h('span', { style: { flex: 1 } }),
                h('span', { style: S.mono }, child.cwd || '')),
              h('p', { style: S.text }, child.items.length
                ? child.items
                  .map((item) => `${item.title || item.id}${item.agentScope && item.agentScope !== 'inherit' ? (item.agentScope === 'main' ? '（仅主代理）' : '（仅子代理）') : ''}`)
                  .join(' · ')
                : '没有从档案继承任何条目')))))
          : null,

        h('details', { style: S.card },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: '13px' } },
            `系统提示词段落（${sectionItems.length} 段${sectionDisabled ? `，已禁用 ${sectionDisabled}` : ''}）`),
          h('p', { style: S.hint },
            '内置段落（Harness 与其他插件）。这里的改动立即生效、只影响本会话 —— 代价是本会话的提示词缓存前缀会失效。'
            + '主页的改动则只对新会话生效。'),
          !assembly
            ? h('div', { style: S.empty }, busy ? '读取中…' : '点「刷新预览」加载')
            : assembly.ok === false
              ? h('div', { style: S.empty }, String(assembly.reason || '本会话还没有产生过装配记录，先对话一轮再刷新。'))
              : sectionItems.length === 0
                ? h('div', { style: S.empty }, '本会话没有内置段落')
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
            h('h3', { style: S.cardTitle }, `本会话上下文（${contextItems.length}）`),
            contextDisabled > 0 ? h('span', { style: S.tagOff }, `已禁用 ${contextDisabled}`) : null),
          h('p', { style: S.hint },
            '这些是随本次会话动态生成的运行时信息：工作目录、沙箱策略、审批策略、插件注入的会话窗口等。'
            + '这里的禁用与覆盖只作用于本会话，不影响其他会话。'),
          !assembly
            ? h('div', { style: S.empty }, busy ? '读取中…' : '点「刷新预览」加载')
            : assembly.ok === false
              ? h('div', { style: S.empty }, String(assembly.reason || '本会话还没有产生过装配记录，先对话一轮再刷新。'))
              : contextItems.length === 0
                ? h('div', { style: S.empty }, '本会话没有上下文')
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
          h('h3', { style: S.cardTitle }, `临时条目（${temps.length}）`),
          h('p', { style: S.hint }, '临时条目只绑定本会话，不进长期档案；会话结束后可以删除。'),
          temps.length === 0
            ? h('div', { style: S.empty }, '暂无临时条目')
            : h('div', { style: S.list }, temps.map((item) => h('div', { key: item.id, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: S.itemTitle }, item.title || item.id),
                h('span', { style: S.mono }, item.id),
                scopeTag(item.agentScope),
                h('span', { style: { flex: 1 } }),
                h('button', {
                  type: 'button', style: S.buttonTiny, disabled: busy,
                  onClick: () => removeTemporary(item.id),
                }, '删除')),
              h('p', { style: S.text }, item.text)))),
          h(Field, { label: '新临时条目内容' }, h('textarea', {
            style: { ...S.input, minHeight: '64px', resize: 'vertical', fontFamily: 'inherit' },
            value: draft,
            placeholder: '只影响当前会话的一段提示词…',
            onChange: (event) => setDraft(event.target.value),
          })),
          h(Field, {
            label: '注入给谁',
            title: '主代理 = 当前这个会话；子代理 = 它派生的子任务',
          }, h('select', {
            style: S.input,
            value: tempScope,
            onChange: (event) => setTempScope(event.target.value),
          },
            h('option', { value: 'inherit' }, '主代理 + 子代理（默认）'),
            h('option', { value: 'main' }, '仅主代理'),
            h('option', { value: 'subagent' }, '仅子代理'))),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button', style: S.buttonPrimary,
              disabled: busy || !draft.trim(),
              onClick: addTemporary,
            }, '加到本会话'))))
    }

    function PanelIcon(props) {
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
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        const disposers = []

        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => '提示词',
        }, PanelIcon)))

        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PanelPage)))

        disposers.push(slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: PANEL_ID,
          order: 40,
          label: () => '提示词',
        }, SessionView)))

        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      },
    }
  },
})