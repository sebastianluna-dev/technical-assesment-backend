export type CircuitState = "closed" | "open" | "half-open";

/** Thrown without calling the operation while the circuit is open. */
export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open.");
    this.name = "CircuitOpenError";
  }
}

/** Thrown when the operation takes longer than `timeoutMs`. */
export class CircuitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs} ms.`);
    this.name = "CircuitTimeoutError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call. Default 30 s. */
  resetTimeoutMs?: number;
  /** Maximum duration of one call; a slower call counts as a failure. Default 5 s. */
  timeoutMs?: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
}

export interface CircuitBreaker {
  /**
   * Runs `operation` if the circuit allows it. Only what happens inside
   * `operation` (rejection or timeout) counts as a failure.
   */
  execute<T>(operation: () => Promise<T>): Promise<T>;
  getState(): CircuitState;
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CircuitTimeoutError(timeoutMs)),
      timeoutMs,
    );
    // The async wrapper turns a synchronous throw into a rejection.
    (async () => operation())()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Closed: calls pass; `failureThreshold` consecutive failures open it.
 * Open: calls are rejected at once until `resetTimeoutMs` has passed.
 * Half-open: one trial call passes. Success closes the circuit, failure
 * opens it again. Other calls are rejected while the trial is running.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const {
    failureThreshold = 3,
    resetTimeoutMs = 30_000,
    timeoutMs = 5_000,
    now = Date.now,
  } = options;

  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;
  let trialInFlight = false;

  function open(): void {
    state = "open";
    openedAt = now();
  }

  function currentState(): CircuitState {
    if (state === "open" && now() - openedAt >= resetTimeoutMs) {
      state = "half-open";
      trialInFlight = false;
    }
    return state;
  }

  return {
    getState: currentState,

    async execute(operation) {
      const stateNow = currentState();
      if (stateNow === "open" || (stateNow === "half-open" && trialInFlight)) {
        throw new CircuitOpenError();
      }
      const isTrial = stateNow === "half-open";
      if (isTrial) {
        trialInFlight = true;
      }

      try {
        const result = await withTimeout(operation, timeoutMs);
        // A slow success that started before the circuit opened must not close it.
        if (isTrial || state === "closed") {
          state = "closed";
          consecutiveFailures = 0;
        }
        return result;
      } catch (error) {
        if (isTrial) {
          open();
        } else if (state === "closed") {
          consecutiveFailures += 1;
          if (consecutiveFailures >= failureThreshold) {
            open();
          }
        }
        throw error;
      } finally {
        if (isTrial) {
          trialInFlight = false;
        }
      }
    },
  };
}
