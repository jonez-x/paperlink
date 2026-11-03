# Paperlink

A self-hosted notebook for handwriting, assignments and PDF worksheets. Start it from your laptop's CLI, write with Apple Pencil in your iPad browser, and keep documents wherever you want in your Obsidian vault. An optional assistant can read a page and leave annotations.

**Status:** Early handwriting prototype. It currently supports a single browser-local draft, pen, stroke eraser, undo/redo and Light/Dark/System themes. Vault storage, PDFs, multi-device synchronization and AI integration are planned.

## Run the prototype

Requires Node.js 22 or newer.

```sh
npm start
npm start -- --port 8081
```

Open http://localhost:8080. The experimental `--lan` flag binds to all network interfaces. Device pairing is still pending, and browser drafts are separate on each device.

The planned CLI command is `paper`. Its availability remains unchecked.

## Documentation

- [Product and interaction](docs/product.md)
- [Architecture, CLI and AI integration](docs/architecture.md)
- [Roadmap and acceptance criteria](docs/roadmap.md)

The target product works without an account, subscription or bundled model service. An optional connected assistant processes requested content under its provider's terms.

Open source is the goal. MIT is the proposed license. Licensing and public release remain undecided.
