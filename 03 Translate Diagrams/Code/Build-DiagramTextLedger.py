"""Build an offline text ledger for a folder of Illustrator diagrams.

Each .ai file carries a PDF-compatible stream that Illustrator writes alongside
its editable artwork. Reading that stream gives the same text lines Illustrator
draws, in drawing order, with the font used for each line. No Adobe application
is launched and no document is modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ContentStream, IndirectObject

LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
}
SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def normalize(text: str) -> str:
    for source, replacement in LIGATURES.items():
        text = text.replace(source, replacement)
    return text


def base_font(name: str) -> str:
    return SUBSET_PREFIX.sub("", (name or "").lstrip("/"))


def font_class(name: str) -> str:
    lowered = base_font(name).lower()
    if (
        "open sans" in lowered
        or "opensans" in lowered
        or "chakrapetch" in lowered
        or "league gothic" in lowered
        or "leaguegothic" in lowered
    ):
        return "prose"
    if "source code" in lowered or "sourcecodepro" in lowered:
        return "sourceCode"
    return "unknown"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_to_unicode(stream) -> dict[int, str]:
    """Read a PDF ToUnicode CMap into a code-to-text table."""
    try:
        data = stream.get_data().decode("latin1")
    except Exception:  # noqa: BLE001
        return {}

    def decode_utf16(value: str) -> str:
        raw = bytes.fromhex(re.sub(r"[^0-9A-Fa-f]", "", value))
        if len(raw) < 2:
            return ""
        return raw.decode("utf-16-be", errors="replace")

    table: dict[int, str] = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", data, re.S):
        for source, target in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            table[int(source, 16)] = decode_utf16(target)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", data, re.S):
        for start, end, target in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block
        ):
            first, last = int(start, 16), int(end, 16)
            decoded = decode_utf16(target)
            if len(decoded) != 1:
                continue
            for offset, code in enumerate(range(first, last + 1)):
                table[code] = chr(ord(decoded) + offset)
    return table


def read_font(resources, name: str) -> dict:
    fonts = resources.get("/Font") if resources else None
    font = fonts.get(name) if fonts else None
    if font is None:
        return {"baseFont": "", "bytesPerCode": 1, "toUnicode": {}}
    if isinstance(font, IndirectObject):
        font = font.get_object()
    subtype = str(font.get("/Subtype", ""))
    base = str(font.get("/BaseFont", ""))
    encoding = font.get("/Encoding")
    to_unicode = font.get("/ToUnicode")
    table: dict[int, str] = {}
    if to_unicode is not None:
        if isinstance(to_unicode, IndirectObject):
            to_unicode = to_unicode.get_object()
        table = parse_to_unicode(to_unicode)
    two_byte = subtype == "/Type0" or "/Identity" in str(encoding)
    return {"baseFont": base, "bytesPerCode": 2 if two_byte else 1, "toUnicode": table}


def decode_bytes(data: bytes, font: dict) -> str:
    if font["bytesPerCode"] == 2:
        table = font["toUnicode"]
        if not table:
            return ""
        out = []
        for index in range(0, len(data) - 1, 2):
            code = (data[index] << 8) | data[index + 1]
            out.append(table.get(code, ""))
        return "".join(out)
    try:
        return data.decode("cp1252")
    except UnicodeDecodeError:
        return data.decode("latin1")


def raw_bytes(value) -> bytes | None:
    """Recover the bytes a PDF string operator carried."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        original = getattr(value, "original_bytes", None)
        if original is not None:
            return bytes(original)
        try:
            return value.encode("latin1")
        except UnicodeEncodeError:
            return None
    return None


def operand_text(operands, font: dict) -> str:
    if not operands:
        return ""
    operand = operands[0]
    direct = raw_bytes(operand)
    if direct is not None:
        return decode_bytes(direct, font)
    if isinstance(operand, list):
        parts = []
        for item in operand:
            data = raw_bytes(item)
            if data is not None:
                parts.append(decode_bytes(data, font))
        return "".join(parts)
    return ""


def extract_units(path: Path) -> list[dict]:
    reader = PdfReader(str(path))
    units: list[dict] = []
    for page in reader.pages:
        resolved = page.get("/Resources")
        if isinstance(resolved, IndirectObject):
            resolved = resolved.get_object()
        walk_content(reader, page.get_contents(), resolved, units, {})
    for position, unit in enumerate(units, start=1):
        unit["id"] = f"{path.stem}#{position:04d}"
    return units


def resolve(value):
    return value.get_object() if isinstance(value, IndirectObject) else value


def walk_content(reader, streams, resources, units: list[dict], font_cache: dict, depth: int = 0) -> None:
    """Walk page or form content in drawing order, tracking the active resources."""
    resource = None
    current = resources
    try:
        operations = (
            streams.operations
            if isinstance(streams, ContentStream)
            else ContentStream(streams, reader).operations
        )
    except Exception:  # noqa: BLE001
        return
    for operands, operator in operations:
        if operator == b"Tf" and len(operands) >= 2:
            name = operands[0]
            resource = name.decode("latin1") if isinstance(name, bytes) else str(name)
            key = id(current)
            cache = font_cache.setdefault(key, {})
            if resource not in cache:
                cache[resource] = read_font(current, resource)
            continue
        if operator == b"Do" and operands and depth < 8:
            name = operands[0]
            name = name.decode("latin1") if isinstance(name, bytes) else str(name)
            xobjects = resolve(current.get("/XObject")) if current else None
            target = resolve(xobjects.get(name)) if xobjects else None
            if target is not None and str(target.get("/Subtype", "")) == "/Form":
                nested = resolve(target.get("/Resources")) or current
                walk_content(reader, target, nested, units, font_cache, depth + 1)
            continue
        if operator not in (b"Tj", b"TJ", b"'", b'"'):
            continue
        if resource is None:
            continue
        font = font_cache.get(id(current), {}).get(resource)
        if font is None:
            continue
        text = normalize(operand_text(operands, font))
        if not text.strip():
            continue
        plain = " ".join(text.split())
        if not plain:
            continue
        units.append({
            "font": base_font(font["baseFont"]),
            "kind": font_class(font["baseFont"]),
            "text": text,
            "plain": plain,
        })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="Folder containing .ai diagrams")
    parser.add_argument("--book", required=True)
    parser.add_argument("--source-language", default="English")
    parser.add_argument(
        "--source-label",
        default="",
        help="Products-relative location recorded in the ledger instead of an absolute path",
    )
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve()
    files = sorted(
        (p for p in source.rglob("*.ai") if ".codex-diagram-" not in p.name),
        key=lambda p: p.name.lower(),
    )
    if not files:
        print("No .ai files found", file=sys.stderr)
        return 1

    diagrams = []
    total_units = 0
    for index, path in enumerate(files, start=1):
        units = extract_units(path)
        total_units += len(units)
        diagrams.append({
            "order": index,
            "file": path.name,
            "relativePath": path.relative_to(source).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "textUnitCount": len(units),
            "textUnits": units,
        })
        print(f"[{index}/{len(files)}] {path.name}: {len(units)} units", flush=True)

    previous = {}
    out = Path(args.out)
    if out.exists():
        try:
            for diagram in json.loads(out.read_text(encoding="utf-8")).get("diagrams", []):
                for unit in diagram.get("textUnits", []):
                    previous[(diagram["file"], unit["id"])] = (unit.get("text"), unit.get("translations") or {})
        except Exception as error:  # noqa: BLE001
            print(f"warning: could not reuse translations from {out}: {error}", file=sys.stderr)

    reused = 0
    for diagram in diagrams:
        for unit in diagram["textUnits"]:
            prior = previous.get((diagram["file"], unit["id"]))
            if prior and prior[0] == unit["text"] and prior[1]:
                unit["translations"] = prior[1]
                reused += 1

    ledger = {
        "schemaVersion": "diagram-text-ledger-2",
        "book": args.book,
        "sourceLanguage": args.source_language,
        "generatedUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceLabel": args.source_label,
        "sourceFolder": source.name,
        "extraction": {
            "method": "PDF text operators in the PDF-compatible stream of each .ai file",
            "adobeRequired": False,
            "order": "Illustrator drawing order, including text inside form XObjects",
            "kinds": {
                "prose": "Open Sans, ChakraPetch and League Gothic text; translate",
                "sourceCode": "Source Code Pro text; resolve from the acronym-symbol workbook",
                "unknown": "unrecognised font; not translated until the font is classified",
            },
            "ligatureNormalization": sorted(LIGATURES),
        },
        "terms": {
            "copyright": "(c) 2026 Matthew Luke Publishing. All rights reserved.",
            "scope": "Diagram source text and every translation derived from it.",
            "permission": (
                "This ledger is included so the owner's own translation work does not "
                "re-export diagram text. Using, copying, redistributing, or translating "
                "this content presumes permission was granted by the copyright holder."
            ),
            "licence": "Source code is MIT licensed; this content is not. See DATA-LICENCE.md.",
        },
        "diagramCount": len(diagrams),
        "textUnitCount": total_units,
        "diagrams": diagrams,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(serialize(ledger), encoding="utf-8")
    print(
        f"Wrote {out} ({out.stat().st_size} bytes, {len(diagrams)} diagrams, "
        f"{total_units} units, {reused} units kept existing translations)"
    )
    return 0


def serialize(ledger: dict) -> str:
    """Emit one text unit per line so diffs stay readable and files stay small."""
    head = {key: value for key, value in ledger.items() if key != "diagrams"}
    lines = ["{"]
    for key, value in head.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},")
    lines.append('  "diagrams": [')
    for diagram_index, diagram in enumerate(ledger["diagrams"]):
        units = diagram["textUnits"]
        meta = {key: value for key, value in diagram.items() if key != "textUnits"}
        lines.append("    {")
        for key, value in meta.items():
            lines.append(f"      {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},")
        lines.append('      "textUnits": [')
        for unit_index, unit in enumerate(units):
            body = json.dumps(unit, ensure_ascii=False, separators=(", ", ": "))
            comma = "," if unit_index < len(units) - 1 else ""
            lines.append(f"        {body}{comma}")
        lines.append("      ]")
        lines.append("    }" + ("," if diagram_index < len(ledger["diagrams"]) - 1 else ""))
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
