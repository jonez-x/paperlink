# Paperlink

A self-hosted notebook for handwriting, assignments and PDF worksheets. Start it from your laptop's CLI, write with Apple Pencil in your iPad browser, and keep documents wherever you want in your Obsidian vault. An optional assistant can read a page and leave annotations.

**Status:** Early handwriting prototype. It currently supports a single browser-local draft, pen, stroke eraser, undo/redo and Light/Dark/System themes. Vault saving and explicit browser-draft import are implemented. PDFs, live multi-device synchronization and AI integration are planned.

## Run the prototype

Requires Node.js 22 or newer.

```sh
npm start
npm start -- --port 8081
```

Open http://localhost:8080. The `--lan` flag binds to all network interfaces. With vault storage enabled, open the private device link printed by the server to authorize access. The link changes on restart. Browser-only drafts remain separate on each device.

The planned CLI command is `paper`. Its availability remains unchecked.

## Documentation

- [Product and interaction](docs/product.md)
- [Architecture, CLI and AI integration](docs/architecture.md)
- [Roadmap and acceptance criteria](docs/roadmap.md)

The target product works without an account, subscription or bundled model service. An optional connected assistant processes requested content under its provider's terms.

Open source is the goal. MIT is the proposed license. Licensing and public release remain undecided.

## File storage milestone

The CLI can now create and list versioned canvas files in an existing vault:

```sh
node bin/paper.js canvas create "Exercise 4" --vault "/path/to/vault" --path "University/Math"
node bin/paper.js canvas list --vault "/path/to/vault" --path "University/Math"
```

All canvas commands return JSON. Listing covers the selected folder. Manage files through the CLI; the browser only writes and autosaves. With the server running against the same vault and folder:

```sh
node bin/paper.js canvas open <canvas-id> --vault "/path/to/vault" --path "University/Math" --port 8080
node bin/paper.js canvas drafts --vault "/path/to/vault" --path "University/Math"
node bin/paper.js canvas import "My draft" --from-browser <draft-id> --vault "/path/to/vault" --path "University/Math"
```

`open` prints private local/device links for the selected canvas. `drafts` lists connected browser drafts (IDs, stroke counts and last update). Keep the original draft tab open with the server connection link: it publishes a temporary snapshot every two seconds. `import` writes that snapshot to a new canvas, then the browser switches to it and autosaves subsequent edits. The original local draft is retained. Imports are idempotent for the same browser draft ID during a server run. In-memory draft snapshots are lost on server restart; the browser republishes after reconnecting.

Saves use revision checks and atomic replacement. Pending edits survive reloads. A save failure marks the info icon; retry there. Conflicting edits are exposed as a draft for CLI import into a separate canvas. Existing recovery snapshots remain in browser storage.

CLI management endpoints only accept requests to the literal loopback host without an Origin header. They are intended for trusted local processes; browser APIs require the connection token.

## Browser vault storage

```sh
npm start -- --lan --vault "/path/to/vault" --path "Paperlink/Canvases"
node --test test/storage.test.js
```

Open the full device link printed at startup, or scan the QR code shown below it with the iPad camera. `canvas open` also prints a QR code for the selected canvas (on stderr, so the JSON output stays clean). QR codes appear in interactive terminals; force them with `--qr` or hide them with `--no-qr`. The QR code contains the access key, so do not share screenshots of it. Use it only on a trusted LAN, since this prototype uses HTTP. The key stays in the browser tab session and is removed from the address bar after loading. The selected canvas reopens on reload. After restarting the server, open the new device link.

A folder lock in the per-user temp directory (never inside the vault) prevents two Paperlink servers from editing the same store. Graceful shutdown removes it; a lock left by a crashed process is detected and replaced automatically.

This milestone supports single-page stroke documents. Other devices can open the same files, but must reopen them to see changes. Concurrent saves produce a visible conflict rather than silently overwriting data. Canvas files currently use JSON; an Obsidian Markdown preview is still pending.
