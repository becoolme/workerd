#!/usr/bin/env python3
"""Resolve merge conflicts that only add `#include` lines, for the weekly upstream sync.

Upstream and our patches regularly add an include at the same anchor, so git reports a content
conflict even though both lines belong. Accept both (in each side's order, de-duplicated).

Fail closed: a hunk that contains anything besides added `#include` lines is left untouched and
the script exits non-zero, so the sync workflow still opens a conflict PR for a real conflict.
"""

import re
import sys
from pathlib import Path

HUNK = re.compile(r"<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n", re.S | re.M)


def resolve(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        ours, theirs = match.group(1), match.group(2)
        lines = [line for line in (ours + theirs).splitlines() if line.strip()]
        if not lines or any(not line.lstrip().startswith("#include") for line in lines):
            raise ValueError
        unique = list(dict.fromkeys(lines))
        return "\n".join(unique) + "\n"

    return HUNK.sub(replace, text)


def main(paths: list[str]) -> int:
    status = 0
    for arg in paths:
        path = Path(arg)
        text = path.read_text()
        if "<<<<<<<" not in text:
            continue
        try:
            path.write_text(resolve(text))
        except ValueError:
            print(f"{path}: conflict is not include-only; leaving it for the sync PR", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
