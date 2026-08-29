# dsh-session-todos

会话内待办事项插件（DSH Web，纯插件，不改 DSH 源码）。

## 功能

1. **右上角悬浮待办面板**：展开时浮在对话区右上角；收缩时只在右上角显示 🎯 图标，
   点击展开。展开态右上角有「→」收起按钮。
2. **任务行**：左勾选框 + 中间任务文字框 + 右侧两按钮（推送到发送框 / 删除）；
   勾选后文字置灰、按钮禁用；勾选/取消立即存；双击文字原地编辑、编辑完自动存；
   长按文字拖动排序；底部「+」新增。
3. **服务器端跨端存储**：任务列表存到 `~/.dsh/dsh-session-todos/<sessionId>.json`，
   任意设备登录同一 DSH 都能读到同一份。
4. **会话列表图标**：左侧会话列表里，有「未完成任务」的会话，其行左边显示 🎯 徽章。

## 安装

```bash
dshpm install ./custom-plugins/dsh-session-todos --profile web
# 或走受保护流程 plugin_install（自动过质量门）
```

装完重启 dsh-web：`restart_dsh` 工具（自动续接）。

## 实现

- **host 一半（lib/index.js）**：`webServer` 注册 `/dsh-session-todos/api` 前缀路由，
  读写 `~/.dsh/dsh-session-todos/<sessionId>.json`。RPC：`get` / `save` / `summary`。
- **client 一半（lib/client.js）**：`shell.overlay` 挂右上角悬浮面板；同源 fetch 走 RPC；
  `ctx.get("conversation").input.for(actx).setDraft(...)` 把任务文本追加进发送框；
  会话行徽章用 `[role="treeitem"]` 定位 + React fiber（`node.id`）读会话 id，
  注入 🎯；MutationObserver + `sessions.list` + 共享 store 响应增删。

## 说明

- 会话行徽章借用 React 内部 fiber 读取会话 id——唯一非官方步骤，仅在 DSH 大改版时
  可能失效，已做优雅降级（读不到就不显示，不影响其它功能）。
- 「推送到发送框」为追加语义（若输入框已有文字则换行拼接）。
- 收缩/展开状态存 localStorage（`dsh-session-todos.collapsed`）。
