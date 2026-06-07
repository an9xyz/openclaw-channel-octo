import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
  resolveDefaultOctoAccountId: vi.fn(),
}));

vi.mock("./api-fetch.js", () => ({
  fetchBotGroups: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupMembers: vi.fn(),
  getGroupMd: vi.fn(),
  updateGroupMd: vi.fn(),
  getVoiceContext: vi.fn(),
  updateVoiceContext: vi.fn(),
  deleteVoiceContext: vi.fn(),
  getThreadMd: vi.fn(),
  updateThreadMd: vi.fn(),
  resolveSecret: vi.fn(),
}));

vi.mock("./group-md.js", () => ({
  broadcastGroupMdUpdate: vi.fn(),
  broadcastThreadMdUpdate: vi.fn(),
}));

// NOTE: node:fs/promises is intentionally NOT mocked. The write-secret tests
// exercise the real path-confinement + write path against an OS temp directory
// so that traversal / absolute-escape / symlink rejection is genuinely tested.

import { createOctoManagementTools } from "./agent-tools.js";
import {
  listOctoAccountIds,
  resolveOctoAccount,
  resolveDefaultOctoAccountId,
} from "./accounts.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  getGroupMd,
  updateGroupMd,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
  getThreadMd,
  updateThreadMd,
  resolveSecret,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate, broadcastThreadMdUpdate } from "./group-md.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal config stub — mocked account functions don't inspect it
const mockCfg = { channels: { octo: { botToken: "tok-secret" } } } as any;

function setupMocks(overrides?: {
  enabled?: boolean;
  configured?: boolean;
  botToken?: string;
  apiUrl?: string;
  secretsFileRoot?: string;
}) {
  const {
    enabled = true,
    configured = true,
    botToken = "tok-secret",
    apiUrl = "http://api.test",
    secretsFileRoot,
  } = overrides ?? {};

  vi.mocked(listOctoAccountIds).mockReturnValue(["default"]);
  vi.mocked(resolveDefaultOctoAccountId).mockReturnValue("default");
  vi.mocked(resolveOctoAccount).mockReturnValue({
    accountId: "default",
    enabled,
    configured,
    config: {
      botToken,
      apiUrl,
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 30000,
      ...(secretsFileRoot ? { secretsFileRoot } : {}),
    },
  });
}

/** Create tool and return its execute function */
function getExecute() {
  const tools = createOctoManagementTools({ cfg: mockCfg });
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("octo_management");
  return tools[0].execute as (
    id: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

function parseText(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------

describe("createOctoManagementTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // -----------------------------------------------------------------------
  // tool creation
  // -----------------------------------------------------------------------
  describe("tool creation", () => {
    it("returns empty array when cfg is undefined", () => {
      expect(createOctoManagementTools({ cfg: undefined })).toEqual([]);
    });

    it("returns empty array when no account has botToken", () => {
      setupMocks({ botToken: "" });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is disabled", () => {
      setupMocks({ enabled: false });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is not configured", () => {
      setupMocks({ configured: false });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when listOctoAccountIds throws", () => {
      vi.mocked(listOctoAccountIds).mockImplementation(() => {
        throw new Error("bad config");
      });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns octo_management as the only tool", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("octo_management");
      expect(typeof tools[0].execute).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // list-groups
  // -----------------------------------------------------------------------
  describe("execute — list-groups", () => {
    it("returns groups on success", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([
        { group_no: "g1", name: "Alpha" },
        { group_no: "g2", name: "Beta" },
      ]);
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.groups).toHaveLength(2);
      expect(data.groups[0].group_no).toBe("g1");
    });

    it("returns error on API failure", async () => {
      vi.mocked(fetchBotGroups).mockRejectedValue(new Error("Network error"));
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.error).toContain("list-groups failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-info
  // -----------------------------------------------------------------------
  describe("execute — group-info", () => {
    it("returns group info on success", async () => {
      vi.mocked(getGroupInfo).mockResolvedValue({
        group_no: "g1",
        name: "Alpha",
        member_count: 5,
      });
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.group_no).toBe("g1");
      expect(data.name).toBe("Alpha");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-info" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error on API failure", async () => {
      vi.mocked(getGroupInfo).mockRejectedValue(new Error("404"));
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("group-info failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-members
  // -----------------------------------------------------------------------
  describe("execute — group-members", () => {
    it("returns members on success", async () => {
      vi.mocked(getGroupMembers).mockResolvedValue([
        { uid: "u1", name: "Alice" },
        { uid: "u2", name: "Bob", role: "admin" },
      ]);
      const result = await getExecute()("tc", {
        action: "group-members",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.members).toHaveLength(2);
      expect(data.members[0].name).toBe("Alice");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-members" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-read
  // -----------------------------------------------------------------------
  describe("execute — group-md-read", () => {
    it("returns GROUP.md content on success", async () => {
      vi.mocked(getGroupMd).mockResolvedValue({
        content: "# Rules\nBe nice.",
        version: 3,
        updated_at: "2024-01-01",
        updated_by: "admin",
      });
      const result = await getExecute()("tc", {
        action: "group-md-read",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.content).toBe("# Rules\nBe nice.");
      expect(data.version).toBe(3);
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-md-read" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-update
  // -----------------------------------------------------------------------
  describe("execute — group-md-update", () => {
    it("updates and calls broadcastGroupMdUpdate", async () => {
      vi.mocked(updateGroupMd).mockResolvedValue({ version: 7 });
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
        content: "# Updated",
      });
      const data = parseText(result);
      expect(data.updated).toBe(true);
      expect(data.version).toBe(7);
      expect(broadcastGroupMdUpdate).toHaveBeenCalledWith({
        accountId: "default",
        groupNo: "g1",
        content: "# Updated",
        version: 7,
      });
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when content is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("content");
    });
  });

  // -----------------------------------------------------------------------
  // accountId resolution
  // -----------------------------------------------------------------------
  describe("accountId resolution", () => {
    it("uses provided accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["default", "acct2"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId: accountId ?? "default",
        enabled: true,
        configured: true,
        config: {
          botToken: "tok-acct2",
          apiUrl: "http://api2.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "acct2" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api2.test",
        botToken: "tok-acct2",
      });
    });

    it("single-account: force-routes to the only configured account", async () => {
      // Default mock setup has listOctoAccountIds returning a single "test-account".
      // No accountId passed — the single-account branch short-circuits directly to
      // knownIds[0], bypassing resolveDefaultOctoAccountId.
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("single-account: force-routes even when the LLM passes a different accountId", async () => {
      // Single-account → whatever the LLM passes is ignored; the only configured
      // account wins. Guards against a stray/hallucinated accountId silently
      // failing auth.
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "test-account" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("case-insensitive accountId match normalises to the real config key", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue([
        "27lZl4QjPzh72d10c8c_bot",
        "other_bot",
      ]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      // LLM drops the capitals — should still hit the mixed-case config key.
      await execute("tc", { action: "list-groups", accountId: "27lzl4qjpzh72d10c8c_bot" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-27lZl4QjPzh72d10c8c_bot.test",
        botToken: "tok-27lZl4QjPzh72d10c8c_bot",
      });
    });

    it("exact-case match wins even if a case-fold variant also exists", async () => {
      // Pathological but legal: two accountIds differ only in casing.
      // Passing the exact one must hit the exact one, not whichever the
      // lowercase collapse happens to find first.
      vi.mocked(listOctoAccountIds).mockReturnValue(["BotA", "bota"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "BotA" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-BotA.test",
        botToken: "tok-BotA",
      });
    });

    it("case-fold ambiguity (no exact match) is rejected, not silently resolved", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["BotA", "bota"]);
      const execute = getExecute();
      // Neither exact; lowercased collapses to same key hitting both.
      const result = await execute("tc", { action: "list-groups", accountId: "BOTA" });
      const data = parseText(result);
      expect(data.error).toContain("ambiguous");
      expect(data.error).toContain("BotA");
      expect(data.error).toContain("bota");
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it("multi-account: unresolvable accountId returns error with available options", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      const execute = getExecute();
      const result = await execute("tc", {
        action: "list-groups",
        accountId: "does-not-exist",
      });
      const data = parseText(result);
      expect(data.error).toContain("Account not found: does-not-exist");
      expect(data.error).toContain("bot-a");
      expect(data.error).toContain("bot-b");
    });

    it("multi-account: no accountId and no default returns error with available options", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue(null as any);
      const execute = getExecute();
      const result = await execute("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.error).toContain("Multiple Octo accounts");
      expect(data.error).toContain("bot-a");
      expect(data.error).toContain("bot-b");
      // Must NOT silently pick an account and make the call.
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it('multi-account: accountId="default" alias behaves as unspecified → error when no default resolvable', async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue(null as any);
      const execute = getExecute();
      const result = await execute("tc", { action: "list-groups", accountId: "default" });
      const data = parseText(result);
      expect(data.error).toContain("Multiple Octo accounts");
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it("resolves correct account in multi-account setup", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              botToken: "tok-secondary",
              apiUrl: "http://api-secondary.test",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          };
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            botToken: "tok-primary",
            apiUrl: "http://api-primary.test",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        };
      });

      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "secondary" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });
  });

  // -----------------------------------------------------------------------
  // agentAccountId resolution
  // -----------------------------------------------------------------------
  describe("agentAccountId resolution", () => {
    it("uses agentAccountId when args.accountId is not provided", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: "bot-A" });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-A.test",
        botToken: "tok-bot-A",
      });
    });

    it("args.accountId takes priority over agentAccountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: "bot-A" });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups", accountId: "bot-B" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-B.test",
        botToken: "tok-bot-B",
      });
    });

    it("falls back to resolveDefault when agentAccountId is undefined", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue("bot-B");
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: undefined });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-B.test",
        botToken: "tok-bot-B",
      });
    });
  });

  // -----------------------------------------------------------------------
  // parameter validation
  // -----------------------------------------------------------------------
  describe("parameter validation", () => {
    it("returns error for unknown action", async () => {
      const result = await getExecute()("tc", { action: "do-magic" });
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });

    it("returns error when action is missing", async () => {
      const result = await getExecute()("tc", {});
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });
  });

  // -----------------------------------------------------------------------
  // token security
  // -----------------------------------------------------------------------
  describe("token security", () => {
    it("tool schema does not contain botToken", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
    });

    it("successful results do not leak botToken", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([{ group_no: "g1", name: "G1" }]);
      const result = await getExecute()("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("error results do not leak botToken", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          botToken: undefined,
          apiUrl: "http://api.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      });
      const result = await execute("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });
  });

  // -----------------------------------------------------------------------
  // voice-context actions
  // -----------------------------------------------------------------------
  describe("voice-context actions", () => {
    // -- Schema tests --

    it("tool schema includes voice-context-* actions", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = tools[0].parameters;
      const actionEnum = schema.properties.action.enum;
      expect(actionEnum).toContain("voice-context-read");
      expect(actionEnum).toContain("voice-context-update");
      expect(actionEnum).toContain("voice-context-delete");
    });

    it("tool description mentions voice correction context", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools[0].description).toContain("voice correction context");
    });

    // Token leak prevention
    it("tool schema does not contain botToken", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
      expect(schema).not.toContain("tok-secret");
    });

    // -- voice-context-read tests --

    it("voice-context-read returns normalized result", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "correction terms",
        updated_at: "2026-04-09T13:00:00+08:00",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.has_context).toBe(true);
      expect(parsed.context).toBe("correction terms");
      expect(parsed.updated_at).toBe("2026-04-09T13:00:00+08:00");
      // No status field in result
      expect(parsed.status).toBeUndefined();
    });

    it("voice-context-read calls getVoiceContext with correct params", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", { action: "voice-context-read" });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-read result does not leak botToken", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("voice-context-read wraps API errors in makeError", async () => {
      vi.mocked(getVoiceContext).mockRejectedValue(
        new Error("Bot API GET /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("voice-context-read failed");
      // Error must not leak token
      expect(parsed.error).not.toContain("tok-secret");
    });

    // -- voice-context-update tests --

    it("voice-context-update succeeds with valid content", async () => {
      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "new correction terms",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.updated).toBe(true);
      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
        content: "new correction terms",
      });
    });

    // Empty string rejection tests

    it("voice-context-update rejects undefined content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        // content not provided
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects null content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: null,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects empty string content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects whitespace-only content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "   \t\n  ",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update wraps API errors", async () => {
      vi.mocked(updateVoiceContext).mockRejectedValue(
        new Error("Bot API PUT /v1/bot/voice/context failed (400): context exceeds max length"),
      );

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "x".repeat(10001),
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-update failed");
    });

    // -- voice-context-delete tests --

    it("voice-context-delete succeeds", async () => {
      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(true);
      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-delete wraps API errors", async () => {
      vi.mocked(deleteVoiceContext).mockRejectedValue(
        new Error("Bot API DELETE /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-delete failed");
    });

    // Multi-account tests

    it("voice-context-read uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    it("voice-context-update uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-update",
        content: "terms",
        accountId: "secondary",
      });

      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
        content: "terms",
      });
    });

    it("voice-context-delete uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-delete",
        accountId: "secondary",
      });

      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    // Token not leaked on multi-account calls
    it("multi-account results do not leak secondary botToken", async () => {
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "secondary",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api-secondary.test",
          botToken: "tok-secondary-secret-123",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(result.content[0].text).not.toContain("tok-secondary-secret-123");
    });

    // -- strict accountId validation --

    it("voice-context-read with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-read",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(getVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-update",
        content: "some terms",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-delete with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-delete",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(deleteVoiceContext).not.toHaveBeenCalled();
    });

    // -- botToken not configured --

    it("returns error when botToken is not configured", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "no-token",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api.test",
          botToken: "",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      const result = await execute("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("botToken is not configured");
    });

    // No alias for voice-context actions

    it("voice-context-* actions do not accept aliases", async () => {
      // Action name must be exact
      const result = await getExecute()("tc", { action: "voice-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Unknown action");
    });
  });

  // -----------------------------------------------------------------------
  // thread-md-read
  // -----------------------------------------------------------------------
  describe("execute — thread-md-read", () => {
    it("returns THREAD.md content on success", async () => {
      vi.mocked(getThreadMd).mockResolvedValue({
        content: "# Sprint 42",
        version: 2,
        updated_at: "2026-04-13",
        updated_by: "user1",
      });
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.content).toBe("# Sprint 42");
      expect(data.version).toBe(2);
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when shortId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("shortId");
    });

    it("returns empty content on 404 instead of throwing", async () => {
      vi.mocked(getThreadMd).mockRejectedValue(new Error("getThreadMd failed (404): not found"));
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.content).toBe("");
      expect(data.version).toBe(0);
    });

    it("returns error on non-404 API failure", async () => {
      vi.mocked(getThreadMd).mockRejectedValue(new Error("getThreadMd failed (500): internal"));
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("Failed to read thread THREAD.md");
    });
  });

  // -----------------------------------------------------------------------
  // thread-md-update
  // -----------------------------------------------------------------------
  describe("execute — thread-md-update", () => {
    it("updates and calls broadcastThreadMdUpdate", async () => {
      vi.mocked(updateThreadMd).mockResolvedValue({ version: 3 });
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
        content: "# Updated thread",
      });
      const data = parseText(result);
      expect(data.updated).toBe(true);
      expect(data.version).toBe(3);
      expect(broadcastThreadMdUpdate).toHaveBeenCalledWith({
        accountId: "default",
        groupNo: "g1",
        shortId: "thr1",
        content: "# Updated thread",
        version: 3,
      });
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        shortId: "thr1",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when shortId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("shortId");
    });

    it("returns error when content is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("content");
    });

    it("returns error on API failure", async () => {
      vi.mocked(updateThreadMd).mockRejectedValue(new Error("updateThreadMd failed (403): forbidden"));
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
        content: "# Fail",
      });
      const data = parseText(result);
      expect(data.error).toContain("thread-md-update failed");
    });
  });

  // -----------------------------------------------------------------------
  // write-secret (user-managed external keys; internal deref)
  // -----------------------------------------------------------------------
  describe("execute — write-secret", () => {
    // The plaintext value any resolved secret yields. The whole point of this
    // feature is that THIS string never appears in a tool return value.
    const PLAINTEXT = "sk-live-SUPER-SECRET-VALUE-123";

    // Real OS temp dir used as the operator-configured jail root. Using the
    // real filesystem (not a mock) is what makes the traversal / absolute /
    // symlink rejection tests meaningful.
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "octo-secret-test-"));
      // Re-arm mocks with this run's jail root.
      setupMocks({ secretsFileRoot: root });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const writeSecret = (args: Record<string, unknown>) =>
      getExecute()("tc", { action: "write-secret", ...args });

    it("tool schema includes the write-secret action", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools[0].parameters.properties.action.enum).toContain("write-secret");
    });

    it("resolves the alias and writes the raw value into the jail", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: PLAINTEXT,
        secret_id: "sec_1",
        display_name: "openai key",
      });

      const result = await writeSecret({ alias: "openai key", filePath: "secrets/.env" });
      const data = parseText(result);

      // resolve is use-time: called with the bot token + alias.
      expect(resolveSecret).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
        alias: "openai key",
      });

      // raw value written verbatim (no template) under the jail root.
      const target = join(root, "secrets/.env");
      expect(await readFile(target, "utf8")).toBe(PLAINTEXT);

      expect(data.written).toBe(true);
      expect(data.path).toBe(target);
      expect(data.mode).toBe("overwrite");
      expect(data.display_name).toBe("openai key");
      // No secret-derived length field is exposed.
      expect(data).not.toHaveProperty("bytesWritten");
    });

    it("creates the secret file 0o600 (owner-only)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({ alias: "k", filePath: "key.txt" });

      const st = await stat(join(root, "key.txt"));
      // Mask to permission bits. Skipped on platforms without POSIX perms.
      if (process.platform !== "win32") {
        expect(st.mode & 0o777).toBe(0o600);
      }
    });

    it("substitutes {{secret}} inside the caller template", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({
        alias: "openai key",
        filePath: ".env",
        template: "OPENAI_API_KEY={{secret}}\n",
      });

      expect(await readFile(join(root, ".env"), "utf8")).toBe(
        `OPENAI_API_KEY=${PLAINTEXT}\n`,
      );
    });

    it("substitutes every {{secret}} occurrence (multi-placeholder)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({
        alias: "k",
        filePath: "dup.txt",
        template: "a={{secret}};b={{secret}}",
      });

      expect(await readFile(join(root, "dup.txt"), "utf8")).toBe(
        `a=${PLAINTEXT};b=${PLAINTEXT}`,
      );
    });

    it("handles a resolved value that itself contains {{secret}}", async () => {
      // The single-pass split/join must not re-expand a literal placeholder
      // that happens to live inside the secret value.
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: "val-{{secret}}-end",
      });

      await writeSecret({ alias: "k", filePath: "weird.txt", template: "X={{secret}}" });

      expect(await readFile(join(root, "weird.txt"), "utf8")).toBe("X=val-{{secret}}-end");
    });

    it("rejects a template that lacks the {{secret}} placeholder", async () => {
      const result = await writeSecret({
        alias: "k",
        filePath: ".env",
        template: "OPENAI_API_KEY=", // no placeholder → would silently write raw
      });
      expect(parseText(result).error).toContain("{{secret}} placeholder");
      // Never resolved nor wrote anything.
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("appends when mode=append", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      // seed an existing file inside the jail
      await fsWriteFile(join(root, ".env"), "EXISTING\n", "utf8");

      const result = await writeSecret({ alias: "k", filePath: ".env", mode: "append" });
      const data = parseText(result);

      expect(await readFile(join(root, ".env"), "utf8")).toBe(`EXISTING\n${PLAINTEXT}`);
      expect(data.mode).toBe("append");
    });

    it("creates the parent directory before writing", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({ alias: "k", filePath: "nested/dir/.env" });

      expect(await readFile(join(root, "nested/dir/.env"), "utf8")).toBe(PLAINTEXT);
    });

    // 🔴 RED LINE: plaintext must never appear in the LLM-visible return value,
    // on ANY branch (templated, raw, append).
    it("NEVER returns the plaintext value — templated path (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: PLAINTEXT,
        secret_id: "sec_1",
        display_name: "openai key",
      });

      const result = await writeSecret({
        alias: "openai key",
        filePath: ".env",
        template: "OPENAI_API_KEY={{secret}}\n",
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PLAINTEXT);
      expect(result.content[0].text).not.toContain(PLAINTEXT);
      expect(JSON.stringify(result.details)).not.toContain(PLAINTEXT);
    });

    it("NEVER returns the plaintext value — raw write (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "k.txt" });
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("NEVER returns the plaintext value — append (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "k.txt", mode: "append" });
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    // -------------------------------------------------------------------
    // 🔴 PATH CONFINEMENT (P0): the file destination must stay in the jail.
    // -------------------------------------------------------------------
    it("rejects parent-directory traversal, no resolve, no write", async () => {
      const result = await writeSecret({ alias: "k", filePath: "../escape.txt" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects a deep traversal that climbs past the root", async () => {
      const result = await writeSecret({ alias: "k", filePath: "a/b/../../../etc/passwd" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects an absolute path outside the jail", async () => {
      const result = await writeSecret({ alias: "k", filePath: "/etc/cron.d/x" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects a write through a symlinked dir that escapes the jail", async () => {
      // outside/  ← real target outside the jail
      // root/link → outside  (symlink inside the jail pointing out)
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        await symlink(outside, join(root, "link"), "dir");
        const result = await writeSecret({ alias: "k", filePath: "link/pwn.txt" });
        expect(parseText(result).error).toMatch(/symlink|outside the allowed/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects when the target itself is a symlink escaping the jail", async () => {
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        const realTarget = join(outside, "victim.txt");
        await fsWriteFile(realTarget, "orig", "utf8");
        await symlink(realTarget, join(root, "evil.txt"), "file");
        const result = await writeSecret({ alias: "k", filePath: "evil.txt" });
        expect(parseText(result).error).toMatch(/symlink|outside the allowed/i);
        expect(resolveSecret).not.toHaveBeenCalled();
        // The out-of-jail victim must be untouched.
        expect(await readFile(realTarget, "utf8")).toBe("orig");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("allows the jail root itself as a relative '.' is not valid but a file at root is", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "atroot.txt" });
      expect(parseText(result).written).toBe(true);
      expect(await readFile(join(root, "atroot.txt"), "utf8")).toBe(PLAINTEXT);
    });

    it("defaults the jail root to process.cwd() when secretsFileRoot is unset", async () => {
      // No secretsFileRoot configured → CWD is the root. A path that escapes
      // CWD must still be rejected.
      setupMocks(); // no secretsFileRoot
      const result = await writeSecret({ alias: "k", filePath: "../../../../etc/passwd" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("not_found → guides the user to add the key, no plaintext, no write", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "not_found" });

      const result = await writeSecret({ alias: "ghost key", filePath: ".env" });
      const data = parseText(result);

      expect(data.error).toContain("No stored secret matches");
      expect(data.error).toContain("ghost key");
      // nothing written into the jail
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("ambiguous → returns label-only candidates, never plaintext, no write", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "ambiguous",
        candidates: [
          { secret_id: "a", display_name: "openai prod" },
          { secret_id: "b", display_name: "openai test" },
        ],
      });

      const result = await writeSecret({ alias: "openai", filePath: ".env" });
      const data = parseText(result);

      expect(data.written).toBe(false);
      expect(data.ambiguous).toBe(true);
      expect(data.candidates).toHaveLength(2);
      expect(data.candidates[0].display_name).toBe("openai prod");
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("resolve failure → actionable re-set hint, no write", async () => {
      vi.mocked(resolveSecret).mockRejectedValue(
        new Error("resolveSecret failed (500)"),
      );

      const result = await writeSecret({ alias: "k", filePath: ".env" });
      const data = parseText(result);

      expect(data.error).toContain("Could not resolve secret");
      expect(data.error).toContain("re-add");
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("write failure after resolve → error mentions path but not the value", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      // Make the target unwritable: create a directory where the file should go.
      await mkdir(join(root, "isdir"), { recursive: true });

      const result = await writeSecret({ alias: "k", filePath: "isdir" });
      const data = parseText(result);

      expect(data.error).toContain("failed to write");
      expect(data.error).toContain("isdir");
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("requires alias", async () => {
      const result = await writeSecret({ filePath: ".env" });
      expect(parseText(result).error).toContain("alias is required");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("requires filePath", async () => {
      const result = await writeSecret({ alias: "k" });
      expect(parseText(result).error).toContain("filePath is required");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects an invalid mode", async () => {
      const result = await writeSecret({ alias: "k", filePath: ".env", mode: "sideways" });
      expect(parseText(result).error).toContain("Invalid mode");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("resolves use-time on every call (latest value, no caching)", async () => {
      vi.mocked(resolveSecret)
        .mockResolvedValueOnce({ status: "resolved", value: "old-value" })
        .mockResolvedValueOnce({ status: "resolved", value: "rotated-value" });

      await writeSecret({ alias: "k", filePath: ".env" });
      await writeSecret({ alias: "k", filePath: ".env" });

      expect(resolveSecret).toHaveBeenCalledTimes(2);
      // overwrite mode → file ends up with the latest value.
      expect(await readFile(join(root, ".env"), "utf8")).toBe("rotated-value");
    });
  });
});
