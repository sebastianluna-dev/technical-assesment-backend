import { describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  CircuitTimeoutError,
  createCircuitBreaker,
} from "../src/services/circuitBreaker.js";
import { createMockAiClient, MOCK_ANSWER } from "../src/services/mockAiClient.js";

const ok = () => Promise.resolve("ok");
const fail = () => Promise.reject(new Error("boom"));

function setup(options: { failureThreshold?: number; timeoutMs?: number } = {}) {
  let time = 0;
  const breaker = createCircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 1000,
    ...options,
    now: () => time,
  });
  return {
    breaker,
    advance: (ms: number) => (time += ms),
    failTimes: async (count: number) => {
      for (let i = 0; i < count; i++) {
        await breaker.execute(fail).catch(() => undefined);
      }
    },
  };
}

describe("circuit breaker", () => {
  it("passes results through while closed", async () => {
    const { breaker } = setup();

    expect(await breaker.execute(ok)).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("rethrows the operation's own error", async () => {
    const { breaker } = setup();

    await expect(breaker.execute(fail)).rejects.toThrow("boom");
  });

  it("stays closed below the failure threshold", async () => {
    const { breaker, failTimes } = setup();
    await failTimes(2);

    expect(breaker.getState()).toBe("closed");
  });

  it("opens after the threshold of consecutive failures", async () => {
    const { breaker, failTimes } = setup();
    await failTimes(3);

    expect(breaker.getState()).toBe("open");
  });

  it("counts only consecutive failures", async () => {
    const { breaker, failTimes } = setup();
    await failTimes(2);
    await breaker.execute(ok);
    await failTimes(2);

    expect(breaker.getState()).toBe("closed");
  });

  it("rejects without calling the operation while open", async () => {
    const { breaker, failTimes } = setup();
    await failTimes(3);
    const operation = vi.fn(ok);

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("allows one trial call after the reset timeout and closes on success", async () => {
    const { breaker, failTimes, advance } = setup();
    await failTimes(3);

    advance(999);
    expect(breaker.getState()).toBe("open");
    advance(1);
    expect(breaker.getState()).toBe("half-open");

    expect(await breaker.execute(ok)).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("opens again when the trial call fails", async () => {
    const { breaker, failTimes, advance } = setup();
    await failTimes(3);
    advance(1000);

    await expect(breaker.execute(fail)).rejects.toThrow("boom");
    expect(breaker.getState()).toBe("open");

    advance(999);
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("rejects other calls while the trial call is running", async () => {
    const { breaker, failTimes, advance } = setup();
    await failTimes(3);
    advance(1000);

    let finishTrial!: (value: string) => void;
    const trial = breaker.execute(
      () => new Promise<string>((resolve) => (finishTrial = resolve)),
    );
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    finishTrial("recovered");
    expect(await trial).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
  });

  it("needs the full threshold again after closing", async () => {
    const { breaker, failTimes, advance } = setup();
    await failTimes(3);
    advance(1000);
    await breaker.execute(ok);
    await failTimes(2);

    expect(breaker.getState()).toBe("closed");
  });

  it("counts a call that exceeds the timeout as a failure", async () => {
    const { breaker } = setup({ failureThreshold: 1, timeoutMs: 20 });

    await expect(
      breaker.execute(() => new Promise(() => undefined)),
    ).rejects.toBeInstanceOf(CircuitTimeoutError);
    expect(breaker.getState()).toBe("open");
  });

  it("counts a synchronous throw as a failure", async () => {
    const { breaker } = setup({ failureThreshold: 1 });

    await expect(
      breaker.execute(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(breaker.getState()).toBe("open");
  });
});

describe("mock AI client", () => {
  it("returns the fixed answer", async () => {
    expect(await createMockAiClient().generateAnswer("anything")).toBe(MOCK_ANSWER);
    expect(MOCK_ANSWER).toBe("Generated Answer");
  });

  it("fails at the configured rate", async () => {
    const always = createMockAiClient({ failureRate: 1 });
    const half = createMockAiClient({ failureRate: 0.5, random: () => 0.49 });
    const halfOk = createMockAiClient({ failureRate: 0.5, random: () => 0.5 });

    await expect(always.generateAnswer("x")).rejects.toThrow(/Mock AI service failure/);
    await expect(half.generateAnswer("x")).rejects.toThrow();
    expect(await halfOk.generateAnswer("x")).toBe(MOCK_ANSWER);
  });

  it("does not put the prompt in its error", async () => {
    const client = createMockAiClient({ failureRate: 1 });
    const error = await client.generateAnswer("secret prompt").catch((e: Error) => e);

    expect((error as Error).message).not.toContain("secret prompt");
  });
});
