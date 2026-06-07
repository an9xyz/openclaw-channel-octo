/**
 * Octo Management agent tool.
 *
 * Registered via `agentTools` on the channel plugin, this tool gives the LLM
 * direct access to Octo group management operations without going through
 * the `message` tool action routing (which only supports a fixed whitelist of
 * action names in OpenClaw core).
 *
 * Operations: list-groups, group-info, group-members, group-md-read, group-md-update,
 * thread management, voice-context, etc.
 */

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
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  searchSpaceMembers,
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listThreadMembers,
  joinThread,
  leaveThread,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
  getThreadMd,
  updateThreadMd,
  resolveSecret,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate, broadcastThreadMdUpdate } from "./group-md.js";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";

/**
 * Placeholder token replaced by the resolved plaintext secret inside the
 * caller-supplied write template. Using an explicit token keeps the LLM in
 * control of *how* the secret is laid out in the file (env line, JSON field,
 * raw value, …) while the plaintext itself only ever materializes inside the
 * tool, never in the tool's arguments or return value.
 */
const SECRET_PLACEHOLDER = "{{secret}}";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

type LogSink = {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createOctoManagementTools(params: {
  cfg?: OpenClawConfig;
  agentAccountId?: string;
}): any[] {
  const cfg = params.cfg;
  const agentAccountId = params.agentAccountId;
  if (!cfg) return [];

  // Check if any account is configured
  try {
    const ids = listOctoAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveOctoAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }

  const buildTool = (name: string) => ({
    name,
    label: "Octo Management",
    description:
      "Manage Octo groups and personal voice correction context: list groups, get group info/members, " +
      "read or update GROUP.md (group-level and thread-level), and manage personal voice correction context. " +
      "Use this tool for any Octo management operations. " +
      "It also handles user-managed secrets (external API keys): when the user asks to write one of THEIR " +
      "stored keys into a local file, call action 'write-secret' and pass the user's ALIAS for the key " +
      "(the display name they used, e.g. \"my openai key\"), never a raw secret value. The tool fetches the " +
      "current value internally and writes it to the file; the plaintext is NEVER returned to you.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list-groups",
            "group-info",
            "group-members",
            "group-md-read",
            "group-md-update",
            "search-members",
            "create-group",
            "update-group",
            "add-members",
            "remove-members",
            "create-thread",
            "list-threads",
            "get-thread",
            "delete-thread",
            "list-thread-members",
            "join-thread",
            "leave-thread",
            "thread-md-read",
            "thread-md-update",
            "voice-context-read",
            "voice-context-update",
            "voice-context-delete",
            "write-secret",
          ],
          description: "The management action to perform.",
        },
        groupId: {
          type: "string",
          description:
            "The group_no (group ID). Required for all group-level actions " +
            "(group-info, group-members, group-md-read, group-md-update, update-group, " +
            "add-members, remove-members) and all thread actions " +
            "(create-thread, list-threads, get-thread, delete-thread, list-thread-members, " +
            "join-thread, leave-thread, thread-md-read, thread-md-update). " +
            "Not required for: list-groups, search-members, create-group, voice-context-*.",
        },
        content: {
          type: "string",
          description:
            "The new content. Required for group-md-update, thread-md-update, and voice-context-update.",
        },
        keyword: {
          type: "string",
          description:
            "Search keyword for search-members action. Fuzzy matches user names in the bot's Space.",
        },
        members: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of member UIDs. Required for create-group, add-members, remove-members.",
        },
        name: {
          type: "string",
          description:
            "Group name. Optional for create-group, update-group.",
        },
        notice: {
          type: "string",
          description:
            "Group notice/announcement. Optional for update-group.",
        },
        creator: {
          type: "string",
          description:
            "UID of the user who requested group creation (becomes group owner). Required for create-group.",
        },
        threadName: {
          type: "string",
          description: "Thread name. Required for create-thread.",
        },
        shortId: {
          type: "string",
          description:
            "Thread short ID. Required for get-thread, delete-thread, list-thread-members, join-thread, leave-thread, thread-md-read, thread-md-update.",
        },
        accountId: {
          type: "string",
          description:
            "Required when multiple Octo accounts are configured. Use the exact accountId from the current Octo context; casing is normalized when unambiguous. Omit when only one account is configured.",
        },
        alias: {
          type: "string",
          description:
            "For write-secret only. The user's alias for one of THEIR stored secrets — the display name they " +
            "referred to it by (e.g. \"openai key\"), or a secret_id returned by a previous ambiguous result. " +
            "🔴 Pass the alias, NEVER a raw secret value: the tool resolves the current plaintext internally.",
        },
        filePath: {
          type: "string",
          description:
            "For write-secret only. Absolute or workspace-relative path of the local file to write the secret into. " +
            "Choose the path based on the user's instruction (e.g. a .env file, a config file).",
        },
        template: {
          type: "string",
          description:
            "For write-secret only. Optional layout for what gets written, with the placeholder " +
            "'{{secret}}' marking where the resolved value goes (e.g. \"OPENAI_API_KEY={{secret}}\\n\" " +
            "or '{\"apiKey\":\"{{secret}}\"}'). If omitted, the raw secret value is written verbatim. " +
            "🔴 Do NOT put the secret value here — only the '{{secret}}' placeholder.",
        },
        mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description:
            "For write-secret only. 'overwrite' (default) replaces the file contents; 'append' adds to the end " +
            "(useful for adding a line to an existing .env). Omit to overwrite.",
        },
      },
      required: ["action"],
    },

    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const action = args.action as string;
      const groupId = (args.groupId ?? args.group_id ?? args.target) as
        | string
        | undefined;
      const content = (args.content ?? args.message) as string | undefined;
      const rawAccountId = (args.accountId as string | undefined) ?? agentAccountId ?? undefined;

      // Treat DEFAULT_ACCOUNT_ID ("default") as a semantic alias — not a
      // real account key — so normalise it to "unspecified".
      // Determine requestedAccountId. The word "default" is both the
      // framework's placeholder constant AND a legitimate config key when
      // the user literally names an account "default". We only strip it
      // when it is NOT an actual configured account.
      const requestedAccountId: string | undefined = (() => {
        if (!rawAccountId) return undefined;
        if (rawAccountId === DEFAULT_ACCOUNT_ID) {
          const ids = listOctoAccountIds(cfg);
          if (ids.includes(DEFAULT_ACCOUNT_ID)) return rawAccountId;
          return undefined;
        }
        return rawAccountId;
      })();

      const knownIds = listOctoAccountIds(cfg);

      // Account routing:
      //   - Single-account: force-route to the only configured account,
      //     regardless of what (if anything) the LLM passed. A stray /
      //     hallucinated accountId can't silently fail auth.
      //   - Multi-account + requested: case-insensitive match against
      //     config keys. Bot IDs generated via util.Ten2Hex are mixed-case
      //     (e.g. "27lZl4QjPzh72d10c8c_bot"); LLMs routinely drop the
      //     capitals in tool calls.
      //   - Multi-account + not requested: require the caller to pick.
      //     Don't silently use the first account — that lets tool calls
      //     target the wrong bot without anyone noticing.
      let accountId: string;
      if (knownIds.length === 1) {
        accountId = knownIds[0];
      } else if (requestedAccountId) {
        // Exact match wins — protects against the pathological case where
        // two accountIds differ only in casing (e.g. "BotA" + "bota"):
        // passing "BotA" must hit the exact one, not whichever sorted
        // first in a lowercase collapse.
        if (knownIds.includes(requestedAccountId)) {
          accountId = requestedAccountId;
        } else {
          const lower = requestedAccountId.toLowerCase();
          const matches = knownIds.filter((id) => id.toLowerCase() === lower);
          if (matches.length === 0) {
            return makeError(
              `Account not found: ${requestedAccountId}. Available: ${knownIds.join(", ")}`,
            );
          }
          if (matches.length > 1) {
            return makeError(
              `Account "${requestedAccountId}" is ambiguous (case-insensitive match hits ${matches.join(", ")}). Pass the exact accountId.`,
            );
          }
          accountId = matches[0];
        }
      } else {
        const defaultId = resolveDefaultOctoAccountId(cfg);
        if (defaultId) {
          accountId = defaultId;
        } else {
          return makeError(
            `Multiple Octo accounts configured; please specify accountId. Available: ${knownIds.join(", ")}`,
          );
        }
      }

      const account = resolveOctoAccount({ cfg, accountId });

      if (!account.config.botToken) {
        return makeError("Octo botToken is not configured for this account");
      }

      const apiUrl = account.config.apiUrl;
      const botToken = account.config.botToken;

      try {
        switch (action) {
          case "list-groups":
            return await handleListGroups({ apiUrl, botToken });

          case "group-info":
            if (!groupId)
              return makeError("groupId is required for group-info");
            return await handleGroupInfo({ apiUrl, botToken, groupId });

          case "group-members":
            if (!groupId)
              return makeError("groupId is required for group-members");
            return await handleGroupMembers({ apiUrl, botToken, groupId });

          case "group-md-read":
            if (!groupId)
              return makeError("groupId is required for group-md-read");
            return await handleGroupMdRead({ apiUrl, botToken, groupId });

          case "group-md-update":
            if (!groupId)
              return makeError("groupId is required for group-md-update");
            if (!content)
              return makeError("content is required for group-md-update");
            return await handleGroupMdUpdate({
              apiUrl,
              botToken,
              groupId,
              content,
              accountId,
            });

          case "search-members": {
            const keyword = (args.keyword ?? args.name ?? args.content) as string | undefined;
            const results = await searchSpaceMembers({
              apiUrl,
              botToken,
              keyword: keyword || undefined,
            });
            return makeSuccess({ members: results });
          }

          case "create-group": {
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for create-group");
            const creatorUid = (args.creator ?? args.creatorUid) as string | undefined;
            if (!creatorUid)
              return makeError("creator is required for create-group");
            const result = await createGroup({
              apiUrl,
              botToken,
              name: (args.name as string | undefined) ?? undefined,
              members,
              creator: creatorUid,
            });
            return makeSuccess(result);
          }

          case "update-group": {
            if (!groupId)
              return makeError("groupId is required for update-group");
            await updateGroup({
              apiUrl,
              botToken,
              groupNo: groupId,
              name: args.name as string | undefined,
              notice: args.notice as string | undefined,
            });
            return makeSuccess({ updated: true, groupId });
          }

          case "add-members": {
            if (!groupId)
              return makeError("groupId is required for add-members");
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for add-members");
            const result = await addGroupMembers({
              apiUrl,
              botToken,
              groupNo: groupId,
              members,
            });
            return makeSuccess(result);
          }

          case "remove-members": {
            if (!groupId)
              return makeError("groupId is required for remove-members");
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for remove-members");
            const result = await removeGroupMembers({
              apiUrl,
              botToken,
              groupNo: groupId,
              members,
            });
            return makeSuccess(result);
          }

          // ========== Thread Actions ==========

          case "create-thread": {
            if (!groupId)
              return makeError("groupId is required for create-thread");
            const threadName = (args.threadName ?? args.name) as string | undefined;
            if (!threadName)
              return makeError("threadName is required for create-thread");
            const result = await createThread({
              apiUrl,
              botToken,
              groupNo: groupId,
              name: threadName,
            });
            return makeSuccess(result);
          }

          case "list-threads": {
            if (!groupId)
              return makeError("groupId is required for list-threads");
            const threads = await listThreads({ apiUrl, botToken, groupNo: groupId });
            return makeSuccess({ threads });
          }

          case "get-thread": {
            if (!groupId)
              return makeError("groupId is required for get-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for get-thread");
            const thread = await getThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess(thread);
          }

          case "delete-thread": {
            if (!groupId)
              return makeError("groupId is required for delete-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for delete-thread");
            await deleteThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ deleted: true, groupId, shortId });
          }

          case "list-thread-members": {
            if (!groupId)
              return makeError("groupId is required for list-thread-members");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for list-thread-members");
            const members = await listThreadMembers({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ members });
          }

          case "join-thread": {
            if (!groupId)
              return makeError("groupId is required for join-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for join-thread");
            await joinThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ joined: true, groupId, shortId });
          }

          case "leave-thread": {
            if (!groupId)
              return makeError("groupId is required for leave-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for leave-thread");
            await leaveThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ left: true, groupId, shortId });
          }

          case "thread-md-read": {
            if (!groupId)
              return makeError("groupId is required for thread-md-read");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for thread-md-read");
            return await handleThreadMdRead({ apiUrl, botToken, groupId, shortId });
          }

          case "thread-md-update": {
            if (!groupId)
              return makeError("groupId is required for thread-md-update");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for thread-md-update");
            if (!content)
              return makeError("content is required for thread-md-update");
            return await handleThreadMdUpdate({
              apiUrl,
              botToken,
              groupId,
              shortId,
              content,
              accountId,
            });
          }

          case "voice-context-read":
            return await handleVoiceContextRead({ apiUrl, botToken });

          case "voice-context-update": {
            if (
              content === undefined ||
              content === null ||
              content.trim() === ""
            ) {
              return makeError(
                "content is required for voice-context-update and must not be empty",
              );
            }
            return await handleVoiceContextUpdate({
              apiUrl,
              botToken,
              content,
            });
          }

          case "voice-context-delete":
            return await handleVoiceContextDelete({ apiUrl, botToken });

          case "write-secret": {
            const alias = (args.alias as string | undefined)?.trim();
            if (!alias) {
              return makeError("alias is required for write-secret");
            }
            const filePath = (args.filePath as string | undefined)?.trim();
            if (!filePath) {
              return makeError("filePath is required for write-secret");
            }
            const template = args.template as string | undefined;
            const rawMode = args.mode as string | undefined;
            if (rawMode !== undefined && rawMode !== "overwrite" && rawMode !== "append") {
              return makeError(
                `Invalid mode "${rawMode}" for write-secret; use "overwrite" or "append"`,
              );
            }
            return await handleWriteSecret({
              apiUrl,
              botToken,
              alias,
              filePath,
              template,
              mode: rawMode === "append" ? "append" : "overwrite",
            });
          }

          default:
            return makeError(`Unknown action: ${action}`);
        }
      } catch (err) {
        return makeError(
          `${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  return [
    buildTool("octo_management"),
  ];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListGroups(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  const groups = await fetchBotGroups({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess({ groups });
}

async function handleGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const info = await getGroupInfo({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(info);
}

async function handleGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const members = await getGroupMembers({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess({ members });
}

async function handleGroupMdRead(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const md = await getGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(md);
}

async function handleGroupMdUpdate(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  content: string;
  accountId: string;
}): Promise<ToolResult> {
  const result = await updateGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
    content: params.content,
  });

  // Update disk cache for all agents that have this group
  broadcastGroupMdUpdate({
    accountId: params.accountId,
    groupNo: params.groupId,
    content: params.content,
    version: result.version,
  });

  return makeSuccess({ updated: true, version: result.version });
}

// ---------------------------------------------------------------------------
// Thread MD Handlers
// ---------------------------------------------------------------------------

async function handleThreadMdRead(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  shortId: string;
}): Promise<ToolResult> {
  try {
    const md = await getThreadMd({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      groupNo: params.groupId,
      shortId: params.shortId,
    });
    return makeSuccess(md);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("(404)")) {
      return makeSuccess({ content: "", version: 0, updated_at: null, updated_by: "" });
    }
    return makeError(`Failed to read thread THREAD.md: ${msg}`);
  }
}

async function handleThreadMdUpdate(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  shortId: string;
  content: string;
  accountId: string;
}): Promise<ToolResult> {
  const result = await updateThreadMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
    shortId: params.shortId,
    content: params.content,
  });

  broadcastThreadMdUpdate({
    accountId: params.accountId,
    groupNo: params.groupId,
    shortId: params.shortId,
    content: params.content,
    version: result.version,
  });

  return makeSuccess({ updated: true, version: result.version });
}

// ---------------------------------------------------------------------------
// Voice Context Handlers
// ---------------------------------------------------------------------------

/**
 * Read the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * Returns { has_context, context, updated_at } — normalized by getVoiceContext().
 */
async function handleVoiceContextRead(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  const result = await getVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess(result);
}

/**
 * Set or replace the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * The `content` param is the full voice-context body (not to be confused
 * with GROUP.md content used by group-md-update). Content validation
 * (empty string rejection) is done in the execute() switch before this
 * handler is called.
 */
async function handleVoiceContextUpdate(params: {
  apiUrl: string;
  botToken: string;
  content: string;
}): Promise<ToolResult> {
  await updateVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    content: params.content,
  });
  return makeSuccess({ updated: true });
}

/**
 * Delete the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * Idempotent — deleting non-existent context is not an error.
 */
async function handleVoiceContextDelete(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  await deleteVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess({ deleted: true });
}

// ---------------------------------------------------------------------------
// Secret Write Handler
// ---------------------------------------------------------------------------

/**
 * Resolve a user-managed secret alias and write its current plaintext into a
 * local file.
 *
 * 🔴 RED LINE — plaintext containment:
 * The resolved secret value is read from resolveSecret(), substituted into the
 * (optional) caller template, and written to disk. It is consumed ENTIRELY
 * inside this function. The ToolResult returned to the LLM contains only:
 *   - success: { written: true, path, bytesWritten, display_name?, mode }
 *   - structured non-plaintext feedback for the not_found / ambiguous /
 *     resolve-failure cases.
 * The plaintext value, the rendered file content, and the template-with-secret
 * are NEVER placed in the return value, so they cannot reach the transcript /
 * Octo. `bytesWritten` is a length only — it carries no secret material.
 *
 * Use-time resolution: resolveSecret is called on every invocation, so the
 * latest value is always written (owner key rotation takes effect with no
 * restart and no cache to invalidate).
 */
async function handleWriteSecret(params: {
  apiUrl: string;
  botToken: string;
  alias: string;
  filePath: string;
  template?: string;
  mode: "overwrite" | "append";
}): Promise<ToolResult> {
  let resolved;
  try {
    resolved = await resolveSecret({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      alias: params.alias,
    });
  } catch (err) {
    // resolve failure (5xx / malformed / transport). Surface a non-plaintext,
    // actionable hint — never the underlying value (a failure has none).
    return makeError(
      `Could not resolve secret "${params.alias}". The key service is unavailable or the secret may need to be re-set. Ask the user to re-add the key, then retry. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  // not_found → guide the user to add the secret first. Echo only the alias the
  // user already typed (not sensitive).
  if (resolved.status === "not_found") {
    return makeError(
      `No stored secret matches "${params.alias}". Ask the user to add this key first (e.g. via the Octo secrets settings), then try again.`,
    );
  }

  // ambiguous → hand back ONLY the labels so the LLM can ask the user which one.
  // 🔴 candidates carry display_name (+ secret_id) only, never the value.
  if (resolved.status === "ambiguous") {
    return makeSuccess({
      written: false,
      ambiguous: true,
      message: `Multiple stored secrets match "${params.alias}". Ask the user which one, then retry write-secret with the chosen display_name (or its secret_id).`,
      candidates: resolved.candidates,
    });
  }

  // resolved → substitute into template (or use raw value) and write to disk.
  // From here the plaintext lives only in local variables and the file.
  const content =
    params.template && params.template.includes(SECRET_PLACEHOLDER)
      ? params.template.split(SECRET_PLACEHOLDER).join(resolved.value)
      : resolved.value;

  const bytesWritten = Buffer.byteLength(content, "utf8");

  try {
    const dir = dirname(params.filePath);
    if (dir && dir !== "." && dir !== params.filePath) {
      await mkdir(dir, { recursive: true });
    }
    if (params.mode === "append") {
      await appendFile(params.filePath, content, "utf8");
    } else {
      await writeFile(params.filePath, content, "utf8");
    }
  } catch (err) {
    // A write error message can include the path but never the content.
    return makeError(
      `Resolved the secret but failed to write it to "${params.filePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 🔴 Success payload is plaintext-free by construction.
  return makeSuccess({
    written: true,
    path: params.filePath,
    mode: params.mode,
    bytesWritten,
    ...(resolved.display_name ? { display_name: resolved.display_name } : {}),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccess(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function makeError(error: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    details: { error },
  };
}
