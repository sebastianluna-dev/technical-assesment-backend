const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes standard, padded base64 and returns `undefined` for anything else.
 * `Buffer.from(value, "base64")` alone skips invalid characters instead of
 * failing, which would let malformed keys and tampered fields through.
 */
export function decodeBase64(value: string): Buffer | undefined {
  if (!BASE64.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}
