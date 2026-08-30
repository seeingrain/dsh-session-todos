/**
 * dsh-session-todos — browser half（手写 bundle，无需构建）。
 *
 * 功能：
 *  1) 右上角悬浮「待办」面板（shell.overlay）：展开=待办列表浮在对话区右上角，
 *     收缩=只在右上角显示 🎯 图标；展开态右上角有「→」收起按钮。
 *  2) 任务行：勾选框 + 文字框 + 右侧两按钮（推送到发送框 / 删除），下一行
 *     颜色按钮 🎨（点开常用色板，选色后任务文本变色）；勾选后置灰、
 *     按钮禁用；勾选/取消立即存；双击原地编辑；单击选中后长按 300ms 拖动排序
 *     （拖拽行实时跟手，手机进入拖动时震动；未选中行按动为原生行为：滚动/选文字）；
 *     列表上下对称的两个「+」：上「+」在开头插入、下「+」追加末尾。
 *  3) 服务器端跨端存储：所有写操作打到 host 的 /dsh-session-todos/api；
 *     任意端保存后 host 经 SSE（/events）广播，其余端收到即重取 → 实时同步。
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

    /** 复制文本到剪贴板：优先 Clipboard API（安全上下文），失败退回 execCommand。 */
    async function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return true; } catch { /* 退回兼容路径 */ }
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
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
      selectedId: null, // 当前选中的任务 id（选中才能拖动排序；重挂载后保留）
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
          // 位置：状态图标的右边、标题之前。
          // 状态 slot 的文本全在嵌套的 visually-hidden span 里（自身无直接文本节点），
          // 标题 span 才有直接文本节点 → 找第一个「有直接非空文本节点」的子节点 = 标题，
          // 徽章插在它前面（有状态图标时即状态图标右边；无状态图标的 flat 布局即行首）。
          const titleEl = [...row.children].find(
            (c) => [...c.childNodes].some((n) => n.nodeType === 3 && (n.textContent || "").trim() !== "")
          );
          if (titleEl) row.insertBefore(badge, titleEl);
          else row.appendChild(badge);
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
      "panel.expandTipNone": "暂无待办（点击展开）",
      "panel.addTip": "新建待办",
      "panel.addTopTip": "在开头新建待办",
      "panel.pushTip": "推送到消息发送框",
      "panel.deleteTip": "删除待办",
      "panel.saveFail": "保存失败，请重试",
      "panel.doneTip": "已完成",
      "panel.placeholder": "待办内容…",
      "panel.colorTip": "指定文本颜色",
      "panel.colorDefault": "默认"
    };
    const en = {
      "panel.title": "Session Todos",
      "panel.empty": "No todos yet — click + to add",
      "panel.pending": "{n} unfinished",
      "panel.collapseTip": "Collapse todo panel",
      "panel.expandTip": "Expand todo panel",
      "panel.expandTipNone": "No todos (click to expand)",
      "panel.addTip": "New todo",
      "panel.addTopTip": "New todo at top",
      "panel.pushTip": "Push to message composer",
      "panel.deleteTip": "Delete todo",
      "panel.saveFail": "Save failed, please retry",
      "panel.doneTip": "Completed",
      "panel.placeholder": "Todo text…"
    };

    // ── 面板样式对象 ─────────────────────────────────────────────────────────
    const ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";
    // 常用色板（深浅背景均可读）；默认色 = null（跟随主题）
    const PALETTE = ["#e5484d", "#f76b15", "#d9a406", "#30a46c", "#12a594", "#3b82f6", "#6366f1", "#8e4ec6", "#e5489b", "#8b5e34"];
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
      // 任务行：单行结构（勾选+文字+右侧按钮两行 [发送/复制 | 颜色/删除]）
      row: { display: "flex", flexDirection: "column", gap: 2, padding: "4px 6px", borderRadius: 8, background: "transparent", border: "1px solid transparent" },
      rowTop: { display: "flex", alignItems: "flex-start", gap: 8 },
      // 右侧按钮区：两行——第一行 发送/复制 并排，第二行 调色盘（左）/删除（右）
      actionsCol: { flex: "none", display: "flex", flexDirection: "column", gap: 4, marginTop: 2, alignItems: "flex-start" },
      actionsRow: { display: "flex", gap: 4 },
      actionsRow2: { display: "flex", gap: 4, width: "100%" },
      // 选中态：整行描边 + 浅底（基类 row 自带 1px 透明边框，描边不引起布局位移）
      rowSelected: { border: `1px solid ${ACCENT}`, background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09))", cursor: "grab" },
      rowDrag: { background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09))", border: `1px solid ${ACCENT}`, boxShadow: "0 3px 12px rgba(0,0,0,.22)", position: "relative", zIndex: 2, cursor: "grabbing", willChange: "transform" },
      // 调色板：fixed 弹层（5×N 网格），锚在 🎨 按钮旁，不受列表滚动裁切
      colorPop: {
        position: "fixed", zIndex: 1006, padding: 8,
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))",
        borderRadius: 10, boxShadow: "0 6px 20px rgba(0,0,0,.25)",
        display: "grid", gridTemplateColumns: "repeat(5, 22px)", gap: 6, alignContent: "start"
      },
      swatch: { width: 20, height: 20, padding: 0, borderRadius: 10, border: "2px solid rgba(0,0,0,.25)", cursor: "pointer" },
      swatchDefault: { width: 20, height: 20, padding: 0, borderRadius: 10, border: "2px solid var(--dsw-alias-border-l2, rgba(0,0,0,.3))", background: "transparent", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, lineHeight: 1, fontFamily: "inherit", color: "var(--dsw-alias-label-secondary, #666)" },
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
      // 顶部「+」行：footer 的镜像（padding 上下对调），保证两个「+」上下对称
      topAdd: { display: "flex", padding: "10px 8px 6px" },
      addBtn: {
        flex: 1, height: 32, borderRadius: 8,
        border: "1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.25))",
        background: "transparent", color: "var(--dsw-alias-label-secondary, #666)",
        cursor: "pointer", fontSize: 14, fontFamily: "inherit"
      },
      notice: { padding: "4px 12px 6px", fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d33)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
    };

    // ── 任务行 ────────────────────────────────────────────────────────────────
    // 交互模型（2026-08-29 重构）：单击选中（整行描边）；仅选中行可拖动排序；
    // 未选中行不设 touch-action/user-select —— 在其上按动 = 原生行为（滚动/选文字）。
    function TaskRow({
      task, done, editing, draft, onDraft, setEditing, onToggle, onChangeText, onPush, onDelete,
      selected, onRowPointerDown, onRowClick, dragging,
      onColorMenuToggle
    }) {
      // 选中且非编辑中才接管触摸手势（拖拽）；否则全部交给浏览器原生处理
      const gestureLock = selected && !editing
        ? { touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }
        : {};
      const textStyle = {
        ...s.text,
        // 自定义文本色（完成态置灰优先覆盖）
        ...(task.color && !task.done ? { color: task.color } : {}),
        ...(task.done ? s.textDone : {}),
        ...gestureLock
      };
      // 双击进入编辑：textarea 挂载即按内容自动增高（否则多行文字只显示第一行）
      const sizeTextarea = react.useCallback((el) => {
        if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
      }, []);
      return react.createElement(
        "div",
        {
          "data-dsh-todo-row": task.id,
          style: {
            ...s.row,
            ...(task.done ? { opacity: 0.55 } : {}),
            ...(selected ? s.rowSelected : {}),
            ...(dragging ? s.rowDrag : {}),
            ...(selected ? { touchAction: "none", WebkitTouchCallout: "none" } : {})
          },
          onPointerDown: (e) => onRowPointerDown(e, task.id),
          onClick: (e) => onRowClick(e, task.id)
        },
        // 上行：勾选 + 文字 + 按钮区（发送/复制 + 颜色/删除）
        react.createElement(
          "div",
          { style: s.rowTop, "data-dsh-todo-row-top": task.id },
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
                  if (e.key === "Escape") { e.preventDefault(); setEditing(null); return; }
                  if (e.key === "Enter" && !e.shiftKey) {
                    // 移动端（粗指针）：Enter 只是换行，不提交（提交靠失焦 onBlur）；
                    // PC 端保持原逻辑：Enter 提交，Shift+Enter 换行。
                    let coarse = false;
                    try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { /* 视为 PC */ }
                    if (!coarse) { e.preventDefault(); onChangeText(task.id, e.currentTarget.value); }
                  }
                },
                onBlur: (e) => onChangeText(task.id, e.currentTarget.value)
              })
            : react.createElement(
                "span",
                {
                  style: textStyle,
                  onDoubleClick: () => { if (!task.done && !editing) setEditing(task.id); },
                  // 选中行：吞掉右键/系统长按菜单（拖拽手势期）；未选中行：保留原生菜单
                  onContextMenu: selected ? (e) => e.preventDefault() : undefined,
                  title: task.text
                },
                task.text === "" ? "（空待办）" : task.text
              ),
          react.createElement(
            "div",
            { style: s.actionsCol, "data-dsh-todo-actions": task.id },
            // 第一行：发送 + 复制 并排
            react.createElement(
              "div",
              { style: s.actionsRow },
              react.createElement(
                "button",
                {
                  type: "button",
                  style: { ...s.actionBtn, ...(task.done ? s.actionBtnDisabled : {}) },
                  disabled: task.done,
                  title: "推送到消息发送框",
                  "aria-label": "推送到消息发送框",
                  onClick: (e) => { e.stopPropagation(); onPush(task.id); }
                },
                "↗"
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  style: { ...s.actionBtn, ...(task.done ? s.actionBtnDisabled : {}) },
                  disabled: task.done,
                  title: "复制待办内容",
                  "aria-label": "复制待办内容",
                  "data-dsh-todo-copy": task.id,
                  // 复制成功后短暂显示 ✓ 作为反馈（直接改 DOM，不引入行状态）
                  onClick: (e) => {
                    e.stopPropagation();
                    copyText(task.text);
                    const el = e.currentTarget;
                    const prev = el.textContent;
                    el.textContent = "✓";
                    window.setTimeout(() => { el.textContent = prev; }, 800);
                  }
                },
                "📋"
              )
            ),
            // 第二行：调色盘（左）+ 删除（右，靠右对齐做调色盘的邻居）
            react.createElement(
              "div",
              { style: s.actionsRow2 },
              react.createElement(
                "button",
                {
                  type: "button",
                  style: { ...s.iconBtn, ...(task.done ? s.actionBtnDisabled : {}) },
                  disabled: task.done,
                  title: "指定文本颜色",
                  "aria-label": "指定文本颜色",
                  onClick: (e) => { e.stopPropagation(); onColorMenuToggle(task.id, e.currentTarget); }
                },
                "🎨"
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  style: { ...s.actionBtn, marginLeft: "auto", ...(task.done ? s.actionBtnDisabled : {}) },
                  disabled: task.done,
                  title: "删除待办",
                  "aria-label": "删除待办",
                  onClick: (e) => { e.stopPropagation(); onDelete(task.id); }
                },
                "🗑"
              )
            )
          )
        ),

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
      // 选中态（window 级，重挂载保留）：单击选中（再点保持选中，不取消）；只有选中行可拖拽排序
      const [selectedId, _setSelectedId] = react.useState(() => W.selectedId ?? null);
      const setSelectedId = (id) => { W.selectedId = id; _setSelectedId(id); };
      // 打开中的调色板（瞬时 UI，不做 window 级保留）：单值 → 开新行的板自动关旧行
      const [colorMenuId, setColorMenuId] = react.useState(null);
      const [colorPopPos, setColorPopPos] = react.useState(null); // fixed 弹层锚点 {x,y}
      const swipeLockRef = react.useRef(0); // 右滑收起后的时间戳：600ms 内忽略合成 click（防弹回）
      const colorGuardRef = react.useRef(0); // 最近一次颜色操作时间戳：800ms 内点面板外不收起面板
      const [swipeAnim, setSwipeAnim] = react.useState(null); // 右滑收起收尾动画 {dur}（时长按释放速度定，跟手）
      const panelRef = react.useRef(null); // 面板根节点（右滑手势用）
      const swipeDxRef = react.useRef(null); // 拖拽中的位移（重渲染时 transform 读它，跟手不被打断）
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
        // 选中/色板是瞬态 UI：切会话即清除（不做跨会话记忆）；进行中的长按计时一并取消
        if (W.selectedId !== null) setSelectedId(null);
        if (colorMenuId !== null) setColorMenuId(null);
        clearArm();
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

      // 跨端实时同步：host 在任意端 save 成功后经 SSE 广播 tasks-changed。
      // 收到即重取该会话——当前会话直接刷新面板，其他会话更新 W 缓存与
      // 未完成徽章（之后切过去直接命中 W，不会显示旧数据）。
      // 空闲成本≈0（无轮询）；EventSource 断线自动重连（host 端 retry 3000ms）。
      react.useEffect(() => {
        let es = null;
        let disposed = false;
        try {
          es = new EventSource(`${API_PREFIX}/events`);
          es.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (!msg || msg.type !== "tasks-changed" || typeof msg.sessionId !== "string") return;
              const sid = msg.sessionId;
              call("get", { sessionId: sid })
                .then((v) => {
                  if (disposed) return;
                  const list = Array.isArray(v && v.tasks) ? v.tasks : [];
                  W.loaded[sid] = true;
                  W.tasks[sid] = list;
                  setUnfinished(sid, list.some((x) => !x.done));
                  if (sid === sessionId) setTasks(list);
                })
                .catch(() => { /* 拉取失败忽略：下次切换会话会重新拉取 */ });
            } catch { /* 忽略坏事件 */ }
          };
        } catch { /* 不支持 EventSource 的浏览器：退化为手动刷新 */ }
        return () => {
          disposed = true;
          if (es) es.close();
        };
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
        // 勾成已完成的任务不可再排序：释放选中
        if (selectedId === id && !tasks.find((x) => x.id === id)?.done) setSelectedId(null);
        if (colorMenuId === id) setColorMenuId(null);
        persist(tasks.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
      };
      const changeText = (id, text) => {
        setEditingId(null);
        const trimmed = typeof text === "string" ? text.trim() : "";
        // 空文字不落盘：若任务文字被清空，直接丢弃。
        if (trimmed === "") {
          if (selectedId === id) setSelectedId(null);
          if (colorMenuId === id) setColorMenuId(null);
          persist(tasks.filter((x) => x.id !== id));
          return;
        }
        persist(tasks.map((x) => (x.id === id ? { ...x, text: trimmed, color: x.color, done: x.done } : x)));
      };
      const del = (id) => {
        const task = tasks.find((x) => x.id === id);
        const label = task && task.text && task.text.trim() !== "" ? task.text.trim() : "该待办";
        // 删除前二次确认
        if (!window.confirm(`确定删除「${label}」吗？`)) return;
        if (selectedId === id) setSelectedId(null);
        if (colorMenuId === id) setColorMenuId(null);
        persist(tasks.filter((x) => x.id !== id));
      };
      const push = (id) => {
        const task = tasks.find((x) => x.id === id);
        if (!task || typeof task.text !== "string" || task.text.trim() === "") return;
        const ok = pushToComposer(sessionId, task.text);
        if (!ok) setNotice(t("panel.saveFail"));
      };
      // 颜色板开关 + 选色（null = 恢复默认）：选择即落盘并收起色板
      const colorMenuToggle = (id, btnEl) => {
        if (tasks.find((x) => x.id === id)?.done) return;
        colorGuardRef.current = Date.now();
        if (colorMenuId === id) { setColorMenuId(null); return; }
        if (btnEl && typeof btnEl.getBoundingClientRect === "function") {
          const r = btnEl.getBoundingClientRect();
          const popW = 150, popH = 96; // 5×N 网格（10 色 + 默）实测尺寸
          let x = r.right - popW - 4;   // 锚在按钮上方偏左（文字一侧）
          let y = r.top - popH - 6;     // 默认向上弹（下方多半是后续行/底部）
          const vw = window.innerWidth, vh = window.innerHeight;
          if (y < 6) y = r.bottom + 6;  // 上方放不下 → 改向下弹
          if (y + popH > vh - 6) y = Math.max(6, vh - 6 - popH);
          if (x < 6) x = 6;
          if (x + popW > vw - 6) x = vw - 6 - popW;
          setColorPopPos({ x: Math.round(x), y: Math.round(y) });
        }
        setColorMenuId(id);
      };
      const colorPick = (id, color) => {
        colorGuardRef.current = Date.now();
        persist(tasks.map((x) => (x.id === id ? { ...x, color } : x)));
        setColorMenuId(null);
      };
      // 删除/清空/勾选完成时收起其色板
      const closeColorMenuIf = (id) => { if (colorMenuId === id) setColorMenuId(null); };
      // atTop：header「+」在列表开头插入；footer「+」追加在末尾
      const addTask = (e, atTop = false) => {
        e && e.preventDefault();
        const id = "t-" + Math.random().toString(36).slice(2, 10);
        const task = { id, text: "", done: false, createdAt: Date.now(), updatedAt: Date.now() };
        const next = atTop ? [task, ...tasks] : [...tasks, task];
        if (sessionId) W.tasks[sessionId] = next; // 未提交也入缓存：重挂载不丢刚建的任务
        setTasks(next);
        setEditingId(id);
        if (atTop && listRef.current) listRef.current.scrollTop = 0; // 列表滚在底部时也看得见新行
      };

      // 选中 + 长按拖动排序（2026-08-29 重构）：
      //  - 单击选中（整行描边）；只有选中行 pointerdown 才「武装」300ms 长按计时器；
      //  - 计时到期且位移仍 ≤10px 才进入 drag 态（手机端震动反馈），拖拽行用
      //    transform 实时钉在指针位置（跟手），同时按指针位置重排；
      //  - 300ms 内松手 = 普通点击（选中该行，已选中则保持）；
      //  - 未选中行按动：不做任何拦截（不 preventDefault、不武装）→ 原生行为
      //    （触摸=滚动，桌面=选文字/拖滚动条），永远不会触发排序逻辑。
      const HOLD_MS = 300; // 按下后需保持多久才允许拖动
      const dragIdRef = react.useRef(null);
      const armRef = react.useRef(null); // { id, sx, sy, moved, timer }：选中行按下时的状态
      const grabRef = react.useRef(null); // { dx, dy }：指针在拖拽行内的抓取点（transform 钉位用）
      const scrollArmRef = react.useRef(null); // { lastY }：选中行上的手指纵向滑动 → 手动接管列表滚动
      const suppressClickRef = react.useRef(false);
      const tasksRef = react.useRef([]);
      tasksRef.current = tasks;
      const rowElOf = (id) => {
        const listEl = listRef.current;
        return listEl ? listEl.querySelector('[data-dsh-todo-row="' + id + '"]') : null;
      };
      const clearArm = () => {
        if (armRef.current && armRef.current.timer) window.clearTimeout(armRef.current.timer);
        armRef.current = null;
        scrollArmRef.current = null; // 新的按下行为：结束任何进行中的手动滚动
      };
      const onRowPointerDown = (e, id) => {
        // 不判定 e.button：触屏 pointerdown 的 button 在不同设备可能不同，统一按主指针处理
        if (drag !== null || editingId !== null) return;
        if (e.target && e.target.closest && e.target.closest("button, input")) return; // 复选框/按钮：各自行为
        if (selectedId !== id) { clearArm(); return; } // 未选中：纯原生行为
        const x0 = e.clientX, y0 = e.clientY;
        clearArm();
        const arm = { id, sx: x0, sy: y0, moved: 0, timer: null };
        // 长按计时器：到期时位移仍小 → 进入拖动；快速按下-松开仍是点击（选中该行）
        arm.timer = window.setTimeout(() => {
          if (armRef.current !== arm) return; // 已被取消/重新武装
          if (arm.moved > 10) { clearArm(); return; } // 已明显移动：不当作长按起手
          const el = rowElOf(id);
          const r = el && el.getBoundingClientRect();
          grabRef.current = r ? { dx: x0 - r.left, dy: y0 - r.top } : { dx: 0, dy: 0 };
          armRef.current = null;
          dragIdRef.current = id;
          setDrag({ id });
          try { if (navigator.vibrate) navigator.vibrate(40); } catch {} // 进入拖动态：手机震动一下
        }, HOLD_MS);
        armRef.current = arm;
      };
      // 卸载时取消未触发的长按计时器
      react.useEffect(() => () => { if (armRef.current && armRef.current.timer) window.clearTimeout(armRef.current.timer); }, []);
      const onRowClick = (e, id) => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; } // 拖拽收尾的 click 不算
        if (editingId === id) return; // 编辑中的行：点击归编辑逻辑
        if (e.target && e.target.closest && e.target.closest("button, input")) return;
        const t = tasks.find((x) => x.id === id);
        if (!t || t.done) return; // 已完成任务不可选中（不可排序）
        if (selectedId === id) return; // 已选中：单击多少次都保持选中（不取消）
        setSelectedId(id);
      };
      // window 监听接管两个阶段：armed（长按计时中）与 drag（跟随重排+钉位）→ 松手持久化。
      // 常驻挂载（单监听、无轮询）；用 refs/闭包读最新值，避免重挂监听丢 move 事件。
      react.useEffect(() => {
        const onMove = (e) => {
          if (drag === null) {
            // 手动滚动阶段：选中行的 touch-action:none 屏蔽了原生触摸滚动，
            // 手指纵向滑动改由这里直接改列表 scrollTop（逐帧增量）。
            if (scrollArmRef.current) {
              const listEl = listRef.current;
              if (listEl) listEl.scrollTop += scrollArmRef.current.lastY - e.clientY;
              scrollArmRef.current.lastY = e.clientY;
              return;
            }
            // armed 阶段：只累计位移（是否进入拖动由长按计时器判定）
            const arm = armRef.current;
            if (!arm) return;
            arm.moved = Math.max(arm.moved, Math.abs(e.clientX - arm.sx) + Math.abs(e.clientY - arm.sy));
            // 长按未到期就先动了：纵向为主 → 放弃长按，接管列表滚动；横向为主 → 仅作废手势
            if (arm.moved > 10) {
              const dx = e.clientX - arm.sx, dy = e.clientY - arm.sy;
              if (Math.abs(dy) > Math.abs(dx)) {
                clearArm();
                scrollArmRef.current = { lastY: e.clientY };
              }
            }
            return;
          }
          const draggingId = drag.id;
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
          // 拖拽行实时钉在指针下：transform 补偿「行在列表里的当前位置 → 指针位置」。
          // 先置 transform:none 再读 rect 拿到的是布局槽位（否则读到的是已含上帧
          // transform 的视觉位置，补偿会归零）；重排后的新槽位最迟下一帧生效。
          const el = rowElOf(draggingId);
          const g = grabRef.current;
          if (el && g) {
            el.style.transform = "none";
            const r = el.getBoundingClientRect();
            el.style.transform =
              "translate(" + (e.clientX - r.left - g.dx) + "px," + (e.clientY - r.top - g.dy) + "px)";
          }
        };
        const onUp = () => {
          if (scrollArmRef.current) {
            // 滚动手势收尾：末尾的合成 click 不算点击（可能落在行尾按钮上）
            scrollArmRef.current = null;
            suppressClickRef.current = true;
            window.setTimeout(() => { suppressClickRef.current = false; }, 300);
            return;
          }
          if (dragIdRef.current !== null) {
            persist(tasksRef.current); // 保存重排后的最终顺序
            const endedId = dragIdRef.current;
            dragIdRef.current = null;
            grabRef.current = null;
            setDrag(null);
            // 钉位释放：140ms 过渡让行落回槽位，随后清掉过渡避免影响后续操作
            const el = rowElOf(endedId);
            if (el) {
              el.style.transition = "transform 140ms ease-out";
              el.style.transform = "translate(0px, 0px)";
              window.setTimeout(() => { el.style.transition = ""; }, 200);
            }
            // 拖拽收尾伴随的 click 不当作选中切换（click 在 pointerup 之后触发）
            suppressClickRef.current = true;
            window.setTimeout(() => { suppressClickRef.current = false; }, 300);
          } else {
            const arm = armRef.current;
            if (arm) {
              if (arm.timer) window.clearTimeout(arm.timer);
              armRef.current = null;
              if (arm.moved > 10) {
                // 按住移动过但长按未触发：既不当拖动也不当点击（废手势不触发任何操作）
                suppressClickRef.current = true;
                window.setTimeout(() => { suppressClickRef.current = false; }, 300);
              }
              // 未移动的按下-松开：交给 onClick 处理选中切换
            }
          }
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

      // 点击面板外（消息区）：移动端自动收起（参考 Outline）；任何端点色板外关闭色板。
      // 保护：刚做过颜色操作（800ms 内）或刚右滑收起（600ms 内，防浏览器合成 click 误触）不收起。
      react.useEffect(() => {
        if (sessionId === null) return;
        let coarse = false;
        try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { coarse = false; }
        const onDocClick = (event) => {
          const target = event.target;
          const inside = (sel) => target && typeof target.closest === "function" && target.closest(sel);
          const inPanel = inside("[data-dsh-todo-panel], [data-dsh-todo-expand]");
          const inPop = inside("[data-dsh-todo-colorbar]");
          if (colorMenuId !== null && !inPop) setColorMenuId(null);
          if (collapsed || !coarse || inPanel || inPop) return;
          const now = Date.now();
          if (now - colorGuardRef.current < 800) return;
          if (now - swipeLockRef.current < 600) return;
          setCollapsed(true);
          writeCollapsed(sessionId, true);
        };
        document.addEventListener("click", onDocClick);
        return () => document.removeEventListener("click", onDocClick);
      }, [collapsed, sessionId, colorMenuId]);

      // 移动端（pointer: coarse）：在面板上向右滑跟手收起。
      //  - 拖拽中面板 translateX 实时钉在手指位置（transition:none，1:1 跟手）；
      //  - 松手时位移 > 40% 宽 或 释放速度 > 0.55px/ms → 收起，收尾过渡时长 =
      //    剩余距离 / 释放速度（钳 120–320ms），收起节奏与手速一致；
      //  - 否则 200ms 弹回原位。
      //  - 仅水平主导（|dx|>10 且 |dx|>1.5|dy|）才接管；垂直移动交给列表原生滚动；
      //  - 起手在 input/textarea 上不接管（编辑中不误触）；行长按拖动用 pointer
      //    事件 + 300ms 计时，快速横移会使其位移 >10px 而放弃激活，互不冲突。
      react.useEffect(() => {
        if (collapsed || sessionId === null) return;
        let coarse = false;
        try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { coarse = false; }
        if (!coarse) return;
        const el = panelRef.current;
        if (!el) return;
        let st = null; // { x0, y0, mode: "pending"|"swipe"|"other", lastX, lastT, vx }
        const onDown = (e) => {
          if (e.touches.length !== 1) return;
          const tgt = e.target;
          if (tgt && tgt.closest && tgt.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
          const p = e.touches[0];
          st = { x0: p.clientX, y0: p.clientY, mode: "pending", lastX: p.clientX, lastT: performance.now(), vx: 0 };
        };
        const onMove = (e) => {
          if (!st) return;
          const p = e.touches[0];
          const dx = p.clientX - st.x0;
          const dy = p.clientY - st.y0;
          const now = performance.now();
          st.vx = 0.8 * st.vx + 0.2 * ((p.clientX - st.lastX) / Math.max(1, now - st.lastT));
          st.lastX = p.clientX;
          st.lastT = now;
          if (st.mode === "pending") {
            if (Math.abs(dx) > 10 && Math.abs(dx) > 1.5 * Math.abs(dy)) st.mode = "swipe";
            else if (Math.abs(dy) > 14) { st.mode = "other"; st = null; return; }
            else return;
          }
          if (st.mode !== "swipe") return;
          e.preventDefault(); // 接管中：挡住原生滚动/横拉
          const off = Math.max(0, dx); // 只有向右滑收起；左滑不移动
          swipeDxRef.current = off;
          el.style.transition = "none";
          el.style.transform = "translateX(" + off + "px)";
        };
        const onEnd = (e) => {
          if (!st) return;
          const s = st;
          st = null;
          if (s.mode !== "swipe") return;
          swipeDxRef.current = null;
          const p = e.changedTouches && e.changedTouches[0];
          const dx = p ? p.clientX - s.x0 : 0;
          const w = el.getBoundingClientRect().width || 300;
          const shouldClose = dx > w * 0.4 || s.vx > 0.55;
          if (shouldClose) {
            const remaining = Math.max(20, w - Math.max(0, dx));
            const dur = s.vx > 0.3 ? Math.round(Math.min(320, Math.max(120, remaining / (s.vx * 1000) * 1000))) : 220;
            swipeLockRef.current = Date.now(); // 合成 click 锁：防弹回
            setColorMenuId(null);
            setSwipeAnim({ dur });
            setCollapsed(true);
            writeCollapsed(sessionId, true);
            // 收尾只复位动画时长（React 重渲染会按 collapsed 状态重写下 transform/transition）。
            // 绝不能清 el.style.transform：面板隐藏完全靠 translateX(100%)（自然位置=展开位），
            // 清空后 React diff 认为 transform「未变」不再写回 → 动画结束瞬间弹回展开位。
            window.setTimeout(() => { setSwipeAnim(null); }, dur + 80);
          } else {
            el.style.transition = "transform 200ms cubic-bezier(0.4, 0, 0.2, 1)";
            el.style.transform = "translateX(0px)";
            window.setTimeout(() => { el.style.transition = ""; el.style.transform = ""; }, 260);
          }
        };
        el.addEventListener("touchstart", onDown, { passive: true });
        el.addEventListener("touchmove", onMove, { passive: false });
        el.addEventListener("touchend", onEnd);
        el.addEventListener("touchcancel", onEnd);
        return () => {
          el.removeEventListener("touchstart", onDown);
          el.removeEventListener("touchmove", onMove);
          el.removeEventListener("touchend", onEnd);
          el.removeEventListener("touchcancel", onEnd);
        };
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

      const doneCount = tasks.filter((x) => x.done).length;
      const total = tasks.length;
      // 展开按钮配色：有未完成任务 = 彩色 🎯；无任务（或全部完成）= 灰色
      // （与会话列表 🎯 徽章的语义一致：只标记「未完成」）。
      const hasUnfinished = tasks.some((x) => !x.done);

      const expandBtn = collapsed && visible
        ? react.createElement(
            "button",
            {
              type: "button",
              style: {
                ...s.iconBtn,
                position: "fixed",
                left: geo.left + geo.width - 30,
                top: geo.top + 8,
                width: 24,
                height: 24,
                zIndex: 1004,
                filter: hasUnfinished ? "none" : "grayscale(1)",
                opacity: hasUnfinished ? 1 : 0.55
              },
              title: hasUnfinished ? t("panel.expandTip") : t("panel.expandTipNone"),
              "aria-label": t("panel.expandTip"),
              "data-dsh-todo-expand": true,
              "data-dsh-todo-has-tasks": hasUnfinished ? "true" : "false",
              // 右滑收起后的合成 click 可能落在这个按钮上：600ms 锁内忽略，防"缩进去又弹出来"
              onClick: () => { if (Date.now() - swipeLockRef.current < 600) return; setCollapsedPersist(false); }
            },
            "🎯"
          )
        : null;

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
        // 右滑拖拽中：transform 跟随手指（swipeDxRef，重渲染不打断跟手）
        transform: collapsed
          ? "translateX(100%)"
          : swipeDxRef.current != null
            ? "translateX(" + swipeDxRef.current + "px)"
            : "translateX(0)",
        transition: swipeAnim
          ? "transform " + swipeAnim.dur + "ms cubic-bezier(0.4, 0, 0.2, 1)"
          : "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)"
      };

      const panelNode = react.createElement(
        "div",
        { style: clipStyle },
        react.createElement(
          "div",
          { ref: panelRef, style: panelStyle, "data-dsh-todo-panel": true, "data-dsh-todo-sid": sessionId || "" },
          react.createElement(
            "div",
            { style: s.header },
            react.createElement("span", { className: "dsh-todo-header-ico", "aria-hidden": true, style: { flex: "none", fontSize: 13, lineHeight: 1 } }, "🎯"),
            react.createElement("span", { style: s.headerTitle }, t("panel.title")),
            react.createElement("span", { style: { ...s.headerCount, flex: "none" }, title: `${doneCount}/${total}` }, `${doneCount}/${total}`),
            collapseBtn
          ),
          notice !== "" && react.createElement("div", { style: s.notice }, notice),
          // 顶部「+」：列表正上方，与底部「+」上下对称（开头插入 vs 追加末尾）；
          // 空列表时只保留底部「+」
          tasks.length > 0 &&
            react.createElement(
              "div",
              { style: s.topAdd },
              react.createElement("button", { type: "button", style: s.addBtn, title: t("panel.addTopTip"), "data-dsh-todo-add": "top", onClick: (e) => addTask(e, true) }, "+")
            ),
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
                    selected: selectedId === task.id,
                    onRowPointerDown,
                    onRowClick,
                    dragging: drag !== null && drag.id === task.id,
                    onColorMenuToggle: colorMenuToggle
                  })
                )
          ),
          react.createElement(
            "div",
            { style: s.footer },
            react.createElement("button", { type: "button", style: s.addBtn, title: t("panel.addTip"), "data-dsh-todo-add": "bottom", onClick: addTask }, "+")
          )
        )
      );

      // 调色板弹层（fixed，5×N 网格：10 色 + 默）；点选即落盘并收起，点外部关闭（doc-click 处理）
      const popTaskId = colorMenuId;
      const colorPop = colorMenuId !== null && colorPopPos
        ? react.createElement(
            "div",
            {
              style: { ...s.colorPop, left: colorPopPos.x, top: colorPopPos.y },
              "data-dsh-todo-colorbar": colorMenuId,
              onClick: (e) => e.stopPropagation()
            },
            PALETTE.map((c) =>
              react.createElement("button", {
                key: c,
                type: "button",
                style: { ...s.swatch, background: c },
                title: c,
                "aria-label": "颜色 " + c,
                "data-dsh-todo-swatch": c,
                onClick: (e) => { e.stopPropagation(); colorPick(popTaskId, c); }
              })
            ),
            react.createElement(
              "button",
              {
                type: "button",
                style: s.swatchDefault,
                title: "默认颜色",
                "aria-label": "默认颜色",
                "data-dsh-todo-swatch": "default",
                onClick: (e) => { e.stopPropagation(); colorPick(popTaskId, null); }
              },
              "默"
            )
          )
        : null;
      return react.createElement(react.Fragment, null, panelNode, expandBtn, colorPop);
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
        let summaryTries = 0;
        // summary 拉取失败时退避重试：刷新页面 / web 刚重启时 host 路由可能尚未注册，
        // 一次 404 若被静默吞掉，未完成映射就空着 → 徽章全不显示（要切会话才逐个补上）。
        const refreshSummary = () =>
          call("summary", {})
            .then((v) => { summaryTries = 0; seedUnfinished(v && v.sessions); syncBadges(); })
            .catch(() => {
              summaryTries += 1;
              if (summaryTries <= 5)
                window.setTimeout(refreshSummary, [1000, 2000, 5000, 10000, 15000][summaryTries - 1]);
            });
        const runSync = () => {
          if (debounce !== null) window.clearTimeout(debounce);
          debounce = window.setTimeout(syncBadges, 200);
        };
        const unsubUnfinished = subscribeUnfinished(runSync);
        const unsubList = sessions.list.subscribe(runSync);
        // 会话行被 React 重挂载（时间戳/运行状态刷新）会带走注入的徽章 DOM，
        // 而当前活跃会话的行刷新最频繁 → 「当前会话不显示徽章、切走后反而显示」。
        // 在侧栏列上挂 MutationObserver（不挂 body：聊天打字不应触发重扫），
        // 侧栏 DOM 一变就防抖重扫补徽章；侧栏节点被重挂载后自动重挂观察。
        let obsRoot = null;
        let obs = null;
        const attachObs = () => {
          const row = document.querySelector('[role="treeitem"]');
          if (!row) return;
          let root = row;
          while (root.parentElement) {
            const r = root.getBoundingClientRect();
            if (r.left <= 2 && r.width > 100 && r.width < 600) break; // 侧栏列
            root = root.parentElement;
          }
          if (obsRoot === root) return;
          if (obs) obs.disconnect();
          obsRoot = root;
          obs = new MutationObserver(runSync);
          obs.observe(root, { childList: true, subtree: true });
          // 会话行可能已存在（数据先到、DOM 后到的竞态）：挂上立即重扫一次兜底
          runSync();
        };
        attachObs();
        const obsTimer = window.setInterval(() => { if (!obsRoot || !obsRoot.isConnected) attachObs(); }, 5000);
        syncBadges();
        refreshSummary();
        window.addEventListener("focus", refreshSummary);
        const onVis = () => { if (document.visibilityState === "visible") refreshSummary(); };
        document.addEventListener("visibilitychange", onVis);
        // bfcache 恢复（前进/后退缓存）不触发 focus：补一个 pageshow 兜底
        window.addEventListener("pageshow", refreshSummary);
        return () => {
          unsubUnfinished();
          unsubList();
          window.removeEventListener("focus", refreshSummary);
          window.removeEventListener("pageshow", refreshSummary);
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
