"""prompt_comments - prompt text nodes for ComfyUI with commented-out lines.

- resizable textarea
- comments rendered in red
- Cmd+/ (macOS) or Ctrl+/ (Windows/Linux) toggles comments on the selection
- output STRING has all comments stripped

Comment syntax:
    # line comment
    // line comment
    /* block comment, can span lines */

A marker only opens a comment when it starts a line or follows whitespace, and
`#` / `//` must also be followed by whitespace or the end of the line. So
`C# minor`, `#hashtag` and `https://example.com/x` are ordinary prompt text,
while `# note`, `a woman, // note` and `/* block */` are comments.
"""

import re
from typing import Optional

_MULTI_COMMA = re.compile(r",(?:[ \t]*,)+")
_SPACE_BEFORE_COMMA = re.compile(r"[ \t]+,")
_SPACE_RUN = re.compile(r"[ \t]{2,}")

MARK = "\x00"  # stands in for removed comment text

# The whitespace that can sit either side of a comment marker. Deliberately an
# explicit set rather than str.isspace(): scan() in web/prompt_comments.js uses
# the same six characters, and Python's idea of whitespace is wider than
# JavaScript's. Change one, change both.
WS = " \t\r\n\f\v"

# What to do with empty lines in the output:
#   "collapse" - keep blank lines you typed, but never more than one in a row
#   "keep"     - keep them exactly as typed
#   "remove"   - no blank lines at all
# Leading and trailing blank lines are trimmed in every mode.
BLANK_LINES = "collapse"

BLANK_MODES = ("collapse", "keep", "remove")


def _opens(src: str, i: int) -> bool:
    """A marker at `i` only counts if it starts the text or follows whitespace.

    This is what keeps `C#`, `#hashtag` and `https://...` out of the scanner:
    the marker has to be a word of its own, not the tail of one.
    """
    return i == 0 or src[i - 1] in WS


def _closes(src: str, i: int) -> bool:
    """...and `#` / `//` also need whitespace or the end of the text after them.

    `# note` is a comment, `#note` is a hashtag. `/*` is exempt - it carries its
    own terminator, so `/*parked` stays usable.
    """
    return i >= len(src) or src[i] in WS


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
        if src.startswith("/*", i) and _opens(src, i):
            end = src.find("*/", i + 2)
            stop = n if end == -1 else end + 2
            out.append(MARK + (("\n" + MARK) * src.count("\n", i, stop)))
            i = stop
        elif _opens(src, i) and (
            (src[i] == "#" and _closes(src, i + 1))
            or (src.startswith("//", i) and _closes(src, i + 2))
        ):
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
    if text is None:
        return ""
    if not isinstance(text, str):
        raise TypeError(
            f"strip_comments() expects a string, got {type(text).__name__}"
        )
    if not text:
        return ""

    blank_lines = blank_lines or BLANK_LINES
    if blank_lines not in BLANK_MODES:
        raise ValueError(
            f"blank_lines must be one of {BLANK_MODES!r}, got {blank_lines!r}"
        )

    # A literal NUL in the prompt would be indistinguishable from the marker
    # _mask() leaves behind, and would make a commented-out line look typed.
    text = text.replace(MARK, "")

    kept = []  # surviving lines, "" for a blank line the user typed
    seps = []  # for each kept line, what sat between it and the one above
    gap = "none"  # "none" | "comment" (a comment-only line went) | "blank"

    # split("\n"), not splitlines(): splitlines() also breaks on \v, \f, \x85,
    #   and friends, which scan() in the frontend does not, and the two
    # halves have to agree on where the lines are.
    for raw in _mask(text).split("\n"):
        # Blank in the source, before any stripping. A line that held only a
        # comment still carries its MARK here, so it never counts as blank.
        was_blank = raw.strip() == ""
        body = raw.replace(MARK, "").rstrip()

        if tidy and body.strip():
            body = _SPACE_BEFORE_COMMA.sub(",", body)
            body = _MULTI_COMMA.sub(",", body)
            body = _SPACE_RUN.sub(" ", body).rstrip()

        if body.strip():
            kept.append(body)
            seps.append(gap)
            gap = "none"
        elif was_blank:
            # You typed this gap. In "remove" mode it does not survive into the
            # output, but it still counts as a deliberate separator below.
            if blank_lines != "remove":
                kept.append("")
                seps.append(gap)
            gap = "blank"
        elif gap != "blank":
            gap = "comment"  # comment-only line -> gone, no empty line behind

    if tidy:
        # Removing a line can leave "a," directly above ", b", which the encoder
        # reads as an empty term. Drop the orphaned comma but keep the line
        # break. A blank line between the two is a deliberate separator in every
        # mode, so the join is never made across one.
        joined = []
        for line, sep in zip(kept, seps):
            if (
                joined
                and sep != "blank"
                and line.lstrip().startswith(",")
                and (sep == "comment" or joined[-1].rstrip().endswith(","))
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
        "from the output. A marker must follow whitespace, and # / // must be "
        "followed by a space, so C# and #hashtag survive. Cmd+/ or Ctrl+/ "
        "toggles comments on the selection."
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
