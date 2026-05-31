# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

A personal knowledge base / digital garden built on [Quartz v4](https://quartz.jzhao.xyz/), deployed to Vercel. Markdown notes live in `content/`, the Quartz framework lives in `quartz/`, and two config files control everything: `quartz.config.ts` and `quartz.layout.ts`.

## Commands

```bash
# Local dev server with hot reload
npx quartz build --serve

# Build only
npx quartz build

# Type check + prettier check
npm run check

# Format code
npm run format

# Run tests
npm test
```

Requires Node >= 22 and npm >= 10.9.2.

## Architecture

### Content (`content/`)
All Markdown notes, organized by topic (大数据, 中间件, Golang, Java, etc.). Notes use Obsidian-flavored Markdown (wiki links `[[...]]`, callouts, etc.). Folders named `private`, `templates`, or `.obsidian` are ignored by the build.

### Quartz Framework (`quartz/`)
- **`quartz.config.ts`** — Site-wide config: title, analytics, theme colors/fonts, and the plugin pipeline (transformers → filters → emitters).
- **`quartz.layout.ts`** — Component layout for content pages vs. list pages (left sidebar, right sidebar, before/after body).
- **`quartz/plugins/`** — Three plugin types:
  - `transformers/` — Process Markdown AST (e.g., ObsidianFlavoredMarkdown, SyntaxHighlighting, Latex)
  - `filters/` — Exclude files from output (e.g., RemoveDrafts removes pages with `draft: true` frontmatter)
  - `emitters/` — Generate output files (ContentPage, FolderPage, TagPage, etc.)
- **`quartz/components/`** — Preact TSX components for the site UI (Explorer, Search, TableOfContents, etc.)
- **`quartz/styles/`** — SCSS stylesheets
- **`quartz/util/`** — Shared utilities

### Deployment
Vercel with `cleanUrls: true`. The `main` branch is the upstream Quartz repo; content and customizations live on the `v4` branch.

## Key Customizations

The Explorer component in `quartz.layout.ts` has performance optimizations for large content sets:
- `folderDefaultState: "collapsed"` — prevents rendering the full DOM tree on cold start
- `useSavedState: false` — skips JS traversal of thousands of nodes to restore open/close state
- `folderClickBehavior: "collapse"` — folder names collapse/expand instead of navigating

## Content Frontmatter

Notes support standard Quartz frontmatter: `title`, `date`, `tags`, `draft` (set `draft: true` to exclude from build), and `aliases`.
