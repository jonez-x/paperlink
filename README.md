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

Both commands return JSON. Listing covers the selected folder. Use the folder icon to open or create vault canvases. Import browser draft creates a separate canvas and retains the original draft. Saves use revision checks and atomic file replacement. Local pending edits survive reloads. Conflicts can be saved as a new copy.

## Browser vault storage

```sh
npm start -- --lan --vault "/path/to/vault" --path "Paperlink/Canvases"
node --test test/storage.test.js
```

Open the full device link printed at startup. Use it only on a trusted LAN, since this prototype uses HTTP. The key stays in the browser tab session and is removed from the address bar after loading. The selected canvas reopens on reload. After restarting the server, open the new device link.

A folder lock prevents two Paperlink servers from editing the same store. Graceful shutdown removes it. After a crash, verify its recorded PID is no longer running before manually removing the stale lock.

This milestone supports single-page stroke documents. Other devices can open the same files, but must reopen them to see changes. Concurrent saves produce a visible conflict rather than silently overwriting data. Canvas files currently use JSON; an Obsidian Markdown preview is still pending.
