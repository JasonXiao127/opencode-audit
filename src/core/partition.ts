// Module partitioner: groups files into module packs with boundary context.
// Only Node builtins. Module roots resolve against process.cwd().

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Partition } from "./types.js";

const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];
const SEARCH_DEPTH = 3;

export interface PartitionFileInput {
  file: string;
  chars: number;
}

export interface PartitionOptions {
  /** Upper char bound per partition (default 120000; soft lower bound is half). */
  targetChars?: number;
  maxFiles?: number;
  maxLines?: number;
}

export interface FileImports {
  imports: string[];
  exports: string[];
}

/**
 * Nearest manifest dir walking up at most 3 levels, else the top-level dir
 * ("" for root-level files is returned as "."). The search root
 * (process.cwd()) itself is intentionally not a module: otherwise a repo
 * with a root package.json would collapse every file into one module and
 * cross-module edges could never exist.
 */
export function moduleOf(file: string): string {
  const rel = String(file).split("\\").join("/").replace(/^\.\//, "");
  const root = process.cwd().split("\\").join("/");
  const dirSegs = rel.split("/").slice(0, -1);
  for (let depth = 0; depth < SEARCH_DEPTH && depth < dirSegs.length; depth++) {
    const cand = dirSegs.slice(0, dirSegs.length - depth);
    const candRel = cand.join("/");
    const candAbs = candRel ? `${root}/${candRel}` : root;
    if (candAbs === root) continue;
    if (MANIFESTS.some((m) => existsSync(`${candAbs}/${m}`))) return candRel;
  }
  return dirSegs[0] ?? ".";
}

/** Test files: *.test.* / *.spec.*, __tests__ dirs, test(s) dirs, py/go conventions. */
export function isTestFile(file: string): boolean {
  const rel = String(file).split("\\").join("/");
  const segs = rel.split("/");
  if (segs.includes("__tests__") || segs.includes("__test__")) return true;
  if (segs.slice(0, -1).some((s) => s === "test" || s === "tests")) return true;
  const base = segs[segs.length - 1] ?? "";
  const lower = base.toLowerCase();
  if (lower.includes(".test.") || lower.includes(".spec.")) return true;
  if (/^test[_.\-]/i.test(base)) return true;
  if (/^tests[_.\-]/i.test(base)) return true;
  if (/_test\.[a-z0-9]+$/i.test(base)) return true;
  if (/^conftest\.py$/i.test(base)) return true;
  return false;
}

const IMPORT_RE = /^(import|from|require|use|mod|include)\b/;
const EXPORT_RE =
  /^(?:export\s+)?(?:default\s+)?(function|class|const|def|fn|func|type)\b\*?\s*([A-Za-z_$][\w$]*)?/;
const RESERVED = new Set(["if", "for", "while", "switch", "return", "typeof"]);

/** Specifier from an import line: first quoted string, else the first token. */
function extractSpecifier(line: string): string | null {
  const q = line.match(/['"]([^'"]+)['"]/);
  if (q) return q[1];
  const rest = line
    .replace(/^(import|from|require|use|mod|include)\b\s*/, "")
    .trim()
    .replace(/[;,]+$/, "");
  const token = rest.split(/[\s,;()]+/, 1)[0] ?? "";
  if (!token || token.startsWith("{") || token.startsWith("(") || token.startsWith("*")) {
    return null;
  }
  return token;
}

/**
 * Deterministic regex import map over line starts. Imports keep the raw
 * specifier (quoted target or bare module word); exports keep the declared
 * symbol name. `require(...)` only counts at line start, per the pattern.
 */
export function buildImportMap(files: Array<{ file: string; content: string }>): Map<
  string,
  FileImports
> {
  const map = new Map<string, FileImports>();
  for (const { file, content } of files) {
    const imports: string[] = [];
    const exports: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim().replace(/;$/, "");
      if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) {
        continue;
      }
      if (IMPORT_RE.test(line)) {
        const spec = extractSpecifier(line);
        if (spec) imports.push(spec);
      } else {
        const m = line.match(EXPORT_RE);
        if (m?.[2] && !RESERVED.has(m[2])) exports.push(m[2]);
      }
    }
    map.set(file, { imports, exports });
  }
  return map;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"];

/** Resolve a relative import specifier to a repo-relative file, or null. */
export function resolveImportSpecifier(
  fromFile: string,
  spec: string,
  allFiles: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const from = fromFile.split("\\").join("/");
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const norm: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") norm.pop();
    else norm.push(p);
  }
  const base = norm.join("/");
  const candidates = [base];
  for (const e of RESOLVE_EXTS) candidates.push(base + e);
  for (const e of RESOLVE_EXTS) candidates.push(`${base}/index${e}`);
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
}

/** Lines estimated at ~80 chars/line; only used for the maxLines cap. */
function estimateLines(chars: number): number {
  return Math.max(1, Math.ceil(chars / 80));
}

/**
 * Pack files into Partitions grouped by `moduleOf`, targeting ≤ targetChars
 * (default 120000), ≤ maxFiles (default 8), ≤ maxLines estimates (1500).
 * Whole small modules stay together; files that alone exceed a cap get
 * their own partition with priority -1. All-test partitions also get -1,
 * else 0. Boundary imports/exports/edges come from a best-effort disk read
 * of the inputs (empty when unreadable); edges are "A -> B" module strings
 * for imports resolved to a different module.
 */
export function partitionFiles(
  files: PartitionFileInput[],
  opts?: PartitionOptions,
): Partition[] {
  const maxChars = opts?.targetChars ?? 120000;
  const maxFiles = opts?.maxFiles ?? 8;
  const maxLines = opts?.maxLines ?? 1500;

  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const byModule = new Map<string, PartitionFileInput[]>();
  for (const f of sorted) {
    const m = moduleOf(f.file);
    const arr = byModule.get(m);
    if (arr) arr.push(f);
    else byModule.set(m, [f]);
  }
  const moduleNames = [...byModule.keys()].sort((a, b) => {
    const rank = (m: string): number =>
      (byModule.get(m) ?? []).every((f) => isTestFile(f.file)) ? 1 : 0;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });

  const diskContents: Array<{ file: string; content: string }> = [];
  for (const f of sorted) {
    try {
      diskContents.push({ file: f.file, content: readFileSync(join(process.cwd(), f.file), "utf8") });
    } catch {
      // unreadable (e.g. synthetic inputs): boundary stays empty for this file
    }
  }
  const importMap = buildImportMap(diskContents);
  const allFileSet = new Set(sorted.map((f) => f.file));

  const partitions: Partition[] = [];
  const counters = new Map<string, number>();

  const emit = (mod: string, group: PartitionFileInput[]): void => {
    const groupFiles = group.map((f) => f.file);
    const chars = group.reduce((s, f) => s + f.chars, 0);
    const allTest = group.every((f) => isTestFile(f.file));
    const huge =
      group.length === 1 &&
      (group[0].chars > maxChars || estimateLines(group[0].chars) > maxLines);
    const priority = allTest || huge ? -1 : 0;
    const importSet = new Set<string>();
    const exportSet = new Set<string>();
    const edgeSet = new Set<string>();
    for (const f of group) {
      const entry = importMap.get(f.file);
      if (!entry) continue;
      for (const s of entry.imports) importSet.add(s);
      for (const s of entry.exports) exportSet.add(s);
      for (const s of entry.imports) {
        const target = resolveImportSpecifier(f.file, s, allFileSet);
        if (target) {
          const targetMod = moduleOf(target);
          if (targetMod !== mod) edgeSet.add(`${mod} -> ${targetMod}`);
        }
      }
    }
    const n = counters.get(mod) ?? 0;
    counters.set(mod, n + 1);
    partitions.push({
      id: `${mod === "." ? "root" : mod}#${n}`,
      files: groupFiles,
      chars,
      priority,
      boundary: {
        imports: [...importSet].sort(),
        exports: [...exportSet].sort(),
        edges: [...edgeSet].sort(),
      },
    });
  };

  for (const mod of moduleNames) {
    const group = byModule.get(mod) ?? [];
    let cur: PartitionFileInput[] = [];
    let curChars = 0;
    let curLines = 0;
    const flush = (): void => {
      if (cur.length > 0) emit(mod, cur);
      cur = [];
      curChars = 0;
      curLines = 0;
    };
    for (const f of group) {
      const fl = estimateLines(f.chars);
      if (
        cur.length > 0 &&
        (cur.length + 1 > maxFiles || curChars + f.chars > maxChars || curLines + fl > maxLines)
      ) {
        flush();
      }
      if (cur.length === 0 && (f.chars > maxChars || fl > maxLines)) {
        emit(mod, [f]);
        continue;
      }
      cur.push(f);
      curChars += f.chars;
      curLines += fl;
    }
    flush();
  }
  return partitions;
}

/**
 * Changed files plus one-hop neighbors: files they import (importees) and
 * files that import them (importers), via relative-specifier resolution
 * against allFiles. Bare specifiers are not resolvable and ignored.
 */
export function expandScope(
  changed: Set<string>,
  importMap: Map<string, FileImports>,
  allFiles: string[],
): Set<string> {
  const fileSet = new Set(allFiles);
  const deps = new Map<string, Set<string>>();
  for (const [f, entry] of importMap) {
    for (const spec of entry.imports) {
      const target = resolveImportSpecifier(f, spec, fileSet);
      if (target && target !== f) {
        const s = deps.get(f);
        if (s) s.add(target);
        else deps.set(f, new Set([target]));
      }
    }
  }
  const out = new Set(changed);
  for (const c of changed) {
    for (const d of deps.get(c) ?? []) out.add(d);
  }
  for (const [f, ds] of deps) {
    for (const c of changed) {
      if (ds.has(c)) {
        out.add(f);
        break;
      }
    }
  }
  return out;
}
