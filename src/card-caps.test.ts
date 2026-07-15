import { describe, expect, it } from "vitest";
import { deriveCardCaps } from "./card-caps.js";

describe("deriveCardCaps", () => {
  it("保留显式空 capability 数组作为权威结果", () => {
    const caps = deriveCardCaps({
      available: true,
      enabled: true,
      elements: [],
      inputs: [],
      actions: [],
    });

    expect(caps.elements).toEqual(new Set());
    expect(caps.inputs).toEqual(new Set());
    expect(caps.actions).toEqual(new Set());
  });

  it("只接受有限正数 limits 并归一为整数", () => {
    const caps = deriveCardCaps({
      available: true,
      enabled: true,
      limits: {
        max_nodes: 200.9,
        max_depth: 0,
        max_payload_bytes: Number.POSITIVE_INFINITY,
        max_input_text_bytes: 4096.8,
        max_inputs_bytes: 16384,
      },
    });

    expect(caps).toEqual({
      maxNodes: 200,
      maxInputTextBytes: 4096,
      maxInputsBytes: 16384,
    });
  });
});
