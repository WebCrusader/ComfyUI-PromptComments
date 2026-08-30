# ComfyUI-PromptComments

A prompt text node for ComfyUI where you can comment lines out and the comments
never reach the encoder.

- **Prompt (comments) 💬** (`PromptComments`) — resizable multiline editor,
  outputs `STRING` with comments removed.
- **Strip Comments 💬** (`StripComments`) — the same filter as a pass-through,
  for text that arrives from another node (wildcards, LLM captioner, etc).

## Comment syntax

```
# whole line off
// whole line off
a woman walking,      # trailing note, only the note is dropped
cinematic, /* inline block */ 35mm
/* several
   lines off */
```

An unterminated `/*` comments out everything after it — handy for parking the
tail of a prompt.

Whichever marker comes first wins, and runs to its natural end. A `/*` inside a
`#` or `//` line is therefore just text and stops at that line's end, so a stray
`/*` in a note can't silently swallow the rest of the prompt.

## Shortcut

`⌘ /` on macOS, `Ctrl + /` on Windows/Linux, with the cursor in the textarea.

- No selection → toggles the current line and leaves the caret on the same
  character, nothing gets selected.
- Selection → toggles every line it touches and stays selected, so you can press
  again. If all of them are already commented, it uncomments instead.
- Indentation is preserved and native undo (`⌘Z`) still works.

Comments render in red. The small counter in the bottom-right shows
`live lines / total lines`.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/WebCrusader/ComfyUI-PromptComments
```

Portable Windows build:

```
ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-PromptComments\
```

macOS / Linux:

```
ComfyUI/custom_nodes/ComfyUI-PromptComments/
```

Keep the layout as-is:

```
ComfyUI-PromptComments/
├── __init__.py
└── web/
    └── prompt_comments.js
```

Restart ComfyUI, then hard-refresh the browser (`Ctrl+Shift+R` / `⌘⇧R`) so the
old frontend bundle isn't cached.

## Blank lines

Commenting out a block never leaves a hole behind — a line that was nothing but
a comment is removed entirely, not turned into an empty line. Blank lines you
typed yourself are treated as intentional separators and survive, but runs of
them collapse to one. Leading and trailing blanks are trimmed.

`Strip Comments 💬` exposes this as `blank_lines`:

| mode | behaviour |
| --- | --- |
| `collapse` | default — keep your gaps, max one in a row |
| `keep` | leave blank lines exactly as typed |
| `remove` | no blank lines in the output at all |

For `Prompt (comments) 💬` the default lives in the `BLANK_LINES` constant at
the top of `__init__.py`. Anything outside these three raises `ValueError`
rather than silently falling back.

## Tests

```
python -m pytest          # or: python test_strip_comments.py
```

The last test runs the same inputs through the Python filter and through
`scan()` in the frontend and asserts they agree, so the two halves cannot
drift apart unnoticed. It is skipped if `node` is not installed.

## Notes

- No dependencies, no changes to core files.
- The frontend extension decorates ComfyUI's own multiline widget rather than
  replacing it, so there is exactly one textarea, and serialization, resizing,
  undo and the API path all stay core behaviour.
- The `#` and `//` markers are stripped anywhere on a line, so a literal `#` or a
  URL in a prompt will be cut. If you need one, escape the intent by editing
  `_LINE` in `__init__.py`.
- The filter also tidies the leftovers: doubled commas, `space ,`, runs of
  spaces, a trailing comma, and a comma orphaned at the start of a line because
  the line above it was commented out. Turn that off by passing `tidy=False`
  (`StripComments` exposes it as a toggle).
- Because comment removal happens in Python, it works the same whether you run
  the graph from the UI or via the API.
- The editor and the filter run the same scan: `scan()` in
  `web/prompt_comments.js` and `_mask()` in `__init__.py` are line-for-line
  equivalents, so what is painted red is exactly what gets removed, and the
  `live/total` counter agrees with both. If you change the comment syntax,
  change both.
