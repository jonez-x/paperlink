# Paperlink — agent handoff

Updated 2026-11-03. Read this first, then README.md, AGENTS.md and docs/product.md, docs/architecture.md, docs/roadmap.md.

## Goal and decisions

Build a CLI-managed, self-hosted browser notebook for Apple Pencil handwriting, PDF assignments and optional assistant access. Store documents at user-chosen locations in an Obsidian vault. CLI and local API are the foundation, MCP is an optional adapter. No bundled AI service, account or subscription. AI triggers are explicitly configured. Keep the interface quiet, warm and Mistral-inspired with Light/Dark/System modes. The repository and default UI are English. Conversations with the user are German.

Project name Paperlink, proposed CLI command paper. Repo https://github.com/jonez-x/paperlink is private. License and public release are undecided.

## Implemented and verified

- Node.js 22 CLI serves the browser UI on port 8080 by default, loopback only. --lan binds all interfaces.
- public/index.html contains the UI and interaction logic. Vanilla HTML, CSS, SVG, JavaScript. No dependencies or build step.
- Pen input, whole-stroke drag eraser with a 12 CSS-pixel radius, gesture-based undo/redo, browser-local storage.
- Fixed viewport and non-passive touch prevention resolved iPad scrolling during Pencil input.
- User confirmed writing and erasing work well on their iPad. Further smoothing can wait.
- Wide canvas, coarse outer work-mat grid, fine inner grid, warm cream/dark palette and pixel logo approved.
- Icon toolbar overlays the canvas, hides while drawing/erasing, returns after 100 ms with an 80 ms transition.
- Header theme icon cycles System/Light/Dark and persists selection. Storage explanation is behind an info popover.
- src/documents.js creates version-1 JSON documents with stable IDs, revision and blank page. CLI canvas create/list uses explicit --vault and optional --path. Tested creation, listing in a fresh process and rejection of a path outside the root.

## Next implementation step

Connect the browser to durable document files. Preserve existing localStorage drafts and offer an explicit import into a chosen document. Add selected-document loading, atomic server writes, revision checking, serialized edits and idempotent operation IDs. Keep pending edits locally until confirmed. Never silently replace an iPad draft with a blank server document.

Add server tests for restart durability, conflict rejection, retry deduplication, failed writes and path boundaries. Then test the actual iPad flow. Add document selection and previews for Obsidian. Follow with multi-page PDF import/export and multi-device sync, then assistant interfaces.

## Current limitations

- Browser drafts are per device/origin. No server save, device sync, PDF support, vault preview, MCP or assistant trigger yet.
- CLI file creation/listing is a backend milestone. List scans one folder. No init/config or recursive index yet.
- No pinch zoom, panning, pressure-aware ink, lasso or highlighter.
- Undo history is session-only. localStorage data is only minimally validated.
- Eraser hit testing and redraw iterate all paths. Optimize when document sizes require it.
- The SVG fixed viewBox and CSS grid will need a shared world coordinate transform for zoom/pan.
- LAN mode has no pairing/authentication yet. It currently only serves the app. Add access control before exposing document read/write APIs.
- Existing folder symlinks outside the vault are rejected. The file layer is not hardened against concurrent filesystem tampering.
- Avoid claiming full iPad compatibility from desktop tests.

## Run

```sh
npm start
npm start -- --port 8080 --lan
node bin/paper.js canvas create "Exercise" --vault "/path/to/vault" --path "Notes"
node bin/paper.js canvas list --vault "/path/to/vault" --path "Notes"
```

The serve process reads index.html per request, so UI updates need only a browser reload. Restart it for server-code changes. Before stopping a process, verify it is the Paperlink listener. Use temporary vaults for tests.

## Repository synchronization

Prior work used the GitHub connector to publish files because gh authentication was invalid. Local and remote commits were created independently and have different histories. Do not force-push. Start from a fresh GitHub clone in a new environment, or carefully reconcile history while preserving local changes. Check the current remote main before any update.

## Keep this handoff current

Record completed work, exact checks and limitations at each milestone. Update the corresponding Obsidian project handoff when accessible. Never include credentials.
