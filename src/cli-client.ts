import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type CliEnvironment = Record<string, string | undefined>;

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/giu, "[REDACTED_CREDENTIAL]")
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_CREDENTIAL]");
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("personal preference CLI aborted"));
      return;
    }
    const child = spawn("python3", [script, ...args, "--data-root", dataRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(environment),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputBytes = 0;
    let finished = false;
    const timer = setTimeout(() => fail(new Error("personal preference CLI timed out")), timeoutMs);
    const abort = () => fail(new Error("personal preference CLI aborted"));
    signal?.addEventListener("abort", abort, { once: true });

    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
      reject(error);
    }

    function append(kind: "stdout" | "stderr", chunk: Buffer): void {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error("personal preference CLI output exceeded 32 MiB"));
        return;
      }
      if (kind === "stdout") stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    }

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        reject(new Error(redact(stderr.trim() || `personal preference CLI returned invalid JSON (exit ${code ?? "unknown"})`)));
        return;
      }
      if (!isRecord(value)) {
        reject(new Error("personal preference CLI result is not an object"));
        return;
      }
      if (value.ok === false) {
        const error = isRecord(value.error) && typeof value.error.message === "string"
          ? value.error.message
          : stderr.trim() || "personal preference CLI failed";
        reject(new Error(redact(error)));
        return;
      }
      if (code !== 0) {
        reject(new Error(redact(stderr.trim() || `personal preference CLI exited with ${code ?? "unknown"}`)));
        return;
      }
      resolve(value);
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(input));
  });
}
