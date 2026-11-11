# Paperlink — agent handoff

Updated 2026-11-11. Read this first, then README.md (user-facing, kept short), AGENTS.md and docs/reference.md (all technical detail), docs/product.md, docs/architecture.md, docs/roadmap.md.

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

## QR pairing in the CLI (2026-11-03, Claude Code)

- src/qr.js is a dependency-free QR encoder (byte mode, level M, versions 1–40) with ANSI half-block terminal rendering in explicit black/white, so it scans on light and dark themes.
- serve --lan prints a QR code for the preferred private-range device link; canvas open prints one for the canvas device link on stderr (JSON stays on stdout). Shown in interactive terminals; --qr forces, --no-qr hides.
- Verified: matrices identical to the qrcode npm package for 56 fixed-mask cases (versions 1–26, UTF-8); test/qr.test.js pins a reference fingerprint. Not yet scanned with the user's iPad camera.

## Interactive CLI and libraries (2026-11-04, Claude Code)

User decisions: storage is not tied to Obsidian. A "library" is any folder; Obsidian output is an opt-in setting. The CLI must serve people (colored, logo, arrow-key menus, text input, folder picker) and AI agents (every action as a command with flags and JSON) equally.

- src/config.js: ~/.config/paperlink/config.json (PAPERLINK_CONFIG) with library, defaultPath, obsidian, lan, port. Precedence: flags > PAPERLINK_LIBRARY/PAPERLINK_PORT > config. --vault is an alias for --library.
- src/server.js serves the whole library: canvas IDs are resolved through a recursive index (hidden folders and symlinked folders are skipped; network-triggered rescans are throttled to 1/s). New local CLI routes /cli/status and /cli/stop; import accepts a target path. Network error responses no longer contain absolute paths.
- src/cli.js: commands init, config [set], serve, start (background, log in ~/.config/paperlink/server.log), stop, status, canvas new|list|open|drafts|import (+ shortcuts new/list/open). `canvas new` creates the file and prints the canvas QR code, so saving is automatic from the first stroke without the draft import detour. `paper` without arguments opens the menu; the first run starts a setup wizard. Non-TTY or --json: JSON only, never prompts, errors as JSON on stderr with exit code 1.
- src/tui.js: dependency-free palette (truecolor or 256-color fallback, NO_COLOR respected), pixel logo banner, paper-like cards, select/input/confirm prompts with in-place redraw.
- Verified: npm test (9 tests, including the full machine interface with a background server) and scripted keystrokes in a pseudo-terminal for the setup wizard and the New canvas flow (folder navigation, server start prompt, QR output). Not yet used by the user; the Obsidian preview setting is stored but not implemented.

## Obsidian previews (2026-11-04, Claude Code)

- src/preview.js renders `<id>.preview.svg` (light paper #fffdf5, ink #24231f, stroke width 3 as in the UI). The page width of 900 is kept so handwriting has the same scale everywhere; height follows the content, strokes beyond the page edges widen it. Atomic replacement.
- Notes `<Title>.md` contain frontmatter `paperlink: <id>`, the embed `![[<id>.preview.svg]]` and `paper open <id8>`. Created once; found again by frontmatter in the canvas folder (survives renames), never overwritten. Name clashes get " (2)".
- Server option `obsidian`: refreshes the SVG 1.5 s after the last save per canvas (one sync upload per pause, not per stroke), flushes pending previews on stop, writes note and preview on draft import (failures logged, never block the import). `paper start` passes `--obsidian/--no-obsidian`.
- CLI: `canvas new` writes note and preview; new command `paper preview [id|title] [--path]` (alias `canvas preview`); `config set obsidian` now asks for a restart; Settings offers notes for existing canvases when turned on; status/serve cards show the setting.
- Verified: npm test (11 tests: preview layout and escaping, note clash/rename/user-text preservation, end-to-end note on new, SVG flushed after a browser save on stop, note on import, idempotent `paper preview`). Rendered the three real vault canvases to PNG; handwriting correct. Not yet viewed inside Obsidian by the user; whether Obsidian re-renders the embed immediately after the SVG changes is unverified.

## Canvas files instead of libraries (2026-11-04, Claude Code)

User decision: no library concept. A canvas is a `.paperlink` file wherever the user (or an AI agent through the CLI) creates it; the server and browser UI are unchanged. Inside an Obsidian vault the note and preview appear automatically.

- src/documents.js: `<Name>.paperlink` files (title defaults to the file name, `--title` overrides), `canvasPath` resolves relative to the cwd, `obsidianVault` walks up to a `.obsidian` folder, folder browser helpers. Legacy `<id>.paperlink.json` files still open.
- src/store.js reads/saves by file path; with an ID it refuses a file that now contains another canvas.
- src/registry.js: `~/.config/paperlink/canvases.json` lists canvases created or opened by the local CLI (ID → path, title, openedAt). Only the CLI writes it. The server serves exactly these IDs to devices, reloads the list on a miss or when a known path vanished, and on every CLI open.
- Server: one per user (lock in the temp dir keyed by the config directory), no library argument. Previews only for files inside a vault.
- CLI: `new`, `open <file|id|prefix|title>`, `list` (marks moved files as missing), `forget`, `preview`, `drafts`, `import <path> --from-browser`, `start/serve/stop/status`, `config set obsidian|lan|port`. `paper` opens the menu (no setup wizard); New canvas uses a file-system folder picker starting in the cwd with recent folders. `--library/--vault/--path/init` give a clear error. A config from the library version is migrated once: its canvases are added to the list, `library/defaultPath` are dropped and `obsidian` becomes true.
- Verified: npm test (12 tests: file storage and ID check, discovery, preview/notes incl. legacy names, full CLI/server flow with migration, vault notes, open by path/title/prefix, unregistered files 404 until opened, draft import, moved files, forget, preview flush). Interactive New canvas flow driven in a pseudo-terminal: title, folder picker, file + note + SVG created in a test vault, server start prompt, QR/link output.
- Not yet used by the user. Device pairing so that a link inside the Obsidian note opens the canvas without a fresh QR code remains open.

## Moving canvases (2026-11-04, Claude Code)

- src/move.js: `moveCanvas` moves/renames canvas, `<id>.preview.svg` and note together (a note named like the canvas follows a rename, a user-chosen note name stays, clashes get " (2)", EXDEV falls back to copy). `findMoved` searches by ID in the enclosing vault (or the old folder's parent, depth 3; never home or root). `followNote` moves canvas and preview next to a note the user moved inside Obsidian.
- Previews are now named `<id>.preview.svg` (stable across renames, unique vault-wide for Obsidian embeds).
- Server: `/cli/move` flushes pending previews and moves inside the write queue; a vanished path triggers `findMoved` (once per 5 s per canvas) and updates the registry (`relocate`); after a save, if the note left the canvas folder, the vault is searched (once a minute per canvas) and the canvas follows.
- CLI: `paper move <canvas> <folder/|new path>` (alias `mv`, interactive folder picker + name), menu entry; `list`/`open` heal moved files via `findMoved`.
- Verified: npm test (15 tests incl. rename/move with companions, discovery in and outside vaults, note following both as unit and through the running server, `paper move` via server, Finder move healed by API and `list`).

## Preview folder and deleting (2026-11-04, Claude Code)

- User found the ID-named SVG next to the note ugly and chose one preview folder per vault: `<vault>/Paperlink Previews/<id>.svg`, embedded as `![[<id>.svg]]`. Canvas folders now only show the note. Older `<id>.preview.svg` files are migrated on the next preview write (only the embed line in the note changes, the old file is removed). Moving a canvas out of a vault removes its preview there.
- `paper delete <canvas> | --all` moves canvas, note and preview to the Trash (`~/.Trash` on macOS, `PAPERLINK_TRASH` overrides); scripts must pass `--yes`. `paper forget --all`. Server route `/cli/forget` cancels pending previews and drops the canvas before deletion.
- Menu: All canvases opens a picker; per canvas Open / Move or rename / Delete / Remove from list; plus Delete all and Remove missing.
- Verified: npm test (16 tests incl. legacy preview migration, trash on delete, leaving a vault, CLI delete/forget --all with a sandboxed trash). Interactive delete driven in a pseudo-terminal.

## Device pairing (2026-11-04, Claude Code)

- The per-run access key is gone. Every QR code carries a one-time pairing code (`#pair=<code>[&canvas=<id>]`, 15 min, single use, held in server memory). The browser redeems it at `POST /api/pair` and stores a long-lived device token in localStorage; `~/.config/paperlink/devices.json` (mode 600) keeps only its SHA-256 hash, device name from the user agent ("iPad · Safari") and pairing date. Re-pairing a browser replaces its entry.
- API auth accepts paired device tokens; the server reloads devices.json on an unknown token (max 1/s) and on `/cli/devices`, so `paper unpair` is immediate.
- Links use the Bonjour name (`scutil --get LocalHostName` + `.local`, `PAPERLINK_HOST` overrides) first, IP addresses as fallbacks, so QR codes and note links share one browser origin. Notes get `[Open in Paperlink](http://<host>.local:<port>/#canvas=<id>)`; older notes have only their `paper open` line replaced on the next preview write.
- CLI: `paper pair`, `paper devices`, `paper unpair <device>|--all`; menu entry "Pair a device", Settings › Paired devices.
- Verified: npm test (16 tests incl. one-time codes, unknown/replaced/revoked tokens, device dedupe, note link, old note upgrade). In Chrome against a sandbox server: pairing link opens the canvas and cleans the URL, a stroke saves, a fresh load of the plain canvas link opens it after pairing, and without a token the page shows the pairing hint. Not yet tested on the iPad, in particular whether iPadOS resolves `<Name>.local`.

## Zoom, pages and PDF worksheets (2026-11-04, Claude Code)

- UI: the SVG gets a view transform (viewBox from `{x, y, scale}`); grids are SVG patterns in world units with 1-screen-pixel lines. Pencil/mouse write, one finger pans, two fingers pinch-zoom (touches are ignored while the pen is down), wheel pans, ctrl/⌘-wheel zooms, Fit button, zoom limits 0.5–8× of fit. Pages stack vertically (gap 40); strokes are stored in page coordinates and assigned to the page under the start point (or nearest). Add-page button (A4 900×1273, undoable; hidden for browser-only drafts). IDs via getRandomValues because randomUUID needs a secure context.
- Format version 2: `pages[]` with `{id, width, height, strokes, pdfPage?}` and optional `pdf: {file, copied}`. Saves send all pages; the server keeps size and `pdfPage` of known pages, accepts new blank pages, refuses dropping PDF pages and old single-page `strokes` saves once a canvas has several pages. Version 1 files open and upgrade on the next save.
- PDFs: pdf.js 5.4.624 legacy build vendored in public/vendor/pdfjs (with standard fonts, cMaps, wasm, ICC; ~5 MB) and served at /vendor/pdfjs/. src/pdf.js reads page sizes in Node (DOMMatrix stub, no rendering). `paper new … --pdf FILE` (or menu prompt) makes one 900-wide page per PDF page; the PDF is used in place if already in the canvas folder, else copied (`copied: true`). GET /api/canvases/:id/pdf for paired devices. The browser renders visible pages at zoom-appropriate width (700–2400 px, power-of-two steps), others at 700 px, and uploads 600 px JPEGs (PUT …/backgrounds/:pageId, JPEG only, PDF pages only) to `~/.config/paperlink/backgrounds/<id>/` for the Obsidian preview, which embeds them as data URLs (≈200 KB per page). Move takes the PDF along (free name on clash, reference updated); delete trashes copied PDFs and the image cache.
- Verified: npm test (18 tests, new: multi-page merge rules, v1 upgrade, PDF creation incl. broken PDF, in-place vs copied, PDF serving and auth, vendor route and traversal, preview image upload rules, PDF page protection, move/delete with PDF). In Chrome against a sandbox server: zoom, fit, add page, undo of the page, saving v2; a generated two-page PDF renders, ink is dark on it, zoom re-renders sharply, the Obsidian preview SVG shows PDF and ink. Not yet tested: touch gestures on the iPad, large/scanned PDFs, memory on the iPad.

## PDF export (2026-11-04, Claude Code)

- src/export.js with pdf-lib 1.17.1 (ESM bundle vendored in vendor/pdf-lib, MIT; Node only, not served). PDF pages are copied unchanged; strokes are mapped from page units into each page's crop box with its rotation (0/90/180/270, matching pdf.js's display) and drawn as vector paths (round caps, ink #24231f, width scaled from 3 units). Non-PDF pages become white pages 595.28 pt wide (A4 for blank pages). Atomic write.
- `paper export <canvas> [--output FILE|FOLDER]`, default `<Name> (annotated).pdf` next to the canvas, overwritten on re-export; menu: All canvases › Export PDF.
- Verified: npm test (20 tests, new: rotation/crop mapping, export read back with pdf.js: page count, displayed sizes incl. rotated page, ink operators on every page, title, original text still extractable). Visual check of an export with a rotated page.

## Live sync and browser export (2026-11-04, Claude Code)

- Edits are operations: `add`/`remove` (page ID + stroke string, the string is the stroke's identity), `addPage` (id, size), `removePage` (blank pages only). Each is idempotent. POST /api/canvases/:id/ops `{operationId, ops}` applies a batch in the write queue without a revision check (src/store.js `saveOperations`, receipts keep the last 200 batches), so concurrent devices never conflict. The whole-document PUT stays for imports and old tabs and makes open tabs reload.
- GET /api/canvases/:id/events?since=R streams `data: {revision, operationId, ops}` lines (fetch + ReadableStream, because EventSource cannot send the device token). The server keeps the last 300 batches per canvas; a tab reconnecting within them catches up, otherwise (or after a restart) it gets `{reload: true}`. `{live: true}` marks the switch to live; pings every 20 s.
- Browser: undo/redo store operation lists and apply their inverse, so undo only takes back this tab's edits. Edits go into a queue persisted in localStorage (`paperlink-queue-<id>`), sent in order with fixed IDs, retried every 4 s; invalid batches (400) are skipped with a message. Remote batches are held back while the pen is down. After a reload event the server state is taken and unsent edits re-applied. Old `paperlink-pending-<id>` records are converted with a diff. Draft import now opens the canvas and adds strokes drawn after the last draft snapshot.
- `paper stop` ends live streams at once and waits until the server process has exited, so `paper stop && paper start` works with open tabs.
- Browser export: GET /api/canvases/:id/export.pdf (paired devices) renders with src/export.js into a temp file and returns it as a download; "Export PDF" button in the info popover. "Retry pending save" only shows while edits are waiting.
- Verified: npm test (21 tests, new: concurrent batches from two devices, replay and reused IDs, page operations, catch-up vs reload after restart, export download and auth). In Chrome with two tabs on one canvas: strokes appear in the other tab, undo removes only the tab's own stroke, an edit made while the server was down is kept (also across a page reload), sent after restart and received by the other tab; export download returns a PDF. Not tested on the iPad. Two tabs of the same browser on the same canvas share one queue key.

## Assistant layer and CLI (2026-11-04, Claude Code)

- Format: optional `annotations: [{id, page, x, y, width?, text, author?, revision?, stale?, createdAt?}]` (page units; validated in store.js `validAnnotation`). Operations `addAnnotation` / `removeAnnotation` (remove carries the note for undo) go through the same merge, receipts and live stream as strokes.
- Browser: notes are an HTML overlay positioned from the view (fixed screen size, readable at any zoom), stale notes greyed, × removes (undoable), toolbar button shows the count and hides/shows the layer.
- CLI for assistants: `paper inspect` (pages, stroke counts, notes with page numbers, revision), `paper snapshot [--page N] [--region X,Y,W,H] [--output FILE]` (single-page export cropped to the region; PNG via Quick Look `qlmanage` on macOS, else PDF; default in ~/.config/paperlink/snapshots), `paper annotate --text … [--page N] [--at X,Y] [--width W] [--author A] [--revision R]`, `--remove <id|prefix>`, `--clear`. Edits go through `/cli/ops` when the server runs (live in tabs), otherwise straight to the file. exportPdf gained `{pages, region}`.
- Fix: an event stream without `since` now starts live instead of asking for a reload.
- Verified: npm test (22 tests, new: notes offline and live, stale marking, region snapshot size, PNG snapshot, remove by prefix and clear). In Chrome: note on a PDF page, a note added from the CLI appears live, × removes, undo restores, layer toggle.

## Request feedback from the page (2026-11-04, Claude Code)

- Config `assistant`: null (default, off), `'claude'`, or a custom JSON argument list containing `"{prompt}"` (`paper config set assistant claude|off|'[…]'`, also in Settings). Restart needed.
- src/assistant.js: prompt with canvas ID, revision, page, region (page units) and the quoted question; it tells the assistant to `paper snapshot … --region … --output ~/.config/paperlink/snapshots/<id8>-feedback.png`, read it, and answer only with `paper annotate … --revision R --author Claude`. Claude runs as `claude -p <prompt> --allowedTools "Bash(paper inspect *) Bash(paper snapshot *) Bash(paper annotate *) Read"` with cwd ~/.config/paperlink, no shell, PATH prefixed with a `paper` shim (~/.config/paperlink/bin/paper → this checkout), PAPERLINK_PORT set, output appended to assistant.log, killed after 5 minutes.
- Server: POST /api/canvases/:id/feedback `{page, region?, question?}` for paired devices; 409 when no assistant is set, 429 while one runs for the canvas, validation of page/region/question (≤1000 chars). Broadcasts `{assistant: started|done|failed, message}` to open tabs (not kept in history). GET canvas includes `assistant: true|false`.
- Browser: ask tool (speech-bubble icon, only when an assistant is set): drag marks a region (dashed orange), a tap asks about the whole page; a form takes an optional question; status shows progress and errors; notes arrive live.
- Verified: npm test (23 tests, new: full flow with a stand-in assistant command that answers through the shim: off by default, validation, 202, 429 while running, started/done events, note text with question and region). In Chrome with the stand-in: mark region, type question, Ask, note appears next to the region. The real `claude` preset was not run (it would use the user's account); the prompt was reviewed.

## Page navigation (2026-11-05, Claude Code, branch feature/page-navigation)

- Toolbar shows previous/next page buttons and a "3 / 4" indicator when a canvas has more than one page (the page under the screen centre). Page Up/Down, Home and End jump too (not while typing). Moving keeps the zoom and puts the page's top just below the toolbar. Fit now fits the current page instead of always page 1; adding a page uses the same jump.
- Verified: npm test (24 tests). In headless Chrome against a sandbox server with a 4-page PDF canvas: indicator and disabled states at both ends, next/previous, keys, zoom then Fit stays on the page. Not tested on the iPad.

## Writing tools (2026-11-05, Claude Code, branch feature/writing-tools on top of feature/page-navigation)

- Format: strokes stay single strings; optional `#rrggbb`, `w<n>`, `h` prefixes, plus `V x y p …` pressure strokes and `T x y <URI text>` text (see docs/reference.md "Stroke format"). Older files stay valid. New `src/ink.js` (parse/format/validate, pressure outline, bounds, hit testing, partial erasing, lasso, translation, shapes) is used by store.js validation, export.js (colours, highlighter opacity, filled pressure outlines, Helvetica text with "?" for unsupported characters, rotation-aware), preview.js and the browser (served at `/ink.js`; the page script is now a module).
- Browser: highlighter (below ink), pen colour/width/pressure, precise eraser, lasso (move, recolour, duplicate, delete), shapes (line, arrow, rectangle, ellipse), text (tap to type or edit), pages overview with thumbnails and removal of empty blank pages, keyboard shortcuts (P H E L S T, ⌘Z/⇧⌘Z, Delete, Esc). Tapping the active tool again opens its options; settings in localStorage `paperlink-tools`.
- Server fix: `removePage` only removes pages without strokes (client and store), so undoing "add page" never deletes another device's ink. `paper inspect` lists typed texts.
- Verified: npm test (27 tests; new test/ink.test.js: format round-trips and rejection, distance, outline, partial erase, lasso, shapes; styled strokes stored, rejected when invalid, exported with real text, previewed with highlighter below ink). Headless Chrome against a sandbox server with a PDF canvas: every tool driven with mouse and synthetic pen pressure, file contents checked after each step, undo via ⌘Z, overview jump, no console errors; screenshots in light and dark; `paper snapshot` of the export matches the browser.
- Not tested on the iPad: real Pencil pressure feel, the on-screen keyboard with the text box, lasso dragging by finger vs Pencil (fingers still pan), toolbar width in portrait. Known limits: moved selections stay on their page; undoing a page removal re-adds the page at the end; text width in previews/exports is estimated.

## Installers and setup wizard (2026-11-05, Claude Code, branch feature/installer)

- `paper setup` (src/cli.js `cmdSetup`): iPad access, connects assistant apps found by src/setup.js (Claude Desktop config file, Claude Code via `claude mcp add --scope user`, Cursor `~/.cursor/mcp.json`; registered with absolute Node and paper.js paths), optional Ask button, restarts the server with the new settings, offers a first canvas. The first interactive `paper` runs it when no config file exists.
- `install/install.sh` and `install/install.ps1` (+ double-click wrappers) download Node 22.x per user with checksum, unpack `paperlink.tgz`, add `paper` to the PATH; `npm run bundle` builds the zip in dist/. package.json `files` limits the package to the app.
- Verified on macOS: installer in a sandboxed HOME with only /usr/bin:/bin on the PATH, twice (second run reuses Node, no duplicate PATH line); setup driven in a pty: first `paper` started setup, a fake Claude Desktop config got the server while its other entries stayed, server started with LAN, menu followed; the registered MCP command answered initialize and tools/list. npm test: 29 tests (test/setup.test.js).
- Review fixes (2026-11-11): installers stop the server before replacing Node; Node is reinstalled when `node --version` fails; install.ps1 swaps Node by renaming and fails clearly when node.exe is in use, and keeps `%VAR%` entries in the user PATH (raw registry value, written as REG_EXPAND_SZ, change broadcast); install.sh writes the PATH line for zsh (.zprofile on macOS, .zshrc elsewhere), bash (.bashrc, .bash_profile) and fish (conf.d), and tests the terminal with `( : </dev/tty )`; setup.js runs `claude` through the shell on Windows (npm's claude.cmd); `paper setup` saves the config when cancelled at the first question, defaults the iPad question to the saved value, and offers the Ask button only when Claude Code connected.
- Verified for the fixes on macOS: `sh -n`, npm test (30 tests), installer twice in sandboxed HOMEs with SHELL=/bin/zsh and /bin/bash (one PATH line per file, Node reused, exit 0 without a terminal, `paper --version` via the wrapper), a broken node binary is reinstalled, a fish config dir gets conf.d/paperlink.fish, a new .bash_profile sources an existing .profile and bash/zsh login shells find `paper`; Esc at the first setup question in a pty writes the config, and a saved `lan: false` makes No the default.
- Not verified for the fixes: install.ps1 (no PowerShell here, not even parsed), the Linux rc branch (.zshrc), Claude Code detection on Windows, the Ask button question after a failed connect (code change only).
- Not verified locally: Windows and Linux installers (CI job `install` covers them without the interactive setup), Gatekeeper behaviour for the .command after a real download, the Windows firewall prompt, Claude Code and Cursor registration on a real machine.

## Notebook UI (2026-11-11, Claude Code, branch feature/notebook-ui)

- Unslop pass on the writing screen (direction: calm, exact, a little warm; world: a desk with paper worksheets; the page is the moment; signature: the pen and highlighter buttons carry their ink). No work-mat grid or ruler ticks; neutral desk, paper with a soft shadow (two offset rects, no blur filter), toolbar as a quiet surface with surface-step active state, system font, 4px spacing, one radius scale and one easing. Document actions moved to the header; the toolbar holds tools, undo/redo and favorites (508 px wide).
- Shape snapping on hold (`recognizeShape`), lasso scale and turn handles (`transformStroke`), page templates (`templateMarks`; `template` on pages, `after` on addPage so new pages follow the page in view and undone removals return in place), a pages sidebar instead of the overview dialog, favorite pens.
- Verified: npm test (36 tests; new ink tests for recognition and transforms, storage test for templates and positions). In the desktop app's browser pane against a sandbox server with a 3-page PDF canvas, at 1180×820 and 820×1180, light and dark: synthetic pen strokes snapped (held circle → circle, held wave → line, unheld stays), lasso scaled and turned a selection (90° exact), lined/dotted pages added after page 1 and saved with their template and position, undo/redo of adding a page, favorites select tool and ink, sidebar thumbnails with PDF pages.
- Not verified: anything on the iPad (Pencil hold timing for snapping, handles with the Pencil, sidebar and header at real sizes), PDF export of templates opened in a viewer (only the code path runs in tests), Obsidian preview of templates.

## Robustness pass (2026-11-11, Claude Code, branch feature/robustness)

- Faster redraws: `renderOps` updates only the stroke elements an edit touches (eraser, lasso, undo/redo, text, pictures, edits from other devices); page changes still call `render()`. 10 pages × 300 pressure strokes in desktop Chrome: an eraser move went from ~55 ms (worst 103 ms) to ~1 ms (worst 6 ms); undo from ~130 ms to under 1 ms. Sidebar thumbnails rebuild only for changed pages and only once the pen is up.
- Review fixes: writing on after a hold-snap restores the hand-drawn points (a pause inside a "4" no longer drops the rest of the stroke); strokes under ~9 mm never snap; incoming page inserts/removals reload the server's page order (concurrent inserts at the same place could leave devices with different orders); `addPage` also takes `before`, so undoing the removal of a first page puts it back first; sidebar buttons act by page id; keys are ignored while the pen is down; a picture uploaded while writing is placed when the pen lifts; failed picture loads retry after 15 s; the turn preview keeps text and pictures upright like the result.
- Verified: npm test (39 tests, storage test covers `before`). Browser pane against a sandbox server: synthetic "4" with a 0.7 s pause kept all points; a key during a stroke changed nothing; a page inserted by a second paired device (curl with its own token) right after this device's insert ended in the same order in the file, the browser and the sidebar; draw/undo/redo/erase/undo counts matched a reload on the heavy canvas.
- Not verified: the iPad.

## Next implementation step

The user plans a first real worksheet on the iPad (2026-11-12): import a PDF, write, erase, highlight, zoom, ask Claude Code or Codex about a region, export. Collect what goes wrong there before adding features. Open device checks: Pencil pressure feel, the on-screen keyboard with the text box, lasso by Pencil while fingers pan, toolbar width in portrait, the Ask button from the iPad. After that: integration tests for simultaneous clients, network disconnects and interrupted writes; lasso scaling (in product.md, not built); moving selections across pages.

## Current limitations

- Undo history is session-only. localStorage data is only minimally validated.
- Moved selections stay on their page; undoing a page removal re-adds the page at the end; text width in previews and exports is estimated; exported and snapshot text only covers Helvetica's Latin set ("?" otherwise).
- Eraser hit testing and redraw iterate all paths. Optimize when document sizes require it.
- LAN API access uses paired device tokens over HTTP and assumes a trusted LAN. HTTPS and production hardening remain pending.
- The Ask button runs an assistant on the computer with a question typed on a paired device; the presets limit what it can do (see Assistant presets), custom commands are not limited.
- Existing folder symlinks outside the vault are rejected. The file layer is not hardened against concurrent filesystem tampering.
- Avoid claiming full iPad compatibility from desktop tests.

## Run

```sh
npm link                      # `paper` runs this checkout
paper start                   # or: npm start (foreground)
paper new "Notes/Exercise"
paper list --json
```

The serve process reads index.html per request, so UI updates need only a browser reload. Restart it for server-code changes. Before stopping a process, verify it is the Paperlink listener. Use temporary folders and PAPERLINK_CONFIG / PAPERLINK_LOCK_DIR for tests.

## Repository synchronization

Prior work used the GitHub connector to publish files because gh authentication was invalid, so local and remote commits once had different histories. On 2026-11-03 the local checkout was moved to ~/Desktop/projects/paperlink and its main was reset to origin/main (identical file tree); the earlier local commits remain on branch codex-local-history. Do not force-push. Check the current remote main before any update.

## Keep this handoff current

Record completed work, exact checks and limitations at each milestone. Update the corresponding Obsidian project handoff when accessible. Never include credentials.

## MCP, Windows support and README split (2026-11-04, Claude Code)

- `paper mcp` (src/mcp.js): dependency-free MCP server with eight tools that call the CLI with `--json`. Covered by test/mcp.test.js.
- Windows: settings in %APPDATA%, Recycle Bin via PowerShell, PNG snapshots via the WinRT PDF API (src/raster.js), `rundll32`/`clip` for the open-link menu, hidden console for the background server, `paper.cmd` shim for the assistant. Linux snapshots use pdftoppm. None of this has run on a real Windows machine yet; CI (.github/workflows/test.yml) runs the tests on Windows, but the PowerShell snapshot and Recycle Bin paths are not covered by tests.
- `paper open` in a terminal shows only the QR code plus **Open canvas** / **Copy link** instead of printing links.
- README holds only install and basic use; everything technical moved to docs/reference.md.

## Assistant presets (2026-11-11, Claude Code, branch feature/assistant-presets on top of feature/installer)

- `assistant` accepts `codex` besides `claude` and custom lists (src/assistant.js `PRESETS`; arrays are never presets). For both presets Paperlink renders the snapshot into a fresh `snapshots/run-*` folder (removed afterwards) and the whole run has one 5-minute deadline.
- Codex: `codex exec` in the read-only sandbox with `--ignore-user-config`, `--ignore-rules`, web search off and apps, plugins, browser/computer use, multi-agent and hooks disabled; snapshot attached with `--image`; the schema-checked JSON answer becomes notes (author "Codex", clamped to the page, added with `paper annotate --literal --text=…`, partial failures reported).
- Claude: runs in the snapshot folder with `--tools Read,Bash`, `--strict-mcp-config`, allowed `Read(//<snapshot>)` and `Bash(paper annotate <id> --page <n> --at *)`; `paper annotate` refuses `--text` with `--clear`/`--remove`. Previously Claude could snapshot to any path and clear notes of any canvas from a question typed on a paired device.
- Notes count as stale only when the writing changed: canvases record `inkRevision` (src/store.js `commit`); older files assume the last change was writing.
- Settings in `paper` pick Claude Code, Codex, a kept custom command or off; `paper setup` detects Codex, registers the MCP server with `codex mcp add` and offers whichever Ask presets it found.
- Verified: npm test (32 tests; stand-in `codex` and `claude` check flags, folder, prompt, attached image, clamping, literal text, stale marking). Real codex-cli 0.157 on macOS against a sandbox server: correct German notes in about 10 s, run folder removed; asked about its tools, the locked-down Codex reported no web or browser tools. Not verified: a real Claude Code run (Claude Code is not logged in on this machine, so the permission rules `Read(//…)` and the annotate prefix are untested against the real CLI), `paper setup` with Codex in a pty, `codex mcp add` registration, Codex on Windows/Linux, the Ask button from the iPad.

## Pictures on pages (2026-11-11, Claude Code, branch feature/images on top of feature/notebook-ui)

- New stroke kind `I x y w h <asset>` (src/ink.js): bounds, distance (0 inside), translate, transform (scales around the middle with the aspect ratio kept; turning moves only the middle, the picture stays upright like text), lasso by middle; the browser's erasers skip pictures (lasso deletes them), `eraseFrom` in ink.js would remove one whole. No colour/width/highlighter prefixes; asset names are strictly `[0-9a-f]{16}.(jpg|png)`, so store validation rejects anything else.
- Files live in `<canvas base>.assets` next to the canvas (`assetDirectory` in src/documents.js; hidden from the folder picker). `POST /api/canvases/<id>/assets` (PNG/JPEG, 15 MB, type and magic bytes must agree, SHA-256 name, temp file + rename, serialized with moves) and `GET …/assets/<asset>` (one-year private cache) in src/server.js. `moveCanvas` moves/renames the folder (merging file by file if the target folder exists; copy + remove across volumes); `deleteCanvas` trashes it (the Windows Recycle Bin path now handles folders).
- Browser: "Insert image" button after Text (hidden for browser-only drafts) with a hidden `<input type=file accept="image/*">`, plus paste. Downscale to 2400 px, JPEG 0.85 unless a PNG ≤ 4 MB has transparency. Upload through `api()` (it now merges caller headers), `add` op centred in the visible part of the page, ≤ 70 % of page width/height, then lasso-selected. Rendered as `<g class="picture">` (placeholder rect + `<image>`) at the bottom of `.marks`; bytes fetched with the device token into a blob-URL cache that is revoked when another canvas opens.
- Export embeds pictures with embedJpg/embedPng below the ink, positioned through `mapper()` and turned with the page's x axis; a missing file is skipped. Obsidian previews draw a placeholder with an "Image" label, because Obsidian shows the SVG as an image, which never loads linked files. `paper inspect` reports `images` per page.
- Verified: npm test (39 tests; new test/images.test.js: format and rejection, export position read back with pdf.js on a 90°-rotated PDF page and a blank page, preview placeholder, move/rename/delete with the folder, upload/serve/401/415/400 signature mismatch/traversal names/idempotency, `paper move` through the server, `paper inspect`). Headless Chrome 1200×900 via CDP against a sandbox server: file-input insert of a 3000×2000 PNG (stored as a 2400×1600 JPEG, selected with handles), lasso move and scale-handle saved, pen ink drawn above the picture, whole-stroke eraser removed it, undo restored it, synthetic paste of a translucent PNG stayed PNG, both pictures re-rendered after reload, export downloaded and rendered correctly.
- Later fix: pictures load with onload and a 20 s limit instead of `image.decode()`, which stayed pending in the desktop app's browser pane and left "Adding picture…" hanging; verified there by pasting a PNG, writing on it and erasing the ink (the picture stays).
- Not verified: anything on the iPad (Photos/Camera picker, HEIC conversion, paste from the iPad clipboard, memory with several large photos, Apple Pencil on top of pictures), Safari in general, cross-volume moves of the folder, the Windows Recycle Bin folder path. Known gaps: pictures removed from all pages stay in the `.assets` folder; a canvas moved in the Finder leaves its `.assets` folder behind (only `paper move` and note-following carry it); the lasso colour swatches do nothing on a picture.
