# Changelog

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
