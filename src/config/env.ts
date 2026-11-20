export type NodeEnv = "development" | "test" | "production";

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
}

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];
const DEFAULT_PORT = 3000;

/**
 * Reads and validates the environment. Throws on invalid values so a bad
 * configuration stops the process at startup instead of failing later.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (!NODE_ENVS.includes(nodeEnv as NodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV "${nodeEnv}". Expected one of: ${NODE_ENVS.join(", ")}.`,
    );
  }

  const rawPort = source.PORT;
  const port =
    rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid PORT "${rawPort}". Expected an integer between 0 and 65535.`,
    );
  }

  return { nodeEnv: nodeEnv as NodeEnv, port };
}
