import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "[REDACTED_CREDENTIAL]")
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_CREDENTIAL]");
}

export function runPreferenceCli(
  script: string,
  dataRoot: string,
  args: string[],
  input?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args, "--data-root", dataRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
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
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("result is not an object");
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error("personal preference CLI returned invalid JSON"));
      }
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(input));
  });
}
