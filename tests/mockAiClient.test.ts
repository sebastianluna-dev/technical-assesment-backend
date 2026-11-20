import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockAiClient,
  DEFAULT_MOCK_AI_DELAY_MS,
  MOCK_ANSWER,
} from "../src/services/mockAiClient.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("mock AI client", () => {
  it("returns the fixed answer whatever the prompt", async () => {
    const client = createMockAiClient({ delayMs: 0 });

    expect(MOCK_ANSWER).toBe("Generated Answer");
    expect(await client.generateAnswer("anything")).toBe(MOCK_ANSWER);
    expect(await client.generateAnswer("")).toBe(MOCK_ANSWER);
  });

  it("never fails at rate 0 and always fails at rate 1", async () => {
    const never = createMockAiClient({ failureRate: 0, delayMs: 0, random: () => 0 });
    const always = createMockAiClient({ failureRate: 1, delayMs: 0, random: () => 0.999999 });

    expect(await never.generateAnswer("x")).toBe(MOCK_ANSWER);
    await expect(always.generateAnswer("x")).rejects.toThrow(/Mock AI service failure/);
  });

  it("fails when the random draw is below the rate", async () => {
    const below = createMockAiClient({ failureRate: 0.5, delayMs: 0, random: () => 0.49 });
    const at = createMockAiClient({ failureRate: 0.5, delayMs: 0, random: () => 0.5 });

    await expect(below.generateAnswer("x")).rejects.toThrow();
    expect(await at.generateAnswer("x")).toBe(MOCK_ANSWER);
  });

  it("waits two seconds by default", async () => {
    const client = createMockAiClient();
    const settled = vi.fn();
    void client.generateAnswer("x").then(settled);

    expect(DEFAULT_MOCK_AI_DELAY_MS).toBe(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(MOCK_ANSWER);
  });

  it("fails only after the default delay, at the configured rate", async () => {
    const client = createMockAiClient({ failureRate: 1, random: () => 0 });
    const rejected = vi.fn();
    void client.generateAnswer("x").catch(rejected);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect((rejected.mock.calls[0]![0] as Error).message).toMatch(/Mock AI service failure/);
  });

  it("answers without any timer when the delay is set to 0", async () => {
    const client = createMockAiClient({ delayMs: 0 });

    expect(await client.generateAnswer("x")).toBe(MOCK_ANSWER);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the configured delay", async () => {
    const client = createMockAiClient({ delayMs: 250 });
    const settled = vi.fn();
    void client.generateAnswer("x").then(settled);

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(MOCK_ANSWER);
  });

  it("does not put the prompt in its error", async () => {
    const client = createMockAiClient({ failureRate: 1, delayMs: 0 });
    const error = await client.generateAnswer("synthetic secret prompt").catch((e: Error) => e);

    expect((error as Error).message).not.toContain("synthetic secret prompt");
  });
});
