#!/usr/bin/env python3
"""
PDF/Text extractor: Python sidecar for MICT-RAG-002 S02.

Usage:
    python sidecar/extract.py <file_path>

Outputs JSON to stdout:
{
  "source": "<basename>",
  "page_count": 3,
  "pages": [
    {"page": 1, "text": "...", "char_start": 0, "char_end": 1234},
    ...
  ]
}

Supports PDF and plain-text/markdown files. Plain text is treated as a
single page.
"""
import sys
import json
import os

try:
    from pypdf import PdfReader
except ImportError:
    print(json.dumps({"error": "pypdf not installed. Run: pip install pypdf"}), file=sys.stderr)
    sys.exit(1)


def extract_pdf(file_path: str) -> dict:
    reader = PdfReader(file_path)
    pages = []
    global_offset = 0

    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        char_start = global_offset
        char_end = global_offset + len(text)
        pages.append({
            "page": i,
            "text": text,
            "char_start": char_start,
            "char_end": char_end,
        })
        global_offset = char_end + 1  # +1 for page separator

    return {
        "source": os.path.basename(file_path),
        "page_count": len(pages),
        "pages": pages,
    }


def extract_plaintext(file_path: str) -> dict:
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    return {
        "source": os.path.basename(file_path),
        "page_count": 1,
        "pages": [
            {"page": 1, "text": text, "char_start": 0, "char_end": len(text)},
        ],
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: extract.py <file_path>"}), file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}), file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(file_path)[1].lower()

    try:
        if ext == ".pdf":
            result = extract_pdf(file_path)
        else:
            result = extract_plaintext(file_path)

        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
