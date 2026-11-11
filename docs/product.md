# Product and interaction

## Target workflow

1. Start Paperlink on the laptop. The CLI displays a local address and a QR code when LAN access is enabled.
2. Create a canvas in a chosen vault folder and import a multi-page PDF worksheet.
3. Open it on the iPad, write on the page, erase, highlight and zoom with two fingers.
4. View the same document on the laptop. Ask about an exercise in chat, or select a region on the iPad and request feedback.
5. The assistant reads the selection and adds feedback on a separate layer. Hide, remove or accept individual annotations.
6. Export the completed assignment as a PDF on light paper while retaining the original, editable handwriting and Obsidian preview.

## Writing interface

Build paginated documents first for assignments. Add an infinite canvas for sketches later. A compact toolbar contains pen, highlighter, eraser, lasso, text and undo/redo. Lasso selection supports movement and scaling. Page navigation, zoom and PDF import stay accessible. Less frequent settings live in a menu.

[Mistral](https://mistral.ai/) is the visual reference. Use warm neutral surfaces, angular shapes, clear typography and fine dividers. Orange indicates the active tool, with restrained yellow and red accents. Small pixel details can appear in empty states. Paperlink uses its own name and icons.

Light, Dark and System themes are required from the first prototype and persist per browser. Dark mode includes blank writing pages. Ink must remain readable in either theme. Imported PDFs retain their original appearance by default. Export paper and ink mapping are independent of the UI theme.

## iPad and network

Use a browser interface. Test Safari with a real Apple Pencil early. Render strokes immediately on the device. Fingers navigate in pen mode. A resting palm must not create strokes or move the page. Test pressure, erasing, two-finger zoom, undo and both device orientations.

The target server defaults to local-only access. Users explicitly enable LAN access and pair devices using a QR code. Laptop and iPad can open the same document simultaneously. During brief disconnections, the browser buffers pending strokes and synchronizes them after reconnecting. Status distinguishes locally pending edits from server-confirmed saves.

These are target requirements. docs/handoff.md records what is implemented and verified; lasso scaling and an infinite canvas are not built yet.
