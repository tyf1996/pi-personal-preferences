#!/usr/bin/env node

import { access, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "../../skills/wikiskill/scripts");
const targetRoot = join(packageRoot, "python");
const checkOnly = process.argv.includes("--check");

async function pythonFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".py")) result.push(relative(root, path));
    }
  }
  await visit(root);
  return result.sort();
}

async function sourceAvailable() {
  try {
    await Promise.all([
      access(join(sourceRoot, "wikiskill_preference.py")),
      access(join(sourceRoot, "wikiskill_preference_core/__init__.py")),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function verifyStandaloneTarget() {
  let targetFiles;
  try {
    targetFiles = await pythonFiles(targetRoot);
  } catch {
    throw new Error("packaged Python runtime is missing");
  }
  for (const required of [
    "wikiskill_preference.py",
    "wikiskill_preference_core/__init__.py",
    "wikiskill_preference_core/store.py",
  ]) {
    if (!targetFiles.includes(required)) throw new Error(`packaged Python runtime is incomplete: ${required}`);
  }
}

async function verifyMonorepoParity() {
  const sourceFiles = (await pythonFiles(sourceRoot)).filter(
    (path) => path === "wikiskill_preference.py" || path.startsWith("wikiskill_preference_core/"),
  );
  await verifyStandaloneTarget();
  const targetFiles = await pythonFiles(targetRoot);
  if (sourceFiles.join("\n") !== targetFiles.join("\n")) {
    throw new Error("packaged Python file list is out of date; run npm run sync-python");
  }
  for (const path of sourceFiles) {
    const [source, target] = await Promise.all([
      readFile(join(sourceRoot, path)),
      readFile(join(targetRoot, path)),
    ]);
    if (!source.equals(target)) throw new Error(`packaged Python runtime is out of date: ${path}`);
  }
}

if (!(await sourceAvailable())) {
  await verifyStandaloneTarget();
} else if (checkOnly) {
  await verifyMonorepoParity();
} else {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(join(sourceRoot, "wikiskill_preference.py"), join(targetRoot, "wikiskill_preference.py"));
  await cp(join(sourceRoot, "wikiskill_preference_core"), join(targetRoot, "wikiskill_preference_core"), {
    recursive: true,
    filter: (path) => basename(path) !== "__pycache__" && (path.endsWith(".py") || !basename(path).includes(".")),
  });
  await verifyMonorepoParity();
}
