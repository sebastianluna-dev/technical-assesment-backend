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
 *
 * Every state change starts a new cycle, identified by a counter. A call
 * remembers the cycle it started in and reports its outcome only if that
 * cycle is still the current one. A call that settles later, after the
 * circuit opened or recovered, still returns its result or error to its
 * caller but changes nothing in the breaker.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const {
    failureThreshold = 3,
    resetTimeoutMs = 30_000,
    timeoutMs = 5_000,
    // Looked up on every call, so a replaced system clock is respected.
    now = () => Date.now(),
  } = options;

  let state: CircuitState = "closed";
  let cycle = 0;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let trialInFlight = false;

  function enter(next: CircuitState): void {
    state = next;
    cycle += 1;
    consecutiveFailures = 0;
    trialInFlight = false;
    if (next === "open") {
      openedAt = now();
    }
  }

  function currentState(): CircuitState {
    if (state === "open" && now() - openedAt >= resetTimeoutMs) {
      enter("half-open");
    }
    return state;
  }

  function recordSuccess(): void {
    if (state === "half-open") {
      enter("closed");
    } else {
      consecutiveFailures = 0;
    }
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (state === "half-open" || consecutiveFailures >= failureThreshold) {
      enter("open");
    }
  }

  return {
    getState: currentState,

    async execute(operation) {
      const stateNow = currentState();
      if (stateNow === "open" || (stateNow === "half-open" && trialInFlight)) {
        throw new CircuitOpenError();
      }
      if (stateNow === "half-open") {
        trialInFlight = true;
      }
      // Only closed and half-open reach this point, and half-open admits one
      // call, so a call in the current cycle is a normal call or the trial.
      const startedIn = cycle;

      try {
        const result = await withTimeout(operation, timeoutMs);
        if (cycle === startedIn) {
          recordSuccess();
        }
        return result;
      } catch (error) {
        if (cycle === startedIn) {
          recordFailure();
        }
        throw error;
      }
    },
  };
}
