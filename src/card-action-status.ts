export type CardActionStatus = "processing" | "completed" | "error";

export function renderCardActionStatus(params: {
  title: string;
  operator: string;
  actionLabel: string;
  status: CardActionStatus;
  errorText?: string;
}): { card: Record<string, unknown>; plain: string } {
  const statusLine = params.status === "processing"
    ? `⏳ ${params.operator} 正在处理「${params.actionLabel}」`
    : params.status === "completed"
      ? `✅ ${params.operator} 已完成「${params.actionLabel}」`
      : `⚠️ ${params.errorText ?? "处理失败"}`;
  const plain = `${params.title}\n${statusLine}`;
  return {
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [
        { type: "TextBlock", text: params.title, weight: "Bolder", size: "Medium", wrap: true },
        { type: "TextBlock", text: statusLine, wrap: true, spacing: "Small" },
      ],
    },
    plain,
  };
}
