# Roadmap and acceptance criteria

| Stage | Deliverables | Acceptance |
|---|---|---|
| 1 · Handwriting | CLI launch, browser page, pen, eraser, undo, zoom, Light/Dark/System | Complete a real exercise on iPad without disruptive latency, accidental marks or jumping pages. |
| 2 · Assignments and vault | Multi-page PDFs, extra pages, durable storage, Obsidian preview, PDF export | Strokes survive restart. Obsidian shows the preview and exports include backgrounds and annotations. |
| 3 · Multiple devices | QR pairing, live updates, local buffering and reconnect | iPad and laptop show the same page. Disconnection loses no strokes and retries create no duplicates. |
| 4 · Assistant | JSON CLI, snapshots, annotations, local triggers and optional MCP (all implemented; MCP via `paper mcp`) | An assistant reads a selection and its undoable feedback appears on both devices. |
| Later | Infinite canvas, Obsidian editor plugin, persistent assistant sessions | Prioritize from real use of the complete workflow. |

## Current state and next milestone

The first prototype implements CLI serving, a single browser-local draft, basic pen and stroke eraser, undo/redo for drawing, and themes. The user has verified pen input and erasing on a real iPad. CLI file creation/listing and browser vault saving with explicit import are implemented.

Next, complete the handwriting interaction before evaluating it on a real iPad. Verify vault import and saving on iPad, then add Obsidian previews and PDF support. Two-finger pan/zoom and pressure-aware strokes remain pending. Erasing is now undoable. Verify palm handling, persistence after reload and theme switching. Device pairing is required before treating LAN mode as ready for normal use.

Pending choices include CLI name availability, license, package format, rendering technology and concurrent editing semantics. Test the storage layout and pairing with disposable documents first. The main early decision is whether browser handwriting is comfortable enough for extended assignments.
