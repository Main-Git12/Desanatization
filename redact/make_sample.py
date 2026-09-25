#!/usr/bin/env python3
"""Generate a synthetic public-records document to demonstrate redaction.

Everything in here is invented. Never commit a real record to this repo, and
never use a real one as a demo fixture -- a sample file is the easiest way to
leak the exact data the tool exists to protect.

The content is chosen to exercise both the detections and the guards: it
contains real-looking PII alongside a badge number and a 16-digit parcel ID
that must survive, because over-redaction is its own failure. The public is
entitled to everything that is not exempt.

Usage:
    python3 make_sample.py [output.pdf]
"""

import sys
from pathlib import Path

import pymupdf

LINES = [
    ("CITY OF EXAMPLE - PUBLIC RECORDS REQUEST #2026-0412", 13),
    ("", 11),
    ("Complainant: Janet Morrison", 11),
    ("Email: janet.morrison@example.com", 11),
    ("Phone: (614) 555-0182", 11),
    ("SSN: 412-88-3390", 11),
    ("Card on file: 4242 4242 4242 4242", 11),
    ("", 11),
    ("Narrative: Caller reported a zoning violation at 1400 Main St.", 11),
    ("Follow-up contact preferred by email at j.morrison@example.org", 11),
    ("Secondary phone 614-555-0199. Case opened 2026-04-12.", 11),
    ("", 11),
    ("-- these must NOT be redacted --", 11),
    ("Officer badge 4417. Parcel ID 0123456789012345.", 11),
    ("Ordinance 1170.05. Case year 2026. Permit 55512345.", 11),
]


def main() -> int:
    """Write the sample PDF.

    :returns: Process exit code.
    """
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("sample_record.pdf")
    doc = pymupdf.open()
    page = doc.new_page()
    y = 90
    for text, size in LINES:
        if text:
            page.insert_text((60, y), text, fontsize=size)
        y += 22
    doc.save(out)
    doc.close()
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
