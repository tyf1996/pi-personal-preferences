import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runPreferenceCli, runPreferenceCliWithModel } from "../src/cli-client.ts";

async function script(source: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-preference-bridge-"));
  const path = join(directory, "bridge.py");
  await writeFile(path, source, "utf8");
  return { directory, path };
}

function rejectWhenAborted(signal: AbortSignal, mark: () => void): Promise<string> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      mark();
      reject(new Error("model request aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("a pre-aborted CLI signal rejects before spawning the Python child", async () => {
  const fixture = await script([
    "from pathlib import Path",
    "Path(__file__).with_name('spawned').write_text('yes')",
    "print('{}')",
  ].join("\n"));
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(runPreferenceCli(fixture.path, fixture.directory, [], undefined, 2_000, {}, controller.signal), /aborted/u);
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(fixture.directory, "spawned"))));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("aborting the actual custom-provider subprocess stops a delayed local HTTP call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-preference-custom-abort-"));
  const cli = resolve(import.meta.dirname, "../python/wikiskill_preference.py");
  let requestStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { requestStarted = resolveStarted; });
  const server = createServer((_request, response) => {
    requestStarted();
    const timer = setTimeout(() => {
      if (response.destroyed) return;
      const body = JSON.stringify({ choices: [{ message: { content: "{}" } }] });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    }, 1_000);
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    execFileSync("python3", [cli, "init", "--data-root", root], { encoding: "utf8" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server did not expose a port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.provider = { name: "openai_compatible", model: "fixture", api_key_env: "PREFERENCE_TEST_KEY", base_url: baseUrl, thinking_level: "off", timeout_seconds: 5, max_tokens: 128 };
    config.learning.extraction.enabled = true;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const groupId = JSON.parse(execFileSync("python3", [cli, "groups", "--data-root", root], { encoding: "utf8" })).groups[0].id;
    const selection = { provider_source: "custom", provider_id: "openai_compatible", model_id: "fixture", api_type: "openai_compatible", endpoint_fingerprint: `sha256:${createHash("sha256").update(baseUrl).digest("hex")}`, thinking_level: "off", max_tokens: 128, timeout_seconds: 5, config_version: 2 };
    const environment = { PREFERENCE_TEST_KEY: "fixture-key" };
    let requestCounter = 0;
    const invoke = async (command: string, action: string, expectedGeneration: number | null, payload: Record<string, unknown>, signal?: AbortSignal) => runPreferenceCli(
      cli,
      root,
      [command, "--stdin"],
      { schema_version: 2, request_id: `request-${++requestCounter}`, action, expected_generation: expectedGeneration, payload },
      5_000,
      environment,
      signal,
    ) as Promise<any>;
    let listed = await invoke("feedback", "list", null, {});
    const snapshot = { session_id: "session", task_key: "task", user_entry_id: "user", assistant_entry_id: "assistant", user_text: "请简洁回答", assistant_text: "这是较长回答", origin_verified: true, storage_mode: "ask" };
    const preview = await invoke("feedback", "preview", null, { feedback: "fix: 请简洁", snapshot, model_selection: selection });
    const authorized = await invoke("feedback", "authorize", preview.cas.generation, { revision: 1, allowed: true, scope: "single", input_signature: preview.data.input_signature, model_selection: selection });
    const created = await invoke("feedback", "create", authorized.cas.generation, { feedback: "fix: 请简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: 1 });
    listed = await invoke("feedback", "list", null, {});
    const claimed = await invoke("learning-job", "claim", listed.cas.generation, { job_id: created.data.job.job_id, owner_id: "worker", consent_revision: 1, model_selection: selection, lease_seconds: 30 });
    const authorization = { job_id: created.data.job.job_id, token: claimed.data.job.lease.token, model_selection: selection, consent_revision: 1, endpoint_fingerprint: selection.endpoint_fingerprint };
    const controller = new AbortController();
    const modelCall = invoke("model-call", "complete", null, { prompt: claimed.data.prompt, model_selection: selection, authorization }, controller.signal);
    await started;
    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(modelCall, /aborted/u);
    assert.ok(Date.now() - abortedAt < 800);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("model bridge aborts the responder when the Python child exits", async () => {
  const fixture = await script([
    "import json",
    "print(json.dumps({'type': 'model_request', 'prompt': 'prompt'}), flush=True)",
  ].join("\n"));
  let aborted = false;
  try {
    await assert.rejects(
      runPreferenceCliWithModel(
        fixture.path,
        fixture.directory,
        [],
        undefined,
        (_prompt, signal) => rejectWhenAborted(signal, () => { aborted = true; }),
        2_000,
      ),
      /model request aborted/u,
    );
    assert.equal(aborted, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("model bridge timeout aborts the responder and rejects promptly", async () => {
  const fixture = await script([
    "import json, sys",
    "print(json.dumps({'type': 'model_request', 'prompt': 'prompt'}), flush=True)",
    "sys.stdin.readline()",
  ].join("\n"));
  let aborted = false;
  const started = Date.now();
  try {
    await assert.rejects(
      runPreferenceCliWithModel(
        fixture.path,
        fixture.directory,
        [],
        undefined,
        (_prompt, signal) => rejectWhenAborted(signal, () => { aborted = true; }),
        500,
      ),
      /timed out/u,
    );
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 1_500);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
