# Architecture, CLI and AI integration

The browser, CLI and optional MCP adapter share the local server's document operations. HTTP provides documents, snapshots and commands. WebSocket distributes changes to connected browsers. The UI renders strokes locally and submits completed strokes with unique operation IDs.

## Documents and Obsidian

Each canvas lives at a user-selected location in the vault. The initial storage proposal includes a Markdown entry with an embedded preview and browser link, a versioned Paperlink document with stable document/page/object IDs, and relatively referenced assets for the original PDF and preview.

Store PDF backgrounds separately from strokes. Page coordinates remain independent of zoom and viewport size. Text and AI annotations are separate objects. Refresh previews after confirmed changes. Identify documents by ID and move related files together through the CLI. Test moves through Obsidian and file managers before general release. Native Obsidian Canvas compatibility and an embedded Obsidian editor are later integrations.

The server performs atomic writes and is authoritative during editing. Every change has a revision. Stable operation IDs prevent duplicate additions. Existing-object updates check the expected revision and report conflicts. Undo/redo tracks the user's operations while preserving other devices' edits. Browsers persist unconfirmed operations locally, reload the confirmed state after reconnecting and resend pending operations.

## Proposed CLI

The prototype implements `serve` and `canvas create/list --vault <root> --path <folder>`. Other commands describe the target interface. The folder menu now supports explicit draft import and single-page vault saving.

```sh
paper init --vault ~/Documents/MyVault
paper serve --port 8080 --lan
paper canvas create "Exercise 4" --path "University/Math"
paper canvas list --json
paper canvas open <canvas-id>
paper canvas import-pdf <canvas-id> Worksheet.pdf
paper page inspect <page-id> --json
paper page snapshot <page-id> --output /tmp/page.png
paper annotate <page-id> --region 120,300,400,200 --text "Check the unit here."
paper canvas export <canvas-id> --pdf --output Assignment.pdf
paper mcp
```

One server manages multiple documents. Ports and storage roots are configurable. Separate instances may use separate ports. The first version should prevent multiple servers from writing the same document store. Agents receive stable IDs, JSON output, actionable errors and concise command documentation. Annotations use page coordinates and appear in connected browsers. Paths remain confined to the configured document root.

## Assistant interaction and triggers

- From chat, assistants with terminal access use the CLI. Compatible clients can use MCP. Initial tools list pages, retrieve selections and create annotations.
- From the page, Request feedback emits a document ID, page, selection, revision and optional question to a configured local adapter. Initial adapters can launch Claude Code with `claude -p` or Codex with `codex exec`. Model connections are opt-in.
- For ongoing conversations, evaluate Claude Code Channels and the Codex App Server. Direct push into ordinary open ChatGPT chats is outside the current integration plan. ChatGPT Workspace Agent API triggers are a separate option.
- A later opt-in mode may request feedback after a writing pause. Ordinary document synchronization never invokes a model.

Limit initial assistant access to the selected document or region and write to a separate annotation layer. Protect original handwriting by default. Check results against the referenced revision before placement or flag them as stale. Configure adapters and allowed actions on the host. Browser requests must not execute arbitrary shell commands.

References: [MCP](https://ts.sdk.modelcontextprotocol.io/server), [Claude Code CLI](https://code.claude.com/docs/en/headless), [Claude Code Channels](https://code.claude.com/docs/en/channels), [Codex](https://developers.openai.com/blog/codex-as-a-platform), [Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business).
