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

from __init__ import strip_comments  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.join(HERE, "web", "prompt_comments.js")

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

    def test_bad_blank_lines_mode_raises(self):
        with self.assertRaises(ValueError):
            strip_comments("a", blank_lines="nope")

    def test_orphaned_comma_is_dropped(self):
        self.assertEqual(strip_comments("red hair,\n# blue eyes\n, tall"),
                         "red hair,\ntall")

    def test_orphaned_comma_not_joined_across_a_blank_line(self):
        self.assertEqual(strip_comments("red hair,\n\n, tall"),
                         "red hair,\n\n, tall")

    def test_tidy_off_leaves_whitespace_alone(self):
        self.assertEqual(strip_comments("a  ,  b ,", tidy=False), "a  ,  b ,")

    def test_tidy_collapses_and_trims(self):
        self.assertEqual(strip_comments("a  ,  b ,"), "a, b")

    def test_empty_and_comment_only_input(self):
        self.assertEqual(strip_comments(""), "")
        self.assertEqual(strip_comments("# a\n// b"), "")


class TestFrontendAgreement(unittest.TestCase):
    """The editor must not paint anything red that Python keeps, or keep
    anything black that Python drops."""

    def _js_live_lines(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        with open(JS, encoding="utf-8") as fh:
            src = fh.read()
        # Take just the scanner, not the ComfyUI-facing half.
        body = src[src.index("const esc ="):src.index("function activeLines")]
        harness = body + """
const corpus = JSON.parse(process.env.CORPUS);
console.log(JSON.stringify(corpus.map((v) => {
  let masked = "";
  for (const p of scan(v)) {
    if (!p.comment) { masked += p.text; continue; }
    masked += "\\u0000" + "\\n\\u0000".repeat((p.text.match(/\\n/g) || []).length);
  }
  return {
    live: masked.split("\\n").map((l) => l.replace(/\\u0000/g, "").trim()).filter(Boolean),
    count: liveCount(v),
  };
})));
"""
        out = subprocess.run(
            [node, "--input-type=module", "-e", harness],
            capture_output=True, text=True, check=True,
            env={**os.environ, "CORPUS": json.dumps(CORPUS)},
        )
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
