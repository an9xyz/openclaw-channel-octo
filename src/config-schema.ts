// Plain config types — no external dependencies

export interface OctoAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
  onBehalfOf?: string;  // Persona clone: grantor uid — bot acts on behalf of this human
  secretsFileRoot?: string;  // Jail root for write-secret: secret files may only be written under this path. When unset, defaults to the agent's workspace (agents.list[].workspace matched to the agent, else agents.defaults.workspace); if neither resolves, write-secret fails closed (no process.cwd() fallback).
  dispatchTimeoutMs?: number;  // Explicit per-inbound dispatch timeout override (ms). Unset = derived from agents.defaults.timeoutSeconds + 60s buffer (issue #113).
}

export interface OctoConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
  onBehalfOf?: string;  // Persona clone: grantor uid — bot acts on behalf of this human
  secretsFileRoot?: string;  // Jail root for write-secret (see OctoAccountConfig)
  dispatchTimeoutMs?: number;  // Explicit per-inbound dispatch timeout override (ms); see OctoAccountConfig
  accounts?: Record<string, OctoAccountConfig | undefined>;
}

// Default English template for history prompt (supports {messages}, {count} placeholders)
export const DEFAULT_HISTORY_PROMPT_TEMPLATE =
  "[Group Chat History] Below are messages from others since your last reply (sender is user ID, body is message content):\n```json\n{messages}\n```\nPlease respond to the current @mention based on this context.\n\n";

// Shared description for secretsFileRoot, kept identical to the wording in
// openclaw.plugin.json so the Control UI and the runtime schema never drift
// (manifest-schema-sync.test.ts asserts this).
export const SECRETS_FILE_ROOT_DESCRIPTION =
  "Jail root for write-secret: secret files may only be written under this path. When unset, defaults to the agent's workspace (agents.list[].workspace matched to the agent, else agents.defaults.workspace). If neither resolves to a usable directory, write-secret is unavailable (fail-closed); there is no process working-directory fallback.";

// Shared description for dispatchTimeoutMs, kept identical to the wording in
// openclaw.plugin.json (manifest-schema-sync.test.ts asserts key-level sync).
// Semantics (issue #113): this timeout is the per-group-queue infrastructure
// backstop from issue #75, NOT an agent-run timeout. When unset it is DERIVED
// as (agents.defaults.timeoutSeconds ?? 600) * 1000 + 60000, so it always
// fires strictly after OpenClaw core's own agent-run timeout.
export const DISPATCH_TIMEOUT_MS_DESCRIPTION =
  "Per-inbound dispatch timeout in milliseconds (infrastructure backstop that releases the per-group queue when an upstream dispatch hangs). When unset, derived from agents.defaults.timeoutSeconds (default 600) as timeoutSeconds*1000 + 60000, so it always fires after the agent-run timeout. Set explicitly only when you need to decouple it from the agent timeout.";

// JSON Schema for OpenClaw plugin config validation
export const OctoConfigJsonSchema = {
  schema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      botToken: { type: "string" },
      apiUrl: { type: "string" },
      wsUrl: { type: "string" },
      cdnUrl: { type: "string" },
      pollIntervalMs: { type: "number", minimum: 500 },
      heartbeatIntervalMs: { type: "number", minimum: 5000 },
      requireMention: { type: "boolean" },
      botUid: { type: "string" },
      historyLimit: { type: "number", minimum: 1, maximum: 100 },
      historyPromptTemplate: { type: "string" },
      onBehalfOf: { type: "string" },
      secretsFileRoot: { type: "string", description: SECRETS_FILE_ROOT_DESCRIPTION },
      dispatchTimeoutMs: { type: "number", minimum: 1000, description: DISPATCH_TIMEOUT_MS_DESCRIPTION },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            botToken: { type: "string" },
            apiUrl: { type: "string" },
            wsUrl: { type: "string" },
            cdnUrl: { type: "string" },
            pollIntervalMs: { type: "number", minimum: 500 },
            heartbeatIntervalMs: { type: "number", minimum: 5000 },
            requireMention: { type: "boolean" },
            botUid: { type: "string" },
            historyLimit: { type: "number", minimum: 1, maximum: 100 },
            historyPromptTemplate: { type: "string" },
            onBehalfOf: { type: "string" },
            secretsFileRoot: { type: "string", description: SECRETS_FILE_ROOT_DESCRIPTION },
            dispatchTimeoutMs: { type: "number", minimum: 1000, description: DISPATCH_TIMEOUT_MS_DESCRIPTION },
          },
        },
      },
    },
  },
};
