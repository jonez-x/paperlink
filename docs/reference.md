# Reference

Everything the [README](../README.md) leaves out: commands for scripts, storage, sync, Obsidian, pairing, assistants, MCP and platform notes.

## CLI for scripts and agents

Every menu action is also a command with flags. Outside a terminal (or with `--json`) commands print JSON, never prompt, report errors on stderr as `{"error": "..."}` and exit with code 1. Relative paths are resolved from the current folder. `paper help` lists every command and option.

```sh
paper new "Uni/Analysis/Sheet 3"          # creates Uni/Analysis/Sheet 3.paperlink, prints its QR code
paper new "Uni/Analysis/Sheet 4" --pdf ~/Downloads/Blatt4.pdf   # write on the pages of a PDF
paper export "Sheet 4"                    # Sheet 4 (annotated).pdf next to the canvas (--output FILE)
paper start                               # background server + QR code
paper open "Uni/Analysis/Sheet 3"         # file path, ID, ID prefix or title
paper list                                # canvases created or opened on this computer
paper move "Sheet 3" "Uni/Archive/"       # move or rename, note and preview included
paper delete "Sheet 3"                    # canvas, note and preview to the Trash (--all, --yes)
paper forget <id|title>                   # remove from the list, keep the file (--all)
paper status
paper stop
```

`paper serve` runs the server in the current terminal instead of the background. `paper drafts` and `paper import "<folder>/<name>" --from-browser <id>` save drawings made before a canvas was opened.

In a terminal, `paper open` shows the QR code and two actions: **Open canvas** opens it in the default browser, **Copy link** copies a link with a one-time pairing code that works on any device in the network. Scripts get the links as JSON.

## Settings

Settings live in `~/.config/paperlink/config.json` (on Windows `%APPDATA%\paperlink\config.json`; override with `PAPERLINK_CONFIG`). Flags win over `PAPERLINK_PORT`, which wins over the file.

```sh
paper config
paper config set lan true         # iPad and other devices may connect
paper config set obsidian false   # no notes next to canvases in vaults
paper config set port 8080
paper config set assistant claude # ask button on the page (claude, codex or off), see Assistants
```

Never run `paper` with `sudo`: files in the settings folder would then belong to root and the server could no longer read them.

## Storage

A canvas is one file, `<Name>.paperlink`, wherever you create it; `--title` sets a title other than the file name. Paperlink keeps a list of the canvases created or opened on this computer (`canvases.json` in the settings folder). The server only serves those files to devices, so nobody on the network can request other files.

Saves use revision checks and atomic replacement. Pending edits survive reloads; a save failure marks the info icon, where you can retry. Concurrent edits produce a visible conflict instead of silently overwriting; conflicting edits stay available as a draft for `paper import`. Listing skips damaged files and sync conflict copies.

A lock in the per-user temp directory (never next to your files) prevents a second server from writing the same canvases. Locks left by crashed processes are replaced automatically.

Pictures inserted on pages live in a folder `<Name>.assets` next to the canvas, created with the first picture. Each file is named after its content (16 hex digits of its SHA-256 plus `.jpg` or `.png`), so the same picture is stored once and a stroke never points at changed bytes. Removing a picture from a page leaves its file in the folder (undo and other devices may still need it).

Deleting moves canvas, note, preview, the pictures folder and a copied PDF to the system trash (macOS Trash, Windows Recycle Bin, `~/.local/share/Trash/files` on Linux), so it can be undone.

## PDF worksheets

`paper new "<folder>/<name>" --pdf <file>` turns every page of a PDF into a page to write on. The PDF stays unchanged: a PDF already in the canvas folder is used in place, one from elsewhere is copied next to the canvas. It moves with the canvas; deleting the canvas trashes a copied PDF but never one that was already there. Pages added later are blank.

PDF pages keep their original look in both themes and are re-rendered sharply when you zoom. Rendering uses [pdf.js](https://github.com/mozilla/pdf.js) 5.4.624 (Apache-2.0), bundled in `public/vendor/pdfjs`, so Paperlink works offline without `npm install`. Obsidian previews show the PDF pages once the browser has opened the canvas.

## Writing tools

| Tool | Key | Tap again for |
|---|---|---|
| Pen | P | colour, width, Apple Pencil pressure (on by default), shape snapping, add to favorites |
| Highlighter | H | colour, width, straightening, add to favorites; drawn translucent below the ink |
| Eraser | E | whole strokes or precise (cuts strokes apart) |
| Lasso | L | – select strokes on one page, then drag inside the box to move, the corner handle to scale and the knob above to turn (snaps to 15°); the bar above recolours, duplicates or deletes (Delete key) |
| Shapes | S | line, arrow, rectangle or ellipse, with the pen's colour and width |
| Text | T | colour and size; tap to type, tap existing text to edit it, Esc cancels |
| Insert image | – | – opens the picture picker (on the iPad: Photos, camera or Files); pasting a picture works too |

Inserting a picture needs a canvas opened from the computer, not a browser-only draft. The browser scales it down to at most 2400 pixels on the long side and sends it as JPEG (quality 0.85); a PNG of up to 4 MB with transparency stays PNG. It lands centred in the visible part of the current page, at most 70% of the page wide and high, and is selected with the lasso, so it can be moved, scaled and turned (it stays upright; only its position turns) right away. Pictures lie below highlighters and ink. The erasers leave pictures alone, so ink written on a photo can be erased; select a picture with the lasso to delete it.

⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Shift+Z redoes. Tool settings are kept per browser. Pressure is used only for Apple Pencil (pointer type pen); mouse strokes keep a constant width.

**Shape snapping.** Holding the pen still for half a second at the end of a stroke replaces it with a clean shape: a straight line, a few straight segments, a circle or ellipse, a triangle, a rectangle (sides close to horizontal and vertical) or another quadrilateral. A scribble stays as written. The highlighter only straightens lines. Recognition lives in `recognizeShape` in `src/ink.js`.

**Favorites.** Up to three pens or highlighters (tool, colour, width) sit in the toolbar as dots of their ink; a tap selects one. "Add to favorites" in the pen or highlighter options saves the current one (the oldest goes when there are three), "Remove favorite" drops it.

**Pages.** The header holds the pages sidebar toggle (thumbnails, jump to a page, remove empty blank pages), page navigation, add page, fit and the notes switch. Add page offers blank, lined, squared or dotted paper; the new page follows the page in view. Pages from before templates keep the squared look. Templates are part of the page (`template` in the file) and appear in exports and previews.

### Stroke format

Every stroke is one string in a page's `strokes` array, so it is its own identity for operations, undo and sync. Optional prefixes come first: `#rrggbb` (colour; without one the theme's ink is used), `w<n>` (width, default 3; for text the size, default 24) and `h` (highlighter). Then one of:

- `M x y l 0.01 0 L x y …`: a line of constant width (the only form in older files, which stay valid),
- `V x y p x y p …`: a pressure stroke, `p` from 0 to 1; drawn as a filled outline,
- `T x y <text>`: text with its top left at x y, URI-encoded,
- `I x y w h <asset>`: a picture with its top left at x y, `w` × `h` page units, showing the file `<asset>` from the canvas's `.assets` folder. Pictures take no prefixes; `<asset>` must be 16 lowercase hex digits plus `.jpg` or `.png` (the file need not exist for the stroke to be valid).

`src/ink.js` parses, validates and draws all of them for the server, exports, previews and the browser (served at `/ink.js`). `paper inspect` lists typed text and the number of pictures per page.

Pictures reach devices through `POST /api/canvases/<id>/assets` (the raw PNG or JPEG body with its `Content-Type`, at most 15 MB; the type must match the file's signature; answers `{ "asset": "<name>" }`, the same name for the same bytes) and `GET /api/canvases/<id>/assets/<asset>` (served with a one-year private cache). Both need a paired device like every other canvas route; names other than the strict asset form are refused. A page is only removed while it has no strokes, so undoing "add page" on one device never deletes another device's writing.

## Exporting

**Export PDF** in the browser's info popover downloads the PDF. `paper export <canvas>` writes `<Name> (annotated).pdf` next to the canvas; `--output` chooses another file or folder. PDF pages are copied unchanged, including rotation and crop, and the handwriting is drawn on top as vectors in its colours, highlighters translucent below it. Text becomes real PDF text in Helvetica; characters outside its Latin set are replaced with "?". Pictures are embedded as they are stored (JPEG or PNG) below the ink, upright as on screen, also on rotated PDF pages; a picture whose file is missing is left out. Blank pages become white A4 pages. The export uses [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT), bundled in `vendor/pdf-lib`.

## Several devices at once

Strokes, erasing and new pages appear on other open devices as they happen. Each device sends its edits as small operations that the server merges, so writing on two devices at once never conflicts, and undo takes back only that device's own edits. When the connection drops, edits wait on the device (also across a reload) and go out in order and without duplicates once the server is reachable again; the info icon shows how many are waiting.

## Pairing devices

Each device pairs once. With `lan` enabled, `paper pair`, `paper start` and `paper new|open` show a QR code. The browser keeps a device key; from then on plain canvas links work on that device, including the **Open in Paperlink** link in Obsidian notes, also after server restarts.

- Links use the computer's network name (`<Name>.local`), so they stay valid when the IP address changes. Set `PAPERLINK_HOST` to use another name or address, for example when your network does not resolve `.local` names.
- Pairing codes work once and expire after 15 minutes. Each link carries its own code.
- `paper devices` lists paired devices, `paper unpair <device>` (or `--all`) revokes access immediately.
- Pairing is stored per browser and address: a browser opened through an IP address pairs separately from one opened through the network name.

The prototype uses HTTP: use it only on a trusted network. `--qr` forces and `--no-qr` hides QR codes.

## Moving canvases

`paper move <canvas> <folder/>` moves, `paper move <canvas> <new path>` renames. The note and the pictures folder move along (renamed with the canvas), and a running server switches over without losing a save. Moves made elsewhere are caught too:

- **File manager or sync:** a canvas missing from its place is searched for by ID, anywhere in its Obsidian vault, or otherwise near its old folder. If it cannot be found, `paper list` marks it as missing; `paper open "<new path>"` reconnects it.
- **Obsidian:** Obsidian does not show `.paperlink` files, so moving a note leaves the canvas behind. On the next save the server moves the canvas next to the note.

## Obsidian

Canvases inside an Obsidian vault (any folder below one with `.obsidian`) get two companions:

- `<Name>.md`, a note that embeds the handwriting and links to the canvas. It is created once and then belongs to you; Paperlink never rewrites it.
- `Paperlink Previews/<id>.svg` at the vault root, the handwriting on light paper, refreshed about 1.5 seconds after the last save. Pictures appear as light placeholders labelled "Image": Obsidian embeds the SVG as an image, and an SVG shown as an image loads no linked files, while embedding the photos would make every preview as large as they are.

`paper preview` creates previews and missing notes for known canvases inside vaults (all, or `paper preview <file|id|title>`).

## Assistants

Coordinates are page units: 900 wide, origin at the page's top left.

**With a terminal** (Claude Code, Codex, scripts):

```sh
paper inspect "Sheet 4" --json                            # pages, stroke counts, notes, revision
paper snapshot "Sheet 4" --page 2 --region 0,300,900,400  # PNG of that area (--output x.pdf for a PDF)
paper annotate "Sheet 4" --page 2 --at 520,320 --text "Check the sign here." --revision 12
paper annotate "Sheet 4" --literal --text="x \neq 2"   # as typed; without --literal \n is a line break
paper annotate "Sheet 4" --remove <id> | --clear
```

**Through MCP** (Claude Desktop, Claude Code and other MCP clients): `paper mcp` is a Model Context Protocol server on stdin/stdout. It needs no dependencies and runs each tool through the CLI.

| Tool | Does |
|---|---|
| `list_canvases` | Known canvases with ID, title and path |
| `create_canvas` | New canvas at a path, optionally from a PDF |
| `open_canvas` | Starts the server if needed, returns links |
| `inspect_canvas` | Pages, stroke counts, notes, revision |
| `snapshot_page` | PNG of a page or region, returned as an image |
| `add_note` | Note on the assistant layer |
| `remove_notes` | One note by ID, or all |
| `export_pdf` | PDF with the handwriting for handing in |

`paper setup` registers the server in Claude Desktop (`claude_desktop_config.json`, other entries kept; a file that is not valid JSON is left alone), Claude Code (`claude mcp add --scope user`), Codex (`codex mcp add`) and Cursor (`~/.cursor/mcp.json`), with the absolute paths of the running Node and `paper.js`. By hand, Claude Code: `claude mcp add paperlink -- paper mcp`. Claude Desktop and other clients (`claude_desktop_config.json`); using `node` with the full path works on every system, including Windows, where `paper` is a `.cmd` wrapper:

```json
{
  "mcpServers": {
    "paperlink": { "command": "node", "args": ["/path/to/paperlink/bin/paper.js", "mcp"] }
  }
}
```

Relative canvas paths in `create_canvas` start at the folder the client launches the server in, so prefer absolute paths.

**Ask from the page.** With `paper config set assistant claude` or `codex` (and a server restart) the toolbar gets an ask button: mark a region, optionally type a question, and the assistant runs on the computer and answers with notes. It is off by default. The browser only sends page, region and question; the command is fixed in the config and runs without a shell. One request per canvas runs at a time (5 minutes for the whole run); output goes to `assistant.log` in the settings folder.

- `claude`: Paperlink renders the snapshot into a fresh folder and runs Claude Code there with only the Read and Bash tools, no MCP servers, permission to read that snapshot and to run `paper annotate <canvas> --page <page> --at …` for the asked canvas and page (annotate refuses `--text` together with `--clear` or `--remove`).
- `codex`: Paperlink renders the snapshot and runs `codex exec` with it attached, in Codex's read-only sandbox (no writes, no network), without the user's Codex config, rules, web search, apps, plugins, browser or computer use. Codex answers with JSON notes (checked against a schema); Paperlink clamps them to the page and adds them with the author "Codex". Tested with codex-cli 0.157 on macOS. Note that the read-only sandbox can still read files on the computer; questions only come from paired devices.
- Other assistants: `paper config set assistant '["my-agent","--flag","{prompt}"]'`. Paperlink cannot restrict what a custom command does; it gets the same instructions as Claude Code, with the author "Assistant".

Notes live on a separate layer: they never change the handwriting, appear live on every open device, can be hidden and removed one by one (undo brings them back). A note made with a revision older than the canvas is marked as written for an earlier version.

## Installers

`npm run bundle` writes `dist/paperlink-<version>-installer.zip`: the app as `paperlink.tgz` (from `npm pack`) plus `install/`. The installers need no Node and no admin rights:

| | macOS, Linux (`install.sh`) | Windows (`install.ps1`) |
|---|---|---|
| Start | `Install Paperlink.command`, or `sh install.sh [paperlink.tgz]` | `Install Paperlink.cmd` (runs PowerShell with `-ExecutionPolicy Bypass` for this script only) |
| Folder | `~/.paperlink` | `%LOCALAPPDATA%\Paperlink` |
| Node.js | latest 22.x from nodejs.org, SHA-256 checked, in `node/` | same, `win-x64` or `win-arm64` |
| `paper` | `bin/paper`, added to the PATH in `~/.zprofile` (macOS) or `~/.zshrc` (elsewhere, when it exists or zsh is the login shell), `~/.bashrc`, `~/.bash_profile` (when it exists, or created on macOS for bash users) and `~/.config/fish/conf.d/paperlink.fish` (fish users) | `bin\paper.cmd`, added to the user PATH (kept as REG_EXPAND_SZ), plus a Start menu entry |

`PAPERLINK_HOME` changes the folder. Running an installer again stops the server first, replaces the app (and Node only when a newer 22.x exists or the installed `node --version` fails), then runs `paper setup`, which is skipped without a terminal. On Windows the new Node is unpacked next to the old one and swapped by renaming; if the old node.exe is still in use (an MCP server started by Claude Desktop or Cursor), the installer stops with a message to quit those apps, and the old Node stays intact. Settings and canvases are not touched. CI runs both installers on clean macOS, Windows and Linux runners.

## Platforms

Paperlink is developed on macOS. CI runs the tests on macOS, Windows and Linux.

| | macOS | Windows | Linux |
|---|---|---|---|
| Settings | `~/.config/paperlink` | `%APPDATA%\paperlink` | `$XDG_CONFIG_HOME/paperlink` or `~/.config/paperlink` |
| Delete | Trash | Recycle Bin (PowerShell) | `~/.local/share/Trash/files` |
| PNG snapshots | Quick Look | Windows PDF engine (Windows 10+, PowerShell 5.1) | `pdftoppm` (poppler-utils) |
| Open / copy link | `open`, `pbcopy` | `rundll32`, `clip` | `xdg-open`, `xclip` |
| Ask button | `claude` or `codex` on the PATH | `claude.exe` or `codex.exe` on the PATH (npm's `.cmd` wrappers cannot run without a shell; Codex not tested on Windows) | `claude` or `codex` on the PATH (Codex not tested on Linux) |

On Windows, allow Node.js through the firewall for private networks when it asks, otherwise the iPad cannot connect. If the iPad cannot resolve `<Name>.local`, set `PAPERLINK_HOST` to the computer's IP address.
