---
name: pdf2md
description: >
  Convert a text-based English or Chinese PDF technical book into multiple
  Obsidian-ready Markdown files, one per chapter or logical section. Extracts
  structure, translates English content into Simplified Chinese, preserves all
  substantive content, converts suitable diagrams to Mermaid, keeps non-diagram
  visual information readable, and produces a mandatory 00 专览导读.md plus quality
  report. Use when a user wants to read a technical book or document inside
  Obsidian.
---

# pdf2md

## Purpose

Convert a text-based PDF book into a high-quality Obsidian note set:

- multiple logically split `.md` files
- Simplified Chinese reading experience by default
- faithful preservation of all substantive source content
- Obsidian-friendly headings, callouts, wiki-links, tables, and code blocks
- Mermaid reconstruction for suitable diagrams
- mandatory `00 专览导读.md`, `_plan.json`, `_glossary.md`, and `_quality_report.md`

This skill is for technical books and long-form technical documents. The final
result should be pleasant to read in Obsidian, not merely raw extracted text.

## Non-negotiable success criteria

The task is not complete until all criteria below are satisfied:

1. **No lazy output**: never say or imply that translation, formatting, image
   conversion, or chapter conversion was skipped because it was too much work.
2. **Chinese-first output**: if the source is English, translate all prose into
   Simplified Chinese. English may remain only in code, commands, API names,
   URLs, equations, file paths, product names, or as parenthesized original terms
   after the Chinese translation.
3. **No summarization as replacement**: do not replace source content with a
   short summary. Preserve every recoverable factual point, definition, example,
   list item, table, figure reference, caption, code snippet, and explanation.
4. **Obsidian-ready Markdown**: output must use clean heading hierarchy, callouts
   where helpful, fenced code blocks with language tags, Markdown tables, and
   `[[??]]` for important recurring concepts.
5. **Every planned section becomes a file**: each item in `_plan.json` must have
   a corresponding non-empty `.md` file.
6. **Images are handled explicitly**: every extracted image must be classified
   and represented as Mermaid, Markdown table, preserved local image, or prose
   description. Use standard markdown `![caption](absolute_path)` for embedding images.
7. **Footnotes are preserved**: maintain all source footnotes using `[^n]` syntax.
8. **Inter-chapter linking**: proactive linking to previous chapters using `[[XX ChapterTitle#Section|AnchorText]]` is required for continuity.
9. **Self-review is mandatory**: create `_quality_report.md` documenting checks,
   problems found, fixes made, and any remaining limitations.

Forbidden lazy phrases include but are not limited to:

- "?????????????????"
- "?????????? Mermaid???????"
- "?????.md ?????????????"
- "????????????"
- "???????"
- "????"
- "?????????"

If any of these phrases appear in final output, the task has failed and must be
redone.

## Inputs

- Path to a `.pdf` file
- Target output directory
- Optional target language, default: Simplified Chinese (`zh-CN`)

## Workflow

### Step 0 ? Create a working state

Before conversion, create the output directory and prepare these files:

- `<output_dir>/_plan.json`
- `<output_dir>/_glossary.md`
- `<output_dir>/_image_map.json`
- `<output_dir>/_quality_report.md`

During the task, keep `_glossary.md` and `_image_map.json` updated instead of
relying only on memory. This reduces terminology drift and image omissions.

### Step 1 ? Extract the PDF outline

Run:

```bash
python scripts/extract_pdf_outline.py <pdf_path>
```

This prints a JSON object to stdout:

```json
{
  "title": "Data Structures and Algorithms",
  "path": "/abs/path/to/book.pdf",
  "page_count": 480,
  "toc": [
    [1, "Chapter 1: Arrays", 1],
    [2, "1.1 Basic Operations", 3],
    [1, "Chapter 2: Linked Lists", 25]
  ],
  "sample_text": "--- Page 1 ---\nChapter 1\nArrays\n...",
  "has_toc": true,
  "warnings": []
}
```

Use `toc`, `sample_text`, `page_count`, and warnings to judge:

- whether the PDF is text-based or extraction is poor
- source language
- likely chapter structure
- whether the document is a book, paper, manual, or mixed document

If extracted text is mostly empty or garbled, do not fake a high-quality result.
Add a clear warning to `_quality_report.md` and the affected chapter files.

### Step 2 ? Plan the chapter breakdown

Based on the ToC and sample text, decide how to split the PDF into Markdown
files.

Planning rules:

1. Prefer ToC-based splitting when a useful ToC exists.
2. Group subsections that belong to the same coherent chapter.
3. When ToC is absent, infer logical sections from headings and page count.
4. Aim for 6?24 output files for a normal technical book; avoid tiny fragments
   unless the source structure requires them.
5. Use stable, filesystem-safe Chinese titles, numbered for sorting.
6. Page ranges must be continuous, non-overlapping unless there is a deliberate
   reason, and should cover all substantive pages.

Write the plan to `<output_dir>/_plan.json`:

```json
[
  {
    "id": "chapter-001",
    "title": "1.1 ????",
    "start_page": 1,
    "end_page": 24,
    "description": "????????????????????",
    "expected_output": "???? Obsidian Markdown ??"
  }
]
```

After writing `_plan.json`, verify:

- every item has `id`, `title`, `start_page`, `end_page`, and `description`
- `start_page <= end_page`
- page ranges are inside the PDF page count
- no planned output filename is duplicated

### Step 3 ? Extract text and images for each section

For each item in `_plan.json`, run:

```bash
python scripts/extract_pdf_text.py <pdf_path> --start <start_page> --end <end_page> --output <output_dir>/_work/<chapter_id>.txt
```

Then extract images:

```bash
python scripts/extract_pdf_images.py <pdf_path> --start <start_page> --end <end_page> --output <output_dir>/images/<chapter_id>/
```

Read the extracted text before writing Markdown. Do not generate a chapter from
the title alone. If extraction is empty or garbled, mark it in the chapter and in
`_quality_report.md`.

### Step 4 ? Process every image

For each extracted image, apply the `image2mermaid` skill.

Required outcomes for each image:

- `mermaid`: structured diagram converted to a Mermaid block
- `table`: legible table or chart data converted to Markdown table
- `keep`: semantically important image preserved with a relative local link
- `describe`: non-Mermaid image explained in concise Chinese prose
- `decorative`: purely decorative image removed without leaving a reference

Rules:

1. "Too much work" is not a valid reason to skip a diagram.
2. Complex diagrams should be simplified faithfully, split into multiple Mermaid
   blocks, or represented with Mermaid plus prose. Do not silently drop them.
3. Screenshots with important UI or configuration information should usually be
   kept or described, not deleted.
4. Data charts should become Markdown tables if values are legible; otherwise
   describe the trend.
5. Every image decision must be written to `<output_dir>/_image_map.json`.

Example `_image_map.json` entry:

```json
{
  "chapter-001/page0003_img001.png": {
    "page": 3,
    "action": "mermaid",
    "reason": "??????????????",
    "markdown": "```mermaid\ngraph TD\n    A[???] --> B[??]\n```"
  }
}
```

### Step 5 ? Convert each section to Obsidian Markdown

For each planned section, read:

- section metadata from `_plan.json`
- extracted raw text
- relevant image mappings from `_image_map.json`
- current terminology in `_glossary.md`

Write `<output_dir>/<title>.md`.

Chapter requirements:

1. Start with exactly one H1 matching the planned title.
2. Translate English prose into natural Simplified Chinese.
3. Preserve original meaning, technical precision, examples, tables, lists, and
   code.
4. Use `##` and `###` headings to reconstruct readable structure.
5. Use Obsidian callouts only when they improve reading:
   - `> [!INFO]` for background or terminology
   - `> [!TIP]` for best practices
   - `> [!WARNING]` for pitfalls or extraction quality warnings
   - `> [!NOTE]` for supplementary notes
6. Use `[[??]]` for important recurring concepts, not every ordinary word.
7. Keep code, commands, config, JSON, XML, YAML, SQL, and APIs in fenced code
   blocks with best-effort language tags. Do not translate code identifiers.
8. Insert image-derived Mermaid/table/link/prose at the correct semantic position
   near the relevant figure reference or caption.
9. Remove or rewrite dangling phrases like "as shown in the figure" only when
   the figure itself has been replaced or described.
10. Do not include process notes, apologies, status reports, or meta commentary.
11. **Footnote Handling**: Preserve pedagogical footnotes using `[^n]` at the point of reference and the definition at the end of the file or sub-section.
12. **Shell Prompts**: Preserve specific shell prompts (e.g., `serverA#`, `serverB#`) in command blocks to maintain technical context.

When translating, use this pattern for key terms on first occurrence:

```markdown
[[?????]]?consistent hashing?
```

Then update `_glossary.md`:

```markdown
| English | ?? | Notes |
|---|---|---|
| consistent hashing | ????? | ????????????? |
```

### Step 6 ? Review each section immediately

After writing each chapter file, review it against the raw extracted text.

Mandatory checks:

- no large untranslated English prose remains
- no "summary-only" replacement of detailed source content
- no empty section, title-only file, or placeholder text
- no broken Markdown code fence
- heading levels are continuous and readable
- tables render as Markdown tables
- image references are valid or intentionally converted/described
- terminology matches `_glossary.md`

If a check fails, revise the chapter before moving on.

### Step 7 – Generate 00 专览导读.md

After all chapter files are complete, create `<output_dir>/00 专览导读.md`.

It must include:

1. `# 📚 [Book Title] 数字化指南`
2. `## 🗺️ 章节导航 (Roadmap)`: Group chapters into logical phases (e.g., Foundations, Observability, Subsystems) with brief Chinese descriptions.
3. `## 🛠️ 使用建议 (Best Practices)`: Tips for reading (links, footnotes, graph view).
4. `## 📖 核心章节`: Obsidian links to every chapter file.

`00 专览导读.md` must not be a substitute for missing chapter conversion. It is an entry point to fully converted chapters.

### Step 8 ? Final quality report

Create or update `<output_dir>/_quality_report.md` with:

- source PDF path and page count
- output file list
- chapter coverage table with page ranges
- translation check result
- Obsidian formatting check result
- image handling summary
- known extraction problems
- remaining limitations, if any

If limitations exist, state them as quality notes, not excuses for skipped work.

### Step 9 ? Verify output directory

Final output must contain:

- `00 专览导读.md`
- `_plan.json`
- `_glossary.md`
- `_image_map.json`
- `_quality_report.md`
- one `.md` file per plan item
- `images/` if images were extracted or preserved

Final verification checklist:

- every planned chapter file exists and is non-empty
- no chapter contains lazy forbidden phrases
- no chapter is mostly English unless the source is already Chinese or content is code/API-heavy
- no broken `![](...)` links
- every Mermaid block is syntactically plausible
- every code block is closed
- `??.md` links to every chapter using `[[filename without .md]]`

## Quality rules

- **Fidelity**: preserve all recoverable substantive content.
- **Chinese readability**: translated prose should read like a Chinese technical
  book, not literal machine translation.
- **KISS formatting**: prefer clean Markdown over decorative complexity.
- **No hallucination**: do not invent facts, examples, APIs, or claims absent
  from the source.
- **Traceability**: page separators in raw extraction should guide coverage, but
  should not appear noisily in final prose unless useful.
- **Fail closed**: when uncertain, preserve content with a warning instead of
  deleting it.

## Example invocations

```bash
python scripts/extract_pdf_outline.py /books/????.pdf
python scripts/extract_pdf_text.py /books/????.pdf --start 1 --end 24 --output ./output/????/_work/chapter-001.txt
python scripts/extract_pdf_images.py /books/????.pdf --start 1 --end 24 --output ./output/????/images/chapter-001/
```
