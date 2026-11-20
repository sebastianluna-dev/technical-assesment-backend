/**
 * Fields are limited to short identifiers and codes by convention: request
 * ids, outcome names, error class names. Never pass message text, user
 * input, keys or whole error objects.
 */
export type LogFields = Record<string, string | number | undefined>;

export interface Logger {
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function write(level: "warn" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.warn(line);
  }
}

export const consoleLogger: Logger = {
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
