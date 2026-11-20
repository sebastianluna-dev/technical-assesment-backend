# Redaction: what is detected, limits and false positives

`redactMessage(message)` in `src/services/redaction.ts` replaces three kinds of data with fixed tokens. Every example below was run against the function.

| Kind | Token | Detected |
| --- | --- | --- |
| Email | `<REDACTED: EMAIL>` | `local@domain.tld`, including plus and dot aliases such as `john.doe+billing@mail.example.co.uk`, apostrophes (`o'connor@example.test`), quoted local parts with spaces (`"ana garcia"@example.test`, quotes included) and letters of any alphabet in the local part or the domain (`josé@example.test`, `john@münchen.example`) |
| Credit card candidate | `<REDACTED: CREDIT_CARD>` | 13 to 19 digits, written together or with separators between digits, in any grouping (`4111 1111 1111 1111`, `4111.1111.1111.1111`, `4111 - 1111 - 1111 - 1111`). Digits may be ASCII or full-width (`４１１１…`). See the separator policy below |
| SSN | `<REDACTED: SSN>` | Nine consecutive digits, or the grouping 3-2-4 with separators between the groups (`123-45-6789`, `123 45 6789`, `123.45.6789`). Digits may be ASCII or full-width (`０００１２３４５６`, `０００-１２-３４５６`) |

## Separator policy

A separator is a character allowed between two digits of the same number. The policy is the same for cards and SSNs.

| | |
| --- | --- |
| **Separators** | Any punctuation mark or symbol (`- . / \ _ : | # * ( ) [ ]` and the rest of Unicode punctuation and symbols), a space of any width (space, no-break space U+00A0, narrow no-break space U+202F, ideographic space), a tab, and invisible format characters such as the zero-width space U+200B |
| **Never separators** | Letters of any alphabet, line breaks, the comma and the semicolon |
| **How many** | At most 3 in a row between two digits. `4111 - 1111` is one number; `4111 -- 1111` (4 characters apart) is two |

Why these limits:

- **Letters** end a number, so numbers are never joined across words: `4111 then 1111 then 1111 then 1111` is left alone, and `2026-11-20T10:30:15Z` is three separate short numbers.
- **Line breaks** end a number, so values on different lines stay different values.
- **Commas and semicolons** end a number because they are what lists are written with. `123-45-6789, 4111 1111 1111 1111` gives `<REDACTED: SSN>, <REDACTED: CREDIT_CARD>`, and a price list such as `12.50, 13.75, 100.00` is left alone. The cost: a card written `4111,1111,1111,1111` is not detected.
- **Three in a row** covers a spaced hyphen or slash (` - `, ` / `) and a closing and opening bracket, and is too short to bridge a wider gap.

How the digit counts apply to a run of digits and separators:

- **13 to 19 digits:** a card candidate, as before.
- **Fewer than 13:** not a card. A nine-digit SSN inside it is still found on its own.
- **More than 19, with separators:** the whole run is redacted as one `<REDACTED: CREDIT_CARD>`. It holds more than one number, there is no safe way to tell where one ends, and redacting only the first 19 digits would leave the rest in the clear. `4111111111111111 5500000000000004` and `1234 5678 9012 3456 7890 1234` each become one token.
- **20 or more digits written together:** not a card, as before.

There is no normalized copy of the message. Separators and full-width digits are matched in the original string, so each replacement covers exactly the characters of the value, separators included.

## Rules

- **No validation.** Cards are not checked with Luhn and SSNs are not checked against issued ranges. `0000000000000000` and `000000000` are redacted.
- **Digit boundaries.** A card or SSN is not matched when it is directly attached to another digit. `12345678901234567890` (20 digits) and `1234567890` (10 digits) are left alone.
- **Overlaps.** Candidates of all three kinds are found on the original text. Overlapping candidates are merged into one replacement, labelled with the kind of the longest one. Examples:
  - `123456789 0123 4567` → `<REDACTED: CREDIT_CARD>` (the nine digits are not treated as an SSN).
  - `123-45-6789@example.com` → `<REDACTED: EMAIL>`.
  - `4111 1111 1111 1111@example.com` → `<REDACTED: CREDIT_CARD>` (the card and the email `1111@example.com` overlap; one token hides both).
  - `4111 1111 1111 1111 123-45-6789` → `<REDACTED: CREDIT_CARD>`. Only a separator is between the two values, so they are one run of 25 digits: both are hidden, but the output shows one token, not two. The same happens with ` / `, ` | ` or `][` between values, and two SSNs written `123-45-6789 / 987-65-4321` (18 digits) come out as one `<REDACTED: CREDIT_CARD>`. With a comma, a semicolon, a word or a line break between them each value gets its own token.
- **Everything else is preserved**: punctuation, spacing, line breaks and non-ASCII text.
- **Idempotent.** The tokens contain no digit and no `@`, so redacting redacted text changes nothing.

## Detection limits (data that is not redacted)

### Emails

- Obfuscated addresses: `john at example dot com`, `john @ example.com`.
- A full-width at sign or dot: `john＠example.com`, `john@example．com`.
- IP-literal domains: `user@[192.168.0.1]`.
- Quoted local parts that span lines or contain an escaped quote. `"a\"b"@example.com` becomes `"a\<REDACTED: EMAIL>`. A quoted part mixed with an unquoted one (`"ana garcia".x@example.com`) is only redacted from the last dot on.
- Domains with no dot: `john@localhost`.
- In an unquoted local part, characters outside letters, digits and `. _ % + - '` cut it. `a!b@example.com` becomes `a!<REDACTED: EMAIL>`: the address is hidden but `a!` stays. The other symbols an address may legally carry (`! # $ & * / = ? ^ { | } ~` and the backtick) are left out on purpose, because they would also swallow text such as `email=` or a URL path in front of an address.
- A local part longer than 64 characters: the last 64 characters and the domain are redacted, the start stays.

### Credit cards

- Groups separated by commas, semicolons, line breaks, letters, or more than three separator characters (`4111,1111,1111,1111`, `4111 -- 1111 -- 1111 -- 1111`).
- Digits of other scripts (Arabic-Indic `٤١١١…`, Devanagari). Only ASCII and full-width digits count.
- Numbers written in words, or split across separate messages.
- Fewer than 13 digits, or 20 or more digits written together.
- Expiry dates and security codes are not detected as such. They are redacted only when nothing but separators stands between them and the card: `4111 1111 1111 1111 12/27` becomes `<REDACTED: CREDIT_CARD>`, but `4111-1111-1111-1111 exp 12/27 cvv 123` becomes `<REDACTED: CREDIT_CARD> exp 12/27 cvv 123`.

### SSNs

- Any grouping other than 3-2-4 (`12-345-6789`, `1 2 3 4 5 6 7 8 9`), and groups separated by commas, line breaks or more than three separator characters.
- Digits of other scripts. Only ASCII and full-width digits count.
- Partial SSNs, such as the last four digits.
- Nine digits directly attached to more digits.

## Possible false positives (harmless data that is redacted)

### As a credit card

Any 13 or more digits with nothing but separators between them (13 to 19 when written together):

- Millisecond timestamps: `1700000000000`.
- ISBN-13 and EAN-13 barcodes: `9780306406157`.
- IMEI numbers, bank account numbers, tracking numbers and long order or invoice IDs.
- Phone numbers with a country code, when they reach 13 digits: `+52 55 1234 5678 9012` becomes `+<REDACTED: CREDIT_CARD>`.
- Several short numbers in a row: `2024 2025 2026 2027` is 16 digits and is redacted.
- A date followed by a time: `2026-11-20 10:30:15` is 14 digits and is redacted. The ISO form `2026-11-20T10:30:15Z` is not, because the letters split it.
- An IP address with a port: `192.168.100.200:8080` is 16 digits and is redacted. The address alone (12 digits at most) is not.
- A decimal next to a date and a time: `3.14159265 2026-11-20 10:30` is redacted whole. With a comma or a word between them (`pi 3.14159265, on 2026-11-20 at 10:30:15`) nothing is redacted.

### As an SSN

Any standalone run of exactly nine digits:

- Order numbers, customer IDs, US bank routing numbers, ZIP+4 codes written without the hyphen.
- Nine-digit phone numbers written without separators.
- Any three, two and four digits in a row with separators between them, whatever they mean: `NNN-NN-NNNN`, `100 20 3000 units`, `123.45.6789`.

Not affected: 10-digit phone numbers (`555-123-4567`, `5512345678`), ZIP+4 with a hyphen (`90210-1234`), ISO dates, times and prices.

### As an email

- Anything in the form `text@name.tld`, such as some package or resource identifiers (`user@host.example` in a connection string). A social handle like `@name` is not matched because it has no local part.
- Text written without spaces in front of an address. Letters of any alphabet can belong to a local part, so in `联系我john@example.com` the three characters before `john` are redacted with it (up to 64 characters).

## Why it leans toward redacting

Skipping Luhn and SSN range checks means more false positives. That is deliberate: a redacted order number is an inconvenience, a leaked card number is an incident. Callers that need the original values must keep them outside the redacted text, because the replacement is not reversible.
