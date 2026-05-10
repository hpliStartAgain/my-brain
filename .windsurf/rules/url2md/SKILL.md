---
name: url2md
description: >
  Convert a public web page URL into an Obsidian-ready Markdown note. Fetches
  article content, removes boilerplate, downloads useful images when helper
  scripts are available, translates English prose to Simplified Chinese, keeps
  code and links intact, and performs quality checks. Use when a user wants to
  save a public article, blog post, or documentation page as a local Markdown
  note.
---

# url2md

## Purpose

Turn a public `http://` or `https://` article into a clean, Chinese-first,
Obsidian-ready Markdown note.

This skill does not support logged-in, paywalled, or heavily anti-scraping pages
unless the user provides accessible HTML or text.

## Important implementation note

The README may mention `scripts/fetch_page.py` and `scripts/download_images.py`.
If these helper scripts are not present in the installed skill directory, do not
pretend they were run. Use available browser/read tools or ask the user for the
HTML/text. Record the limitation in the final note only if it affects output
quality.

## Non-negotiable success criteria

1. Preserve all substantive article content.
2. Translate English prose into Simplified Chinese by default.
3. Keep code, commands, configuration, URLs, API names, and identifiers intact.
4. Remove ads, cookie banners, newsletter prompts, navigation, unrelated
   recommendations, author boilerplate, and footer noise.
5. Keep useful links as Markdown links.
6. Handle every useful image explicitly: Mermaid, table, local image link, prose
   description, or clean decorative removal.
7. Output valid Markdown that renders cleanly in Obsidian.
8. Do not output lazy placeholders such as "?????????" or "???????".

## Inputs

- A valid public URL or user-provided HTML/text
- Target output directory
- Optional target language, default Simplified Chinese

## Workflow

### Step 1 ? Fetch or obtain content

If helper scripts exist, run:

```bash
python scripts/fetch_page.py <url> --output <output_dir>
```

Expected files:

- `<output_dir>/_raw_content.txt`
- `<output_dir>/_images.json`

If helper scripts do not exist, use available tools to fetch/read the URL, or ask
the user to provide page content. Do not fabricate article content.

### Step 2 ? Identify article body

Extract only the main article or documentation body.

Remove:

- navigation
- sidebars unrelated to the article
- ads
- cookie banners
- newsletter prompts
- "related posts"
- comment sections unless explicitly requested
- footer boilerplate

Preserve:

- headings
- paragraphs
- lists
- tables
- code blocks
- meaningful callouts/asides
- useful links
- figure captions and image context

### Step 3 ? Download or handle images

If image download helpers exist, run:

```bash
python scripts/download_images.py <output_dir>/_images.json --output <output_dir>/images
```

For each useful image, apply `image2mermaid`:

- diagrams ? Mermaid
- legible tables/charts ? Markdown tables
- important screenshots/photos/formulas ? local relative image link or prose
- decorative images ? remove cleanly

Do not leave broken image references.

### Step 4 ? Convert to Obsidian Markdown

Write `<output_dir>/<safe-title>.md`.

Markdown requirements:

1. Begin with `# <????>` unless the original Chinese title is already good.
2. Preserve source heading hierarchy with `##`?`######`.
3. Translate English prose into natural Simplified Chinese.
4. Keep code blocks fenced with best-effort language tags.
5. Keep tables as Markdown tables.
6. Keep links as `[text](url)`.
7. Use Obsidian callouts for true notes, tips, warnings, and important context.
8. Use `[[??]]` for important recurring technical concepts.
9. End with source attribution:

```markdown
---
???<original url>
```

Do not add process commentary, apologies, or "conversion completed" messages
inside the Markdown file.

### Step 5 ? Quality check

Before finishing, verify:

- no large untranslated English prose remains unless it is code/API/URL content
- no substantive paragraph, list, table, or code block is missing
- no boilerplate noise remains
- all code fences are closed
- all local image links point to existing files
- no lazy placeholder phrases appear
- the note has a clear title and readable structure

If a check fails, revise the Markdown before returning.

## Quality rules

- Preserve factual content; do not summarize as a replacement.
- Improve layout, but do not invent facts.
- Prefer clean, boring Markdown over decorative formatting.
- If source extraction is incomplete because of login, paywall, or anti-scraping,
  state the limitation clearly and ask the user for accessible content instead of
  pretending the conversion succeeded.

## Example invocations

```bash
python scripts/fetch_page.py https://blog.example.com/post --output ./notes/post
python scripts/download_images.py ./notes/post/_images.json --output ./notes/post/images
```
