/**
 * Smoke test: ensures the package exports are correctly configured.
 *
 * Tests that the main "." export points to the expected dist output.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "../package.json");

describe("package exports", () => {
  it("exposes main \".\" export pointing to dist/index.js", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["."].import).toBe("./dist/index.js");
  });
});
