import type { CardProfileManifest } from "./api-fetch.js";
import type { CardCaps } from "./card-render.js";

function positiveFiniteLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

/** Convert the server manifest into one authoritative set of renderer capabilities. */
export function deriveCardCaps(manifest: CardProfileManifest): CardCaps {
  const limits = manifest.limits;
  const maxNodes = positiveFiniteLimit(limits?.max_nodes);
  const maxDepth = positiveFiniteLimit(limits?.max_depth);
  const maxPayloadBytes = positiveFiniteLimit(limits?.max_payload_bytes);
  const maxInputTextBytes = positiveFiniteLimit(limits?.max_input_text_bytes);
  const maxInputsBytes = positiveFiniteLimit(limits?.max_inputs_bytes);

  return {
    ...(Array.isArray(manifest.elements) ? { elements: new Set(manifest.elements) } : {}),
    ...(Array.isArray(manifest.inputs) ? { inputs: new Set(manifest.inputs) } : {}),
    ...(Array.isArray(manifest.actions) ? { actions: new Set(manifest.actions) } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
    ...(maxInputTextBytes !== undefined ? { maxInputTextBytes } : {}),
    ...(maxInputsBytes !== undefined ? { maxInputsBytes } : {}),
  };
}
