import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  CircuitTimeoutError,
  createCircuitBreaker,
  type CircuitBreaker,
} from "../src/services/circuitBreaker.js";

const RESET_MS = 30_000;
const TIMEOUT_MS = 5_000;

const succeed = () => vi.fn(async () => "ok");
const reject = () => vi.fn(async () => Promise.reject(new Error("boom")));

let breaker: CircuitBreaker;

async function failTimes(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await breaker.execute(reject()).catch(() => undefined);
  }
}

/** A call that stays pending until `resolve` or `reject` is used. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { operation: vi.fn(() => promise), resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
  // Defaults: threshold 3, open for 30 s, 5 s call timeout, system clock.
  breaker = createCircuitBreaker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("circuit breaker: closed", () => {
  it("passes the result through", async () => {
    expect(await breaker.execute(succeed())).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("rethrows the operation's own error", async () => {
    await expect(breaker.execute(reject())).rejects.toThrow("boom");
  });

  it("stays closed after two consecutive failures", async () => {
    await failTimes(2);

    expect(breaker.getState()).toBe("closed");
  });

  it("opens after three consecutive failures", async () => {
    await failTimes(3);

    expect(breaker.getState()).toBe("open");
  });

  it("does not invoke the operation on the fourth call", async () => {
    await failTimes(3);
    const fourth = succeed();

    await expect(breaker.execute(fourth)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fourth).not.toHaveBeenCalled();
  });

  it("resets the counter on a success", async () => {
    await failTimes(2);
    await breaker.execute(succeed());
    await failTimes(2);
    expect(breaker.getState()).toBe("closed");

    await failTimes(1);
    expect(breaker.getState()).toBe("open");
  });

  it("does not open on failures separated by successes", async () => {
    for (let i = 0; i < 10; i++) {
      await failTimes(2);
      await breaker.execute(succeed());
    }

    expect(breaker.getState()).toBe("closed");
  });

  it("counts a synchronous throw as a failure", async () => {
    const throwing = () => {
      throw new Error("sync");
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(throwing)).rejects.toThrow("sync");
    }

    expect(breaker.getState()).toBe("open");
  });

  it("honours a custom threshold", async () => {
    breaker = createCircuitBreaker({ failureThreshold: 1 });
    await failTimes(1);

    expect(breaker.getState()).toBe("open");
  });
});

describe("circuit breaker: open", () => {
  it("rejects every call until the reset time has passed", async () => {
    await failTimes(3);
    const operation = succeed();

    for (const elapsed of [0, 1_000, 28_998]) {
      vi.advanceTimersByTime(elapsed);
      await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    }
    expect(vi.getMockedSystemTime()!.getTime() - Date.UTC(2026, 10, 20, 12)).toBe(RESET_MS - 2);
    expect(operation).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe("open");
  });

  it("becomes half-open exactly at the reset time", async () => {
    await failTimes(3);

    vi.advanceTimersByTime(RESET_MS - 1);
    expect(breaker.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(breaker.getState()).toBe("half-open");
  });

  it("does not let rejected calls extend the open period", async () => {
    await failTimes(3);
    vi.advanceTimersByTime(RESET_MS - 1);
    await breaker.execute(succeed()).catch(() => undefined);
    vi.advanceTimersByTime(1);

    expect(breaker.getState()).toBe("half-open");
  });
});

describe("circuit breaker: half-open", () => {
  beforeEach(async () => {
    await failTimes(3);
    vi.advanceTimersByTime(RESET_MS);
  });

  it("closes when the probe succeeds", async () => {
    expect(await breaker.execute(succeed())).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("permits only one probe while it is in flight", async () => {
    const probe = deferred<string>();
    const pending = breaker.execute(probe.operation);

    const others = [succeed(), succeed(), succeed()];
    for (const other of others) {
      await expect(breaker.execute(other)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(other).not.toHaveBeenCalled();
    }
    expect(probe.operation).toHaveBeenCalledTimes(1);

    probe.resolve("recovered");
    expect(await pending).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
  });

  it("opens for another full period when the probe fails", async () => {
    await expect(breaker.execute(reject())).rejects.toThrow("boom");
    expect(breaker.getState()).toBe("open");

    vi.advanceTimersByTime(RESET_MS - 1);
    const early = succeed();
    await expect(breaker.execute(early)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(early).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(await breaker.execute(succeed())).toBe("ok");
  });

  it("allows a new single probe after a failed one", async () => {
    await breaker.execute(reject()).catch(() => undefined);
    vi.advanceTimersByTime(RESET_MS);

    const probe = deferred<string>();
    const pending = breaker.execute(probe.operation);
    await expect(breaker.execute(succeed())).rejects.toBeInstanceOf(CircuitOpenError);
    probe.resolve("ok");
    await pending;

    expect(breaker.getState()).toBe("closed");
  });

  it("needs three new failures to open again after recovering", async () => {
    await breaker.execute(succeed());
    await failTimes(2);
    expect(breaker.getState()).toBe("closed");

    await failTimes(1);
    expect(breaker.getState()).toBe("open");
  });

  it("opens when the probe times out", async () => {
    const pending = breaker.execute(() => new Promise<string>(() => undefined));
    const assertion = expect(pending).rejects.toBeInstanceOf(CircuitTimeoutError);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await assertion;

    expect(breaker.getState()).toBe("open");
  });
});

describe("circuit breaker: call timeout", () => {
  it("lets a call finish just under the timeout", async () => {
    const slow = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), TIMEOUT_MS - 1));
    const pending = breaker.execute(slow);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);

    expect(await pending).toBe("late");
    expect(breaker.getState()).toBe("closed");
  });

  it("fails a call that reaches the timeout", async () => {
    const pending = breaker.execute(() => new Promise<string>(() => undefined));
    const assertion = expect(pending).rejects.toThrow(/timed out after 5000 ms/);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await assertion;
  });

  it("counts three timeouts as three failures", async () => {
    for (let i = 0; i < 3; i++) {
      const pending = breaker.execute(() => new Promise<string>(() => undefined));
      const assertion = expect(pending).rejects.toBeInstanceOf(CircuitTimeoutError);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await assertion;
    }

    expect(breaker.getState()).toBe("open");
  });

  it("leaves no timer running after a call settles", async () => {
    await breaker.execute(succeed());
    await breaker.execute(reject()).catch(() => undefined);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a late success close a circuit that opened meanwhile", async () => {
    const slow = deferred<string>();
    const pending = breaker.execute(slow.operation); // Starts while closed.
    await failTimes(3);
    expect(breaker.getState()).toBe("open");

    slow.resolve("late");
    expect(await pending).toBe("late");
    expect(breaker.getState()).toBe("open");
  });
});
