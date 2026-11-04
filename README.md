# Paperlink

Handwriting and PDF worksheets in the iPad browser, saved as files on your computer. Start Paperlink on your laptop, scan a QR code with the iPad and write with Apple Pencil. Every canvas is a `.paperlink` file wherever you like, for example next to your notes in an Obsidian vault.

**Status:** early prototype.

## Install

Requires [Node.js](https://nodejs.org) 22 or newer. Works on macOS, Windows and Linux.

```sh
git clone https://github.com/jonez-x/paperlink.git
cd paperlink
npm link
```

## Use

```sh
paper
```

The menu is driven with the arrow keys:

1. **New canvas**: pick a folder and, optionally, a PDF worksheet.
2. **Open canvas**: scan the QR code with the iPad, or choose **Open canvas** to write on this computer or **Copy link** to send the link elsewhere.
3. Write. Everything saves automatically.

To let the iPad connect, allow network access once: `paper config set lan true`. The iPad and computer need to be on the same network.

## Writing

- **Apple Pencil or mouse** writes; the eraser removes whole strokes.
- **One finger** pans, **two fingers** zoom.
- **Export PDF** in the info menu gives you the worksheet with your handwriting, ready to hand in.

## Assistants

Claude and other assistants can read a page and leave notes next to your writing:

```sh
claude mcp add paperlink -- paper mcp
```

## More

- [Reference](docs/reference.md): all commands, settings, storage, Obsidian, pairing, MCP, Windows and Linux
- [Architecture](docs/architecture.md) · [Product](docs/product.md) · [Roadmap](docs/roadmap.md)
