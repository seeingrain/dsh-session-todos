# Changelog

## v1.3.1 - 2026-10-13

- **电脑端（pointer: fine）按 `Esc` 收起面板**：面板展开时按一次 `Esc` 即收起
  （钉住中会先取消钉住）；调色板开着时第一下 `Esc` 只关调色板、第二下收起面板。
  焦点在输入框里（编辑任务 / 发送框打字）时不接管——任务编辑框先 `Esc` 取消编辑、
  再按一次才收起面板。触屏（pointer: coarse）行为不变。

## v1.3.0 - 2026-10-08

- **实时同步改走 WebSocket（`WS /dsh-session-todos/api/ws`），不再用 SSE。**
  Browsers allow only ~6 concurrent HTTP/1.1 connections per destination; SSE streams
  occupy one each, so two clients (e.g. two VS Code sidebars) could exhaust the pool and
  stall every other request — including sending a message. WebSockets do not consume that
  budget (measured: 14 websockets on one page, POSTs still fast; 11 SSE streams — POST times out).
- The old `GET /events` SSE endpoint is **kept for compatibility**; new clients prefer the websocket.
- Client reconnect uses exponential backoff (1s → 10s), and re-pulls the current session once on open.

## v1.2.0 - 2026-09-12

- The header **📌 Pin** button is now ~80% of its previous size (26px→21px) so it sits
  more discreetly next to the panel title
- **Auto-collapse after push-to-composer**: clicking a task row's **⏎ send** button
  (which pushes the task text into the message box and turns the task green) now makes
  the panel automatically collapse so you can send the message right away — even while
  pinned (it un-pins itself first). Copy / delete / done-toggle / sort / color do NOT
  collapse the panel.

## v1.1.0 - 2026-09-12

- Removed the header **→** collapse button
- Auto-collapse on outside click now applies on **all platforms** (previously touch only)
- New header **📌 Pin** toggle: while pinned the panel never auto-collapses; unpinned (default)
  it always collapses when you click outside
- Docs: add language switch links and an "especially for" line to both READMEs

## v1.0.0 - 2026-09-03

- Initial public release
- Floating todo panel (top-right, collapsible to 🎯 icon)
- Per-task: checkbox, multi-line edit (double-click), push-to-composer, delete, long-press drag reorder
- Divider tasks (type `---`) for visual grouping
- Color picker per task
- Server-side cross-device storage (`~/.dsh/dsh-session-todos/<sessionId>.json`)
- Session-list 🎯 badge (pure plugin, no DSH source modification)
- Mobile friendly (tap-outside auto-collapse)
