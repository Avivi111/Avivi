import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "dist", ".git"]);

function trackedFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (skip.has(entry)) continue;
    const full = path.join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) trackedFiles(full, found);
    else if (stat.isFile() && stat.size <= 1_000_000) found.push(full);
  }
  return found;
}

describe("repository guardrails", () => {
  it("keeps the package private and CI least-privilege", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { private?: boolean };
    assert.equal(pkg.private, true);

    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /permissions:\n {2}contents: read/);
    assert.match(ci, /persist-credentials: false/);
    assert.match(ci, /npm run typecheck/);
    assert.match(ci, /npm test/);
    assert.match(ci, /npm run audit:deps/);

    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /evidence/i);
    assert.match(readme, /emergency stop/i);
    assert.match(readme, /does not execute tools/i);
  });

  it("keeps LICENSE as an all-rights-reserved proposal", () => {
    const license = readFileSync(path.join(root, "LICENSE"), "utf8");
    assert.match(license, /PROPOSAL — NOT A LICENSE GRANT/);
    assert.match(license, /all rights are reserved/i);
    assert.equal(/permission is hereby granted/i.test(license), false);
  });

  it("keeps the kernel free of IO and network calls", () => {
    const source = readFileSync(path.join(root, "blueprints/agent-kernel.ts"), "utf8");
    assert.doesNotMatch(source, /\bfrom ["']node:/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\bchild_process\b/);
  });

  it("does not contain private keys or common credential prefixes", () => {
    const patterns = [
      /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
      /AKIA[0-9A-Z]{16}/,
      /ghp_[A-Za-z0-9]{20,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
    ];
    for (const file of trackedFiles(root)) {
      const text = readFileSync(file, "utf8");
      if (text.includes("\0")) continue;
      for (const pattern of patterns) {
        assert.equal(pattern.test(text), false, `${path.relative(root, file)} matched ${pattern}`);
      }
    }
  });
});
