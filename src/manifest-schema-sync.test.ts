import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OctoConfigJsonSchema } from "./config-schema.js";

// Regression guard for OpenClaw v2026.5.x channel manifest requirement:
// openclaw.plugin.json#channelConfigs.octo.schema must stay in sync
// with OctoConfigJsonSchema, otherwise the Control UI / config validator
// and the runtime zod pipeline disagree.

describe("openclaw.plugin.json channelConfigs", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf-8"),
  );

  it("declares channelConfigs.octo.schema", () => {
    expect(manifest.channelConfigs?.octo?.schema).toBeDefined();
  });

  it("manifest schema properties match OctoConfigJsonSchema properties", () => {
    const manifestProps = manifest.channelConfigs.octo.schema.properties;
    const tsProps = OctoConfigJsonSchema.schema.properties;
    // Key-level compare — catches additions/removals on either side
    expect(Object.keys(manifestProps).sort()).toEqual(Object.keys(tsProps).sort());
  });

  it("manifest accounts schema matches OctoConfigJsonSchema accounts", () => {
    const manifestAccountProps =
      manifest.channelConfigs.octo.schema.properties.accounts.additionalProperties.properties;
    const tsAccountProps =
      (OctoConfigJsonSchema.schema.properties.accounts as any).additionalProperties.properties;
    expect(Object.keys(manifestAccountProps).sort()).toEqual(
      Object.keys(tsAccountProps).sort(),
    );
  });
});
