# Paperlink

Handwriting and PDF worksheets in the iPad browser, saved as files on your computer. Start Paperlink on your laptop, scan a QR code with the iPad and write with Apple Pencil. Every canvas is a `.paperlink` file wherever you like, for example next to your notes in an Obsidian vault.

**Status:** early prototype.

## Install

**With the installer** (macOS, Windows, Linux): unzip `paperlink-<version>-installer.zip` and double-click **Install Paperlink.command** (macOS) or **Install Paperlink.cmd** (Windows); on Linux run `sh install.sh`. It downloads Node.js for Paperlink alone (no admin rights needed), adds the `paper` command and walks you through setup: iPad access, AI assistants, first canvas. Run it again to update. Build the zip with `npm run bundle`.

If macOS refuses to open the installer, right-click it and choose **Open**, or allow it under System Settings › Privacy & Security.

**From the source**, with [Node.js](https://nodejs.org) 22 or newer:

```sh
git clone https://github.com/jonez-x/paperlink.git
cd paperlink
npm link
```

On Windows, if PowerShell says running scripts is disabled, allow them once for your user with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` and `paper.cmd` instead.

## Use

```sh
paper
```

The first run starts a short setup (again any time with `paper setup`). The menu is driven with the arrow keys:

1. **New canvas**: pick a folder and, optionally, a PDF worksheet.
2. **Open canvas**: scan the QR code with the iPad, or choose **Open canvas** to write on this computer or **Copy link** to send the link elsewhere.
3. Write. Everything saves automatically.

To let the iPad connect, allow network access once: `paper config set lan true`. The iPad and computer need to be on the same network.

## Writing

- **Apple Pencil or mouse** writes. Tap the active tool again for its options: pen colour, width and pressure; highlighter colour; whole-stroke or precise eraser; shape and text size.
- **Highlighter**, **shapes** (line, arrow, rectangle, ellipse) and **text** (tap to type, tap text to edit it).
- **Lasso** selects strokes on a page to move, recolour, duplicate or delete them.
- **All pages** shows thumbnails to jump to; blank pages can be removed there.
- **One finger** pans, **two fingers** zoom.
- **Arrows** in the toolbar (or Page Up/Down, Home/End) jump between pages; **Fit** fits the page you are on.
- **Export PDF** in the info menu gives you the worksheet with your handwriting, ready to hand in.

## Assistants

Claude and other assistants can read a page and leave notes next to your writing. `paper setup` connects the ones it finds (Claude Desktop, Claude Code, Cursor). By hand:

```sh
claude mcp add paperlink -- paper mcp
```

## More

- [Reference](docs/reference.md): all commands, settings, storage, Obsidian, pairing, MCP, Windows and Linux
- [Architecture](docs/architecture.md) · [Product](docs/product.md) · [Roadmap](docs/roadmap.md)
