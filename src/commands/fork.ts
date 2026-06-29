// `/fork` command — pure orchestration layer.
//
// This module is intentionally free of any octo Bot API / OpenClaw runtime
// calls. It only parses the command, derives metadata, resolves authorization
// scope, and orchestrates the fork flow against a single injected dependency,
// `spawnChildBoundSession`. The concrete implementation (octo `createThread` +
// seed-context assembly + dispatch seam) lives in `fork-runtime.ts`.
//
// Fork model (spec §5.2, "Plan B"): the fork is NOT driven from the plugin.
// Creating the child thread and dispatching the prompt into it — with the
// parent session key on the inbound context — makes the OpenClaw reply pipeline
// auto-fork the parent transcript into the child session. The plugin therefore
// cannot synchronously observe whether the fork carried context or fell back to
// isolated, so there is no `forkMode` here; the parent receipt is a flat
// confirmation (decision matrix #3).
//
// See docs/specs/2026-06-18-fork-command-design.md.

import { THREAD_ID_SEPARATOR } from "../constants.js";

/** Result of parsing a stripped command body against the `/fork` grammar. */
export type ParseForkResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: "empty" | "not_fork_command" };

/**
 * Parse a command body (already stripped of any leading `@bot ` mention; see
 * `resolveCommandBody` in inbound.ts) against the `/fork <prompt>` grammar.
 *
 * Matching is case-sensitive (`/Fork` is not `/fork`) and tolerant of
 * surrounding whitespace (`  /fork x  ` matches). A bare `/fork` or one
 * followed only by whitespace yields `empty`. Anything that is not the `/fork`
 * token yields `not_fork_command`.
 *
 * @param commandBody Stripped command body.
 * @returns Parsed prompt on success, or a reason for rejection.
 */
export function parseForkCommand(commandBody: string): ParseForkResult {
  // `[\s\S]` (not `.`) so multi-line prompts are captured whole.
  const match = commandBody.trim().match(/^\/fork(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { ok: false, reason: "not_fork_command" };
  }
  const prompt = (match[1] ?? "").trim();
  if (prompt === "") {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, prompt };
}

/** Maximum thread-name length, counted in Unicode code points (spec §3.2). */
const THREAD_NAME_MAX_CODE_POINTS = 30;

/**
 * Derive the child thread name from the fork prompt (spec §3.2).
 *
 * Takes the first 30 Unicode code points of the prompt. Code-point counting
 * (via the string iterator) keeps surrogate pairs — emoji, astral chars —
 * intact; CJK wide chars count as one each. When the prompt is empty or
 * whitespace-only, falls back to `Forked: <ISO timestamp without millis>`.
 *
 * @param prompt Fork prompt text.
 * @param now Clock injection for deterministic fallback naming.
 * @returns Thread name.
 */
export function deriveThreadName(prompt: string, now: () => Date): string {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    const iso = now().toISOString().replace(/\.\d{3}Z$/, "Z");
    return `Forked: ${iso}`;
  }
  return [...trimmed].slice(0, THREAD_NAME_MAX_CODE_POINTS).join("");
}

/**
 * Whether the given channelId already refers to a thread / sub-topic, i.e. it
 * contains the `____` separator (`<groupNo>____<shortId>`). Used to detect a
 * nested fork (spec §5.5).
 */
export function isInsideThread(channelId: string): boolean {
  return channelId.includes(THREAD_ID_SEPARATOR);
}

/** Authorization scope for `/fork` (spec §5.4). */
export type ForkScope = "owner-mentioned" | "any-mentioned" | "owner-only" | "any";

const VALID_FORK_SCOPES: ReadonlySet<string> = new Set<ForkScope>([
  "owner-mentioned",
  "any-mentioned",
  "owner-only",
  "any",
]);

/**
 * Resolve whether a sender is authorized to run `/fork` under the configured
 * scope (spec §5.4). Unknown scope values fall back to the default
 * `owner-mentioned`.
 *
 * Scope semantics:
 * - `owner-mentioned` (default): DM → anyone; group → owner + explicit @bot.
 *   Equivalent to the existing `resolveCommandAuthorized`.
 * - `any-mentioned`: DM → anyone; group → any member + explicit @bot.
 * - `owner-only`: must be owner everywhere; group still requires explicit @bot.
 * - `any`: anyone, anywhere (widest; use with care).
 *
 * @param scope Configured scope, or undefined for the default.
 * @param isGroup Whether the message is from a group (vs DM).
 * @param isOwnerUser Whether the sender is the registered owner.
 * @param isExplicitBotMention Whether the bot was explicitly @mentioned.
 */
export function resolveForkScope(
  scope: string | undefined,
  isGroup: boolean,
  isOwnerUser: boolean,
  isExplicitBotMention: boolean,
): boolean {
  const effective: ForkScope = VALID_FORK_SCOPES.has(scope ?? "")
    ? (scope as ForkScope)
    : "owner-mentioned";

  switch (effective) {
    case "owner-mentioned":
      return !isGroup || (isOwnerUser && isExplicitBotMention);
    case "any-mentioned":
      return !isGroup || isExplicitBotMention;
    case "owner-only":
      return isOwnerUser && (!isGroup || isExplicitBotMention);
    case "any":
      return true;
  }
}

/** Default fork scope — the only value v1's inbound hook actually honors. */
export const DEFAULT_FORK_SCOPE: ForkScope = "owner-mentioned";

/**
 * Startup warning for a configured `commands.fork.scope` that v1 does not yet
 * honor. v1's inbound hook always uses the default
 * `owner-mentioned`; wiring a configured value is a v1.1 TODO. So an operator
 * who sets a non-default scope would be silently fail-closed — confusing.
 *
 * @returns The one-line warning when `scope` is a non-default value, or null
 *   when it is unset or already the default (nothing to warn about).
 */
export function forkScopeStartupWarning(scope: string | undefined): string | null {
  if (!scope || scope === DEFAULT_FORK_SCOPE) return null;
  return (
    `octo: commands.fork.scope="${scope}" is configured but not yet wired in v1; ` +
    `using default "${DEFAULT_FORK_SCOPE}"`
  );
}

export type ForkLogLevel = "debug" | "info" | "warn" | "error";
export type ForkLogger = (level: ForkLogLevel, message: string, meta?: Record<string, unknown>) => void;

/**
 * Injected dependency for {@link executeFork}.
 *
 * `spawnChildBoundSession` merges what were previously separate create-thread,
 * fork-session, and seed-message steps: under the Plan B fork model the child
 * channelId only exists after the thread is created, and the fork itself is a
 * runtime side-effect of the seed dispatch — so the three cannot be driven
 * independently from the plugin. The concrete implementation lives in
 * `fork-runtime.ts`.
 */
export interface ForkOrchestrator {
  /**
   * Create the child thread under the parent group, assemble the seed inbound
   * context (carrying `parentSessionKey`), and dispatch the prompt into the new
   * thread — which triggers the runtime auto-fork.
   *
   * Failure semantics are split by whether the thread got created (I-1):
   * - throws → the thread was NOT created (e.g. createThread error); the fork
   *   has no side effect and executeFork reports `spawn_failed`.
   * - resolves with `seedFailed: true` → the thread DOES exist but the seed
   *   dispatch failed; executeFork reports `ok_seed_failed` and tells the user
   *   to retry in the now-live child thread.
   * - resolves without `seedFailed` → full success.
   */
  spawnChildBoundSession(args: {
    parentChannelId: string;
    parentSessionKey: string;
    prompt: string;
    threadName: string;
  }): Promise<{ childChannelId: string; seedFailed?: boolean }>;
  /** Send the plain-text receipt back to the parent conversation. */
  sendParentReceipt(args: { text: string }): Promise<void>;
  log: ForkLogger;
}

/** Input to {@link executeFork}. */
export interface ForkInput {
  /** Parsed fork prompt (re-validated defensively inside executeFork). */
  prompt: string;
  /** ChannelId of the originating conversation (parent group, or a thread for nested forks). */
  parentChannelId: string;
  /** Session key of the parent conversation; seeds the runtime auto-fork. */
  parentSessionKey: string;
  /** Clock injection for deterministic thread-name fallback. */
  now: () => Date;
}

/**
 * Terminal status of an {@link executeFork} run.
 *
 * `ok_seed_failed`: the child thread was created but the seed dispatch failed
 * (I-1). The thread is live and usable; the fork's first prompt just didn't
 * land, so the receipt asks the user to resend it in the child thread.
 */
export type ForkStatus = "ok" | "ok_seed_failed" | "empty_prompt" | "spawn_failed";

/** Structured result of {@link executeFork}. */
export interface ForkResult {
  status: ForkStatus;
  /** Present when a thread was created. */
  threadName?: string;
  /** Present when a thread was created (the child thread channelId). */
  channelId?: string;
  /** Whether the parent was itself a thread (nested fork). */
  nested: boolean;
  /** Plain text already sent to the parent conversation. */
  replyText: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Send the parent-group receipt, swallowing any failure (S-1). The fork's main
 * effect (thread + seed dispatch) is already done by the time any receipt is
 * sent, so a receipt error must never bubble out of executeFork or alter its
 * status — it is logged and dropped.
 */
async function safeSendReceipt(deps: ForkOrchestrator, text: string): Promise<void> {
  try {
    await deps.sendParentReceipt({ text });
  } catch (err) {
    deps.log("error", "[fork] sendParentReceipt failed", { error: errorMessage(err) });
  }
}

/**
 * Orchestrate the `/fork` flow (spec §3): validate prompt → derive thread name →
 * spawn the child bound session → send the parent-group receipt. Pure
 * orchestration over the injected {@link ForkOrchestrator}; performs no
 * octo/runtime calls itself.
 *
 * Exception handling (spec §3.3):
 * - empty prompt → usage hint, nothing spawned;
 * - spawnChildBoundSession throws → `开 fork 子区失败：<msg>` receipt, flow aborts
 *   (thread was not created);
 * - spawnChildBoundSession resolves with `seedFailed` → thread exists but the
 *   first prompt didn't land; receipt asks the user to resend in the child (I-1);
 * - sendParentReceipt failures are logged and swallowed, never bubbled (S-1);
 * - nested fork (parent is already a thread) → allowed; logged.
 *
 * @param deps Injected orchestration dependency.
 * @param input Fork input.
 * @returns Structured result describing what happened.
 */
export async function executeFork(deps: ForkOrchestrator, input: ForkInput): Promise<ForkResult> {
  const nested = isInsideThread(input.parentChannelId);
  const prompt = input.prompt.trim();

  if (prompt === "") {
    const replyText = "用法：/fork <你的问题>";
    await safeSendReceipt(deps, replyText);
    return { status: "empty_prompt", nested, replyText };
  }

  if (nested) {
    deps.log("info", "[fork] nested fork: parent is a thread", { parentChannelId: input.parentChannelId });
  }

  const threadName = deriveThreadName(prompt, input.now);

  let spawned: { childChannelId: string; seedFailed?: boolean };
  try {
    spawned = await deps.spawnChildBoundSession({
      parentChannelId: input.parentChannelId,
      parentSessionKey: input.parentSessionKey,
      prompt,
      threadName,
    });
  } catch (err) {
    const message = errorMessage(err);
    deps.log("error", "[fork] spawnChildBoundSession failed", { error: message });
    const replyText = `开 fork 子区失败：${message}`;
    await safeSendReceipt(deps, replyText);
    return { status: "spawn_failed", nested, replyText };
  }

  if (spawned.seedFailed) {
    const replyText = `已开 fork 子区：${threadName}（首条问题处理失败，请到子区重发）`;
    await safeSendReceipt(deps, replyText);
    return { status: "ok_seed_failed", threadName, channelId: spawned.childChannelId, nested, replyText };
  }

  const replyText = `已开 fork 子区：${threadName}`;
  await safeSendReceipt(deps, replyText);

  return {
    status: "ok",
    threadName,
    channelId: spawned.childChannelId,
    nested,
    replyText,
  };
}
