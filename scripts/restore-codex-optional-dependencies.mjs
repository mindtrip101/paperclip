#!/usr/bin/env node
// Restore nested @openai/codex optionalDependencies from the top-level Codex
// install, then prove the host platform vendor directory is a sandbox read root.
// Live install-runtime.sh can call this script. This file does not change deploy hooks.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_PIN = "0.160.0";
const PLATFORM_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];

function fail(message) {
  throw new Error(message);
}

function readManifest(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid Codex manifest: ${path}`);
  return value;
}

export function officialCodexOptionalDependencies(value, version = CODEX_PIN) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Top-level Codex optionalDependencies are missing");
  const optional = {};
  for (const target of PLATFORM_TARGETS) {
    const name = `@openai/codex-${target}`;
    const expected = `npm:@openai/codex@${version}-${target}`;
    if (value[name] !== expected) fail(`Top-level Codex ${name} must be ${expected}`);
    optional[name] = expected;
  }
  return optional;
}

function contained(root, path) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function hostPlatformName() {
  return `@openai/codex-${process.platform}-${process.arch}`;
}

function collectCodexManifests(root) {
  const manifests = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (seen.size > 20000) fail("Codex install walk exceeded its bound");
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    const parent = basename(dir);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".pnpm" || entry.name === ".bin") continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        const manifest = join(path, "@openai/codex/package.json");
        if (existsSync(manifest)) manifests.push(manifest);
        for (const scope of ["@openai", "@agentclientprotocol", "@paperclipai"]) {
          const scopeDir = join(path, scope);
          if (existsSync(scopeDir)) queue.push(scopeDir);
        }
        continue;
      }
      if (parent.startsWith("@") || entry.name === "runtime" || entry.name.startsWith("@")) queue.push(path);
    }
  }
  return manifests;
}

function copyContainedDirectory(source, destination) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail("Codex platform package must be a real directory");
  const sourceRoot = realpathSync(source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(sourceRoot, destination, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const stat = lstatSync(src);
      if (!stat.isSymbolicLink()) return true;
      const target = realpathSync(src);
      if (!contained(sourceRoot, target) && target !== sourceRoot) return false;
      return true;
    },
  });
}

/** The vendor directory is the only sandbox read root this restore may add. */
export function verifyCodexVendorReadRoot(platformPackageDir) {
  const packageRoot = realpathSync(platformPackageDir);
  const link = join(packageRoot, "vendor");
  const stat = lstatSync(link);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Codex vendor must be a real directory inside the platform package");
  const vendor = realpathSync(link);
  if (!vendor.startsWith(`${packageRoot}${sep}`)) fail("Codex vendor escapes its platform package");
  if (vendor === packageRoot || basename(vendor) !== "vendor") fail("Codex sandbox read root must be the platform vendor directory");
  return vendor;
}

export function restoreCodexOptionalDependencies(root, options = {}) {
  const installRoot = realpathSync(root);
  const version = options.codexVersion ?? CODEX_PIN;
  const topLevel = join(installRoot, "node_modules/@openai/codex/package.json");
  if (!existsSync(topLevel)) fail(`Top-level Codex package is not installed at ${topLevel}`);
  const top = readManifest(topLevel);
  if (top.name !== "@openai/codex" || top.version !== version) {
    fail(`Top-level Codex must be @openai/codex@${version}`);
  }
  const optional = officialCodexOptionalDependencies(top.optionalDependencies, version);
  const topReal = realpathSync(topLevel);
  for (const manifestPath of collectCodexManifests(installRoot)) {
    if (realpathSync(manifestPath) === topReal) continue;
    const manifest = readManifest(manifestPath);
    if (manifest.name !== "@openai/codex" || manifest.version !== version) continue;
    const current = manifest.optionalDependencies ?? {};
    const missing = Object.entries(optional).some(([name, specifier]) => current[name] !== specifier);
    if (!missing) continue;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, optionalDependencies: { ...current, ...optional } }, null, 2)}\n`);
  }
  const platformName = hostPlatformName();
  const sourcePlatform = join(installRoot, "node_modules", platformName);
  if (!existsSync(sourcePlatform)) fail(`Top-level ${platformName} is not installed`);
  const runtimePlatform = join(installRoot, "runtime/node_modules", platformName);
  const vendorPath = join(runtimePlatform, "vendor");
  if (!existsSync(vendorPath)) copyContainedDirectory(sourcePlatform, runtimePlatform);
  const vendor = verifyCodexVendorReadRoot(runtimePlatform);
  if (!contained(installRoot, vendor)) fail("Codex vendor must stay inside the install root");
  return { codexVersion: version, optionalDependencies: optional, vendor };
}

function main() {
  const root = process.argv[2] ? process.argv[2] : process.cwd();
  const restored = restoreCodexOptionalDependencies(root);
  process.stdout.write(`${JSON.stringify({
    codexVersion: restored.codexVersion,
    vendor: restored.vendor,
    sandboxReadRoot: "vendor",
  })}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
