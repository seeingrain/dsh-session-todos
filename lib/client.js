/**
 * dsh-session-todos — browser half（手写 bundle，无需构建）。
 *
 * 功能：
 *  1) 右上角悬浮「待办」面板（shell.overlay）：展开=待办列表浮在对话区右上角，
 *     收缩=只在右上角显示 🎯 图标；展开态右上角有「→」收起按钮。
 *  2) 任务行：勾选框 + 文字框 + 右侧两按钮（推送到发送框 / 删除）；勾选后置灰、
 *     按钮禁用；勾选/取消立即存；双击原地编辑；长按拖动排序；底部「+」新增。
 *  3) 服务器端跨端存储：所有写操作打到 host 的 /dsh-session-todos/api。
 *  4) 会话列表左侧「未完成待办」图标：纯插件，不改 DSH 源码——用 [role="treeitem"]
 *     定位会话行，经 React fiber（node.id）读出会话 id，注入 🎯 徽章；MutationObserver
 *     响应行增删，订阅 sessions.list 与共享 store 即时增删徽章。
 *
 * Bundle 纯净：只需 require('react')；协作全走 slot 注册、locale 注册与
 * ctx.get("conversation")（会话作用域注入发送框）。样式仅用 dsh 语义 token，自动适配深色。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-todos",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");

    const NS = "sessionTodos";
    const API_PREFIX = "/dsh-session-todos/api";
    // 面板展开/收起：按会话、仅前端维护（localStorage 每会话一条），不存后台。
    // 默认收起——新会话/无记录的会话恒为收起；切走再切回恢复到离开时的状态。
    const collapsedKey = (sid) => `dsh-session-todos.collapsed.${sid}`;
    function readCollapsed(sid) {
      try {
        if (!sid) return true;
        const v = window.localStorage.getItem(collapsedKey(sid));
        // 存储值："1"=收起，"0"=展开；无记录=默认收起
        return v === null || v === "1";
      } catch { return true; }
    }
    function writeCollapsed(sid, val) {
      if (!sid) return;
      try { window.localStorage.setItem(collapsedKey(sid), val ? "1" : "0"); } catch {}
    }
    const CSS_ID = "dsh-session-todos";

    // ── RPC 封装（同源 fetch，响应 {ok,value} | {ok:false,error:{code,message}}）──
    async function call(method, payload) {
      const resp = await fetch(`${API_PREFIX}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      const parsed = await resp.json().catch(() => null);
      if (!resp.ok || !parsed || parsed.ok !== true) {
        const msg = parsed && parsed.error && parsed.error.message
          ? parsed.error.message
          : `HTTP ${resp.status}`;
        throw new Error(msg);
      }
      return parsed.value;
    }

    // ── 跨模块重载的 window 级 store ─────────────────────────────────────────
    // DSH 的 client-hmr 会在 client.js 文件变化时（开发期热重载）重执行本模块、
    // 重新 apply，面板组件因此被卸载重建。状态若只放 React state 里，重建即丢：
    // 面板闪一下、正在编辑的文字被吞。故全部关键状态提升到 window 级——
    // 模块重执行后仍是同一份数据，重建的组件实例挂载即恢复，无感、无损。
    const W = (window.__dshSessionTodos = window.__dshSessionTodos || {
      unfinished: new Map(), // sessionId -> true（仅存未完成项；面板 + 会话行徽章共用）
      unfinishedListeners: new Set(),
      tasks: {},   // sessionId -> tasks[]（最近一次已知的列表；重挂载时同步恢复，不闪空）
      loaded: {},  // sessionId -> true（已拉取过；重挂载不重复 get）
      editingId: null, // 正在编辑的任务 id（重挂载后恢复编辑态）
      draft: null,     // { id, text } 正在输入的文字（重挂载后 textarea 用它恢复，防吞字）
      lastGeometry: null // 聊天区几何（重挂载首帧即用，不闪空位）
    });
    // 旧版全局收起 key（未按会话）已废弃：清掉，避免遗留旧状态
    try { window.localStorage.removeItem("dsh-session-todos.collapsed"); } catch {}
    const unfinished = W.unfinished;
    const unfinishedListeners = W.unfinishedListeners;
    function getUnfinished(sid) {
      return unfinished.has(sid) ? unfinished.get(sid) === true : false;
    }
    function fireUnfinished() {
      for (const fn of unfinishedListeners) {
        try { fn(); } catch { /* 忽略 */ }
      }
    }
    function setUnfinished(sid, val) {
      const was = unfinished.get(sid) === true;
      if (was === !!val) return;
      if (val) unfinished.set(sid, true);
      else unfinished.delete(sid);
      fireUnfinished();
    }
    /** 用 summary 结果对齐未完成映射（跨端兜底刷新）。
     *  增量式增删，不用临时 Map——直接迭代 Map 拿到的是 [key,value] 元组，
     *  旧版 `for (k of next) unfinished.set(k, …)` 会把「数组」当 key 写入，
     *  与 setUnfinished 的字符串 key 并存：每次 summary 后 getUnfinished(sid)
     *  恒 false，徽章被反复摘除再补回（用户可见的闪烁来源之一）。 */
    function seedUnfinished(sessions) {
      const nextKeys = new Set();
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          if (s && s.hasUnfinished && typeof s.sessionId === "string") nextKeys.add(s.sessionId);
        }
      }
      let changed = false;
      for (const k of [...unfinished.keys()]) {
        if (!nextKeys.has(k)) { unfinished.delete(k); changed = true; }
      }
      for (const k of nextKeys) {
        if (!unfinished.has(k)) { unfinished.set(k, true); changed = true; }
      }
      if (changed) fireUnfinished();
    }
    function subscribeUnfinished(fn) {
      unfinishedListeners.add(fn);
      return () => unfinishedListeners.delete(fn);
    }

    // ── 会话行徽章（纯插件：DOM 定位 + React fiber 读会话 id）─────────────────
    /** 从会议行 DOM 节点的 fiber 树向上找 SessionNodeItem 的 memoizedProps.node.id。 */
    function sessionIdFromRow(row) {
      // React 的 fiber 属性名带随机后缀（__reactFiber$<hash>），不能硬编码。
      const fk = Object.keys(row).find((k) => k.indexOf("__reactFiber") === 0);
      let f = fk ? row[fk] : null;
      for (let i = 0; f && i < 10; i += 1, f = f.return) {
        const p = f.memoizedProps;
        if (
          p &&
          p.node &&
          typeof p.node.id === "string" &&
          p.group === void 0 &&
          p.result === void 0
        ) {
          return p.node.id;
        }
      }
      return null;
    }
    /** 扫描所有会话行，按当前未完成状态增删 🎯 徽章（幂等）。 */
    function syncBadges() {
      for (const row of document.querySelectorAll('[role="treeitem"]')) {
        const sid = sessionIdFromRow(row);
        if (sid === null) continue;
        const has = getUnfinished(sid);
        const existing = row.querySelector(".dsh-todo-ind");
        if (has && existing === null) {
          const badge = document.createElement("span");
          badge.className = "dsh-todo-ind";
          badge.setAttribute("aria-label", "有未完成的待办");
          badge.title = "有未完成的待办";
          badge.appendChild(Object.assign(document.createElement("span"), { className: "dsh-todo-emoji", textContent: "🎯" }));
          row.insertBefore(badge, row.firstElementChild);
        } else if (!has && existing !== null) {
          existing.remove();
        }
      }
    }

    // ── 样式（内联 + 少量 hover 用 style 标签）───────────────────────────────
    if (
      typeof document !== "undefined" &&
      document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = CSS_ID;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        // 会话行左侧徽章：紧贴状态点，位于标题前。
        ".dsh-todo-ind{flex:none;display:inline-flex;align-items:center;justify-content:center;width:17px;height:20px;margin-left:1px}",
        ".dsh-todo-emoji{font-size:13px;line-height:1;display:inline-block;transition:transform .12s var(--ds-ease-in-out)}",
        ".dsh-todo-ind:hover .dsh-todo-emoji{transform:scale(1.2)}",
        // 面板内部任务行：编辑态多行输入框统一样式。
        ".dsh-todo-text{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:8px;padding:6px 9px;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-family:inherit;resize:none;overflow:hidden;display:block;box-sizing:border-box}",
        ".dsh-todo-text:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-1px}",
        // 面板标题左侧的任务图标：固定尺寸、不随 flex 拉伸。
        ".dsh-todo-header-ico{flex:none;display:inline-grid;place-items:center;width:18px;height:18px}"
      ].join("\n");
      document.head.appendChild(tag);
    }

    // ── 文案 ────────────────────────────────────────────────────────────────
    const zh = {
      "panel.title": "会话待办",
      "panel.empty": "暂无待办，点「+」新建",
      "panel.pending": "{n} 项未完成",
      "panel.collapseTip": "收起待办面板",
      "panel.expandTip": "展开待办面板",
      "panel.addTip": "新建待办",
      "panel.pushTip": "推送到消息发送框",
      "panel.deleteTip": "删除待办",
      "panel.saveFail": "保存失败，请重试",
      "panel.doneTip": "已完成",
      "panel.placeholder": "待办内容…"
    };
    const en = {
      "panel.title": "Session Todos",
      "panel.empty": "No todos yet — click + to add",
      "panel.pending": "{n} unfinished",
      "panel.collapseTip": "Collapse todo panel",
      "panel.expandTip": "Expand todo panel",
      "panel.addTip": "New todo",
      "panel.pushTip": "Push to message composer",
      "panel.deleteTip": "Delete todo",
      "panel.saveFail": "Save failed, please retry",
      "panel.doneTip": "Completed",
      "panel.placeholder": "Todo text…"
    };

    // ── 面板样式对象 ─────────────────────────────────────────────────────────
    const ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";
    const s = {
      panel: {
        position: "fixed",
        zIndex: 1003,
        display: "flex",
        flexDirection: "column",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
        boxShadow: "0 8px 30px rgba(0,0,0,.22)",
        borderRadius: 12,
        overflow: "hidden",
        fontFamily: "var(--dsw-font-family, system-ui)",
        color: "var(--dsw-alias-label-primary, #111)"
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))"
      },
      headerTitle: { flex: "none", fontWeight: 600, fontSize: 14 },
      headerCount: { flex: 1, minWidth: 0, fontSize: 12, color: "var(--dsw-alias-label-caption, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      iconBtn: {
        flex: "none", width: 26, height: 26, padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))",
        background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-secondary, #666)",
        cursor: "pointer", fontSize: 13, lineHeight: 1, fontFamily: "inherit"
      },
      list: { flex: 1, overflowY: "auto", padding: "8px 8px 4px", display: "flex", flexDirection: "column", gap: 6 },
      row: { display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 6px", borderRadius: 8, background: "transparent", border: "1px solid transparent" },
      rowDrag: { background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09))", border: `1px solid ${ACCENT}`, boxShadow: "0 3px 12px rgba(0,0,0,.22)", position: "relative", zIndex: 2 },
      checkbox: { flex: "none", width: 16, height: 16, marginTop: 4, accentColor: ACCENT, cursor: "pointer" },
      text: {
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: "20px",
        color: "var(--dsw-alias-label-primary, #111)",
        // 多行折行：不再用 ellipsis 截断，展示完整任务文字
        whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "visible",
        cursor: "text", borderRadius: 8, padding: "4px 6px"
      },
      textDone: { color: "var(--dsw-alias-label-caption, #999)", textDecoration: "line-through" },
      actionBtn: {
        flex: "none", width: 28, height: 28, padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))",
        background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-secondary, #666)",
        cursor: "pointer", fontSize: 13, lineHeight: 1, fontFamily: "inherit"
      },
      actionBtnDisabled: { opacity: 0.4, cursor: "default" },
      footer: { display: "flex", padding: "6px 8px 10px" },
      addBtn: {
        flex: 1, height: 32, borderRadius: 8,
        border: "1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.25))",
        background: "transparent", color: "var(--dsw-alias-label-secondary, #666)",
        cursor: "pointer", fontSize: 14, fontFamily: "inherit"
      },
      notice: { padding: "4px 12px 6px", fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d33)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
    };

    // ── 任务行 ────────────────────────────────────────────────────────────────
    function TaskRow({
      task, done, editing, draft, onDraft, setEditing, onToggle, onChangeText, onPush, onDelete,
      onDragStart, onDragCancel, dragging
    }) {
      const onTextPointerDown = (e) => {
        if (editing || task.done) return;
        // 长按拖拽用：阻止默认（触摸选中/滚动），并捕获指针
        try { if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        onDragStart(e, task.id);
      };
      const textStyle = {
        ...s.text,
        ...(task.done ? s.textDone : {}),
        // 触屏长按拖拽必需：禁滚动/禁选中/禁系统长按菜单，否则 tablet 会走系统手势或 pointercancel
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none"
      };
      // 双击进入编辑：textarea 挂载即按内容自动增高（否则多行文字只显示第一行）
      const sizeTextarea = react.useCallback((el) => {
        if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
      }, []);
      return react.createElement(
        "div",
        {
          "data-dsh-todo-row": task.id,
          style: { ...s.row, ...(task.done ? { opacity: 0.55 } : {}), ...(dragging ? s.rowDrag : {}) }
        },
        react.createElement("input", {
          type: "checkbox",
          checked: task.done,
          disabled: editing,
          onChange: () => onToggle(task.id),
          style: s.checkbox,
          "aria-label": done
        }),
        editing
          ? react.createElement("textarea", {
              className: "dsh-todo-text",
              // 优先用输入中草稿（重挂载时恢复正在打的字，防吞字）；否则任务原文
              defaultValue: draft !== undefined ? draft : task.text,
              autoFocus: true,
              rows: 1,
              ref: sizeTextarea,
              placeholder: "待办内容…",
              // 多行编辑：随内容自动增高；同步记录草稿
              onInput: (e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; onDraft(task.id, el.value); },
              onKeyDown: (e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onChangeText(task.id, e.currentTarget.value); }
                else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
              },
              onBlur: (e) => onChangeText(task.id, e.currentTarget.value)
            })
          : react.createElement(
              "span",
              {
                style: textStyle,
                onDoubleClick: () => { if (!task.done) setEditing(task.id); },
                onPointerDown: onTextPointerDown,
                onPointerUp: onDragCancel,
                onPointerCancel: onDragCancel,
                onContextMenu: (e) => e.preventDefault(),
                title: task.text
              },
              task.text === "" ? "（空待办）" : task.text
            ),
        react.createElement(
          "button",
          {
            type: "button",
            style: { ...s.actionBtn, ...(task.done ? s.actionBtnDisabled : {}) },
            disabled: task.done,
            title: "推送到消息发送框",
            "aria-label": "推送到消息发送框",
            onClick: () => onPush(task.id)
          },
          "↗"
        ),
        react.createElement(
          "button",
          {
            type: "button",
            style: { ...s.actionBtn, ...(task.done ? s.actionBtnDisabled : {}) },
            disabled: task.done,
            title: "删除待办",
            "aria-label": "删除待办",
            onClick: () => onDelete(task.id)
          },
          "🗑"
        )
      );
    }

    // ── 悬浮面板 ──────────────────────────────────────────────────────────────
    function SessionTodosPanel({ t: tProp, sessions, pushToComposer }) {
      const t = typeof tProp === "function" ? tProp : (key, opts) => {
        const template = zh[key] ?? key;
        if (opts) return String(template).replace("{n}", String(opts.n ?? ""));
        return template;
      };
      const [sessionId, setSessionId] = react.useState(() => {
        try { return sessions.list.getSnapshot().current ?? null; } catch { return null; }
      });
      // 按会话的展开/收起状态：挂载时从前端每会话记录恢复（无记录=默认收起）
      const [collapsed, setCollapsed] = react.useState(() => {
        try { return readCollapsed(sessions.list.getSnapshot().current ?? null); } catch { return true; }
      });
      // tasks / geometry / editingId 初始值都从 window 级 W 恢复：模块热重载导致的
      // 重挂载是「无感」的——挂载首帧就渲染与卸载前相同的内容。
      const [tasks, setTasks] = react.useState(() => {
        try {
          const sid = sessions.list.getSnapshot().current;
          return sid && W.tasks[sid] ? W.tasks[sid] : [];
        } catch { return []; }
      });
      const [geometry, setGeometry] = react.useState(() => W.lastGeometry);
      const [notice, setNotice] = react.useState("");
      const [editingId, _setEditingId] = react.useState(() => W.editingId);
      const setEditingId = (id) => {
        W.editingId = id;
        if (id === null) W.draft = null; // 退出编辑：草稿作废
        _setEditingId(id);
      };
      const [drag, setDrag] = react.useState(null); // { id, overId, half }
      // 正在输入的文字进 window 级草稿（W.draft）：组件重挂载时 textarea 用它恢复，
      // 热重载不吞字。
      const onDraft = (id, text) => { W.draft = { id, text }; };
      // 一旦出现过会话，面板保持挂载（瞬时空 sessionId/geometry 时仅隐藏不卸载，避免吞字）
      const [knownSession, setKnownSession] = react.useState(() => {
        try { return (sessions.list.getSnapshot().current ?? null) !== null; } catch { return false; }
      });
      const listRef = react.useRef(null);

      // 会话切换订阅
      react.useEffect(
        () =>
          sessions.list.subscribe((snap) => {
            const next = snap && snap.current ? snap.current : null;
            if (next) setKnownSession(true);
            setSessionId(next);
          }),
        [sessions]
      );
      // 切换会话时恢复到离开该会话时的展开/收起状态（新会话无记录→默认收起）
      react.useEffect(() => {
        if (sessionId === null) return;
        setCollapsed(readCollapsed(sessionId));
      }, [sessionId]);

      // 会话列表在重建/更新时可能发出瞬时的 null。liveSession 延迟 400ms 才认定
      // 「无会话」：瞬时 null 期间面板保持原样（不闪 hidden），真正的会话关闭才收起。
      const [liveSession, setLiveSession] = react.useState(sessionId);
      react.useEffect(() => {
        if (sessionId === null) {
          const t = window.setTimeout(() => setLiveSession(null), 400);
          return () => window.clearTimeout(t);
        }
        setLiveSession(sessionId);
      }, [sessionId]);

      // 会话切换 → 拉取该会话待办。W.loaded（window 级）保证「同一会话不重复拉取」：
      // 热重载重挂载后不会重新 get（直接用 W.tasks 恢复），瞬时 sessionId 为 null 时
      // 保留现有任务/编辑，避免把正在输入的文字覆盖掉。
      react.useEffect(() => {
        if (sessionId === null) return; // 瞬时无会话：保留现有任务与编辑态
        if (W.loaded[sessionId]) {
          // 切回已加载过的会话：从 W 同步恢复任务（不重复拉取、不闪空列表）
          setTasks(Array.isArray(W.tasks[sessionId]) ? W.tasks[sessionId] : []);
          return;
        }
        W.loaded[sessionId] = true;
        setEditingId(null);
        let cancelled = false;
        call("get", { sessionId })
          .then((v) => {
            if (cancelled) return;
            const list = Array.isArray(v && v.tasks) ? v.tasks : [];
            W.tasks[sessionId] = list;
            setTasks(list);
            setUnfinished(sessionId, list.some((x) => !x.done));
            setNotice("");
          })
          .catch(() => { if (!cancelled) setNotice(t("panel.saveFail")); });
        return () => { cancelled = true; };
      }, [sessionId]);

      // 重挂载恢复的编辑态若指向已不存在的任务（如重载恰好发生在拉取中途），
      // 丢弃悬空状态，避免 editingId 指向空气。
      react.useEffect(() => {
        if (editingId && !tasks.some((x) => x.id === editingId)) setEditingId(null);
      }, [editingId, tasks]);

      // 几何：锚定聊天区右上角（以 [data-conversation-scroll] 视口矩形为基准）
      react.useEffect(() => {
        if (!sessionId) return; // 瞬时 null 时保留上次几何（不清 null，避免闪烁）
        let observer = null;
        let retries = 0;
        let timer = null;
        let disposed = false;
        // 面板宽度：聊天区宽度的 40%（随窗口/侧栏动态变化），两道保险——
        // 下限 320px：手机等窄屏上 40% 不够用，落回 320（移动端体验不变）；
        // 上限 560px：大屏上防止面板过宽挤占聊天区。
        const panelWidth = (chatW) => Math.min(560, Math.max(320, Math.round(chatW * 0.4)));
        const measure = () => {
          const scrollport = document.querySelector("[data-conversation-scroll]");
          if (!scrollport) {
            setGeometry(null);
            if (!disposed && retries < 30) {
              retries += 1;
              timer = window.setTimeout(measure, 100);
            }
            return;
          }
          const rect = scrollport.getBoundingClientRect();
          const PANEL_W = panelWidth(rect.width);
          const next = { left: rect.right - PANEL_W, top: rect.top, width: PANEL_W, height: rect.height };
          setGeometry((cur) => {
            if (cur && cur.left === next.left && cur.top === next.top && cur.width === next.width && cur.height === next.height) {
              W.lastGeometry = cur;
              return cur;
            }
            W.lastGeometry = next;
            return next;
          });
          if (observer === null && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(() => measure());
            observer.observe(scrollport);
          }
        };
        measure();
        window.addEventListener("resize", measure);
        return () => {
          disposed = true;
          if (timer !== null) window.clearTimeout(timer);
          if (observer !== null) observer.disconnect();
          window.removeEventListener("resize", measure);
        };
      }, [sessionId]);

      // 持久化：写 window 缓存 + 本地 state + 服务器接口 + 同步未完成映射
      const persist = react.useCallback(
        (nextTasks) => {
          if (sessionId) W.tasks[sessionId] = nextTasks;
          setTasks(nextTasks);
          if (sessionId) {
            setUnfinished(sessionId, nextTasks.some((x) => !x.done));
            call("save", { sessionId, tasks: nextTasks })
              .then(() => setNotice(""))
              .catch(() => setNotice(t("panel.saveFail")));
          }
        },
        [sessionId, t]
      );

      const toggle = (id) => {
        persist(tasks.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
      };
      const changeText = (id, text) => {
        setEditingId(null);
        const trimmed = typeof text === "string" ? text.trim() : "";
        // 空文字不落盘：若任务文字被清空，直接丢弃。
        if (trimmed === "") {
          persist(tasks.filter((x) => x.id !== id));
          return;
        }
        persist(tasks.map((x) => (x.id === id ? { ...x, text: trimmed, done: x.done } : x)));
      };
      const del = (id) => {
        const task = tasks.find((x) => x.id === id);
        const label = task && task.text && task.text.trim() !== "" ? task.text.trim() : "该待办";
        // 删除前二次确认
        if (!window.confirm(`确定删除「${label}」吗？`)) return;
        persist(tasks.filter((x) => x.id !== id));
      };
      const push = (id) => {
        const task = tasks.find((x) => x.id === id);
        if (!task || typeof task.text !== "string" || task.text.trim() === "") return;
        const ok = pushToComposer(sessionId, task.text);
        if (!ok) setNotice(t("panel.saveFail"));
      };
      const addTask = (e) => {
        e && e.preventDefault();
        const id = "t-" + Math.random().toString(36).slice(2, 10);
        const next = [...tasks, { id, text: "", done: false, createdAt: Date.now(), updatedAt: Date.now() }];
        if (sessionId) W.tasks[sessionId] = next; // 未提交也入缓存：重挂载不丢刚建的任务
        setTasks(next);
        setEditingId(id);
      };

      // 长按拖拽逻辑（hold 320ms 起手）
      const holdTimer = react.useRef(null);
      const dragIdRef = react.useRef(null);
      const tasksRef = react.useRef([]);
      tasksRef.current = tasks;
      const onDragStart = (e, id) => {
        // 不判定 e.button：触屏 pointerdown 的 button 在不同设备可能不同，统一按主指针处理
        if (editingId !== null || drag !== null) return;
        // 注意：不能在 pointerdown 上 preventDefault —— 那会吞掉后续 click/dblclick，导致双击进不了编辑。
        // 触屏防滚动/防选中/防长按菜单已由 span 的 touch-action:none + user-select:none + contextmenu 来处理。
        if (holdTimer.current) window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => {
          dragIdRef.current = id;
          setDrag({ id });
        }, 320);
      };
      const onDragCancel = () => {
        if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
      };
      // 进入 drag 态后由 window 监听接管：实时跟随手指重排 + 松手持久化。
      // 用 refs 读最新值，避免 setTasks 每次重排都重挂监听（会丢 move 事件、不跟手）。
      react.useEffect(() => {
        if (drag === null) return;
        const draggingId = drag.id;
        const onMove = (e) => {
          const listEl = listRef.current;
          if (!listEl) return;
          const rows = [...listEl.querySelectorAll("[data-dsh-todo-row]")];
          const y = e.clientY;
          // 计算指针下方的插入位 k：跳过被拖行，按其它行上半/下半中点计数
          let k = 0;
          for (const row of rows) {
            const rid = row.getAttribute("data-dsh-todo-row");
            if (rid === draggingId) continue;
            const r = row.getBoundingClientRect();
            if (y < r.top + r.height / 2) break;
            k += 1;
          }
          setTasks((prev) => {
            const from = prev.findIndex((t) => t.id === draggingId);
            if (from === -1) return prev;
            const next = prev.filter((t) => t.id !== draggingId);
            const insertAt = Math.min(k, next.length);
            if (insertAt === from) return prev; // 顺序未变，避免多余重排
            next.splice(insertAt, 0, prev[from]);
            tasksRef.current = next; // 立即同步，供松手持久化
            return next;
          });
        };
        const onUp = () => {
          if (dragIdRef.current !== null) persist(tasksRef.current); // 保存重排后的最终顺序
          dragIdRef.current = null;
          setDrag(null);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [drag, persist]);

      // 移动端（pointer: coarse）：点击面板外（消息区）自动收起。参考 Outline 插件。
      react.useEffect(() => {
        if (collapsed || sessionId === null) return;
        let coarse = false;
        try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { coarse = false; }
        if (!coarse) return;
        const onDocClick = (event) => {
          const target = event.target;
          if (
            target &&
            typeof target.closest === "function" &&
            target.closest("[data-dsh-todo-panel], [data-dsh-todo-expand]")
          ) {
            return;
          }
          setCollapsed(true);
          writeCollapsed(sessionId, true);
        };
        document.addEventListener("click", onDocClick);
        return () => document.removeEventListener("click", onDocClick);
      }, [collapsed, sessionId]);

      // 一旦出现过会话，面板保持挂载；瞬时空 sessionId/geometry 时仅隐藏（visibility），
      // 避免卸载导致正在编辑的输入框丢失文字（吞字）。
      if (!knownSession) return null;
      const geo = geometry || W.lastGeometry;
      if (!geo) return null; // 聊天区几何尚未测得（如还未进入对话视图）：暂不渲染，但保持组件挂载
      // 可见性用「回退后的几何」判定：切换会话时新旧滚动区之间的间隙不再让面板闪 hidden
      const visible = liveSession !== null && geo !== null;

      const setCollapsedPersist = (val) => {
        setCollapsed(val);
        writeCollapsed(sessionId, val);
      };

      const collapseBtn = collapsed
        ? null
        : react.createElement(
            "button",
            {
              type: "button",
              style: { ...s.iconBtn, marginLeft: "auto" },
              title: t("panel.collapseTip"),
              "aria-label": t("panel.collapseTip"),
              "data-dsh-todo-collapse": true,
              onClick: () => setCollapsedPersist(true)
            },
            "→"
          );

      const expandBtn = collapsed && visible
        ? react.createElement(
            "button",
            {
              type: "button",
              style: { ...s.iconBtn, position: "fixed", left: geo.left + geo.width - 30, top: geo.top + 8, width: 24, height: 24, zIndex: 1004 },
              title: t("panel.expandTip"),
              "aria-label": t("panel.expandTip"),
              "data-dsh-todo-expand": true,
              onClick: () => setCollapsedPersist(false)
            },
            "🎯"
          )
        : null;

      const doneCount = tasks.filter((x) => x.done).length;
      const total = tasks.length;

      // 裁剪容器：锚定聊天区右上角，overflow hidden；面板在其内以 translateX 滑入/滑出
      // （参考 Outline 插件：展开 = 滑入，收起 = 向右滑出并被裁剪）。
      const clipStyle = {
        position: "fixed",
        left: geo.left,
        top: geo.top - 24,
        width: geo.width + 60,
        height: geo.height + 56,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 1003,
        visibility: visible ? "visible" : "hidden"
      };
      const panelStyle = {
        ...s.panel,
        position: "absolute",
        left: 0,
        top: 34,
        width: geo.width,
        maxHeight: Math.max(220, geo.height - 16),
        pointerEvents: "auto",
        visibility: visible ? "visible" : "hidden",
        transform: collapsed ? "translateX(100%)" : "translateX(0)",
        transition: "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)"
      };

      const panelNode = react.createElement(
        "div",
        { style: clipStyle },
        react.createElement(
          "div",
          { style: panelStyle, "data-dsh-todo-panel": true },
          react.createElement(
            "div",
            { style: s.header },
            react.createElement("span", { className: "dsh-todo-header-ico", "aria-hidden": true, style: { flex: "none", fontSize: 13, lineHeight: 1 } }, "🎯"),
            react.createElement("span", { style: s.headerTitle }, t("panel.title")),
            react.createElement("span", { style: { ...s.headerCount, flex: "none" }, title: `${doneCount}/${total}` }, `${doneCount}/${total}`),
            collapseBtn
          ),
          notice !== "" && react.createElement("div", { style: s.notice }, notice),
          react.createElement(
            "div",
            { ref: listRef, style: s.list },
            tasks.length === 0
              ? react.createElement("div", { style: { padding: "18px 10px", textAlign: "center", fontSize: 13, color: "var(--dsw-alias-label-caption,#999)" } }, t("panel.empty"))
              : tasks.map((task) =>
                  react.createElement(TaskRow, {
                    key: task.id,
                    task,
                    done: task.done,
                    editing: editingId === task.id,
                    draft: W.draft && W.draft.id === task.id ? W.draft.text : undefined,
                    onDraft,
                    setEditing: (id) => setEditingId(id),
                    onToggle: toggle,
                    onChangeText: changeText,
                    onPush: push,
                    onDelete: del,
                    onDragStart,
                    onDragCancel,
                    dragging: drag !== null && drag.id === task.id
                  })
                )
          ),
          react.createElement(
            "div",
            { style: s.footer },
            react.createElement("button", { type: "button", style: s.addBtn, title: t("panel.addTip"), onClick: addTask }, "+")
          )
        )
      );

      return react.createElement(react.Fragment, null, panelNode, expandBtn);
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────
    const inject = ["slots", "sessions", "locale"];

    function apply(ctx) {
      // 注册双向文案
      ctx.effect(() => {
        const z = ctx.locale.register(NS, "zh", zh);
        const e = ctx.locale.register(NS, "en", en);
        return () => { z(); e(); };
      }, "dsh-session-todos: dictionaries");

      const sessions = ctx.sessions;

      /** 把任务文本追加进会话消息发送框（追加语义）。 */
      const pushToComposer = (sessionId, text) => {
        try {
          const actx = sessions.scope(sessionId);
          const conversation = actx && typeof actx.get === "function"
            ? (actx.get("conversation") || ctx.get("conversation"))
            : ctx.get("conversation");
          const resolver = conversation && conversation.input;
          if (!resolver) throw new Error("conversation input unavailable");
          // 优先 input.shell(sessionId)（已证明可用，不依赖会话已 open），
          // 回退 input.for(actx)（公开契约）。
          const shell =
            typeof resolver.shell === "function"
              ? resolver.shell(sessionId)
              : typeof resolver.for === "function" && actx
                ? resolver.for(actx)
                : null;
          if (!shell) throw new Error("conversation input shell unavailable");
          const cur = shell.state && shell.state.getSnapshot ? shell.state.getSnapshot().draft : "";
          const next = typeof cur === "string" && cur.trim() !== "" ? `${cur}\n${text}` : text;
          shell.setDraft(next);
          return true;
        } catch (err) {
          console.error("[dsh-session-todos] pushToComposer failed:", err);
          return false;
        }
      };

      // 会话行徽章：订阅未完成 store + 会话列表（数据源变化时重扫）。
      // summary 只在初始加载 / 窗口聚焦 / 标签页切回时刷新——没有定时轮询
      // （旧版 60s setInterval 已被移除：周期性刷新会造成无谓闪烁，已按反馈去除）。
      // 不用 body 级 MutationObserver（会在用户每敲一个键/每次聊天渲染时反复触发，造成卡顿/闪烁）。
      ctx.effect(() => {
        let debounce = null;
        const refreshSummary = () =>
          call("summary", {})
            .then((v) => { seedUnfinished(v && v.sessions); syncBadges(); })
            .catch(() => {});
        const runSync = () => {
          if (debounce !== null) window.clearTimeout(debounce);
          debounce = window.setTimeout(syncBadges, 200);
        };
        const unsubUnfinished = subscribeUnfinished(runSync);
        const unsubList = sessions.list.subscribe(runSync);
        syncBadges();
        refreshSummary();
        window.addEventListener("focus", refreshSummary);
        const onVis = () => { if (document.visibilityState === "visible") refreshSummary(); };
        document.addEventListener("visibilitychange", onVis);
        return () => {
          unsubUnfinished();
          unsubList();
          window.removeEventListener("focus", refreshSummary);
          document.removeEventListener("visibilitychange", onVis);
          if (debounce !== null) window.clearTimeout(debounce);
        };
      }, "dsh-session-todos: session-row badges");

      // 悬浮面板（shell.overlay；order 较高避免被 outline 覆盖）
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "dsh-session-todos-panel",
            order: 40,
            locale: NS,
            inject: () => ({ sessions, pushToComposer })
          },
          SessionTodosPanel
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
