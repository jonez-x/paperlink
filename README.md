# Paperlink

A self-hosted notebook for handwriting, assignments and PDF worksheets. Start it from your laptop's CLI, write with Apple Pencil in your iPad browser, and keep every canvas as a file in a folder you choose. That folder can be an Obsidian vault, but it does not have to be. An optional assistant can read a page and leave annotations.

**Status:** Early prototype. Pen, stroke eraser, undo/redo, Light/Dark/System themes, automatic saving to a library folder, QR pairing and an interactive CLI are implemented. PDFs, Obsidian previews, live multi-device synchronization and AI integration are planned.

## Install

Requires Node.js 22 or newer. No dependencies.

```sh
npm link        # makes the `paper` command available (or use: node bin/paper.js)
paper           # interactive menu; the first run asks where to keep canvases
```

## Two ways to use the CLI

**People:** run `paper` for a menu you drive with the arrow keys: create and open canvases, pick folders, start the server, scan QR codes, change settings. Commands that are missing input ask for it.

**Scripts and AI agents:** every action is also a command with flags. Outside a terminal (or with `--json`) commands print JSON, never prompt, report errors on stderr as `{"error": "..."}` and exit with code 1.

```sh
paper init ~/Notes --default-path "Paperlink" --lan   # choose the library once
paper start                                           # background server + QR code
paper canvas new "Analysis sheet 3" --path "Uni/Analysis"
paper canvas list
paper canvas open "analysis"                          # ID, ID prefix or title
paper status
paper stop
paper help                                            # all commands and options
```

`paper serve` runs the server in the current terminal instead of the background. `canvas drafts` and `canvas import "<title>" --from-browser <id>` save drawings made before a canvas was opened. Shortcuts: `paper new`, `paper list`, `paper open`.

## Where canvases are stored

The **library** is any existing folder. Canvases are `<id>.paperlink.json` files anywhere inside it; hidden folders (`.obsidian`, `.git`, `.trash`) are ignored. New canvases go to `--path`, or the configured default folder.

Settings live in `~/.config/paperlink/config.json` (override with `PAPERLINK_CONFIG`). Flags win over `PAPERLINK_LIBRARY` / `PAPERLINK_PORT`, which win over the config file. `--vault` remains an alias for `--library`.

```sh
paper config
paper config set defaultPath "Uni"
paper config set lan true
paper config set obsidian true    # Obsidian Markdown previews
```

## Obsidian previews

With `obsidian` on, every canvas gets two companions in its folder:

- `<Title>.md`, a note that embeds the handwriting and shows the `paper open` command. It is created once (by `canvas new`, `canvas import` or `paper preview`) and then belongs to you: rename or move it within the folder and add your own text below the embed; Paperlink never rewrites it.
- `<id>.preview.svg`, the handwriting on light paper. The running server refreshes it about 1.5 seconds after the last save.

`paper preview` creates previews and missing notes for existing canvases (all, or `paper preview <id|title>`). Restart the server after changing the setting.

## Connecting the iPad

With network access enabled (`lan`), `paper start`, `paper serve` and `paper canvas new|open` print a QR code. Scan it with the iPad camera; the canvas opens and saves automatically from the first stroke. The code contains a per-run access key, so do not share screenshots of it. QR codes appear in terminals; `--qr` forces and `--no-qr` hides them.

This prototype uses HTTP: use it only on a trusted network. The key stays in the browser tab session and is removed from the address bar after loading. After a server restart, scan the new code.

## Storage guarantees

Saves use revision checks and atomic replacement. Pending edits survive reloads; a save failure marks the info icon, where you can retry. Concurrent edits produce a visible conflict instead of silently overwriting; conflicting edits stay available as a draft for `canvas import`. Listing skips damaged files and sync conflict copies.

A lock in the per-user temp directory (never inside the library) prevents two Paperlink servers from writing the same library. Locks left by crashed processes are replaced automatically.

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
