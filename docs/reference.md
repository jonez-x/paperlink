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
paper config set assistant claude # ask button on the page, see Assistants
```

Never run `paper` with `sudo`: files in the settings folder would then belong to root and the server could no longer read them.

## Storage

A canvas is one file, `<Name>.paperlink`, wherever you create it; `--title` sets a title other than the file name. Paperlink keeps a list of the canvases created or opened on this computer (`canvases.json` in the settings folder). The server only serves those files to devices, so nobody on the network can request other files.

Saves use revision checks and atomic replacement. Pending edits survive reloads; a save failure marks the info icon, where you can retry. Concurrent edits produce a visible conflict instead of silently overwriting; conflicting edits stay available as a draft for `paper import`. Listing skips damaged files and sync conflict copies.

A lock in the per-user temp directory (never next to your files) prevents a second server from writing the same canvases. Locks left by crashed processes are replaced automatically.

Deleting moves canvas, note, preview and a copied PDF to the system trash (macOS Trash, Windows Recycle Bin, `~/.local/share/Trash/files` on Linux), so it can be undone.

## PDF worksheets

`paper new "<folder>/<name>" --pdf <file>` turns every page of a PDF into a page to write on. The PDF stays unchanged: a PDF already in the canvas folder is used in place, one from elsewhere is copied next to the canvas. It moves with the canvas; deleting the canvas trashes a copied PDF but never one that was already there. Pages added later are blank.

PDF pages keep their original look in both themes and are re-rendered sharply when you zoom. Rendering uses [pdf.js](https://github.com/mozilla/pdf.js) 5.4.624 (Apache-2.0), bundled in `public/vendor/pdfjs`, so Paperlink works offline without `npm install`. Obsidian previews show the PDF pages once the browser has opened the canvas.

## Exporting

**Export PDF** in the browser's info popover downloads the PDF. `paper export <canvas>` writes `<Name> (annotated).pdf` next to the canvas; `--output` chooses another file or folder. PDF pages are copied unchanged, including rotation and crop, and the handwriting is drawn on top as vector lines. Blank pages become white A4 pages. The export uses [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT), bundled in `vendor/pdf-lib`.

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

`paper move <canvas> <folder/>` moves, `paper move <canvas> <new path>` renames. The note moves along, and a running server switches over without losing a save. Moves made elsewhere are caught too:

- **File manager or sync:** a canvas missing from its place is searched for by ID, anywhere in its Obsidian vault, or otherwise near its old folder. If it cannot be found, `paper list` marks it as missing; `paper open "<new path>"` reconnects it.
- **Obsidian:** Obsidian does not show `.paperlink` files, so moving a note leaves the canvas behind. On the next save the server moves the canvas next to the note.

## Obsidian

Canvases inside an Obsidian vault (any folder below one with `.obsidian`) get two companions:

- `<Name>.md`, a note that embeds the handwriting and links to the canvas. It is created once and then belongs to you; Paperlink never rewrites it.
- `Paperlink Previews/<id>.svg` at the vault root, the handwriting on light paper, refreshed about 1.5 seconds after the last save.

`paper preview` creates previews and missing notes for known canvases inside vaults (all, or `paper preview <file|id|title>`).

## Assistants

Coordinates are page units: 900 wide, origin at the page's top left.

**With a terminal** (Claude Code, Codex, scripts):

```sh
paper inspect "Sheet 4" --json                            # pages, stroke counts, notes, revision
paper snapshot "Sheet 4" --page 2 --region 0,300,900,400  # PNG of that area (--output x.pdf for a PDF)
paper annotate "Sheet 4" --page 2 --at 520,320 --text "Check the sign here." --revision 12
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

Claude Code: `claude mcp add paperlink -- paper mcp`. Claude Desktop and other clients (`claude_desktop_config.json`); using `node` with the full path works on every system, including Windows, where `paper` is a `.cmd` wrapper:

```json
{
  "mcpServers": {
    "paperlink": { "command": "node", "args": ["/path/to/paperlink/bin/paper.js", "mcp"] }
  }
}
```

Relative canvas paths in `create_canvas` start at the folder the client launches the server in, so prefer absolute paths.

**Ask from the page.** With `paper config set assistant claude` (and a server restart) the toolbar gets an ask button: mark a region, optionally type a question, and Claude Code runs on the computer and answers with notes. It is off by default. The browser only sends page, region and question; the command is fixed in the config, runs without a shell, and Claude may only use `paper inspect`, `paper snapshot`, `paper annotate` and read the snapshot. One request per canvas runs at a time (5-minute limit); output goes to `assistant.log` in the settings folder. Other assistants: `paper config set assistant '["my-agent","--flag","{prompt}"]'`.

Notes live on a separate layer: they never change the handwriting, appear live on every open device, can be hidden and removed one by one (undo brings them back). A note made with a revision older than the canvas is marked as written for an earlier version.

## Platforms

Paperlink is developed on macOS. CI runs the tests on macOS, Windows and Linux.

| | macOS | Windows | Linux |
|---|---|---|---|
| Settings | `~/.config/paperlink` | `%APPDATA%\paperlink` | `$XDG_CONFIG_HOME/paperlink` or `~/.config/paperlink` |
| Delete | Trash | Recycle Bin (PowerShell) | `~/.local/share/Trash/files` |
| PNG snapshots | Quick Look | Windows PDF engine (Windows 10+, PowerShell 5.1) | `pdftoppm` (poppler-utils) |
| Open / copy link | `open`, `pbcopy` | `rundll32`, `clip` | `xdg-open`, `xclip` |
| Ask button | `claude` on the PATH | `claude.exe` on the PATH (native installer; npm's `.cmd` wrapper cannot run without a shell) | `claude` on the PATH |

On Windows, allow Node.js through the firewall for private networks when it asks, otherwise the iPad cannot connect. If the iPad cannot resolve `<Name>.local`, set `PAPERLINK_HOST` to the computer's IP address.
