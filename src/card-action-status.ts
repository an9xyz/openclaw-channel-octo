export type CardActionStatus = "processing" | "completed" | "error";

interface StatusParams {
  card: Record<string, unknown>;
  plain: string;
  inputs?: Record<string, string>;
  operator: string;
  actionLabel: string;
  status: CardActionStatus;
  errorText?: string;
}

function freezeInput(
  element: Record<string, unknown>,
  inputs: Record<string, string>,
  selections: string[],
): Record<string, unknown> | null {
  const id = typeof element.id === "string" ? element.id : "";
  if (!id || !Object.hasOwn(inputs, id)) return null;
  const rawValue = inputs[id];
  let displayValue = rawValue;
  if (element.type === "Input.ChoiceSet" && Array.isArray(element.choices)) {
    const selected = element.choices.find((choice) => (
      choice && typeof choice === "object" && (choice as { value?: unknown }).value === rawValue
    )) as { title?: unknown } | undefined;
    if (typeof selected?.title === "string") displayValue = selected.title;
  }
  const label = typeof element.label === "string" && element.label.trim() ? element.label.trim() : id;
  const text = `${label}：${displayValue}`;
  selections.push(text);
  return { type: "TextBlock", text, wrap: true, spacing: "Small" };
}

function freezeElement(
  element: Record<string, unknown>,
  inputs: Record<string, string>,
  selections: string[],
): Record<string, unknown> | null {
  if (typeof element.type === "string" && element.type.startsWith("Input.")) {
    return freezeInput(element, inputs, selections);
  }
  const frozen: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (Array.isArray(value)) {
      frozen[key] = value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
        const child = freezeElement(item as Record<string, unknown>, inputs, selections);
        return child ? [child] : [];
      });
    } else {
      frozen[key] = value;
    }
  }
  return frozen;
}

/** Preserve the authored card body, freeze submitted inputs, remove actions, and append status. */
export function renderCardActionStatus(params: StatusParams): { card: Record<string, unknown>; plain: string } {
  const statusLine = params.status === "processing"
    ? `⏳ ${params.operator} 正在处理「${params.actionLabel}」`
    : params.status === "completed"
      ? `✅ ${params.operator} 已选择「${params.actionLabel}」`
      : `⚠️ ${params.errorText ?? "处理失败"}`;
  const selections: string[] = [];
  const inputs = params.inputs ?? {};
  const sourceBody = Array.isArray(params.card.body) ? params.card.body : [];
  const body = sourceBody.flatMap((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return [];
    const frozen = freezeElement(element as Record<string, unknown>, inputs, selections);
    return frozen ? [frozen] : [];
  });
  body.push({ type: "TextBlock", text: statusLine, wrap: true, spacing: "Medium", separator: true });

  const { actions: _actions, ...cardWithoutActions } = params.card;
  const basePlain = params.plain
    .split("\n")
    .filter((line) => !line.startsWith("可选操作："))
    .join("\n")
    .trim();
  const plain = [...(basePlain ? [basePlain] : []), ...selections, statusLine].join("\n");
  return {
    card: { ...cardWithoutActions, body },
    plain,
  };
}
