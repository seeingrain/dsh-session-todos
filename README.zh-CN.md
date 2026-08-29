# dsh-session-todos

面向 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的**会话内待办事项**插件。
在聊天窗口右上角加一个**悬浮待办面板**，把待办列表**存储在服务器端**（跨设备同步），
并在左侧会话列表中给**还有未完成任务**的会话打上一个 **🎯 徽章**。

纯插件 —— **不改 DSH 任何源码**。

<p align="center">
  <img src="docs/preview.png" alt="dsh-session-todos 面板" width="720" />
</p>

## 功能特性

- **右上角悬浮待办面板**：展开时浮在对话区右上角，可收起成一个 🎯 图标，带滑入/滑出动画。
- **任务行**
  - 勾选框 —— 勾选/取消即时保存
  - 多行文字 —— 长任务自动折行；**双击**原地编辑（自动增高的多行 `<textarea>`）；
    `Enter` 提交，`Shift+Enter` 换行
  - 推送到发送框 —— 把任务文本**追加**到消息输入框
  - 删除 —— 带确认弹窗
  - **长按拖动排序** —— 被拖行跟手移动、实时预览落点
- **标题栏**：🎯 图标 + `done/total` 计数（如 `2/4`）。
- **移动端友好** —— 点击面板外自动收起。
- **服务器端跨端存储** —— 每会话一个 JSON 文件，位于 `~/.dsh/dsh-session-todos/`，
  任意设备登录同一 DSH 都能读到同一份列表。
- **会话列表徽章** —— 有未完成待办的会话在侧边栏左侧显示 🎯，随勾选即时出现/消失。

## 要求

- DeepSeek Harness（DSH）Web 端 —— 本插件为 **bundle 插件**（host + client 两半）。

## 安装

```bash
# 本地路径（你 clone/放置该仓库的位置）
dshpm install /绝对路径/to/dsh-session-todos --profile web
# 或从 git 地址安装：
# dshpm install https://git.6.seeingrain.fun:6443/dsh/dsh-session-todos.git --profile web
```

安装后重启 dsh-web，或强刷浏览器（`Ctrl+Shift+R`）。

## 使用

打开一个会话，点击聊天窗口右上角的 🎯 展开面板。

- 底部 **+** 新建任务。
- **双击**任务文字进入编辑（出现多行 textarea，随内容增高）；`Enter` 保存、`Esc` 取消、
  `Shift+Enter` 换行。
- 勾选框标记完成（文字置灰、按钮禁用）。
- **↗** 把任务文本追加到消息发送框。
- **🗑** 删除（有确认弹窗）。
- **长按**任务文字后上下拖动排序，松手提交。
- **→** 收起面板回到 🎯 图标。
- 触屏设备：点击面板外任意处自动收起。

## 实现原理

插件分 host 与 client 两半，均为独立自包含。

### Host 半边（`lib/index.js`）

在 DSH 的 `webServer` 上注册路由，并把待办持久化为 JSON 文件：

- `POST /dsh-session-todos/api/get` —— `{ sessionId }` → `{ tasks }`
- `POST /dsh-session-todos/api/save` —— `{ sessionId, tasks }` → 保存并返回规范化列表
- `POST /dsh-session-todos/api/summary` —— 返回 `{ sessions: [{ sessionId, hasUnfinished }] }`

存储目录：`~/.dsh/dsh-session-todos/<sessionId>.json`（首次写入时创建）。

### Client 半边（`lib/client.js`）

- 悬浮面板挂在 `shell.overlay` 插槽，锚定聊天区 `[data-conversation-scroll]`。
- 推送任务到发送框使用官方输入门面（`conversation.input` → `setDraft`），**追加**到已有草稿。
- 会话列表徽章**不改 DSH 源码**：用 `[role="treeitem"]` 定位会话行，从 React 18 fiber
  读取每个会话的 id，再按待办状态注入/移除 🎯 徽章。若 fiber 结构未来改变，会优雅降级
  （徽章不渲染，其余功能不受影响）。

## 存储结构

```json
{
  "version": 1,
  "sessionId": "session-…",
  "updatedAt": 1787992050268,
  "tasks": [
    { "id": "t-…", "text": "…", "done": false, "createdAt": 1787992050268, "updatedAt": 1787992050268 }
  ]
}
```

## 说明与限制

- 面板收起/展开状态存 `localStorage`（不同步到其它设备）。
- 会话行徽章依赖 React 18 内部 fiber；未来 React/DSH 大版本升级后可能需要重新验证
  （只会优雅降级，不会报错）。
- 存储路径位于 DSH 主目录（`~/.dsh`）。

## 许可证

[MIT](LICENSE)
