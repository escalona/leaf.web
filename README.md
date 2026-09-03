# Leaf

Leaf is a DOM-based visual design editor that people and AI agents use together. Every design
node is a real HTML element with CSS styles, so the canvas an agent edits is the same DOM the
person is looking at, not a picture of it.

**Try it: [new.leafnode.app](https://new.leafnode.app).** It opens straight onto a canvas. There
is no account and nothing to install; your designs stay in your browser. Open it in ChatGPT's
built-in browser, or in Chrome with WebMCP enabled, and the page registers its editing operations
as WebMCP site tools on `document.modelContext`. No server, extension, or MCP client configuration
is involved.

This repository is the browser app in that local-only configuration, exported from a private
development repository. The account-backed version at [leafnode.app](https://leafnode.app)
(multiplayer sync, image generation) and the macOS desktop app with its MCP server for Codex and
Claude Code come from the same codebase; the sync Worker, sign-in, and desktop shell are left out
of the export, along with the design documentation, LLM wiki, test suite, benchmarks, and release
tooling. The file `.export-source` records the commit each export came from. Issues and patches
are welcome.

## The Core Idea

Most design tools paint the scene graph into a `<canvas>`. Leaf renders a frame as a `<div>`.

```
┌──────────────────────────────────────────────┐
│  Toolbar                                     │
├────────┬──────────────────────┬──────────────┤
│        │                      │              │
│ Layers │   Viewport           │  Properties  │
│        │   ┌──────────────┐   │              │
│        │   │ camera div   │   │              │
│        │   │ (CSS matrix) │   │              │
│        │   │  ┌─────────┐ │   │              │
│        │   │  │ <div/>  │ │   │              │
│        │   │  │ nodes   │ │   │              │
│        │   │  └─────────┘ │   │              │
│        │   └──────────────┘   │              │
│        │   ┌──────────────┐   │              │
│        │   │ Canvas+SVG   │   │              │
│        │   │ overlay      │   │              │
│        │   └──────────────┘   │              │
├────────┴──────────────────────┴──────────────┤
```

Because nodes are real elements, text measurement, flex layout, fonts, and CSS effects come from
the browser for free, and an agent can reason about a design as HTML it already understands.

## WebMCP — Browser-native AI Integration

Leaf progressively exposes the open editor as WebMCP site tools. In ChatGPT's built-in browser, a
person opens the app and asks for what they want; ChatGPT inspects the design, authors HTML onto
the canvas, edits layers, organizes pages, and leaves canvas comments, while the person keeps
editing the same document with the ordinary tools. Nothing about Leaf's UI changes for browsers
without WebMCP.

### Try it

1. Open [new.leafnode.app](https://new.leafnode.app) in the ChatGPT desktop app's browser, or in
   Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled. A first visit opens a new
   file on the canvas; later visits list the files this browser holds.
2. Leaf registers its tools while a ready editor is visible; check **Site tools** in the address
   bar (ChatGPT) or the WebMCP panel in DevTools (Chrome).
3. Ask for work on the open file, for example:
   - "Create a 1440-wide landing page hero for a coffee subscription with a headline, a
     supporting line, and two buttons."
   - "Find every text layer under 14px and bump it to 14."
   - "Look at the artboards on this page and leave a comment on the one with the weakest
     hierarchy explaining why."

### What the page registers

All tools act on the visible page of the focused file, so their schemas carry no document or
window identifiers.

| Group                    | Tools                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context and verification | `list_pages`, `get_basic_info`, `get_selection`, `get_tree_summary`, `get_node_info`, `get_node_styles`, `measure_text`, `find_nodes`, `get_canvas_layout`, `get_jsx`, `get_font_family_info` |
| Pages and camera         | `edit_pages` (create, rename, duplicate, reorder, set-active, move-nodes in one batch), `set_viewport`                                                                                        |
| Creation and mutation    | `create_artboard`, `write_html`, `update_styles`, `set_text_content`, `duplicate_nodes`, `delete_nodes`, `rename_nodes`, `move_nodes`, `set_node_visibility`, `rename_file`                   |
| Collaboration            | `list_comments`, `add_comment`, `resolve_comment_thread`, `finish_working_on_nodes`                                                                                                           |

### How it is built

The registration lives in [`src/agent/webmcp/leaf-webmcp.ts`](src/agent/webmcp/leaf-webmcp.ts)
and is wired from the app shell in [`src/app/App.tsx`](src/app/App.tsx).

- **One agent surface.** Every WebMCP tool dispatches through the same renderer bridge
  (`src/agent/mcp/bridge.ts`) and `EditorRuntime` mutation surface as the desktop MCP tools and
  the editor's own commands, so an agent's edits get the same validation, undo history, and
  persistence as a person's. The WebMCP layer is a curated projection, not a second editor API.
- **Page-scoped and pinned.** Tools register when a ready editor tab is visible and unregister,
  through an `AbortController`, when the tab or file changes. Each registration captures the
  document it was created for, and every call rechecks it before acting, so a stale in-flight
  call fails closed instead of following focus onto a different file.
- **Strict inputs, compact outputs.** Browser schema enforcement is advisory, so each tool parses
  its input again with Zod and returns a JSON envelope, `{ ok, result }` or
  `{ ok: false, error }`, with an error code the agent can act on. Nodes are addressed by short
  `#n` handles so results stay small.
- **Annotations.** Read tools carry `readOnlyHint`; tools that can return document-authored text
  carry `untrustedContentHint`.
- **Agent presence.** Successful node-scoped calls light up the nodes the agent is working on and
  add it to the avatar group beside the person. `finish_working_on_nodes` clears them. Each
  browser tab gets its own agent identity, kept in `sessionStorage`.
- **Origin isolation.** WebMCP needs an origin-keyed page. The Vite dev and preview servers and
  the production host all send `Origin-Agent-Cluster: ?1` (`vite.config.ts`, `public/_headers`).

Screenshots, staged files, native documents and scripts, workspace creation, and destructive page
deletion remain desktop MCP-only.

### Timeline

Leaf existed before this integration as a design editor with a desktop MCP server. The WebMCP
integration, the agent-surface work that supports it, and this local-only public build were done
between 2026-08-26 and 2026-09-03. Dates are Pacific time; this export carries no history, and the
private repository's full commit log is available on request.

| Date       | Work                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-26 | Curated browser WebMCP tool surface: registration on `document.modelContext`, page-scoped schemas, strict input validation, the result envelope, registration lifecycle, and `Origin-Agent-Cluster` on every host |
| 2026-08-27 | Durable image generation reachable from the shared authoring tools (`write_html`, `create_artboard`, `update_styles`)                                                                                             |
| 2026-08-30 | Tool surface slimmed for current models; short `#n` node handles and compact response envelopes; tool-call latency cut 3-4x; static, CSS-only agent working indicator                                             |
| 2026-08-31 | Review hardening of handle resolution, durability, and read paths                                                                                                                                                 |
| 2026-09-01 | Bug triage across the agent surface; `wait_for_image_generation`                                                                                                                                                  |
| 2026-09-02 | Faster launch and file create/open; release pipeline for the hosted app; `src/` layered so the browser bundle never carries desktop code                                                                          |
| 2026-09-03 | Local-only public build: a first visit opens onto a canvas with no sign-in; this export                                                                                                                           |

## Codex plugin

This repository is also a Codex plugin marketplace. The `leaf-web` plugin (`plugins/leaf-web`) installs
one skill that tells the agent where Leaf is and how to use its site tools from the ChatGPT
desktop app's built-in browser. Add it from the Plugins page under Personal with this
repository's URL, or:

```bash
codex plugin marketplace add escalona/leaf.web
codex plugin add leaf-web@leaf
```

## Quick Start

Install dependencies from the repository root (Node 24, pnpm 11):

```bash
pnpm install
```

Start the local editor and open the printed URL in a WebMCP-capable browser:

```bash
pnpm dev
```

The app runs entirely in the browser: no Worker, no sign-in, documents in IndexedDB.

```bash
pnpm build      # production build into dist/
pnpm preview    # serve dist/ with the header WebMCP needs
pnpm check      # format and lint
```

### Hosting your own

`dist/` is a static site. Two things matter for WebMCP: the document must be origin-keyed, so the
host has to send `Origin-Agent-Cluster: ?1` (`public/_headers` does this on Cloudflare; set it
yourself elsewhere), and file deep links need a single-page-app fallback to `index.html`.

## Architecture

- **Rendering:** every node is a real DOM element positioned inside a CSS-transformed camera
  element; overlays for selection and presence draw in Canvas and SVG above it.
- **State:** a normalized durable document plus a MobX `EditorStore` session projection. All
  durable mutations, from a person, a script, or an agent, go through `EditorRuntime`.
- **Persistence:** this build runs the local runtime, which keeps files and image assets in
  IndexedDB. The hosted app swaps in a network runtime backed by a Cloudflare Worker with Durable
  Objects per document; the editor above it is the same.
- **Agents:** one renderer bridge serves both the WebMCP projection and the desktop MCP server.

## Tech Stack

React 19, MobX 6, TypeScript 6, Vite, Tailwind CSS 4, Zod 4, Oxlint and Oxfmt, and pnpm. The
hosted app adds Cloudflare Workers, Durable Objects, D1, R2, and WorkOS AuthKit; the desktop app
adds Electron and the MCP v2 SDK.

## File Structure

`src/` is layered `core` < `ui` < `agent` < `app`; imports only flow downward. (The private
repository adds a `desktop` layer on top.)

```
src/
  core/
    editor/                — EditorRuntime, interaction math, HTML import, clipboard, export
    state/                 — EditorStore, local and network runtimes, IndexedDB persistence, image assets
    shared/collaboration/  — Environment-neutral records, commands, DTOs, and checkpoints
    nodes/, fonts/, markup/ — Node model, font metadata, and markup helpers
  ui/
    app/                   — Editor canvas app, dashboard, and workspace chrome
    viewport/              — Camera, pointer phases, direct manipulation, clipboard/drop
    node-renderer/         — Recursive real-DOM renderers
    canvas-overlay/        — Live geometry and editor/presence chrome
    layers/, properties/   — Hierarchy and inspector surfaces
  agent/
    webmcp/                — WebMCP site-tool registration
    mcp/                   — Renderer bridge and handlers shared by WebMCP and desktop MCP
  app/
    App.tsx, main.tsx      — Application shell and web entry
    AppBoot.tsx, boot/     — Boot tree (local mode in this build)
public/                    — Fonts, font metadata, and hosting headers
```

## License

[MIT](LICENSE).
