import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPreferenceCliWithModel } from "../src/cli-client.ts";

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
        50,
      ),
      /timed out/u,
    );
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 1_000);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
