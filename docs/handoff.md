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

## Latest milestone — browser vault saving

Implemented src/server.js (authenticated local API and folder writer lock) and src/store.js (validation, atomic replacement, revision checking, bounded retry receipts). The user explicitly chose CLI-only canvas/storage management. The browser file menu has been removed. CLI canvas open prints authenticated canvas links; canvas drafts lists connected draft snapshots; canvas import <title> --from-browser <id> imports a draft and binds its open tab to the new canvas. The browser autosaves and retains a retry control in its info popover. Conflicting edits are available as drafts for CLI import.

Start serve with --vault and --path. The generated device link carries a random per-run token in its fragment. It is stored in sessionStorage and removed from the address bar. The selected document reopens on reload. Restarting the server requires the new device link.

The browser retains pending snapshots and exact operation IDs in localStorage. Saving is serialized and unknown outcomes retry the same operation. Concurrent edits report a conflict. The initial local draft is retained after import.

Verified: storage tests for disk persistence, duplicate retries, stale revision rejection, operation-ID reuse, invalid input preservation and path traversal rejection. Browser UI import, drawing to a vault canvas, reload and reopening after a full server restart passed. A test canvas named "Browser import verification" remains in the configured vault folder. The user has not yet verified the new storage flow on iPad.

## CLI management correction

Browser draft snapshots are kept in server memory (maximum 100 sessions) and published every two seconds by connected tabs. Import writes to disk before assigning the new document to the browser. Original local drafts and conflict recovery records remain intact. CLI management routes require loopback, a literal loopback Host header and no Origin; they also verify the requested folder. No tokens are written into the vault. See README for commands.

Verified the correction with both storage and CLI integration tests (import retry, disk contents, open links, browser autosave API and Origin/auth rejection). In the browser, CLI import bound the existing draft, reload reopened it, and a new stroke reached disk at revision 3. A second test canvas, "CLI import verification", remains in the vault. The revised flow still needs the user's iPad check.

## Robustness fixes (2026-11-03, Claude Code)

- Folder lock moved out of the vault into the per-user temp directory (src/lock.js, override with PAPERLINK_LOCK_DIR) so sync services never copy it. Locks of dead processes are detected by PID and replaced; a stale legacy .paperlink-server.lock in the vault is removed automatically.
- Canvas listing skips invalid JSON, unsupported formats, ID/file-name mismatches and sync conflict copies instead of failing; the CLI reports skipped files on stderr.
- Browser drafts live in src/drafts.js: at most 100 drafts and 64 MB in total, idle drafts expire after 15 minutes, and strokes of imported drafts are freed once the tab adopts the canvas.
- readCanvas rejects documents without a pages array instead of crashing. npm test runs the suite.
- Verified: npm test (5 tests), plus a real server killed with SIGKILL restarts without manual lock cleanup.

## Next implementation step

Test the storage flow on the user's iPad. Add Obsidian Markdown previews and useful document navigation. Improve integration tests for simultaneous clients, network disconnects and interrupted writes. Then implement PDF import/export and multi-device synchronization.

## Current limitations

- Browser-only drafts are per device/origin. Vault saves work. Live device sync, PDFs, vault previews, MCP and assistant triggers remain pending.
- CLI and API list one configured folder. No init/config or recursive index yet.
- No pinch zoom, panning, pressure-aware ink, lasso or highlighter.
- Undo history is session-only. localStorage data is only minimally validated.
- Eraser hit testing and redraw iterate all paths. Optimize when document sizes require it.
- The SVG fixed viewBox and CSS grid will need a shared world coordinate transform for zoom/pan.
- LAN API access uses a per-run bearer token. HTTP assumes a trusted LAN. QR pairing, HTTPS and production hardening remain pending.
- Existing folder symlinks outside the vault are rejected. The file layer is not hardened against concurrent filesystem tampering.
- Avoid claiming full iPad compatibility from desktop tests.

## Run

```sh
npm start
npm start -- --port 8080 --lan --vault "/path/to/vault" --path "Paperlink/Canvases"
node bin/paper.js canvas create "Exercise" --vault "/path/to/vault" --path "Notes"
node bin/paper.js canvas list --vault "/path/to/vault" --path "Notes"
```

The serve process reads index.html per request, so UI updates need only a browser reload. Restart it for server-code changes. Before stopping a process, verify it is the Paperlink listener. Use temporary vaults for tests.

## Repository synchronization

Prior work used the GitHub connector to publish files because gh authentication was invalid, so local and remote commits once had different histories. On 2026-11-03 the local checkout was moved to ~/Desktop/projects/paperlink and its main was reset to origin/main (identical file tree); the earlier local commits remain on branch codex-local-history. Do not force-push. Check the current remote main before any update.

## Keep this handoff current

Record completed work, exact checks and limitations at each milestone. Update the corresponding Obsidian project handoff when accessible. Never include credentials.
