import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock api-fetch so the send paths don't hit the network. Mirrors the
// mocking style used by channel.test.ts.
vi.mock("./api-fetch.js", async () => {
  const actual = await vi.importActual<any>("./api-fetch.js");
  return {
    ...actual,
    sendMessage: vi.fn().mockResolvedValue({
      message_id: "msg-text-1",
      client_msg_no: "cli-1",
      message_seq: 1,
    }),
    sendMediaMessage: vi.fn().mockResolvedValue({
      message_id: "msg-media-1",
      client_msg_no: "cli-2",
      message_seq: 2,
    }),
    getUploadPresign: vi.fn().mockResolvedValue({
      uploadUrl: "https://upload.example/put",
      downloadUrl: "https://cdn.example/file.png",
      contentType: "image/png",
      contentDisposition: "inline",
    }),
    uploadFileToPresignedUrl: vi.fn().mockResolvedValue({ url: "https://cdn.example/file.png" }),
    registerBot: vi.fn(),
    sendHeartbeat: vi.fn(),
    fetchBotGroups: vi.fn().mockResolvedValue([]),
    getGroupMd: vi.fn(),
  };
});

import { octoPlugin } from "./channel.js";
import { CHANNEL_ID } from "./constants.js";

/**
 * Sprint A (#111): migrate octo from the legacy `outbound` slot to the new
 * `message` (ChannelMessageAdapterShape) slot via
 * createChannelMessageAdapterFromOutbound, keeping `outbound` as the
 * presentation-layer fallback (chunker/sanitize/pin are read from `outbound`
 * by the runtime; send.* prefers `message`). See
 * node_modules/openclaw/dist/deliver-*.js createPluginHandler.
 */

const baseCfg = {
  channels: {
    octo: {
      accounts: {
        default: { botToken: "bf_test", apiUrl: "https://octo.example" },
      },
    },
  },
};

describe("#111 Sprint A — message adapter slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares a message slot with send.text and send.media", () => {
    expect(octoPlugin.message).toBeDefined();
    expect(typeof octoPlugin.message?.send?.text).toBe("function");
    expect(typeof octoPlugin.message?.send?.media).toBe("function");
  });

  it("declares durableFinal capabilities for text and media", () => {
    expect(octoPlugin.message?.durableFinal?.capabilities?.text).toBe(true);
    expect(octoPlugin.message?.durableFinal?.capabilities?.media).toBe(true);
  });

  it("keeps the legacy outbound slot for presentation-layer fallback", () => {
    // Runtime still reads chunker/sanitizeText/pin from outbound even when
    // message.send.* is present; removing outbound would drop those hooks.
    expect(octoPlugin.outbound).toBeDefined();
    expect(typeof octoPlugin.outbound?.sendText).toBe("function");
    expect(typeof octoPlugin.outbound?.sendMedia).toBe("function");
  });

  it("message.send.text returns a MessageReceipt carrying the real message_id", async () => {
    const result = await octoPlugin.message!.send!.text!({
      cfg: baseCfg as any,
      to: "user:u123",
      text: "hello",
      accountId: "default",
    } as any);
    // ChannelMessageSendResult = { receipt: MessageReceipt; messageId? }
    expect(result.receipt).toBeDefined();
    expect(result.receipt.primaryPlatformMessageId ?? result.receipt.platformMessageIds[0]).toBe(
      "msg-text-1",
    );
  });

  it("message.send.text on empty text yields no platform message id (noop)", async () => {
    const result = await octoPlugin.message!.send!.text!({
      cfg: baseCfg as any,
      to: "user:u123",
      text: "",
      accountId: "default",
    } as any);
    const id = result.receipt?.primaryPlatformMessageId ?? result.receipt?.platformMessageIds?.[0] ?? "";
    expect(id).toBe("");
  });

  it("outbound and message share the same send behavior (parity)", async () => {
    const viaOutbound = await octoPlugin.outbound!.sendText!({
      cfg: baseCfg as any,
      to: "user:u123",
      text: "hello",
      accountId: "default",
    } as any);
    expect(viaOutbound.channel).toBe(CHANNEL_ID);
    expect(viaOutbound.messageId).toBe("msg-text-1");
  });
});
