# Roadmap and acceptance criteria

| Stage | Deliverables | Acceptance |
|---|---|---|
| 1 · Handwriting | CLI launch, browser page, pen, eraser, undo, zoom, Light/Dark/System | Complete a real exercise on iPad without disruptive latency, accidental marks or jumping pages. |
| 2 · Assignments and vault | Multi-page PDFs, extra pages, durable storage, Obsidian preview, PDF export | Strokes survive restart. Obsidian shows the preview and exports include backgrounds and annotations. |
| 3 · Multiple devices | QR pairing, live updates, local buffering and reconnect | iPad and laptop show the same page. Disconnection loses no strokes and retries create no duplicates. |
| 4 · Assistant | JSON CLI, snapshots, annotations, local triggers and optional MCP (all implemented; MCP via `paper mcp`) | An assistant reads a selection and its undoable feedback appears on both devices. |
| Later | Infinite canvas, Obsidian editor plugin, persistent assistant sessions | Prioritize from real use of the complete workflow. |

## Current state and next milestone

Stages 1 to 4 are implemented (see docs/handoff.md for what is verified where): pen with pressure, highlighter, erasers, lasso, shapes and text, zoom and pages, PDF worksheets, vault storage with Obsidian previews, PDF export, QR pairing with live sync, and the assistant layer with CLI, MCP and an Ask button answered by Claude Code or Codex. Installers bring their own Node, and `paper setup` connects assistant apps.

None of the stages has passed its acceptance criteria on a real iPad yet; the user verified only early pen input and erasing there. The next milestone is completing a real worksheet on the iPad and fixing what that shows. Pending choices: license, public release and concurrent editing semantics beyond the current per-stroke operations.
