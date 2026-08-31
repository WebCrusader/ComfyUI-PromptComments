"""Tests for strip_comments, and for its agreement with the frontend.

Run with `python -m pytest`, or plain `python test_strip_comments.py`.

The cross-check at the bottom is the important one: the editor paints comments
red using scan() in web/prompt_comments.js, and this module removes them using
_mask(). If those two ever drift apart, the editor lies about what reaches the
encoder - which is exactly the bug this file exists to catch. It is skipped
when node is not installed.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nodes import strip_comments  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.join(HERE, "web", "prompt_comments.js")
BEGIN = "/* pcm:scanner:begin */"
END = "/* pcm:scanner:end */"

# Inputs both implementations must agree on.
CORPUS = [
    "a woman, # note with /* star\ncinematic, 35mm",
    "a woman, cinematic\n/* parked\ntail\nmore",
    "red hair,\n# blue eyes\n, tall",
    "cinematic, /* inline block */ 35mm",
    "a /* x\ny */ b",
    "a\n/* x\ny */\nb",
    "# a\n// b",
    "a,\n# b\nc",
    "a woman walking,      # trailing note\ncinematic, /* inline */ 35mm",
    "  indented, # c\n\tvalue",
    "a\n\n\nb",
    "no comments at all, cinematic, 35mm",
    "trailing hash #",
    "// leading slashes\nkept",
    "/* unterminated only",
    "",
    "#",
    "a /* b # c */ d",
    # The boundary rule: markers glued to a word are prompt text.
    "album cover, C# minor",
    "trending #art, #8k, cinematic",
    "see https://example.com/pic, cinematic",
    "a,# glued marker is text\nb",
    "path/*not a block*/here",
    "C#\n# but this one is a comment",
    "#tag at the start of a line",
    "//no-space slashes are text",
    "ratio 16//9, sharp",
    # Line breaks Python's splitlines() would split on and JS would not.
    "a\x0bb, c",
    "a\x0cb, c",
    "a b, c",
    "a, b\r\nc, d",
    "a, b # note\r\nc, d",
    "nbsp\xa0separated, fine",
    # A marker right after a block comment ends is glued, so it is text.
    "/* x */#glued",
    "/* x */ # spaced",
]


class TestCommentRemoval(unittest.TestCase):
    def test_line_comments(self):
        self.assertEqual(strip_comments("a\n# gone\nb"), "a\nb")
        self.assertEqual(strip_comments("a\n// gone\nb"), "a\nb")

    def test_trailing_comment_keeps_the_line(self):
        self.assertEqual(strip_comments("a woman # note"), "a woman")

    def test_inline_block(self):
        self.assertEqual(
            strip_comments("cinematic, /* inline */ 35mm"), "cinematic, 35mm"
        )

    def test_unterminated_block_parks_the_tail(self):
        self.assertEqual(strip_comments("keep me\n/* parked\ntail"), "keep me")

    def test_slash_star_inside_a_line_comment_is_inert(self):
        """The regression that made the editor lie: a stray /* in a # note used
        to open a block and silently eat every line below it."""
        self.assertEqual(
            strip_comments("a woman, # note with /* star\ncinematic, 35mm"),
            "a woman,\ncinematic, 35mm",
        )

    def test_comment_only_line_leaves_no_hole(self):
        self.assertEqual(strip_comments("a\n# gone\nb"), "a\nb")

    def test_typed_blank_line_survives(self):
        self.assertEqual(strip_comments("a\n\nb"), "a\n\nb")

    def test_blank_runs_collapse(self):
        self.assertEqual(strip_comments("a\n\n\n\nb"), "a\n\nb")

    def test_blank_lines_keep(self):
        self.assertEqual(strip_comments("a\n\n\nb", blank_lines="keep"), "a\n\n\nb")

    def test_blank_lines_remove(self):
        self.assertEqual(strip_comments("a\n\n\nb", blank_lines="remove"), "a\nb")

    def test_leading_and_trailing_blanks_go_in_every_mode(self):
        for mode in ("collapse", "keep", "remove"):
            with self.subTest(mode=mode):
                self.assertEqual(
                    strip_comments("\n\na\n\nb\n\n", blank_lines=mode).strip("\n"),
                    strip_comments("\n\na\n\nb\n\n", blank_lines=mode),
                )

    def test_bad_blank_lines_mode_raises(self):
        with self.assertRaises(ValueError):
            strip_comments("a", blank_lines="nope")

    def test_non_string_input_raises(self):
        with self.assertRaises(TypeError):
            strip_comments(["a # b"])
        self.assertEqual(strip_comments(None), "")


class TestMarkerBoundaries(unittest.TestCase):
    """A marker has to be a word of its own. Prompts are full of `#` and `//`
    that mean nothing of the sort."""

    def test_hash_glued_to_a_word_is_text(self):
        self.assertEqual(strip_comments("album cover, C# minor"),
                         "album cover, C# minor")
        self.assertEqual(strip_comments("trending #art, #8k"), "trending #art, #8k")

    def test_url_survives(self):
        self.assertEqual(
            strip_comments("see https://example.com/pic, cinematic"),
            "see https://example.com/pic, cinematic",
        )

    def test_marker_needs_whitespace_before_it(self):
        self.assertEqual(strip_comments("a,# not a comment"), "a,# not a comment")

    def test_marker_needs_whitespace_after_it(self):
        self.assertEqual(strip_comments("#tag line"), "#tag line")
        self.assertEqual(strip_comments("//slashes"), "//slashes")

    def test_bare_marker_at_end_of_text_still_counts(self):
        self.assertEqual(strip_comments("trailing hash #"), "trailing hash")

    def test_block_marker_needs_whitespace_before_it(self):
        self.assertEqual(strip_comments("path/*not a block*/here"),
                         "path/*not a block*/here")

    def test_block_marker_does_not_need_whitespace_after_it(self):
        self.assertEqual(strip_comments("keep\n/*parked\ntail"), "keep")

    def test_real_comments_still_go(self):
        self.assertEqual(strip_comments("C# minor\n# but this goes"), "C# minor")
        self.assertEqual(strip_comments("a woman, // note\nb"), "a woman,\nb")


class TestTidy(unittest.TestCase):
    def test_orphaned_comma_is_dropped(self):
        self.assertEqual(strip_comments("red hair,\n# blue eyes\n, tall"),
                         "red hair,\ntall")

    def test_orphaned_comma_dropped_even_without_a_comma_above(self):
        self.assertEqual(strip_comments("a\n# b\n, c"), "a\nc")

    def test_orphaned_comma_not_joined_across_a_blank_line(self):
        for mode in ("collapse", "keep", "remove"):
            with self.subTest(mode=mode):
                self.assertEqual(
                    strip_comments("red hair,\n\n, tall", blank_lines=mode)
                    .replace("\n\n", "\n"),
                    "red hair,\n, tall",
                )

    def test_blank_line_beats_a_removed_comment_line(self):
        self.assertEqual(strip_comments("a,\n\n# b\n, c"), "a,\n\n, c")

    def test_tidy_off_leaves_whitespace_alone(self):
        self.assertEqual(strip_comments("a  ,  b ,", tidy=False), "a  ,  b ,")

    def test_tidy_collapses_and_trims(self):
        self.assertEqual(strip_comments("a  ,  b ,"), "a, b")

    def test_empty_and_comment_only_input(self):
        self.assertEqual(strip_comments(""), "")
        self.assertEqual(strip_comments("# a\n// b"), "")

    def test_literal_nul_cannot_fake_a_comment(self):
        self.assertEqual(strip_comments("a\x00b, c"), "ab, c")
        self.assertEqual(strip_comments("\x00\n# gone\nb"), "b")


class TestFrontendAgreement(unittest.TestCase):
    """The editor must not paint anything red that Python keeps, or keep
    anything black that Python drops."""

    def _scanner_source(self):
        with open(JS, encoding="utf-8") as fh:
            src = fh.read()
        start, end = src.find(BEGIN), src.find(END)
        self.assertNotEqual(
            start, -1, f"{BEGIN} is missing from {JS} - the scanner cannot be "
            "extracted, so Python and the editor are no longer cross-checked"
        )
        self.assertNotEqual(end, -1, f"{END} is missing from {JS}")
        self.assertLess(start, end, f"{BEGIN} appears after {END} in {JS}")
        return src[start + len(BEGIN):end]

    def _js_live_lines(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        harness = self._scanner_source() + """
const corpus = JSON.parse(process.env.CORPUS);
console.log(JSON.stringify(corpus.map((v) => {
  let masked = "";
  for (const p of scan(v)) {
    if (!p.comment) { masked += p.text; continue; }
    masked += MARK + `\\n${MARK}`.repeat((p.text.match(/\\n/g) || []).length);
  }
  return {
    live: masked.split("\\n").map((l) => l.split(MARK).join("").trim()).filter(Boolean),
    count: liveCount(v),
  };
})));
"""
        out = subprocess.run(
            [node, "--input-type=module", "-e", harness],
            capture_output=True, text=True,
            env={**os.environ, "CORPUS": json.dumps(CORPUS)},
        )
        if out.returncode != 0:
            self.fail(f"the extracted scanner would not run:\n{out.stderr}")
        return json.loads(out.stdout)

    def test_scanners_agree(self):
        for src, js in zip(CORPUS, self._js_live_lines()):
            with self.subTest(src=src):
                py = [
                    line.strip()
                    for line in strip_comments(
                        src, tidy=False, blank_lines="remove"
                    ).split("\n")
                    if line.strip()
                ]
                self.assertEqual(py, js["live"], "surviving lines differ")
                self.assertEqual(
                    len(py),
                    int(js["count"].split("/")[0]),
                    "the live/total counter disagrees with the filter",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
