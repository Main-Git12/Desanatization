#!/usr/bin/env python3
"""Redact PII from a PDF, for real, and prove it.

WHY THIS EXISTS

Public-records law obliges an agency to remove personal information before it
releases a document. The usual failure is not missing a name -- it is drawing a
black rectangle on top of one. A rectangle is a drawing; the text stays in the
file underneath it, and anyone can select it, copy it, or pull it out with a
one-line script. That mistake has leaked witness names, addresses and SSNs from
agencies that believed they had redacted them.

So this tool does two things a graphics editor cannot:

  1. It applies TRUE redactions. PyMuPDF's apply_redactions() removes the
     underlying glyphs from the content stream before drawing the box. What is
     covered is also gone.

  2. It proves it. After writing the output, the file is re-opened, the text is
     extracted afresh, and every redacted string is searched for. If any
     survives, the run FAILS LOUDLY rather than handing back a document that
     looks redacted and is not.

The audit trail matters as much as the redaction: an agency has to be able to
say what it withheld and why, sometimes years later in front of a judge. Every
run writes a JSON record of each item -- page, category, position, and a salted
hash of the original value so the entry can be verified later without the log
itself becoming a second copy of the PII.

Detection is ported verbatim from sanitize.js so both paths agree exactly.

Usage:
    python3 redact_pdf.py input.pdf                 # -> input.redacted.pdf
    python3 redact_pdf.py input.pdf -o out.pdf
    python3 redact_pdf.py input.pdf --audit log.json
"""

import argparse
import hashlib
import json
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

# --- Detection patterns ------------------------------------------------------
# Ported verbatim from sanitize.js. Keep the two in lockstep: a divergence means
# the PDF path and the API path disagree about what counts as PII, which is the
# kind of silent inconsistency that gets an agency sued.

EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
# The leading (?<!\\d) stops the pattern matching a 13-digit slice inside a
# longer run -- without it a 16-digit parcel ID is redacted as a phone number.
PHONE = re.compile(r"(?<!\d)(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?){1,2}\d{3}[-.\s]?\d{4}(?!\d)")
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
CREDIT_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
SECRET = re.compile(
    r"\b(?:0x)?[0-9a-fA-F]{64}\b|\bsk-[a-zA-Z0-9]{8,}\b|\bAKIA[0-9A-Z]{16}\b"
)
BEARER = re.compile(r"\bBearer\s+[a-zA-Z0-9\-._~+/=]{8,}\b", re.IGNORECASE)


def luhn_valid(digits: str) -> bool:
    """Luhn checksum, used to cut false positives on card-shaped digit runs.

    Without this, any 16-digit case number or parcel ID gets redacted as a
    credit card -- and over-redaction is its own legal problem, since the
    public is entitled to everything that is not exempt.
    """
    total = 0
    double = False
    for char in reversed(digits):
        digit = int(char)
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0


def find_pii(text: str) -> list[tuple[str, str]]:
    """Return (category, matched_text) for every PII item found.

    Ordering mirrors sanitize.js: cards are tested before phones so a card
    number is never claimed by the phone pattern first.
    """
    found: list[tuple[str, str]] = []

    for match in EMAIL.finditer(text):
        found.append(("email", match.group()))

    for match in CREDIT_CARD.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        if 13 <= len(digits) <= 19 and luhn_valid(digits):
            found.append(("card", match.group()))

    for match in PHONE.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        # Guard against years and plain digit runs that merely look phone-shaped.
        if 7 <= len(digits) <= 15:
            found.append(("phone", match.group()))

    for match in SSN.finditer(text):
        found.append(("ssn", match.group()))

    for match in SECRET.finditer(text):
        found.append(("secret", match.group()))

    for match in BEARER.finditer(text):
        found.append(("secret", match.group()))

    return found


def redact_pdf(src: Path, dst: Path, audit_path: Path | None = None) -> dict:
    """Apply true redactions to every page and verify the result.

    :param src: Source PDF
    :param dst: Where to write the redacted PDF
    :param audit_path: Optional path for the JSON audit record
    :returns: Summary dict with per-category counts and verification status
    """
    doc = pymupdf.open(src)

    # Salt the audit hashes per run. A bare hash of an SSN is reversible by
    # brute force in milliseconds -- there are only a billion of them -- so an
    # unsalted log would quietly become a second copy of the data we removed.
    salt = secrets.token_hex(16)
    entries: list[dict] = []
    counts: dict[str, int] = {}
    redacted_values: set[str] = set()

    for page_number, page in enumerate(doc, start=1):
        text = page.get_text()
        for category, value in find_pii(text):
            # search_for locates every visual occurrence, including the same
            # value appearing more than once on the page.
            for rect in page.search_for(value):
                page.add_redact_annot(rect, fill=(0, 0, 0))
                entries.append(
                    {
                        "page": page_number,
                        "category": category,
                        "rect": [round(v, 2) for v in rect],
                        "value_sha256": hashlib.sha256(
                            (salt + value).encode()
                        ).hexdigest(),
                    }
                )
                counts[category] = counts.get(category, 0) + 1
                redacted_values.add(value)

        # This is the step that makes it real: the glyphs are removed from the
        # content stream, not merely covered.
        page.apply_redactions()

    doc.save(dst, garbage=4, deflate=True)
    doc.close()

    # --- Verification --------------------------------------------------------
    # Re-open the written file and hunt for anything we claimed to remove. A
    # tool that says "redacted" without checking is exactly the tool that leaks.
    leaked: list[str] = []
    verify = pymupdf.open(dst)
    remaining = "\n".join(page.get_text() for page in verify)
    verify.close()
    for value in redacted_values:
        if value in remaining:
            leaked.append(value)

    summary = {
        "source": str(src),
        "output": str(dst),
        "pages": len(entries and {e["page"] for e in entries} or set()) or 0,
        "total_redactions": len(entries),
        "by_category": counts,
        "verified_clean": not leaked,
        "leaked_count": len(leaked),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if audit_path:
        audit_path.write_text(
            json.dumps(
                {
                    "summary": summary,
                    "salt_note": (
                        "Values are hashed with a per-run random salt. The salt "
                        "is intentionally NOT stored: the log proves how many "
                        "items were removed and where, without being a second "
                        "copy of the data. To prove a specific value was "
                        "redacted, re-hash it with a salt retained separately "
                        "under your records-retention policy."
                    ),
                    "entries": entries,
                },
                indent=2,
            )
        )

    return summary


def main() -> int:
    """CLI entry point.

    :returns: Process exit code -- non-zero if verification found a leak.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("input", type=Path, help="PDF to redact")
    parser.add_argument("-o", "--output", type=Path, help="output PDF path")
    parser.add_argument("--audit", type=Path, help="write a JSON audit record here")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"No such file: {args.input}", file=sys.stderr)
        return 1

    output = args.output or args.input.with_suffix(".redacted.pdf")
    summary = redact_pdf(args.input, output, args.audit)

    print(f"  in:  {args.input}")
    print(f"  out: {output}")
    print(f"  removed: {summary['total_redactions']} items {summary['by_category']}")

    if summary["verified_clean"]:
        print("  VERIFIED: re-extracted the output; none of the removed text remains.")
        return 0

    # Never report success on an unverified document.
    print(
        f"  FAILED VERIFICATION: {summary['leaked_count']} value(s) still "
        "extractable from the output. Do not release this file.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
