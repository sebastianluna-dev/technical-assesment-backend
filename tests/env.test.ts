import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("falls back to defaults when nothing is set", () => {
    expect(loadEnv({})).toEqual({ nodeEnv: "development", port: 3000 });
  });

  it("reads NODE_ENV and PORT", () => {
    expect(loadEnv({ NODE_ENV: "production", PORT: "8080" })).toEqual({
      nodeEnv: "production",
      port: 8080,
    });
  });

  it("rejects a PORT that is not a valid port number", () => {
    expect(() => loadEnv({ PORT: "abc" })).toThrow(/Invalid PORT/);
    expect(() => loadEnv({ PORT: "70000" })).toThrow(/Invalid PORT/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(/Invalid NODE_ENV/);
  });
});
