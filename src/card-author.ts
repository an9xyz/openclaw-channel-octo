import { cardFitsLimits } from "./card-limits.js";
import { cardSupports, isSensitive, reduceUrlsInText, type CardCaps } from "./card-render.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

export interface CardButtonSpec {
  id: string;
  label: string;
  data?: Record<string, unknown>;
  style?: "positive" | "destructive";
}

export interface CardInputSpec {
  id: string;
  kind?: "text" | "number" | "date" | "time" | "toggle" | "choice";
  label?: string;
  placeholder?: string;
  choices?: Array<{ title: string; value: string }>;
}

export interface InteractiveCardSpec {
  title: string;
  text?: string;
  buttons: CardButtonSpec[];
  inputs?: CardInputSpec[];
}

export interface BuiltInteractiveCard {
  ok: true;
  card: Record<string, unknown>;
  plain: string;
  title: string;
  actionLabels: Record<string, string>;
}

type BuildFailure = { ok: false; error: string };

const MAX_BUTTONS = 6;
const MAX_INPUTS = 5;
const MAX_TITLE = 200;
const MAX_TEXT = 2_000;
const MAX_LABEL = 64;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRET_KEY = /token|secret|password|passwd|pwd|authorization|bearer|api[_-]?key|client[_-]?secret/i;

const INPUT_TYPES: Record<NonNullable<CardInputSpec["kind"]>, string> = {
  text: "Input.Text",
  number: "Input.Number",
  date: "Input.Date",
  time: "Input.Time",
  toggle: "Input.Toggle",
  choice: "Input.ChoiceSet",
};

function failure(error: string): BuildFailure {
  return { ok: false, error };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const reduced = reduceUrlsInText(value).trim();
  if (!reduced || isSensitive(reduced, true)) return null;
  return reduced.length > max ? `${reduced.slice(0, max)}…` : reduced;
}

function sanitizeData(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    const reduced = reduceUrlsInText(value).trim();
    return isSensitive(reduced, true) ? "[redacted]" : reduced.slice(0, 512);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeData(item, "", depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[childKey] = sanitizeData(childValue, childKey, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function buildInteractiveCard(
  spec: InteractiveCardSpec,
  caps?: CardCaps,
): BuiltInteractiveCard | BuildFailure {
  const title = cleanText(spec.title, MAX_TITLE);
  if (!title) return failure("title is required and must not contain sensitive data");
  if (caps && !cardSupports(caps, "TextBlock")) return failure("TextBlock is not supported");
  if (caps && !cardSupports(caps, "Action.Submit")) return failure("Action.Submit is not supported");

  if (!Array.isArray(spec.buttons) || spec.buttons.length === 0) {
    return failure("at least one button is required");
  }
  if (spec.buttons.length > MAX_BUTTONS) return failure(`too many buttons (max ${MAX_BUTTONS})`);

  const actionIds = new Set<string>();
  const actions: Record<string, unknown>[] = [];
  const actionLabels: Record<string, string> = {};
  for (const button of spec.buttons) {
    const id = typeof button.id === "string" ? button.id.trim() : "";
    const label = cleanText(button.label, MAX_LABEL);
    if (!ID_PATTERN.test(id)) return failure("button id must be 1-64 safe characters");
    if (!label) return failure(`button ${id} requires a safe label`);
    if (actionIds.has(id)) return failure(`duplicate button id: ${id}`);
    actionIds.add(id);
    const action: Record<string, unknown> = { type: "Action.Submit", id, title: label };
    if (button.data && typeof button.data === "object") action.data = sanitizeData(button.data);
    if (button.style === "positive" || button.style === "destructive") action.style = button.style;
    actions.push(action);
    actionLabels[id] = label;
  }

  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
  ];
  const plainLines = [title];
  const text = spec.text ? cleanText(spec.text, MAX_TEXT) : null;
  if (spec.text && !text) return failure("text contains sensitive or invalid content");
  if (text) {
    body.push({ type: "TextBlock", text, wrap: true, spacing: "Small" });
    plainLines.push(text);
  }

  const inputs = spec.inputs ?? [];
  if (!Array.isArray(inputs)) return failure("inputs must be an array");
  if (inputs.length > MAX_INPUTS) return failure(`too many inputs (max ${MAX_INPUTS})`);
  const inputIds = new Set<string>();
  const inputNodes: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!ID_PATTERN.test(id)) return failure("input id must be 1-64 safe characters");
    if (inputIds.has(id)) return failure(`duplicate input id: ${id}`);
    inputIds.add(id);
    const kind = input.kind ?? "text";
    const type = INPUT_TYPES[kind];
    if (!type) return failure(`unsupported input kind: ${String(kind)}`);
    if (caps && !cardSupports(caps, type)) return failure(`${type} is not supported`);

    const node: Record<string, unknown> = { type, id };
    if (input.label) {
      const label = cleanText(input.label, MAX_LABEL);
      if (!label) return failure(`input ${id} has an invalid label`);
      node.label = label;
    }
    if (kind === "choice") {
      if (!Array.isArray(input.choices) || input.choices.length === 0) {
        return failure(`choice input ${id} requires choices`);
      }
      const choices: Array<{ title: string; value: string }> = [];
      for (const choice of input.choices.slice(0, 50)) {
        const choiceTitle = cleanText(choice.title, MAX_LABEL);
        const choiceValue = cleanText(choice.value, MAX_LABEL);
        if (!choiceTitle || !choiceValue) return failure(`choice input ${id} contains invalid choices`);
        choices.push({ title: choiceTitle, value: choiceValue });
      }
      node.choices = choices;
    } else if (input.placeholder) {
      const placeholder = cleanText(input.placeholder, MAX_LABEL);
      if (!placeholder) return failure(`input ${id} has an invalid placeholder`);
      node.placeholder = placeholder;
    }
    if (kind === "text" && caps?.maxInputTextBytes) {
      // Adaptive Cards maxLength counts characters; divide by four for a conservative UTF-8 cap.
      node.maxLength = Math.max(1, Math.floor(caps.maxInputTextBytes / 4));
    }
    inputNodes.push(node);
    plainLines.push(`[${String(node.label ?? id)}]`);
  }

  if (
    caps?.maxInputsBytes &&
    new TextEncoder().encode(JSON.stringify(inputNodes)).byteLength > caps.maxInputsBytes
  ) {
    return failure("input definitions exceed max_inputs_bytes");
  }
  body.push(...inputNodes);
  plainLines.push(`可选操作：${Object.values(actionLabels).join(" / ")}`);

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions,
  };
  const plain = plainLines.join("\n");
  if (!cardFitsLimits(card, plain, caps, CARD_INTERACTIVE_PROFILE)) {
    return failure("interactive card exceeds negotiated limits");
  }
  return { ok: true, card, plain, title, actionLabels };
}
