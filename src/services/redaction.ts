export type RedactionKind = "EMAIL" | "CREDIT_CARD" | "SSN";

interface Detector {
  kind: RedactionKind;
  pattern: RegExp;
  /** Optional extra rule a regex match must pass to become a candidate. */
  accepts?: (match: string) => boolean;
}

interface Span {
  kind: RedactionKind;
  start: number;
  end: number;
}

/**
 * EMAIL, built from named parts. "Letter" and "digit" mean any Unicode letter
 * or number (\p{L}, \p{N}), so josé@example.test and john@münchen.example are
 * matched like their ASCII counterparts. The local part (before the @) has
 * two forms:
 *
 * - Unquoted: up to 64 letters, digits, combining marks and . _ % + - ' (plus
 *   and dot aliases, and names such as o'connor). It cannot start with a dot,
 *   a mark or an apostrophe, so a quote mark placed around an address stays
 *   in the text. The length bound keeps matching linear on long inputs
 *   without an @.
 * - Quoted: anything between two double quotes on one line, which is how an
 *   address carries spaces: "ana garcia"@example.test. The quotes are part of
 *   the address and are redacted with it. No length bound is needed (the scan
 *   stops at the next quote) and none is wanted: a bound would let redacting
 *   a card inside the quotes shorten the text into a new match on a second
 *   pass.
 *
 * The domain is one or more labels and a final label that starts with a
 * letter.
 */
const LETTER_OR_DIGIT = String.raw`\p{L}\p{N}`;
const UNQUOTED_LOCAL_PART = String.raw`[${LETTER_OR_DIGIT}_%+-][${LETTER_OR_DIGIT}\p{M}._%+'-]{0,63}`;
const QUOTED_LOCAL_PART = String.raw`"[^"\r\n]+"`;
const DOMAIN_LABEL = String.raw`[${LETTER_OR_DIGIT}](?:[${LETTER_OR_DIGIT}\p{M}-]{0,61}[${LETTER_OR_DIGIT}\p{M}])?`;
const TOP_LEVEL_LABEL = String.raw`\p{L}[${LETTER_OR_DIGIT}\p{M}-]{0,61}[${LETTER_OR_DIGIT}\p{M}]`;

const EMAIL_PATTERN = new RegExp(
  `(?:${QUOTED_LOCAL_PART}|${UNQUOTED_LOCAL_PART})@(?:${DOMAIN_LABEL}\\.)+${TOP_LEVEL_LABEL}`,
  "gu",
);

/**
 * Cards and SSNs are matched on the message as typed, with no normalized
 * copy, so every match position is a position in the original string.
 *
 * DIGIT: an ASCII digit or its full-width form (０ to ９, U+FF10 to U+FF19),
 * as produced by East Asian input methods. Both are one UTF-16 unit.
 *
 * SEPARATOR: one character that may sit between two digits of the same
 * number: any punctuation mark or symbol, a space of any width, a tab or an
 * invisible format character such as the zero-width space. Three things are
 * never separators, so they always end a number:
 *
 * - letters, so numbers are not joined across words;
 * - line breaks, so numbers are not joined across lines;
 * - the comma and the semicolon, which separate the items of a list.
 *
 * SEPARATOR_RUN: one to MAX_SEPARATORS separators in a row, enough for
 * " - " or " / " and too short to bridge a wider gap.
 */
const DIGIT = String.raw`[0-9０-９]`;
const SEPARATOR = String.raw`(?![,;])[\p{P}\p{S}\p{Zs}\p{Cf}\t]`;
const MAX_SEPARATORS = 3;
const SEPARATOR_RUN = `(?:${SEPARATOR}){1,${MAX_SEPARATORS}}`;

/**
 * A numeric run: 13 or more digits, each pair optionally split by one
 * separator run. The match is greedy, so it is the longest such run.
 */
const NUMERIC_RUN_PATTERN = new RegExp(
  `(?<!${DIGIT})${DIGIT}(?:(?:${SEPARATOR_RUN})?${DIGIT}){12,}`,
  "gu",
);

const MAX_CARD_DIGITS = 19;
const DIGIT_PATTERN = new RegExp(DIGIT, "g");

/**
 * A numeric run is a card candidate when it has 13 to 19 digits. A longer
 * run is also redacted when it contains separators: it holds several numbers
 * and there is no safe way to tell where one ends, so none of it is left in
 * the clear. Twenty or more digits written together are not a card.
 */
function isCardCandidate(run: string): boolean {
  const digitCount = run.match(DIGIT_PATTERN)?.length ?? 0;
  const hasSeparators = digitCount < run.length;
  return digitCount <= MAX_CARD_DIGITS || hasSeparators;
}

/** Nine digits together, or grouped 3-2-4 with a separator run between groups. */
const SSN_PATTERN = new RegExp(
  `(?<!${DIGIT})(?:${DIGIT}{3}${SEPARATOR_RUN}${DIGIT}{2}${SEPARATOR_RUN}${DIGIT}{4}|${DIGIT}{9})(?!${DIGIT})`,
  "gu",
);

/**
 * Detectors in priority order. The order only matters as a tie-breaker when
 * two overlapping candidates have the same length.
 */
const DETECTORS: readonly Detector[] = [
  { kind: "EMAIL", pattern: EMAIL_PATTERN },
  { kind: "CREDIT_CARD", pattern: NUMERIC_RUN_PATTERN, accepts: isCardCandidate },
  { kind: "SSN", pattern: SSN_PATTERN },
];

const PRIORITY: Record<RedactionKind, number> = {
  EMAIL: 0,
  CREDIT_CARD: 1,
  SSN: 2,
};

function findCandidates(message: string): Span[] {
  const spans: Span[] = [];
  for (const { kind, pattern, accepts } of DETECTORS) {
    for (const match of message.matchAll(pattern)) {
      if (accepts && !accepts(match[0])) continue;
      spans.push({ kind, start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function length(span: Span): number {
  return span.end - span.start;
}

/** True when `candidate` should label a merged span instead of `current`. */
function outranks(candidate: Span, current: Span): boolean {
  if (length(candidate) !== length(current)) {
    return length(candidate) > length(current);
  }
  return PRIORITY[candidate.kind] < PRIORITY[current.kind];
}

/**
 * Merges overlapping candidates into one span each. The merged span covers
 * every candidate in the group and takes the kind of the longest one, so a
 * shorter match (an SSN inside a card, a card tail inside an email) can
 * neither split a longer one nor leave part of it in the clear.
 */
function resolveOverlaps(candidates: Span[]): Span[] {
  const sorted = [...candidates].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  const resolved: Span[] = [];
  let group: Span | undefined;
  let label: Span | undefined;

  for (const span of sorted) {
    if (group && label && span.start < group.end) {
      group.end = Math.max(group.end, span.end);
      if (outranks(span, label)) {
        label = span;
        group.kind = span.kind;
      }
      continue;
    }
    group = { ...span };
    label = span;
    resolved.push(group);
  }

  return resolved;
}

/**
 * Returns `message` with every email address, credit card candidate and SSN
 * replaced by `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>` or
 * `<REDACTED: SSN>`. All other text is returned unchanged.
 *
 * Pure: no I/O, no shared state, same output for the same input. Redacting
 * an already redacted message returns it unchanged.
 *
 * Detection limits and known false positives: docs/REDACTION.md.
 */
export function redactMessage(message: string): string {
  const spans = resolveOverlaps(findCandidates(message));

  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += `${message.slice(cursor, span.start)}<REDACTED: ${span.kind}>`;
    cursor = span.end;
  }
  return result + message.slice(cursor);
}
