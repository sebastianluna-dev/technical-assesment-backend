# Redaction: what is detected, limits and false positives

`redactMessage(message)` in `src/services/redaction.ts` replaces three kinds of data with fixed tokens. Every example below was run against the function.

| Kind | Token | Detected |
| --- | --- | --- |
| Email | `<REDACTED: EMAIL>` | `local@domain.tld`, including plus and dot aliases such as `john.doe+billing@mail.example.co.uk` |
| Credit card candidate | `<REDACTED: CREDIT_CARD>` | 13 to 19 digits, written together or with a single space or hyphen between digits, in any grouping |
| SSN | `<REDACTED: SSN>` | `XXX-XX-XXXX`, or exactly nine consecutive digits |

## Rules

- **No validation.** Cards are not checked with Luhn and SSNs are not checked against issued ranges. `0000000000000000` and `000000000` are redacted.
- **Digit boundaries.** A card or SSN is not matched when it is directly attached to another digit. `12345678901234567890` (20 digits) and `1234567890` (10 digits) are left alone.
- **Overlaps.** Candidates of all three kinds are found on the original text. Overlapping candidates are merged into one replacement, labelled with the kind of the longest one. Examples:
  - `123456789 0123 4567` → `<REDACTED: CREDIT_CARD>` (the nine digits are not treated as an SSN).
  - `123-45-6789@example.com` → `<REDACTED: EMAIL>`.
  - `4111 1111 1111 1111@example.com` → `<REDACTED: CREDIT_CARD>` (the card and the email `1111@example.com` overlap; one token hides both).
- **Everything else is preserved**: punctuation, spacing, line breaks and non-ASCII text.
- **Idempotent.** The tokens contain no digit and no `@`, so redacting redacted text changes nothing.

## Detection limits (data that is not redacted)

### Emails

- Obfuscated addresses: `john at example dot com`, `john @ example.com`.
- Non-ASCII characters in the local part or the domain: `josé@example.com`, `john@münchen.de`. Punycode domains (`xn--...`) are detected.
- Quoted local parts (`"a b"@example.com`) and IP-literal domains (`user@[192.168.0.1]`).
- Domains with no dot: `john@localhost`.
- Characters outside letters, digits and `. _ % + -` cut the local part. `o'brien@example.com` becomes `o'<REDACTED: EMAIL>`: the address is hidden but `o'` stays.
- A local part longer than 64 characters: the last 64 characters and the domain are redacted, the start stays.

### Credit cards

- Separators other than one space or one hyphen: dots, slashes, tabs, line breaks, or two spaces (`4111.1111.1111.1111`, `4111  1111  1111  1111`).
- Digits that are not ASCII, such as full-width `４１１１…`.
- Numbers written in words, or split across separate messages.
- Fewer than 13 digits, or 20 or more digits written together.
- A grouped number longer than 19 digits is only partly hidden: `1234 5678 9012 3456 7890 1234` becomes `<REDACTED: CREDIT_CARD> 7890 1234`.
- Expiry dates and security codes are not detected as such. Digits that follow a card after a single space can be absorbed into the match: `4111 1111 1111 1111 12/27` becomes `<REDACTED: CREDIT_CARD>/27`.

### SSNs

- Any other format: spaces (`123 45 6789`), dots, or other groupings.
- Partial SSNs, such as the last four digits.
- Nine digits directly attached to more digits.

## Possible false positives (harmless data that is redacted)

### As a credit card

Any 13 to 19 digits, alone or separated by single spaces or hyphens:

- Millisecond timestamps: `1700000000000`.
- ISBN-13 and EAN-13 barcodes: `9780306406157`.
- IMEI numbers, bank account numbers, tracking numbers and long order or invoice IDs.
- Phone numbers with a country code, when they reach 13 digits: `+52 55 1234 5678 9012` becomes `+<REDACTED: CREDIT_CARD>`.
- Several short numbers in a row: `2024 2025 2026 2027` is 16 digits and is redacted.

### As an SSN

Any standalone run of exactly nine digits:

- Order numbers, customer IDs, US bank routing numbers, ZIP+4 codes written without the hyphen.
- Nine-digit phone numbers written without separators.
- Any text in the form `NNN-NN-NNNN`, whatever it means.

Not affected: 10-digit phone numbers (`555-123-4567`, `5512345678`), ZIP+4 with a hyphen (`90210-1234`), ISO dates, times and prices.

### As an email

- Anything in the form `text@name.tld`, such as some package or resource identifiers (`user@host.example` in a connection string). A social handle like `@name` is not matched because it has no local part.

## Why it leans toward redacting

Skipping Luhn and SSN range checks means more false positives. That is deliberate: a redacted order number is an inconvenience, a leaked card number is an incident. Callers that need the original values must keep them outside the redacted text, because the replacement is not reversible.
