import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

function isolatedEnvironment(agentDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  delete environment.PI_PREFERENCE_DATA_ROOT;
  delete environment.WIKISKILL_PREFERENCE_CLI;
  return environment;
}

async function verifyInstalledCommand(packageDirectory: string, cwd: string, agentDir: string): Promise<void> {
  const environment = isolatedEnvironment(agentDir);
  execFileSync("pi", ["install", packageDirectory], { cwd, env: environment, encoding: "utf8" });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pi", [
      "--mode", "rpc", "--no-session", "--offline", "--no-tools", "--no-skills",
      "--no-prompt-templates", "--no-context-files",
    ], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let prompted = false;
    const timer = setTimeout(() => finish(new Error(`timed out waiting for installed /pref command: ${stderr}`)), 30_000);

    function finish(error?: Error): void {
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise();
    }

    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (code !== null && code !== 0 && !prompted) finish(new Error(`pi RPC exited with ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type === "extension_error") {
          finish(new Error(String(event.error ?? "installed extension failed")));
          return;
        }
        if (event.type === "response" && event.id === "commands") {
          const commands = event.data?.commands as Array<{ name?: string }> | undefined;
          if (!commands?.some((command) => command.name === "pref")) {
            finish(new Error("installed package did not register /pref"));
            return;
          }
          prompted = true;
          child.stdin.write(`${JSON.stringify({ id: "pref", type: "prompt", message: "/pref" })}\n`);
          continue;
        }
        if (event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(event.method)) {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
          continue;
        }
        if (event.type === "response" && event.id === "pref") {
          if (!event.success) finish(new Error(String(event.error ?? "/pref failed")));
          else finish();
          return;
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  });
}

test("packed package installs and initializes without monorepo paths or CLI overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-pack-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    const packed = JSON.parse(packOutput) as Array<{ filename: string }> | Record<string, { filename: string }>;
    const filename = Array.isArray(packed) ? packed[0]?.filename : Object.values(packed)[0]?.filename;
    assert.equal(typeof filename, "string");
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", join(root, filename), "-C", extracted]);
    const packageDirectory = join(extracted, "package");
    const cli = join(packageDirectory, "python/wikiskill_preference.py");
    assert.equal(existsSync(cli), true);
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], "*");
    assert.equal(existsSync(join(extracted, "skills")), false);
    const directData = join(root, "direct-data");
    execFileSync("python3", [cli, "init", "--data-root", directData], { encoding: "utf8" });
    const groups = JSON.parse(await readFile(join(directData, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.map((group: any) => group.name), ["global"]);

    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await verifyInstalledCommand(packageDirectory, cwd, agentDir);
    const installedData = join(agentDir, "personal-preferences");
    assert.equal(existsSync(join(installedData, "config.json")), true);
    assert.equal(existsSync(join(installedData, "repo/groups.json")), true);
    for (const [command, payload] of [
      ["manage-group", { action: "create", name: "coding", description: "适用于代码实现。" }],
      ["remember", { group: "coding", rule: "优先复用现有设计。", task_id: null }],
      ["set-activation", { target: "directory", key: cwd, group: "coding", enabled: true }],
    ] as const) {
      execFileSync("python3", [cli, command, "--stdin", "--data-root", installedData], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
    }

    const peerScope = join(packageDirectory, "node_modules/@earendil-works");
    await mkdir(peerScope, { recursive: true });
    const peerTarget = join(peerScope, "pi-tui");
    if (!existsSync(peerTarget)) {
      await symlink(resolve(PACKAGE_ROOT, "node_modules/@earendil-works/pi-tui"), peerTarget, "dir");
    }

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousDataRoot = process.env.PI_PREFERENCE_DATA_ROOT;
    const previousCli = process.env.WIKISKILL_PREFERENCE_CLI;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_PREFERENCE_DATA_ROOT;
    delete process.env.WIKISKILL_PREFERENCE_CLI;
    try {
      const handlers = new Map<string, (event: any, ctx: any) => unknown>();
      const extension = await import(pathToFileURL(join(packageDirectory, "index.ts")).href);
      extension.default({
        on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
        registerCommand: () => undefined,
      } as any);
      const prompt = await handlers.get("before_agent_start")?.(
        { systemPrompt: "Base prompt", systemPromptOptions: {} },
        {
          cwd,
          hasUI: false,
          hasPendingMessages: () => false,
          sessionManager: { getSessionId: () => "installed-session" },
          ui: { notify: () => undefined, setStatus: () => undefined },
        },
      );
      assert.match(String((prompt as any)?.systemPrompt), /Personal Preference Group: coding/u);
      assert.match(String((prompt as any)?.systemPrompt), /优先复用现有设计/u);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousDataRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
      else process.env.PI_PREFERENCE_DATA_ROOT = previousDataRoot;
      if (previousCli === undefined) delete process.env.WIKISKILL_PREFERENCE_CLI;
      else process.env.WIKISKILL_PREFERENCE_CLI = previousCli;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
