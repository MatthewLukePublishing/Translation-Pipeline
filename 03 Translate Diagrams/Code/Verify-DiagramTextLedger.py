"""Cross-check the ledger against an independent pypdf text extraction."""

import json
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium


def norm(value: str) -> str:
    return re.sub(r"\s+", "", value)


ledger_path = Path(sys.argv[1])
ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
source_root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(ledger.get("sourceRoot", ""))
checked = 0
missing = []
for diagram in ledger["diagrams"]:
    if not diagram["textUnitCount"]:
        continue
    target = source_root / diagram["relativePath"]
    document = pdfium.PdfDocument(str(target))
    page_text = norm(
        "".join(document[index].get_textpage().get_text_range() for index in range(len(document)))
    )
    checked += 1
    for unit in diagram["textUnits"]:
        if norm(unit["plain"]) and norm(unit["plain"]) not in page_text:
            missing.append((diagram["file"], unit["id"], unit["plain"]))

print(f"diagrams checked: {checked}")
print(f"units missing from independent extraction: {len(missing)}")
for row in missing[:40]:
    print("  ", row[0], row[1], repr(row[2]))
