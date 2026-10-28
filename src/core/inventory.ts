// File inventory: recursive walk with passive secret/binary/exclusion filters.
// All paths are repo-relative with forward slashes. Only Node builtins.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface InventoryEntry {
  file: string;
  abs: string;
  mtimeMs: number;
  bytes: number;
}

export interface InventoryOptions {
  /** Keep only files matching at least one glob. Absent/empty = keep all. */
  include?: string[];
  /** Extra glob patterns (files or dirs) on top of the defaults. */
  exclude?: string[];
  maxFileBytes?: number;
}

/** Directory names skipped at any depth during the walk. */
export const DEFAULT_EXCLUDE_DIRS: string[] = [
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "vendor",
  "target",
  "__pycache__",
  ".audit",
  "coverage",
];

/**
 * File patterns skipped during the walk. Bare names match a full path
 * segment or the basename; patterns with "/" match the repo-relative path.
 * `*` never crosses "/" except in `**`.
 */
export const DEFAULT_EXCLUDE_FILES: string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "*.min.js",
  "*.map",
  "*.generated.*",
  "*.pb.*",
  "generated/**",
];

/**
 * Small passive secret-name list. Used as a substring signal for redaction
 * decisions; `hasSecretContent` applies a stricter filename rule for "key"
 * (extension only) so ordinary words like "keyboard" are not skipped.
 */
export const DEFAULT_REDACT: string[] = ["pem", "key", "token", "secret", "password"];

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const SECRET_EXTS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const SECRET_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".env"]);
const SECRET_SUBSTRINGS = ["secret", "token", "password", "passwd", "credential"];

/**
 * True for binary-looking files (NUL byte in the first 8 KiB) or
 * secret-file names (key material extensions, .env, key names, or
 * secret/token/password/credential in the basename). Missing or unreadable
 * paths return false.
 */
export function hasSecretContent(absPath: string): boolean {
  const base = basename(absPath).toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  if (SECRET_EXTS.has(ext)) return true;
  if (SECRET_BASENAMES.has(base) || base.startsWith(".env.")) return true;
  if (
    base.startsWith("id_rsa") ||
    base.startsWith("id_dsa") ||
    base.startsWith("id_ecdsa") ||
    base.startsWith("id_ed25519")
  ) {
    return true;
  }
  for (const s of SECRET_SUBSTRINGS) {
    if (base.includes(s)) return true;
  }
  let fd = -1;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors on an already-handled fd
      }
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesPattern(rel: string, pattern: string): boolean {
  const p = pattern.split("\\").join("/");
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? rel;
  if (!p.includes("/")) {
    if (segs.includes(p)) return true;
    return globToRegExp(p).test(base);
  }
  return globToRegExp(p).test(rel);
}

function isExcludedDir(rel: string, extra?: string[]): boolean {
  const segs = rel.split("/");
  for (const d of DEFAULT_EXCLUDE_DIRS) {
    if (segs.includes(d)) return true;
  }
  if (extra) {
    for (const p of extra) {
      if (matchesPattern(rel, p)) return true;
    }
  }
  return false;
}

function isExcludedFile(rel: string, extra?: string[]): boolean {
  for (const p of DEFAULT_EXCLUDE_FILES) {
    if (matchesPattern(rel, p)) return true;
  }
  if (extra) {
    for (const p of extra) {
      if (matchesPattern(rel, p)) return true;
    }
  }
  return false;
}

/**
 * Recursive walk returning repo-relative entries sorted by path.
 * Skips excluded dirs/files, non-matching `include` globs, files over
 * `maxFileBytes`, and secret/binary content. Symlinks are skipped to avoid
 * cycles. Per-file I/O errors skip that file.
 */
export function inventory(root: string, opts?: InventoryOptions): InventoryEntry[] {
  const absRoot = resolve(root);
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const out: InventoryEntry[] = [];

  const walk = (dirAbs: string): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dirAbs, e.name);
      if (e.isSymbolicLink()) continue;
      const rel = relative(absRoot, abs).split(sep).join("/");
      if (e.isDirectory()) {
        if (isExcludedDir(rel, opts?.exclude)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (isExcludedFile(rel, opts?.exclude)) continue;
        if (opts?.include && opts.include.length > 0) {
          if (!opts.include.some((p) => matchesPattern(rel, p))) continue;
        }
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > maxFileBytes) continue;
        if (hasSecretContent(abs)) continue;
        out.push({ file: rel, abs, mtimeMs: st.mtimeMs, bytes: st.size });
      }
    }
  };

  walk(absRoot);
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

function stripQuotes(p: string): string {
  const t = p.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/**
 * Repo-relative changed paths: union of `git status --porcelain` (covers
 * untracked) and `git diff --name-only HEAD`, filtered through the default
 * excludes. Falls back to the full inventory file list when git fails
 * (not a repo, no git binary, etc.).
 */
export function changedFiles(root: string): Set<string> {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const diff = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = new Set<string>();
    const add = (p: string): void => {
      if (!p) return;
      if (isExcludedDir(p) || isExcludedFile(p)) return;
      out.add(p);
    };
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      let p = stripQuotes(line.slice(3));
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = stripQuotes(p.slice(arrow + 4));
      add(p);
    }
    for (const line of diff.split("\n")) {
      add(stripQuotes(line));
    }
    return out;
  } catch {
    return new Set(inventory(root).map((e) => e.file));
  }
}

/** `git rev-parse HEAD` trimmed, or "unknown" when unavailable. */
export function headCommit(root: string): string {
  try {
    const s = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return s.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
