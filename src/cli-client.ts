import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type CliEnvironment = Record<string, string | undefined>;
export type PreferenceModelResponder = (prompt: string, signal: AbortSignal) => Promise<string>;

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "[REDACTED_CREDENTIAL]")
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_CREDENTIAL]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function childEnvironment(overrides: CliEnvironment): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

export function runPreferenceCli(
  script: string,
  dataRoot: string,
  args: string[],
  input?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  environment: CliEnvironment = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args, "--data-root", dataRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(environment),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let finished = false;
    const timer = setTimeout(() => finishError(new Error("personal preference CLI timed out")), timeoutMs);

    function finishError(error: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
      reject(error);
    }

    function append(kind: "stdout" | "stderr", chunk: Buffer): void {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finishError(new Error("personal preference CLI output exceeded 1 MiB"));
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    }

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finishError(error));
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(redact(stderr.trim() || `personal preference CLI exited with ${code ?? "unknown"}`)));
        return;
      }
      try {
        const value = JSON.parse(stdout) as unknown;
        if (!isRecord(value)) throw new Error("result is not an object");
        resolve(value);
      } catch {
        reject(new Error("personal preference CLI returned invalid JSON"));
      }
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(input));
  });
}

export function runPreferenceCliWithModel(
  script: string,
  dataRoot: string,
  args: string[],
  input: unknown | undefined,
  respond: PreferenceModelResponder,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  environment: CliEnvironment = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args, "--pi-model", "--data-root", dataRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(environment),
      shell: false,
    });
    const controller = new AbortController();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "";
    let outputBytes = 0;
    let modelRequests = 0;
    let finalOutput: string | undefined;
    let processingError: Error | undefined;
    let finished = false;

    function fail(error: Error): void {
      if (processingError || finished) return;
      processingError = error;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
      reject(error);
    }

    const timer = setTimeout(() => fail(new Error("personal preference CLI timed out")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) fail(new Error("personal preference CLI output exceeded 1 MiB"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error("personal preference CLI output exceeded 1 MiB"));
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => fail(error));

    const processLines = (async () => {
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || processingError) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          throw new Error("personal preference CLI emitted invalid bridge JSON");
        }
        if (isRecord(value) && value.type === "model_request" && typeof value.prompt === "string") {
          modelRequests += 1;
          if (modelRequests > 1) throw new Error("personal preference CLI requested more than one model call");
          const response = await respond(value.prompt, controller.signal);
          if (!child.stdin.writable) throw new Error("personal preference CLI closed stdin before the model response");
          child.stdin.end(`${JSON.stringify({ model_response: response })}\n`);
          continue;
        }
        if (finalOutput !== undefined) throw new Error("personal preference CLI emitted more than one final result");
        finalOutput = line;
      }
    })().catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", async (code) => {
      if (finished) return;
      controller.abort();
      await processLines;
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      if (processingError) {
        reject(processingError);
        return;
      }
      if (code !== 0) {
        reject(new Error(redact(stderr.trim() || `personal preference CLI exited with ${code ?? "unknown"}`)));
        return;
      }
      if (!finalOutput) {
        reject(new Error("personal preference CLI returned no JSON"));
        return;
      }
      try {
        const value = JSON.parse(finalOutput) as unknown;
        if (!isRecord(value)) throw new Error("result is not an object");
        resolve(value);
      } catch {
        reject(new Error("personal preference CLI returned invalid JSON"));
      }
    });

    if (input !== undefined) child.stdin.write(`${JSON.stringify(input)}\n`);
  });
}
