// `/fork` runtime wiring — the impure half of the command.
//
// `fork.ts` is pure orchestration; this module supplies the concrete
// `spawnChildBoundSession` it depends on. That involves one real octo Bot API
// call (`createThread`) plus assembling the seed inbound context that — once
// dispatched into the child thread — makes the OpenClaw reply pipeline auto-fork
// the parent session.
//
// Fork mechanism (spec §5.2, "Plan B"): the fork is a side-effect of the seed
// dispatch, not a plugin-driven step. `get-reply` forks the parent transcript
// into the child session iff the inbound context carries `ParentSessionKey` and
// it differs from the child's own `SessionKey`
// (node_modules/openclaw/dist/get-reply-DuA7xbHV.js:3780). The only generic
// producer of `ctx.ParentSessionKey` upstream is Discord's auto-thread layer
// (threading-idEBBpQ_.js:334, Discord-only), so octo must set it itself here.
//
// 1b scope (payload-only): this module creates the thread, derives the child
// channelId, and assembles the full seed context. The ACTUAL dispatch is left to
// the injected `dispatchSeed` seam, wired in stage 2. The runtime dispatch entry
// is `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher`
// (src/inbound.ts:2607); it consumes a context built by `finalizeInboundContext`
// (src/inbound.ts:2299) and needs the deliver harness from
// `handleInboundMessage` to route the fork reply back into the child thread —
// reusing or replicating that harness is the stage-2 work.

import { createThread as defaultCreateThread } from "../api-fetch.js";
import { CHANNEL_ID, THREAD_ID_SEPARATOR } from "../constants.js";
import { extractParentGroupNo } from "../group-md.js";
import { inheritParentMdToChildThread } from "./fork-inherit-md.js";
import type { ForkLogger, ForkOrchestrator } from "./fork.js";

/** Subset of `createThread` used here, injectable for tests. */
export type CreateThreadFn = (params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name: string;
}) => Promise<{ short_id: string; name: string; creator_uid: string }>;

/**
 * The inbound context assembled for the fork seed message. Field choices mirror
 * `finalizeInboundContext` in src/inbound.ts:2299-2363. The Plan-B-critical
 * additions are `ParentSessionKey` / `ModelParentSessionKey`, which trigger the
 * runtime auto-fork.
 *
 * `SessionKey` is intentionally absent: it is derived from the child channel's
 * agent route at dispatch time (src/inbound.ts:2344, `SessionKey:
 * route.sessionKey`). Resolving the route and setting it is the stage-2 dispatch
 * seam's responsibility — keeping it out here avoids replicating runtime routing
 * logic and the consequent divergence risk.
 */
export interface ForkSeedContext {
  Body: string;
  BodyForAgent: string;
  RawBody: string;
  CommandBody: string;
  BodyForCommands: string;
  /**
   * The fork requester's command authorization (owner-mentioned), threaded from
   * the originating inbound — NOT hardcoded. This is deliberately decoupled from
   * the fork-scope gate: the seed must carry whether the requester may run
   * *commands*, independent of whether they may *fork*. When `commands.fork.scope`
   * is wired in v1.1 to let non-owners fork, their `commandAuthorized` stays false
   * (owner-mentioned), so a non-owner's seed prompt can never be treated as an
   * authorized command in the child session. Do not revert to a literal `true`.
   */
  CommandAuthorized: boolean;
  From: string;
  To: string;
  /** Triggers the runtime auto-fork (must differ from the child `SessionKey`). */
  ParentSessionKey: string;
  ModelParentSessionKey: string;
  AccountId: string;
  ChatType: "group";
  ConversationLabel: string;
  SenderId: string;
  SenderName: string;
  SenderUsername: string;
  /** Seed is a synthetic dispatch, not a real @mention. */
  WasMentioned: false;
  MessageSid: string;
  Timestamp: number;
  GroupSubject: string;
  GroupSystemPrompt?: string;
  Provider: typeof CHANNEL_ID;
  Surface: typeof CHANNEL_ID;
  OriginatingChannel: typeof CHANNEL_ID;
  OriginatingTo: string;
}

/**
 * Per-invocation runtime dependencies for {@link buildForkOrchestrator}. Built
 * fresh for each `/fork` (in inbound.ts, stage 2), so the requester identity and
 * account context are closure-captured rather than threaded through
 * `spawnChildBoundSession`'s signature.
 */
export interface ForkRuntimeDeps {
  apiUrl: string;
  botToken: string;
  accountId: string;
  /**
   * The requester's command authorization (owner-mentioned) from the originating
   * inbound. Becomes the seed's `CommandAuthorized` — see {@link ForkSeedContext}
   * for why this is threaded rather than hardcoded `true`.
   */
  commandAuthorized: boolean;
  /** Identity attributed to the seed message — the user who ran `/fork`. */
  requesterUid: string;
  requesterName: string;
  /** Optional group system prompt carried into the seed (group-md). */
  groupSystemPrompt?: string;
  now: () => Date;
  log: ForkLogger;
  /** Send the parent-group receipt (plain text). */
  sendParentReceipt: ForkOrchestrator["sendParentReceipt"];
  /** Injectable for tests; defaults to the real octo Bot API call. */
  createThread?: CreateThreadFn;
  /**
   * Stage-2 dispatch seam. Resolves the child agent route, sets `SessionKey`,
   * runs `finalizeInboundContext` + `dispatchReplyWithBufferedBlockDispatcher`,
   * and delivers the fork reply back into the child thread. Absent in 1b — the
   * thread is still created and the seed context assembled, but nothing is
   * dispatched (a warning is logged).
   */
  dispatchSeed?: (ctx: ForkSeedContext) => Promise<void>;
  /**
   * Inherit the parent location's md into the new child thread's THREAD.md.
   * Injectable for tests; defaults to the real {@link inheritParentMdToChildThread}.
   * Always invoked fire-and-forget — never awaited on the fork main path
   * (owner decision: md copy latency must not block the fork or its receipt).
   */
  inheritParentMd?: typeof inheritParentMdToChildThread;
}

/**
 * Assemble the seed inbound context for a fork. Pure: no I/O, fully determined
 * by its inputs (the clock is injected via `deps.now`).
 *
 * @param deps Runtime deps supplying requester identity, account, and clock.
 * @param childChannelId Full channelId of the freshly created child thread.
 * @param parentSessionKey Parent session key — drives the auto-fork.
 * @param prompt The user's fork prompt (becomes the seed body).
 */
export function assembleForkSeedContext(args: {
  deps: Pick<ForkRuntimeDeps, "accountId" | "commandAuthorized" | "requesterUid" | "requesterName" | "groupSystemPrompt" | "now">;
  childChannelId: string;
  parentSessionKey: string;
  prompt: string;
}): ForkSeedContext {
  const { deps, childChannelId, parentSessionKey, prompt } = args;
  return {
    Body: prompt,
    BodyForAgent: prompt,
    RawBody: prompt,
    CommandBody: prompt,
    BodyForCommands: prompt,
    CommandAuthorized: deps.commandAuthorized,
    From: `${CHANNEL_ID}:${deps.requesterUid}`,
    To: `${CHANNEL_ID}:${childChannelId}`,
    ParentSessionKey: parentSessionKey,
    ModelParentSessionKey: parentSessionKey,
    AccountId: deps.accountId,
    ChatType: "group",
    ConversationLabel: `group:${childChannelId}`,
    SenderId: deps.requesterUid,
    SenderName: deps.requesterName,
    SenderUsername: deps.requesterUid,
    WasMentioned: false,
    MessageSid: `fork-seed:${childChannelId}`,
    Timestamp: deps.now().getTime(),
    GroupSubject: childChannelId,
    ...(deps.groupSystemPrompt ? { GroupSystemPrompt: deps.groupSystemPrompt } : {}),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${childChannelId}`,
  };
}

/**
 * Build the concrete {@link ForkOrchestrator} for one `/fork` invocation.
 *
 * `spawnChildBoundSession` creates the child thread under the parent group,
 * derives its channelId (`<groupNo>____<shortId>`), assembles the seed context,
 * and hands it to the `dispatchSeed` seam. createThread errors propagate
 * (executeFork turns them into the failure receipt).
 */
export function buildForkOrchestrator(deps: ForkRuntimeDeps): ForkOrchestrator {
  const createThreadFn = deps.createThread ?? defaultCreateThread;
  const inheritFn = deps.inheritParentMd ?? inheritParentMdToChildThread;

  return {
    async spawnChildBoundSession({ parentChannelId, parentSessionKey, prompt, threadName }) {
      const groupNo = extractParentGroupNo(parentChannelId);
      const thread = await createThreadFn({
        apiUrl: deps.apiUrl,
        botToken: deps.botToken,
        groupNo,
        name: threadName,
      });
      const childChannelId = `${groupNo}${THREAD_ID_SEPARATOR}${thread.short_id}`;

      // Inherit parent md → child THREAD.md. Fire-and-forget (owner decision):
      // the copy must never block the fork main path or the receipt. The helper
      // never throws (returns a status enum), so the trailing .catch is purely
      // a defensive backstop, not an expected path.
      void inheritFn({
        apiUrl: deps.apiUrl,
        botToken: deps.botToken,
        accountId: deps.accountId,
        parentChannelId,
        childGroupNo: groupNo,
        childShortId: thread.short_id,
        log: deps.log,
      })
        .then((status) => deps.log("info", "[fork] inherit md status", { status, childChannelId }))
        .catch((error) => deps.log("warn", "[fork] inherit md threw uncaught", { error: String(error) }));

      const seedCtx = assembleForkSeedContext({ deps, childChannelId, parentSessionKey, prompt });

      // Seed dispatch is the only step that can fail AFTER the thread exists.
      // Isolate it (I-1): a dispatch error must NOT propagate as a create-thread
      // failure — the thread is already live. Surface `seedFailed: true` so
      // executeFork keeps the "thread created" fact and asks the user to resend
      // in the child thread, instead of the misleading "开 fork 子区失败".
      if (deps.dispatchSeed) {
        try {
          await deps.dispatchSeed(seedCtx);
          deps.log("info", "[fork] seed dispatched into child thread", { childChannelId });
        } catch (err) {
          deps.log("error", "[fork] seed dispatch failed; child thread already exists", {
            childChannelId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { childChannelId, seedFailed: true };
        }
      } else {
        deps.log("warn", "[fork] dispatch seam not wired (stage 2); child thread created + seed context assembled only", {
          childChannelId,
        });
      }

      return { childChannelId };
    },

    sendParentReceipt: deps.sendParentReceipt,
    log: deps.log,
  };
}
