import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedFiles,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILES,
  DEFAULT_REDACT,
  hasSecretContent,
  headCommit,
  inventory,
} from "../src/core/inventory.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "inv-test-"));
}

function write(root: string, rel: string, content: string | Buffer): void {
  const parts = rel.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe("inventory", () => {
  it("exports the frozen default lists", () => {
    assert.ok(DEFAULT_EXCLUDE_DIRS.includes("node_modules"));
    assert.ok(DEFAULT_EXCLUDE_DIRS.includes(".git"));
    assert.ok(DEFAULT_EXCLUDE_FILES.includes("*.min.js"));
    assert.ok(DEFAULT_EXCLUDE_FILES.includes("package-lock.json"));
    for (const name of ["pem", "key", "token", "secret", "password"]) {
      assert.ok(DEFAULT_REDACT.includes(name));
    }
  });

  it("applies default excludes and returns sorted repo-relative paths", () => {
    const root = makeRoot();
    try {
      write(root, "src/a.ts", "export const a = 1;\n");
      write(root, "src/app.min.js", "minified");
      write(root, "src/x.generated.ts", "gen");
      write(root, "src/y.pb.go", "gen");
      write(root, "bundle.js.map", "{}");
      write(root, "node_modules/pkg/index.js", "x");
      write(root, ".git/config", "x");
      write(root, "dist/b.js", "x");
      write(root, "dist-test/t.js", "x");
      write(root, "vendor/v.js", "x");
      write(root, ".audit/logs/x.jsonl", "x");
      write(root, "coverage/lcov.info", "x");
      write(root, "package-lock.json", "{}");
      write(root, "yarn.lock", "x");
      write(root, "generated/g.ts", "x");
      const entries = inventory(root);
      assert.deepEqual(
        entries.map((e) => e.file),
        ["src/a.ts"],
      );
      assert.equal(entries[0].bytes, Buffer.byteLength("export const a = 1;\n"));
      assert.ok(entries[0].mtimeMs > 0);
      assert.ok(entries[0].abs.endsWith("src/a.ts"));
      assert.ok(!entries[0].file.includes("\\"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors include, exclude, and maxFileBytes opts", () => {
    const root = makeRoot();
    try {
      write(root, "src/a.ts", "a");
      write(root, "src/b.py", "b");
      write(root, "big/data.bin", "x".repeat(100));
      let entries = inventory(root, { include: ["*.ts"] });
      assert.deepEqual(entries.map((e) => e.file), ["src/a.ts"]);
      entries = inventory(root, { exclude: ["src/**"] });
      assert.ok(!entries.some((e) => e.file.startsWith("src/")));
      entries = inventory(root, { maxFileBytes: 10 });
      assert.ok(!entries.some((e) => e.file === "big/data.bin"));
      assert.ok(entries.some((e) => e.file === "src/a.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hasSecretContent flags secret names and binary content", () => {
    const root = makeRoot();
    try {
      write(root, ".env", "K=1");
      write(root, "id_rsa", "key");
      write(root, "cert.pem", "x");
      write(root, "img.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
      write(root, "ok.ts", "export const a = 1;\n");
      assert.equal(hasSecretContent(join(root, ".env")), true);
      assert.equal(hasSecretContent(join(root, "id_rsa")), true);
      assert.equal(hasSecretContent(join(root, "cert.pem")), true);
      assert.equal(hasSecretContent(join(root, "img.png")), true);
      assert.equal(hasSecretContent(join(root, "ok.ts")), false);
      assert.equal(hasSecretContent(join(root, "missing.ts")), false);
      const files = inventory(root).map((e) => e.file);
      assert.deepEqual(files, ["ok.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changedFiles works in a temp git repo", () => {
    const root = makeRoot();
    try {
      write(root, "a.txt", "v1");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
        cwd: root,
        stdio: "ignore",
      });
      write(root, "a.txt", "v2");
      write(root, "b.txt", "new");
      const changed = changedFiles(root);
      assert.ok(changed.has("a.txt"), `expected a.txt in ${[...changed]}`);
      assert.ok(changed.has("b.txt"), `expected b.txt in ${[...changed]}`);
      const commit = headCommit(root);
      assert.match(commit, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changedFiles falls back to inventory and headCommit to unknown outside git", () => {
    const root = makeRoot();
    try {
      write(root, "x.ts", "x");
      write(root, "sub/y.ts", "y");
      assert.equal(headCommit(root), "unknown");
      assert.deepEqual([...changedFiles(root)].sort(), ["sub/y.ts", "x.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
