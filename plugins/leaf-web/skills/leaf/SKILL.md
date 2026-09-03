---
name: leaf
description: Design on the Leaf canvas through its WebMCP site tools in ChatGPT's built-in browser. Use whenever the user asks to design, mock up, wireframe, or lay out UI, or mentions Leaf. Leaf lives at https://new.leafnode.app and needs no account.
---

# Leaf

Leaf is a design editor where every layer is a real HTML element. The page itself is the API:
while a file is open, Leaf registers its editor as WebMCP site tools in the browser. There is
nothing to connect, install, or configure.

## How to reach it

1. Open **https://new.leafnode.app** in the built-in browser. A first visit opens a new file on
   the canvas. A later visit shows the file list; open a file.
2. Leaf's site tools appear once a file is open. Use them directly. Do not look for an MCP
   server, a connector, an extension, or a login; there are none.
3. If the tools disappear, the tab left the file (file list, another site, or a reload). Go
   back to the file and re-check.

## Working on the canvas

- `get_basic_info` and `list_pages` show what is there. `create_artboard` (name plus
  `styles.width` and `styles.height`) makes a root; `write_html` with
  `mode: "insert-children"` fills it. Edit with `update_styles` (camelCase),
  `set_text_content`, `move_nodes`, `find_nodes`; prefer a targeted edit over rebuilding.
- HTML rules: inline kebab-case styles only; flex or grid with padding and gap; font-family,
  font-size, color, and line-height on every text element (styles do not cascade);
  `layer-name="..."` on meaningful elements; SVG for icons, not emoji; real copy, not lorem.
- Results are `{ ok, result }` or `{ ok: false, error }`. `invalid_input` lists the exact schema
  problems; fix the call. `document_changed` means the user switched files; re-read.
- The user edits the same canvas while you work, so re-read a node before changing something you
  did not just create. Review notes go in `add_comment`, pinned to the node they are about.
