export type RedactionKind = "EMAIL" | "CREDIT_CARD" | "SSN";

interface Detector {
  kind: RedactionKind;
  pattern: RegExp;
}

interface Span {
  kind: RedactionKind;
  start: number;
  end: number;
}

/**
 * EMAIL, built from named parts. The local part (before the @) has two forms:
 *
 * - Unquoted: up to 64 letters, digits and . _ % + - ' (plus and dot aliases,
 *   and names such as o'connor). It cannot start with a dot or an apostrophe,
 *   so a quote mark placed around an address stays in the text. The length
 *   bound keeps matching linear on long inputs without an @.
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
const UNQUOTED_LOCAL_PART = String.raw`[a-z0-9_%+-][a-z0-9._%+'-]{0,63}`;
const QUOTED_LOCAL_PART = String.raw`"[^"\r\n]+"`;
const DOMAIN_LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
const TOP_LEVEL_LABEL = String.raw`[a-z][a-z0-9-]{0,61}[a-z0-9]`;

const EMAIL_PATTERN = new RegExp(
  `(?:${QUOTED_LOCAL_PART}|${UNQUOTED_LOCAL_PART})@(?:${DOMAIN_LABEL}\\.)+${TOP_LEVEL_LABEL}`,
  "gi",
);

/**
 * Detectors in priority order. The order only matters as a tie-breaker when
 * two overlapping candidates have the same length.
 *
 * EMAIL: see EMAIL_PATTERN above.
 *
 * CREDIT_CARD: 13 to 19 digits, each optionally preceded by one space or one
 * hyphen, not directly attached to another digit. No Luhn check on purpose.
 *
 * SSN: XXX-XX-XXXX or exactly nine digits, not directly attached to another
 * digit.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: "EMAIL",
    pattern: EMAIL_PATTERN,
  },
  {
    kind: "CREDIT_CARD",
    pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
  },
  {
    kind: "SSN",
    pattern: /(?<!\d)(?:\d{3}-\d{2}-\d{4}|\d{9})(?!\d)/g,
  },
];

const PRIORITY: Record<RedactionKind, number> = {
  EMAIL: 0,
  CREDIT_CARD: 1,
  SSN: 2,
};

function findCandidates(message: string): Span[] {
  const spans: Span[] = [];
  for (const { kind, pattern } of DETECTORS) {
    for (const match of message.matchAll(pattern)) {
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
