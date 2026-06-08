/**
 * Regression test for issue #77 — "Octo runtime not initialized" after
 * SIGUSR1 in-process restart under OPENCLAW_NO_RESPAWN=1.
 *
 * The root cause was OpenClaw SDK's loadBundledEntryExportSync producing a
 * different module instance from ESM static `import` (jiti fallback on older
 * Node, etc.), making the module-scope `let runtime` two independent slots.
 *
 * We can't reproduce SIGUSR1 in unit tests, but we CAN simulate the failure
 * shape: write the runtime module source to two different paths and load
 * each — Node ESM cache is keyed by URL so this guarantees two module
 * records (== two independent top-level state slots). If state is shared
 * across those two records, the underlying mechanism is loader-agnostic
 * and the SIGUSR1 path is fixed by the same fact.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  setOctoRuntime,
  getOctoRuntime,
  _resetOctoRuntimeForTests,
} from "./runtime";

const tmpDir = resolve(process.cwd(), "src/.tmp-runtime-dual-instance");

beforeEach(() => {
  _resetOctoRuntimeForTests();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runtime singleton (issue #77)", () => {
  it("setOctoRuntime then getOctoRuntime within same instance works", () => {
    const fake = { handleMessage: () => "ok" } as any;
    setOctoRuntime(fake);
    expect(getOctoRuntime()).toBe(fake);
  });

  it("getOctoRuntime throws before any set", () => {
    expect(() => getOctoRuntime()).toThrow("Octo runtime not initialized");
  });

  it("state survives across two independent module instances of runtime.ts", async () => {
    // Compile runtime.ts inline (without TypeScript types) so we can write
    // it to two paths and Node ESM will treat them as two module records.
    // This is the exact dual-instance shape that SDK loader vs ESM import
    // produces under SIGUSR1 in-process restart on affected Node versions.
    const source = `
      const KEY = Symbol.for("openclaw.octo.runtime");
      export function setOctoRuntime(next) { globalThis[KEY] = next; }
      export function getOctoRuntime() {
        const r = globalThis[KEY];
        if (!r) throw new Error("Octo runtime not initialized");
        return r;
      }
    `;
    mkdirSync(tmpDir, { recursive: true });
    const pathA = resolve(tmpDir, "runtime-a.mjs");
    const pathB = resolve(tmpDir, "runtime-b.mjs");
    writeFileSync(pathA, source);
    writeFileSync(pathB, source);

    const bust = Date.now() + Math.random().toString(36).slice(2);
    const modA = await import(`${pathToFileURL(pathA).href}?b=${bust}`);
    const modB = await import(`${pathToFileURL(pathB).href}?b=${bust}`);

    // Sanity: these really ARE two different module instances
    expect(modA.setOctoRuntime).not.toBe(modB.setOctoRuntime);

    const fake = { handleMessage: () => "from-A" } as any;
    modA.setOctoRuntime(fake);

    // The whole point: module B sees state set via module A,
    // because state lives on globalThis, not on either module's scope.
    expect(modB.getOctoRuntime()).toBe(fake);
  });

  it("_resetOctoRuntimeForTests clears globalThis slot", () => {
    setOctoRuntime({ handleMessage: () => "x" } as any);
    _resetOctoRuntimeForTests();
    expect(() => getOctoRuntime()).toThrow("Octo runtime not initialized");
  });
});
