# PDF redaction

Removes PII from a PDF, **for real**, and proves it afterwards.

```bash
pip install pymupdf
python3 make_sample.py                              # build a synthetic record
python3 redact_pdf.py sample_record.pdf --audit audit.json
```

```
  in:  sample_record.pdf
  out: sample_record.redacted.pdf
  removed: 6 items {'email': 2, 'card': 1, 'phone': 2, 'ssn': 1}
  VERIFIED: re-extracted the output; none of the removed text remains.
```

## Why it isn't just a black rectangle

The standard way documents get "redacted" is by drawing a filled box over the
text in a PDF editor. The box is a drawing. The text is still in the file
underneath it, selectable and copyable, and agencies have leaked names,
addresses and SSNs exactly this way.

This applies **true redactions** — PyMuPDF's `apply_redactions()` strips the
glyphs out of the content stream before the box is drawn. Then it re-opens the
file it just wrote, extracts the text fresh, and searches for everything it
claimed to remove. If anything survives, the run **fails loudly and exits
non-zero** rather than handing back a document that looks safe and isn't.

A tool that reports success without checking is precisely the tool that leaks.

## Over-redaction is also a failure

A public-records requester is entitled to everything that is *not* exempt, so
blacking out a parcel ID is a defect, not caution. Two guards exist for this:

- **Luhn checksum** on card-shaped digit runs, so a 16-digit case number isn't
  mistaken for a credit card.
- **A leading `(?<!\d)` on the phone pattern.** Without it the pattern matches a
  13-digit slice *inside* a longer run, and a 16-digit parcel ID comes back
  redacted as a phone number. This was a real bug in `sanitize.js`; it is fixed
  there too, and `test/growth.test.js` has a regression test.

`make_sample.py` deliberately includes a badge number, parcel ID, ordinance
number and permit number that must all survive.

## The audit trail

`--audit` writes a JSON record of every removal: page, category, rectangle, and
a **salted** SHA-256 of the original value.

The salt is random per run and deliberately **not stored**. An unsalted hash of
an SSN is reversible by brute force in under a second — there are only a billion
of them — so an unsalted log would quietly become a second copy of the data the
tool just removed. The log proves how many items came out and where, without
being a liability itself. To prove a specific value was redacted later, retain
the salt separately under your records-retention policy.

## Detection coverage, stated honestly

Emails, phone numbers, US SSNs, Luhn-valid card numbers, private keys, API keys
and Bearer tokens — all pattern-based, ported from `sanitize.js` so the two
paths agree exactly.

It does **not** detect names, street addresses, dates of birth, or medical
record numbers. Those need named-entity recognition, not regular expressions.
Anyone releasing records should treat this as a first pass that catches the
structured identifiers reliably, not as a substitute for review.

## Scanned documents

Text extraction only. A scanned image with no text layer yields nothing to
match, and the tool will honestly report zero redactions rather than pretend.
OCR would be the next addition.

## Files

| | |
|---|---|
| `redact_pdf.py` | The tool |
| `make_sample.py` | Generates a synthetic record — never commit a real one |
| `.gitignore` | Blocks `*.pdf` and audit logs from ever landing in git |
