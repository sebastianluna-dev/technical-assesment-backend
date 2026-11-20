export interface AiClient {
  /** Receives the already redacted message and returns the answer text. */
  generateAnswer(prompt: string): Promise<string>;
}

export const MOCK_ANSWER = "Generated Answer";

export interface MockAiClientOptions {
  /** Probability from 0 to 1 that a call fails. Default 0. */
  failureRate?: number;
  /** Simulated latency in milliseconds. Default 0. */
  delayMs?: number;
  /** Random source, replaceable in tests. */
  random?: () => number;
}

/**
 * Stand-in for a real AI provider. It ignores the prompt, never stores or
 * logs it, and returns a fixed answer or fails at the configured rate.
 */
export function createMockAiClient(options: MockAiClientOptions = {}): AiClient {
  const { failureRate = 0, delayMs = 0, random = Math.random } = options;

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
