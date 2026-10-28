import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImportMap,
  expandScope,
  isTestFile,
  moduleOf,
  partitionFiles,
} from "../src/core/partition.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "part-test-"));
}

function write(root: string, rel: string, content: string): void {
  const parts = rel.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function chdir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

describe("partition", () => {
  it("isTestFile matches common conventions", () => {
    for (const f of [
      "src/foo.test.ts",
      "src/foo.spec.js",
      "src/__tests__/a.ts",
      "test_foo.py",
      "pkg/foo_test.go",
      "tests/x.py",
      "test/a.ts",
      "conftest.py",
    ]) {
      assert.equal(isTestFile(f), true, f);
    }
    for (const f of ["src/foo.ts", "src/testing/util.ts", "src/latest.ts", "pkg/tokenizer.py"]) {
      assert.equal(isTestFile(f), false, f);
    }
  });

  it("moduleOf finds the nearest manifest dir, else the top-level dir", () => {
    const root = makeRoot();
    try {
      write(root, "pkg/package.json", "{}");
      write(root, "pkg/b.ts", "x");
      write(root, "pkg/sub/c.ts", "x");
      write(root, "src/a.ts", "x");
      write(root, "top.ts", "x");
      chdir(root, () => {
        assert.equal(moduleOf("pkg/b.ts"), "pkg");
        assert.equal(moduleOf("pkg/sub/c.ts"), "pkg");
        assert.equal(moduleOf("src/a.ts"), "src");
        assert.equal(moduleOf("top.ts"), ".");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("moduleOf ignores a manifest at the search root itself", () => {
    const root = makeRoot();
    try {
      write(root, "package.json", "{}");
      write(root, "pkg/pyproject.toml", "");
      write(root, "pkg/x.py", "x");
      write(root, "a/b.ts", "x");
      chdir(root, () => {
        assert.equal(moduleOf("pkg/x.py"), "pkg");
        assert.equal(moduleOf("a/b.ts"), "a");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packing respects caps and keeps modules pure and deterministic", () => {
    const files = [];
    for (let i = 0; i < 10; i++) {
      files.push({ file: `alpha/f${i}.ts`, chars: 1000 });
    }
    files.push({ file: "beta/big.ts", chars: 200000 });
    files.push({ file: "gamma/a.test.ts", chars: 500 });
    files.push({ file: "gamma/b.test.ts", chars: 500 });
    const opts = { targetChars: 5000, maxFiles: 3 };
    const once = partitionFiles(files, opts);
    const twice = partitionFiles(files, opts);
    assert.deepEqual(once, twice);
    for (const p of once) {
      assert.ok(p.files.length <= 3, `${p.id} has ${p.files.length} files`);
      assert.ok(
        p.chars <= 5000 || p.priority === -1,
        `${p.id} exceeds chars without huge priority`,
      );
      const mods = new Set(p.files.map((f) => moduleOf(f)));
      assert.equal(mods.size, 1, `${p.id} mixes modules`);
    }
    const ids = once.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    const byFile = new Map(once.flatMap((p) => p.files.map((f) => [f, p] as const)));
    assert.equal(byFile.get("beta/big.ts")!.priority, -1);
    assert.equal(byFile.get("gamma/a.test.ts")!.priority, -1);
    assert.equal(byFile.get("alpha/f0.ts")!.priority, 0);
    assert.ok(once.filter((p) => p.id.startsWith("alpha")).length >= 4);
  });

  it("buildImportMap finds imports and export symbols", () => {
    const map = buildImportMap([
      {
        file: "a.ts",
        content: [
          "import {x} from './b';",
          'import y from "./c";',
          "export function foo() {}",
          "export class Bar {}",
          "export const BAZ = 1;",
        ].join("\n"),
      },
      {
        file: "b.py",
        content: ["import os", "from .utils import helper", "def my_func():", "class MyClass:"].join(
          "\n",
        ),
      },
    ]);
    assert.deepEqual(map.get("a.ts")!.imports, ["./b", "./c"]);
    assert.deepEqual(map.get("a.ts")!.exports, ["foo", "Bar", "BAZ"]);
    assert.deepEqual(map.get("b.py")!.imports, ["os", ".utils"]);
    assert.deepEqual(map.get("b.py")!.exports, ["my_func", "MyClass"]);
  });

  it("expandScope adds one-hop importers and importees", () => {
    const inputs = [
      { file: "a.ts", content: "import {b} from './b';\nexport const a = 1;" },
      { file: "b.ts", content: "export const b = 1;" },
      { file: "c.ts", content: "import {a} from './a';" },
      { file: "lonely.ts", content: "export const l = 1;" },
    ];
    const map = buildImportMap(inputs);
    const all = inputs.map((f) => f.file);
    assert.deepEqual([...expandScope(new Set(["a.ts"]), map, all)].sort(), [
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    assert.deepEqual([...expandScope(new Set(["b.ts"]), map, all)].sort(), ["a.ts", "b.ts"]);
    assert.deepEqual([...expandScope(new Set(["c.ts"]), map, all)].sort(), ["a.ts", "c.ts"]);
    assert.deepEqual([...expandScope(new Set(["lonely.ts"]), map, all)].sort(), ["lonely.ts"]);
  });

  it("partitionFiles fills boundary imports/exports/edges from disk", () => {
    const root = makeRoot();
    try {
      write(root, "modA/a.ts", "import {b} from '../modB/b';\nexport const a = 1;");
      write(root, "modB/b.ts", "export const b = 1;");
      const parts = chdir(root, () =>
        partitionFiles([
          { file: "modA/a.ts", chars: 60 },
          { file: "modB/b.ts", chars: 20 },
        ]),
      );
      assert.equal(parts.length, 2);
      const a = parts.find((p) => p.id.startsWith("modA"))!;
      const b = parts.find((p) => p.id.startsWith("modB"))!;
      assert.deepEqual(a.boundary.imports, ["../modB/b"]);
      assert.deepEqual(a.boundary.exports, ["a"]);
      assert.deepEqual(a.boundary.edges, ["modA -> modB"]);
      assert.deepEqual(b.boundary.exports, ["b"]);
      assert.deepEqual(b.boundary.edges, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
