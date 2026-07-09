/**
 * Tier-1 端到端联调（对真实 octo-server），env-gated —— 无 OCTO_E2E_* 环境变量时整组 skip，
 * 不进 CI 默认路径、不含任何密钥（凭据只从环境读）。
 *
 * 用真实 fetch 直打 D12 端点与 send/edit，验证单测 mock 不到的两件事:
 *   1. 真实 manifest 能解析出 elements/inputs/limits（wire 契约对得上 pkg/cardmsg 导出）;
 *   2. 服务端 pkg/cardmsg 真的接受我们在 advertise 后发的 ColumnSet 卡（200 而非 400），
 *      且 transient 中间帧 + 终态帧 edit 均 200。
 *
 * 跑法:
 *   OCTO_E2E_API_URL=… OCTO_E2E_BOT_TOKEN=… [OCTO_E2E_CHANNEL=… [OCTO_E2E_CHANNEL_TYPE=2]] \
 *     npx vitest run src/card-e2e.test.ts
 *   仅给 API_URL+BOT_TOKEN → 只跑只读 manifest 探测（零副作用）;
 *   再给 CHANNEL → 追加 send/edit 往返（会向该频道发一条真实进度卡）。
 */
import { describe, it, expect } from "vitest";
import { getCardProfile, sendCardMessage, editCardMessage } from "./api-fetch.js";
import { renderProgressCard, type CardCaps } from "./card-render.js";
import { ChannelType } from "./types.js";

const API = process.env.OCTO_E2E_API_URL;
const TOKEN = process.env.OCTO_E2E_BOT_TOKEN;
const CHANNEL = process.env.OCTO_E2E_CHANNEL;
const CHANNEL_TYPE = Number(process.env.OCTO_E2E_CHANNEL_TYPE ?? ChannelType.Group);

const suite = API && TOKEN ? describe : describe.skip;

suite("card E2E（真实 octo-server）", () => {
  it("getCardProfile:真实 manifest 可解析(elements/inputs/limits)", async () => {
    const m = await getCardProfile({ apiUrl: API!, botToken: TOKEN! });
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] manifest =", JSON.stringify(m, null, 2));
    expect(m.available).toBe(true);
    if (m.elements !== undefined) expect(Array.isArray(m.elements)).toBe(true);
    if (m.inputs !== undefined) expect(Array.isArray(m.inputs)).toBe(true);
  });

  const sendIt = API && TOKEN && CHANNEL ? it : it.skip;
  sendIt("send/edit/terminal 往返 + 服务端接受渲染后的卡", async () => {
    const m = await getCardProfile({ apiUrl: API!, botToken: TOKEN! });
    const caps: CardCaps = {
      ...(m.elements ? { elements: new Set(m.elements) } : {}),
      ...(typeof m.limits?.max_nodes === "number" ? { maxNodes: m.limits.max_nodes as number } : {}),
    };
    // 探针:OCTO_E2E_FORCE_COLUMNS=1 时强制 advertise ColumnSet+Column,验证 octo/v1 是否接受
    // 列布局(即便本部署 manifest 尚未 advertise elements)—— 回答"server 端上线 elements 后我们发
    // ColumnSet 会不会 400"。
    if (process.env.OCTO_E2E_FORCE_COLUMNS === "1") {
      caps.elements = new Set([...(caps.elements ?? []), "TextBlock", "ColumnSet", "Column"]);
    }
    const steps = [
      { tool: "read", status: "done" as const, summary: "/work/README.md", durationMs: 180 },
      { tool: "exec", status: "done" as const, summary: "ls -la", durationMs: 220 },
    ];
    const { card, plain } = renderProgressCard({ phase: "tool", steps }, caps);
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] send card =", JSON.stringify(card));
    const res = await sendCardMessage({
      apiUrl: API!, botToken: TOKEN!, channelId: CHANNEL!, channelType: CHANNEL_TYPE, card, plain,
    });
    expect(res?.message_id).toBeTruthy();

    // transient 中间帧（不进修订历史）
    await editCardMessage({
      apiUrl: API!, botToken: TOKEN!, messageId: res!.message_id!, channelId: CHANNEL!,
      channelType: CHANNEL_TYPE, card, plain, transient: true,
    });

    // 终态帧（进修订历史）
    const done = renderProgressCard({ phase: "done", steps, elapsedMs: 1600 }, caps);
    await editCardMessage({
      apiUrl: API!, botToken: TOKEN!, messageId: res!.message_id!, channelId: CHANNEL!,
      channelType: CHANNEL_TYPE, card: done.card, plain: done.plain,
    });
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] round-trip ok, message_id =", res!.message_id);
  });
});
