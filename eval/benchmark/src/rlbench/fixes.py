"""Decide which commits are bug fixes, and which paths count as product source.

Stricter than the retrieval heuristic in packages/context-engine: benchmark cases need fixes
that are clearly linked to an issue or pull request, so a reference is required by default.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_FIX_WORD = re.compile(
    r"\b(fix(e[sd]|ing)?|bug(fix)?|regression|crash(es|ed|ing)?|leak(s|ed|ing)?"
    r"|incorrect(ly)?|wrong(ly)?|broken|hotfix)\b",
    re.I,
)
# Conventional-commit types that are never behavior fixes.
_NON_FIX_TYPE = re.compile(
    r"^(docs?|chore|ci|style|build|test|tests|refactor|perf|deps)(\(.+\))?!?:", re.I
)
_NOT_A_BUG = re.compile(
    r"\b(typo|typos|lint|linting|eslint|prettier|format(ting)?|readme|docs?|documentation"
    r"|comment|comments|changelog|ci|workflow|deps?|dependenc(y|ies)|bump|release|version"
    r"|types? definitions?|typings?|flaky|test only)\b",
    re.I,
)
_REVERT = re.compile(r"^revert\b|^reapply\b|this reverts commit", re.I | re.M)
_REF = re.compile(r"(?<![\w/])#(\d+)\b")
_CLOSES = re.compile(r"\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)", re.I)
_PR_SUFFIX = re.compile(r"\(#(\d+)\)\s*$")


@dataclass(frozen=True)
class FixSignal:
    is_fix: bool
    reason: str  # why it was accepted or rejected
    references: tuple[int, ...]  # every #N in the message
    closes: tuple[int, ...]  # #N after fixes/closes/resolves
    pr_number: int | None  # trailing "(#N)" of a squash-merged pull request


def pr_number_of(subject: str) -> int | None:
    match = _PR_SUFFIX.search(subject)
    return int(match.group(1)) if match else None


def classify(subject: str, body: str, require_reference: bool = True) -> FixSignal:
    message = f"{subject}\n{body}"
    refs = tuple(dict.fromkeys(int(n) for n in _REF.findall(message)))
    closes = tuple(dict.fromkeys(int(m.group(3)) for m in _CLOSES.finditer(message)))
    pr = pr_number_of(subject)

    def result(is_fix: bool, reason: str) -> FixSignal:
        return FixSignal(is_fix, reason, refs, closes, pr)

    if _REVERT.search(message):
        return result(False, "revert")
    if _NON_FIX_TYPE.match(subject):
        return result(False, "non_fix_type")
    explicit = re.match(r"^(fix|bugfix|hotfix)(\(.+\))?!?:", subject, re.I) is not None
    if not explicit and not _FIX_WORD.search(subject):
        return result(False, "no_fix_keyword")
    if _NOT_A_BUG.search(subject):
        return result(False, "not_behavior")
    if require_reference and not refs:
        return result(False, "no_reference")
    return result(True, "explicit_fix_type" if explicit else "fix_keyword")


SOURCE_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
_NON_PRODUCT_DIR = re.compile(
    r"(^|/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|examples?|docs?|website"
    r"|benchmarks?|bench|scripts?|tools?|node_modules|dist|build|out|coverage|vendor"
    r"|\.github|types?-tests?|test-d)/",
    re.I,
)
_TEST_FILE = re.compile(r"\.(test|spec|test-d|bench)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\.js$", re.I)


def is_product_source(path: str) -> bool:
    """TS/JS code that ships: not tests, fixtures, docs, build output or type declarations."""
    if not path.lower().endswith(SOURCE_EXTENSIONS):
        return False
    return not (_NON_PRODUCT_DIR.search(path) or _TEST_FILE.search(path))


_COMMENT_ONLY = re.compile(r"^\s*(//|/\*|\*|\*/|#!|<!--)")
_PUNCTUATION_ONLY = re.compile(r"^[\s{}()\[\];,]*$")


def is_trivial_line(content: str) -> bool:
    """Blank lines, comments and bare punctuation carry no defect and are never blamed."""
    return bool(_PUNCTUATION_ONLY.match(content) or _COMMENT_ONLY.match(content))
