"""
prompt_comments - prompt text nodes for ComfyUI with commented-out lines.

- resizable textarea
- comments rendered in red
- Cmd+/ (macOS) or Ctrl+/ (Windows/Linux) toggles comments on the selection
- output STRING has all comments stripped

Comment syntax:
    # line comment
    // line comment
    /* block comment, can span lines */
"""

import re
from typing import Optional

_MULTI_COMMA = re.compile(r",(?:[ \t]*,)+")
_SPACE_BEFORE_COMMA = re.compile(r"[ \t]+,")

MARK = "\x00"  # stands in for removed comment text

# What to do with empty lines in the output:
#   "collapse" - keep blank lines you typed, but never more than one in a row
#   "keep"     - keep them exactly as typed
#   "remove"   - no blank lines at all
BLANK_LINES = "collapse"

BLANK_MODES = ("collapse", "keep", "remove")


def _mask(src: str) -> str:
    """Blank out every comment, left to right, first marker wins.

    A `#` or `//` runs to the end of its line; a `/*` runs to the matching
    `*/` or, unterminated, to the end of the text. Because the scan is a
    single left-to-right pass, a `/*` sitting inside a `#` comment is just
    text and cannot swallow the lines below it.

    web/prompt_comments.js scan() mirrors this exactly, so what the editor
    paints red is what this function removes. Change one, change both.

    Comment spans collapse to MARK rather than disappearing, so a line that
    held nothing but a comment stays distinguishable from a line the user
    deliberately left blank. Line count is preserved.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        if src.startswith("/*", i):
            end = src.find("*/", i + 2)
            stop = n if end == -1 else end + 2
            out.append(MARK + (("\n" + MARK) * src.count("\n", i, stop)))
            i = stop
        elif src[i] == "#" or src.startswith("//", i):
            end = src.find("\n", i)
            out.append(MARK)
            i = n if end == -1 else end
        else:
            out.append(src[i])
            i += 1
    return "".join(out)


def strip_comments(
    text: str, tidy: bool = True, blank_lines: Optional[str] = None
) -> str:
    if not text:
        return ""

    blank_lines = blank_lines or BLANK_LINES
    if blank_lines not in BLANK_MODES:
        raise ValueError(
            f"blank_lines must be one of {BLANK_MODES!r}, got {blank_lines!r}"
        )

    kept = []
    for raw in _mask(text).splitlines():
        # Blank in the source, before any stripping. A line that held only a
        # comment still carries its MARK here, so it never counts as blank.
        was_blank = raw.strip() == ""
        body = raw.replace(MARK, "").rstrip()

        if tidy and body.strip():
            body = _SPACE_BEFORE_COMMA.sub(",", body)
            body = _MULTI_COMMA.sub(",", body)
            body = re.sub(r"[ \t]{2,}", " ", body).rstrip()

        if body.strip():
            kept.append(body)
        elif was_blank and blank_lines != "remove":
            kept.append("")  # you typed this gap, it stays
        # otherwise the line was comment-only -> gone, no empty line left behind

    if tidy:
        # Removing a line can leave "a," directly above ", b", which the encoder
        # reads as an empty term. Drop the orphaned comma but keep the line
        # break. A blank line between the two counts as a deliberate separator,
        # so the join is not made across one.
        joined = []
        for line in kept:
            if (
                joined
                and joined[-1].rstrip().endswith(",")
                and line.lstrip().startswith(",")
            ):
                line = line.lstrip()[1:].lstrip()
                if not line:
                    continue
            joined.append(line)
        kept = joined

    if blank_lines == "collapse":
        collapsed = []
        for line in kept:
            if line == "" and (not collapsed or collapsed[-1] == ""):
                continue
            collapsed.append(line)
        kept = collapsed

    while kept and kept[0] == "":
        kept.pop(0)
    while kept and kept[-1] == "":
        kept.pop()

    out = "\n".join(kept)
    if tidy:
        out = out.strip().strip(",").strip()
    return out


class PromptComments:
    """Prompt text with comments"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "utils/text"
    DESCRIPTION = (
        "Multiline prompt editor. Lines starting with # or //, trailing "
        "# / // comments and /* ... */ blocks are shown in red and removed "
        "from the output. Cmd+/ or Ctrl+/ toggles comments on the selection."
    )

    def run(self, text):
        return (strip_comments(text),)


class StripComments:
    """Same filter as a pass-through node, for text coming from elsewhere."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "tidy": ("BOOLEAN", {"default": True}),
                "blank_lines": (list(BLANK_MODES),),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "utils/text"

    def run(self, text, tidy, blank_lines):
        return (strip_comments(text, tidy, blank_lines),)


NODE_CLASS_MAPPINGS = {
    "PromptComments": PromptComments,
    "StripComments": StripComments,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptComments": "Prompt (comments) 💬",
    "StripComments": "Strip Comments 💬",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
