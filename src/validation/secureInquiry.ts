export const USER_ID_MAX_LENGTH = 100;
export const MESSAGE_MAX_LENGTH = 10_000;

/** A validated request body. The only definition of this shape. */
export interface SecureInquiryInput {
  userId: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: SecureInquiryInput }
  | { ok: false; errors: string[] };

const FIELDS = [
  ["userId", USER_ID_MAX_LENGTH],
  ["message", MESSAGE_MAX_LENGTH],
] as const;

/**
 * Whitespace plus the zero-width characters that `trim()` keeps (zero-width
 * space, non-joiner, joiner and word joiner). A value made only of these
 * shows nothing on screen, so it counts as blank.
 */
const INVISIBLE_ONLY = /^[\s\u200B-\u200D\u2060]*$/;

/** Length in Unicode code points, so an emoji counts as one character. */
function characterCount(value: string): number {
  return Array.from(value).length;
}

/**
 * Checks the body without changing it: values are never trimmed or
 * normalized, so what is accepted is exactly what was sent.
 *
 * Error texts name fields and rules only. They never repeat a value or the
 * name of an unexpected property, because both come from the request.
 */
export function validateSecureInquiryBody(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["The body must be a JSON object"] };
  }

  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, maxLength] of FIELDS) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;

    if (value === undefined) {
      errors.push(`${field} is required`);
    } else if (typeof value !== "string") {
      errors.push(`${field} must be a string`);
    } else if (INVISIBLE_ONLY.test(value)) {
      errors.push(`${field} must not be blank`);
    } else if (!value.isWellFormed()) {
      // A lone surrogate cannot be encoded as UTF-8: it would be replaced
      // during encryption and the stored original would no longer match.
      errors.push(`${field} must be valid Unicode text`);
    } else if (characterCount(value) > maxLength) {
      errors.push(`${field} must be at most ${maxLength} characters`);
    }
  }

  const allowed = new Set<string>(FIELDS.map(([field]) => field));
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    errors.push("Only userId and message are allowed");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { userId: record.userId as string, message: record.message as string },
  };
}
