# Architecture, CLI and AI integration

The browser, CLI and optional MCP adapter share the local server's document operations. HTTP provides documents, snapshots and commands. A streamed HTTP response per open canvas (server-sent events read with fetch, so the device token can be sent) distributes changes to connected browsers. The UI renders strokes locally and submits completed strokes with unique operation IDs.

## Documents and Obsidian

Each canvas is a versioned `.paperlink` file with stable document/page/object IDs at a user-selected location, often inside an Obsidian vault. Inside a vault, a Markdown note with an embedded preview accompanies it. The original PDF and other assets will be referenced relatively.

Store PDF backgrounds separately from strokes. Page coordinates remain independent of zoom and viewport size. Text and AI annotations are separate objects. Refresh previews after confirmed changes. Identify documents by ID and move related files together through the CLI. Test moves through Obsidian and file managers before general release. Native Obsidian Canvas compatibility and an embedded Obsidian editor are later integrations.

The server performs atomic writes and is authoritative during editing. Every change has a revision. Stable operation IDs prevent duplicate additions. Existing-object updates check the expected revision and report conflicts. Undo/redo tracks the user's operations while preserving other devices' edits. Browsers persist unconfirmed operations locally, reload the confirmed state after reconnecting and resend pending operations.

## Proposed CLI

The prototype implements `new/open/list/move/delete/forget/export/preview/drafts/import`, the assistant commands `inspect/snapshot/annotate`, `mcp` and `start/serve/stop/status/pair/devices/unpair/config`; see [reference.md](reference.md). A canvas is a `.paperlink` file anywhere; there is no configured storage root. Other commands below describe the target interface. Canvas management and draft imports run through the CLI. The browser follows a canvas link and autosaves; no browser file-management menu is provided.

```sh
paper serve --port 8080 --lan
paper new "University/Math/Exercise 4"
paper list --json
paper open <file|canvas-id>
paper canvas import-pdf <canvas-id> Worksheet.pdf
paper page inspect <page-id> --json
paper page snapshot <page-id> --output /tmp/page.png
paper annotate <page-id> --region 120,300,400,200 --text "Check the unit here."
paper canvas export <canvas-id> --pdf --output Assignment.pdf
paper mcp
```

One server manages multiple documents. One server per user serves every canvas the local CLI has created or opened; a lock prevents a second server. Agents receive stable IDs, JSON output, actionable errors and concise command documentation. Annotations use page coordinates and appear in connected browsers. Devices reach only canvases on the CLI's list, never arbitrary paths.

## MCP adapter

`paper mcp` (src/mcp.js) speaks JSON-RPC 2.0 over stdin/stdout, one message per line, without the MCP SDK so the project stays dependency-free. It supports `initialize`, `ping`, `tools/list` and `tools/call`. Each tool runs the matching CLI command with `--json` in a child process, so validation, server routing (edits through a running server reach open tabs live) and errors stay identical to the CLI. Tool errors are returned as results with `isError`, protocol errors as JSON-RPC errors. `snapshot_page` renders to a temporary PNG and returns it as an image content block.

## Platform layer

Platform-specific calls are isolated: settings folder (src/config.js), trash and Recycle Bin (src/move.js), PDF-to-PNG rendering (src/raster.js: Quick Look, the WinRT PDF API through Windows PowerShell, pdftoppm), opening and copying links (src/cli.js) and the assistant's `paper` shim (src/assistant.js, a shell script plus `paper.cmd` on Windows). Paths handed to PowerShell travel in environment variables, never inside the script. `.github/workflows/test.yml` runs `npm test` on macOS, Windows and Linux.

## Development

```sh
npm test
```

Open source is the goal. MIT is the proposed license. Licensing and public release remain undecided. The product works without an account, subscription or bundled model service; an optional connected assistant processes requested content under its provider's terms.

## Assistant interaction and triggers

- From chat, assistants with terminal access use the CLI. Compatible clients can use MCP. Initial tools list pages, retrieve selections and create annotations.
- From the page, Request feedback emits a document ID, page, selection, revision and optional question to a configured local adapter. Initial adapters can launch Claude Code with `claude -p` or Codex with `codex exec`. Model connections are opt-in.
- For ongoing conversations, evaluate Claude Code Channels and the Codex App Server. Direct push into ordinary open ChatGPT chats is outside the current integration plan. ChatGPT Workspace Agent API triggers are a separate option.
- A later opt-in mode may request feedback after a writing pause. Ordinary document synchronization never invokes a model.

Limit initial assistant access to the selected document or region and write to a separate annotation layer. Protect original handwriting by default. Check results against the referenced revision before placement or flag them as stale. Configure adapters and allowed actions on the host. Browser requests must not execute arbitrary shell commands.

References: [MCP](https://ts.sdk.modelcontextprotocol.io/server), [Claude Code CLI](https://code.claude.com/docs/en/headless), [Claude Code Channels](https://code.claude.com/docs/en/channels), [Codex](https://developers.openai.com/blog/codex-as-a-platform), [Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business).
