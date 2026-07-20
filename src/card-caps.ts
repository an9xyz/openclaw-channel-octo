import type { CardProfileManifest } from "./api-fetch.js";
import type { CardCaps } from "./card-render.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

const ACTION_SUBMIT = "Action.Submit";

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

/**
 * D12 reserves `actions` for local/navigation actions. Submit callback support is advertised by
 * the `octo/v2` profile itself, so translate that profile into the builder's semantic capability.
 */
export function deriveInteractiveCardCaps(manifest: CardProfileManifest): CardCaps {
  const caps = deriveCardCaps(manifest);
  const actions = new Set(caps.actions ?? []);
  actions.delete(ACTION_SUBMIT);
  if (manifest.profiles?.includes(CARD_INTERACTIVE_PROFILE)) actions.add(ACTION_SUBMIT);
  return { ...caps, actions };
}
