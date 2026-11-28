import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreCodexOptionalDependencies, verifyCodexVendorReadRoot } from "./restore-codex-optional-dependencies.mjs";

const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
const optionalDependencies = Object.fromEntries(targets.map((target) => [
  `@openai/codex-${target}`,
  `npm:@openai/codex@0.160.0-${target}`,
]));
const host = `${process.platform}-${process.arch}`;

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("restores nested Codex optionalDependencies and keeps the platform vendor as a sandbox read root", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-codex-restore-"));
  try {
    const platform = join(root, "node_modules", `@openai/codex-${host}`);
    writeJson(join(root, "node_modules/@openai/codex/package.json"), {
      name: "@openai/codex",
      version: "0.160.0",
      bin: { codex: "bin/codex.js" },
      optionalDependencies,
    });
    writeJson(join(platform, "package.json"), {
      name: "@openai/codex",
      version: `0.160.0-${host}`,
      os: [process.platform],
      cpu: [process.arch],
    });
    mkdirSync(join(platform, "vendor"), { recursive: true });
    writeFileSync(join(platform, "vendor/codex"), "platform vendor fixture, never executed");
    const nested = join(root, "node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex/package.json");
    writeJson(nested, { name: "@openai/codex", version: "0.160.0", bin: { codex: "bin/codex.js" } });
    const runtimeNested = join(root, "runtime/node_modules/@openai/codex/package.json");
    writeJson(runtimeNested, { name: "@openai/codex", version: "0.160.0" });

    const restored = restoreCodexOptionalDependencies(root);
    const vendor = join(root, "runtime/node_modules", `@openai/codex-${host}`, "vendor");
    assert.equal(restored.vendor, vendor);
    assert.equal(readFileSync(join(vendor, "codex"), "utf8"), "platform vendor fixture, never executed");
    assert.deepEqual(JSON.parse(readFileSync(nested, "utf8")).optionalDependencies, optionalDependencies);
    assert.deepEqual(JSON.parse(readFileSync(runtimeNested, "utf8")).optionalDependencies, optionalDependencies);
    assert.equal(verifyCodexVendorReadRoot(join(root, "runtime/node_modules", `@openai/codex-${host}`)), vendor);
    assert.deepEqual(restoreCodexOptionalDependencies(root).optionalDependencies, optionalDependencies);

    const security = readFileSync(new URL("../packages/paperclip-runner/src/drivers/codex/codex-security-config.ts", import.meta.url), "utf8");
    assert.match(security, /if \(vendor\.startsWith\(`\$\{packageRoot\}\/`\)\) add\(vendor\)/);
    assert.doesNotMatch(security, /add\(packageRoot\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a Codex vendor symlink that leaves the platform package", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-codex-vendor-escape-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const platform = join(root, "platform");
    mkdirSync(platform, { recursive: true });
    symlinkSync(outside, join(platform, "vendor"));
    assert.throws(() => verifyCodexVendorReadRoot(platform), /real directory|escapes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
