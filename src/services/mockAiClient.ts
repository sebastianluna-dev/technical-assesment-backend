export interface AiClient {
  /** Receives the already redacted message and returns the answer text. */
  generateAnswer(prompt: string): Promise<string>;
}

export const MOCK_ANSWER = "Generated Answer";

/**
 * Latency of a call when none is configured. The single source of this
 * default: the environment loader uses the same constant.
 */
export const DEFAULT_MOCK_AI_DELAY_MS = 2_000;

export interface MockAiClientOptions {
  /** Probability from 0 to 1 that a call fails. Default 0. */
  failureRate?: number;
  /** Simulated latency in milliseconds. Default 2,000; pass 0 for no wait. */
  delayMs?: number;
  /** Random source, replaceable in tests. */
  random?: () => number;
}

/**
 * Stand-in for a real AI provider. It ignores the prompt, never stores or
 * logs it, and returns a fixed answer or fails at the configured rate.
 */
export function createMockAiClient(options: MockAiClientOptions = {}): AiClient {
  const { failureRate = 0, delayMs = DEFAULT_MOCK_AI_DELAY_MS, random = Math.random } = options;

  return {
    async generateAnswer(_prompt) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (random() < failureRate) {
        throw new Error("Mock AI service failure.");
      }
      return MOCK_ANSWER;
    },
  };
}
