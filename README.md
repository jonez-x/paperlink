# Paperlink

A self-hosted notebook for handwriting, assignments and PDF worksheets. Start it from your laptop's CLI, write with Apple Pencil in your iPad browser, and keep every canvas as a `.paperlink` file wherever you like, for example next to your notes in an Obsidian vault. An optional assistant can read a page and leave annotations.

**Status:** Early prototype. Pen, stroke eraser, undo/redo, zoom and panning, multiple pages, PDF worksheets and PDF export, Light/Dark/System themes, automatic saving to canvas files, Obsidian notes with previews, device pairing with stable links and an interactive CLI are implemented. Live multi-device synchronization and AI integration are planned.

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
paper new "Uni/Analysis/Sheet 4" --pdf ~/Downloads/Blatt4.pdf   # write on the pages of a PDF
paper export "Sheet 4"                    # Sheet 4 (annotated).pdf next to the canvas (--output FILE)
paper start                               # background server + QR code
paper open "Uni/Analysis/Sheet 3"         # file path, ID, ID prefix or title
paper list                                # canvases created or opened on this computer
paper move "Sheet 3" "Uni/Archive/"      # move or rename, note and preview included
paper delete "Sheet 3"                    # canvas, note and preview to the Trash (--all for every canvas)
paper forget <id|title>                   # remove from that list, keep the file (--all)
paper status
paper stop
paper help                                # all commands and options
```

In the menu, **All canvases** lists everything; pick one to open, move, delete or remove it from the list. Deleting asks for confirmation (scripts pass `--yes`) and uses the Trash, so it can be undone.

`paper serve` runs the server in the current terminal instead of the background. `paper drafts` and `paper import "<folder>/<name>" --from-browser <id>` save drawings made before a canvas was opened.

## Where canvases are stored

A canvas is one file, `<Name>.paperlink`, wherever you create it. Relative paths are resolved from the current folder; `--title` sets a title other than the file name. There is no storage folder to configure.

Paperlink keeps a list of the canvases created or opened on this computer (`~/.config/paperlink/canvases.json`). The server only serves those files to devices, so nobody on the network can request other files. ## Writing

- **Apple Pencil or mouse** writes; the eraser removes whole strokes.
- **One finger** pans, **two fingers** pinch to zoom. On a Mac, scroll pans and pinch (or ⌘/Ctrl + scroll) zooms. The frame button fits the page again.
- **Pages** stack vertically; the page button adds an A4 page. Writing may run over a page's edge.

## PDF worksheets

`paper new "<folder>/<name>" --pdf <file>` (or the PDF prompt in the menu) turns every page of a PDF into a page to write on. The PDF stays unchanged: a PDF already in the canvas folder is used in place, one from elsewhere is copied next to the canvas. It moves with the canvas; deleting the canvas trashes a copied PDF but never one that was already there. Pages added later are blank.

PDF pages keep their original look (white paper, dark ink) in both themes and are re-rendered sharply when you zoom. Rendering uses [pdf.js](https://github.com/mozilla/pdf.js) 5.4.624 (Apache-2.0), bundled in `public/vendor/pdfjs`, so Paperlink still works offline and needs no `npm install`. Obsidian previews show the PDF pages once the browser has opened the canvas, because the server cannot render PDFs itself.

## Exporting

`paper export <canvas>` (or **Export PDF** in the menu's canvas list) writes `<Name> (annotated).pdf` next to the canvas; `--output` chooses another file or folder. PDF pages are copied unchanged, including rotation and crop, and your handwriting is drawn on top as vector lines, so the worksheet's text stays sharp and searchable. Blank pages become white A4 pages. The export uses [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT), bundled in `vendor/pdf-lib`.

## Moving canvases

Use `paper move <canvas> <folder/>` to move, or `paper move <canvas> <new path>` to rename. The note moves along, and a running server switches over without losing a save. Moves made elsewhere are caught too:

- **Finder or sync:** a canvas missing from its place is searched for by ID, anywhere in its Obsidian vault, or otherwise near its old folder. If it cannot be found, `paper list` marks it as missing; `paper open "<new path>"` reconnects it.
- **Obsidian:** Obsidian does not show `.paperlink` files, so moving a note leaves the canvas behind. On the next save the server notices and moves the canvas next to the note.

Settings live in `~/.config/paperlink/config.json` (override with `PAPERLINK_CONFIG`):

```sh
paper config
paper config set lan true         # iPad and other devices may connect
paper config set obsidian false   # no notes next to canvases in vaults
paper config set port 8080
```

## Obsidian

Canvases inside an Obsidian vault (any folder below one with `.obsidian`) automatically get two companions:

- `<Name>.md`, a note that embeds the handwriting and links to the canvas (**Open in Paperlink**, see Connecting the iPad). It is created once and then belongs to you: rename or move it and add your own text below the embed; Paperlink never rewrites it.
- `Paperlink Previews/<id>.svg` at the vault root, the handwriting on light paper. One folder per vault keeps your folders clean; the ID keeps names unique and stable when you rename or move things. The running server refreshes it about 1.5 seconds after the last save.

`paper preview` creates previews and missing notes for known canvases inside vaults (all, or `paper preview <file|id|title>`). Restart the server after changing the setting.

## Connecting the iPad

Each device pairs once. With network access enabled (`lan`), `paper pair`, `paper start` and `paper new|open` print a QR code; scan it with the iPad camera. The page opens (with the canvas, if the code belongs to one) and the browser keeps a device key. From then on plain canvas links work on that device, including the **Open in Paperlink** link in Obsidian notes, also after server restarts.

- Links use the computer's network name (`<Name>.local`, from System Settings › Sharing), so they stay valid when the IP address changes. The server must be running for a link to open.
- Pairing codes work once and expire after 15 minutes. The browser removes them from the address bar.
- `paper devices` lists paired devices, `paper unpair <device>` (or `--all`) revokes access immediately.
- Pairing is stored per browser and address: a browser opened through an IP address pairs separately from one opened through the network name.

This prototype uses HTTP: use it only on a trusted network. QR codes appear in terminals; `--qr` forces and `--no-qr` hides them.

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
