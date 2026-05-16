/**
 * Thin wrapper around the user's globally installed `openclaw` CLI.
 *
 * Used by the IM-side slash command handlers in index.ts (/octo_info,
 * /octo_add_account, /octo_remove_account) to read/write OpenClaw config
 * and restart the gateway after changes.
 *
 * Scope is intentionally narrow: just the helpers index.ts needs. The full
 * plugin lifecycle (install/update/uninstall/doctor) lived here previously
 * but was moved out — ClawHub handles install/update, and the legacy
 * dmwork→octo migration stays in the octo-adapters npm package.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// OpenClaw CLI binary discovery (handles Windows .cmd shims + npx isolation)
// ---------------------------------------------------------------------------

/**
 * Find the user's globally installed openclaw, skipping the npx environment.
 *
 * npx installs openclaw as a peerDependency, which may be a newer version
 * than the user's server. Using the npx version to write openclaw.json
 * causes version incompatibility crashes on older OpenClaw servers.
 */
function findGlobalOpenclaw(): string {
  const isWindows = process.platform === "win32";

  for (const cmd of ["which -a openclaw", "where openclaw"]) {
    try {
      const output = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const paths = output
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter((p) =>
          p.length > 0 &&
          !p.includes("_npx") &&
          !p.includes("npx-cache") &&
          !p.includes("node_modules"),
        );
      if (paths.length > 0) {
        if (isWindows) {
          const cmdShim = paths.find((p) => /\.cmd$/i.test(p));
          if (cmdShim) return cmdShim;
        }
        return paths[0];
      }
    } catch {
      // command not available on this platform
    }
  }

  if (isWindows) {
    try {
      const npmResolved = resolveCommand("npm");
      let prefix: string;
      if (/\.cmd$/i.test(npmResolved)) {
        const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        prefix = execFileSync(comspec, ["/d", "/v:off", "/c", "call", npmResolved, "config", "get", "prefix"], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } else {
        prefix = execSync("npm config get prefix", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      }
      if (prefix) {
        const cmdPath = resolve(prefix, "openclaw.cmd");
        if (existsSync(cmdPath)) return cmdPath;
      }
    } catch { /* npm not available */ }
  }

  for (const p of [
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
    resolve(homedir(), ".npm-global", "bin", "openclaw"),
  ]) {
    if (existsSync(p)) return p;
  }

  return "openclaw";
}

const IS_WINDOWS = process.platform === "win32";

function resolveCommand(name: string): string {
  if (IS_WINDOWS) {
    try {
      const output = execSync(`where.exe ${name}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const paths = output.split(/\r?\n/).map((p) => p.trim()).filter((p) => p.length > 0);
      const cmdShim = paths.find((p) => /\.cmd$/i.test(p));
      if (cmdShim) return cmdShim;
      if (paths.length > 0) return paths[0];
    } catch { /* not found */ }
  }
  return name;
}

function escapeCmdArg(a: string): string {
  let s = a.replace(/%/g, "%%");
  if (/[&|<>^()"\s]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function escapeCmdArgs(args: string[]): string[] {
  return args.map(escapeCmdArg);
}

const OPENCLAW = findGlobalOpenclaw();
const NEEDS_SHELL = IS_WINDOWS && /\.cmd$/i.test(OPENCLAW);

function runOpenclaw(args: string[], opts: Record<string, unknown> = {}): string {
  if (NEEDS_SHELL) {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    return execFileSync(comspec, ["/d", "/v:off", "/c", "call", OPENCLAW, ...escapeCmdArgs(args)], { encoding: "utf-8", ...opts } as any) as unknown as string;
  }
  return execFileSync(OPENCLAW, args, { encoding: "utf-8", ...opts } as any) as unknown as string;
}

// ---------------------------------------------------------------------------
// Config get/set (passes through to `openclaw config`)
// ---------------------------------------------------------------------------

/**
 * Strip OpenClaw stdout noise (banner, plugin log lines, timestamps).
 * Older OpenClaw versions mix these into stdout alongside the actual value.
 */
function stripStdoutNoise(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^[\u{1F980}\u{1F600}-\u{1FAFF}]/u.test(t)) return false;  // emoji banner
      if (/^\[[\w-]+\]/.test(t)) return false;                       // [plugins] / [octo]
      if (/^\d{1,2}:\d{2}(:\d{2})?\s*\[/.test(t)) return false;      // timestamped log
      return true;
    })
    .join("\n")
    .trim();
}

export function configGet(path: string): string | null {
  try {
    const raw = runOpenclaw(["config", "get", path], { stdio: ["pipe", "pipe", "pipe"] });
    const val = stripStdoutNoise(raw);
    return val === "" ? null : val;
  } catch {
    return null;
  }
}

export function configGetJson(path: string): any {
  try {
    const out = runOpenclaw(["config", "get", path, "--json"], { stdio: ["pipe", "pipe", "pipe"] });
    const jsonStart = out.indexOf("{");
    const arrStart = out.indexOf("[");
    const start = jsonStart >= 0 && arrStart >= 0
      ? Math.min(jsonStart, arrStart)
      : Math.max(jsonStart, arrStart);
    if (start < 0) return null;
    const openChar = out[start];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    let end = -1;
    for (let i = start; i < out.length; i++) {
      if (out[i] === openChar) depth++;
      else if (out[i] === closeChar) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function configSet(path: string, value: string): void {
  runOpenclaw(["config", "set", path, value], { stdio: ["pipe", "pipe", "pipe"] });
}

export function configUnset(path: string): void {
  runOpenclaw(["config", "unset", path], { stdio: ["pipe", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------
// Plugin inspect (used by /octo_info to show installed version)
// ---------------------------------------------------------------------------

export interface PluginInspectResult {
  plugin?: { id: string; version: string; enabled: boolean };
  install?: { source: string; version: string; installPath: string };
}

export function pluginsInspect(id: string): PluginInspectResult | null {
  try {
    const out = runOpenclaw(["plugins", "inspect", id, "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) return null;
    return JSON.parse(out.slice(jsonStart));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gateway control (used after config writes to apply changes live)
// ---------------------------------------------------------------------------

export function gatewayRestart(quiet?: boolean): boolean {
  try {
    runOpenclaw(["gateway", "restart"], {
      stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Version (used by /octo_info)
// ---------------------------------------------------------------------------

export function getOpenClawVersion(): string | null {
  try {
    const out = runOpenclaw(["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = out.match(/(\d{4}\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.error(`Failed to execute openclaw --version: ${err?.message ?? err}`);
    return null;
  }
}
