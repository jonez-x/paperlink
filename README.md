# Paperlink

A self-hosted notebook for handwriting, assignments and PDF worksheets. Start it from your laptop's CLI, write with Apple Pencil in your iPad browser, and keep every canvas as a `.paperlink` file wherever you like, for example next to your notes in an Obsidian vault. An optional assistant can read a page and leave annotations.

**Status:** Early prototype. Pen, stroke eraser, undo/redo, Light/Dark/System themes, automatic saving to canvas files, Obsidian notes with previews, QR pairing and an interactive CLI are implemented. PDFs, live multi-device synchronization and AI integration are planned.

## Install

Requires Node.js 22 or newer. No dependencies.

```sh
npm link        # makes the `paper` command available (or use: node bin/paper.js)
paper           # interactive menu
```

## Two ways to use the CLI

**People:** run `paper` for a menu you drive with the arrow keys: create a canvas by browsing to a folder, open recent canvases, start the server, scan QR codes, change settings. Commands that are missing input ask for it.

**Scripts and AI agents:** every action is also a command with flags. Outside a terminal (or with `--json`) commands print JSON, never prompt, report errors on stderr as `{"error": "..."}` and exit with code 1. An assistant can, for example, create a canvas in a folder, start the server and hand you the link.

```sh
paper new "Uni/Analysis/Sheet 3"          # creates Uni/Analysis/Sheet 3.paperlink, prints its QR code
paper start                               # background server + QR code
paper open "Uni/Analysis/Sheet 3"         # file path, ID, ID prefix or title
paper list                                # canvases created or opened on this computer
paper move "Sheet 3" "Uni/Archive/"      # move or rename, note and preview included
paper forget <id|title>                   # remove from that list, keep the file
paper status
paper stop
paper help                                # all commands and options
```

`paper serve` runs the server in the current terminal instead of the background. `paper drafts` and `paper import "<folder>/<name>" --from-browser <id>` save drawings made before a canvas was opened.

## Where canvases are stored

A canvas is one file, `<Name>.paperlink`, wherever you create it. Relative paths are resolved from the current folder; `--title` sets a title other than the file name. There is no storage folder to configure.

Paperlink keeps a list of the canvases created or opened on this computer (`~/.config/paperlink/canvases.json`). The server only serves those files to devices, so nobody on the network can request other files. ## Moving canvases

Use `paper move <canvas> <folder/>` to move, or `paper move <canvas> <new path>` to rename. Note and preview move along, and a running server switches over without losing a save. Moves made elsewhere are caught too:

- **Finder or sync:** a canvas missing from its place is searched for by ID, anywhere in its Obsidian vault, or otherwise near its old folder. If it cannot be found, `paper list` marks it as missing; `paper open "<new path>"` reconnects it.
- **Obsidian:** Obsidian does not show `.paperlink` files, so moving a note leaves the canvas behind. On the next save the server notices and moves the canvas and its preview next to the note.

Settings live in `~/.config/paperlink/config.json` (override with `PAPERLINK_CONFIG`):

```sh
paper config
paper config set lan true         # iPad and other devices may connect
paper config set obsidian false   # no notes next to canvases in vaults
paper config set port 8080
```

## Obsidian

Canvases inside an Obsidian vault (any folder below one with `.obsidian`) automatically get two companions:

- `<Name>.md`, a note that embeds the handwriting and shows the `paper open` command. It is created once and then belongs to you: rename or move it and add your own text below the embed; Paperlink never rewrites it.
- `<id>.preview.svg`, the handwriting on light paper, named by canvas ID so renames never break the embed. The running server refreshes it about 1.5 seconds after the last save.

`paper preview` creates previews and missing notes for known canvases inside vaults (all, or `paper preview <file|id|title>`). Restart the server after changing the setting.

## Connecting the iPad

With network access enabled (`lan`), `paper start`, `paper serve` and `paper canvas new|open` print a QR code. Scan it with the iPad camera; the canvas opens and saves automatically from the first stroke. The code contains a per-run access key, so do not share screenshots of it. QR codes appear in terminals; `--qr` forces and `--no-qr` hides them.

This prototype uses HTTP: use it only on a trusted network. The key stays in the browser tab session and is removed from the address bar after loading. After a server restart, scan the new code.

## Storage guarantees

Saves use revision checks and atomic replacement. Pending edits survive reloads; a save failure marks the info icon, where you can retry. Concurrent edits produce a visible conflict instead of silently overwriting; conflicting edits stay available as a draft for `canvas import`. Listing skips damaged files and sync conflict copies.

A lock in the per-user temp directory (never next to your files) prevents a second Paperlink server from writing the same canvases. Locks left by crashed processes are replaced automatically.

## Development

```sh
npm test
```

## Documentation

- [Product and interaction](docs/product.md)
- [Architecture, CLI and AI integration](docs/architecture.md)
- [Roadmap and acceptance criteria](docs/roadmap.md)
- [Agent handoff](docs/handoff.md)

The target product works without an account, subscription or bundled model service. An optional connected assistant processes requested content under its provider's terms.

Open source is the goal. MIT is the proposed license. Licensing and public release remain undecided.
