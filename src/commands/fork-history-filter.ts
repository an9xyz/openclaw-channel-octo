// `/fork` history-leak filter.
//
// The fork hook (inbound.ts, handleForkCommandIfMatched) keeps a /fork command
// out of the bot's OWN session: it early-returns before
// finalizeInboundContext / recordInboundSession. But it does NOT cover the
// other path by which a /fork command can re-enter the bot's context: when the
// bot is later @mentioned and inbound.ts backfills group history from
// `getChannelMessages` (or its in-memory `groupHistories` cache), a prior
// `/fork ...` message would otherwise be injected into the historyPrefix and
// become visible to the LLM.
//
// /fork commands are control-flow, not conversation — they must never appear in
// the bot's ctx history. octo Bot API cannot delete the user's original /fork
// message from the server, so this plugin-side filter is the mitigation: the
// message stays visible to humans in the group UI, but is invisible to the bot.
//
// See docs/specs/2026-06-18-fork-command-design.md.

import { resolveCommandBody } from "../inbound.js";
import { parseForkCommand } from "./fork.js";

/**
 * Whether a group-history message body is a `/fork` command that must be
 * excluded from historyPrefix injection.
 *
 * Mirrors the inbound command-split path: the raw body is first stripped of any
 * leading `@bot ` prefix (only when the bot was explicitly mentioned, same as
 * `resolveCommandBody`), then matched against the `/fork` grammar. Both a valid
 * `/fork <prompt>` and a bare `/fork` (empty prompt) count as fork commands;
 * anything else (`/forks`, `/btw`, `/Fork`, ordinary text) does not.
 *
 * @param rawBody Raw message body, possibly carrying a leading `@bot ` prefix.
 * @param isExplicitBotMention Whether this history message explicitly @mentioned
 *   the bot — gates the prefix strip exactly as the live command path does.
 */
export function isForkCommandHistoryMessage(
  rawBody: string,
  isExplicitBotMention: boolean,
): boolean {
  if (!rawBody) return false;
  const stripped = resolveCommandBody(rawBody, /* isGroup */ true, isExplicitBotMention);
  const parsed = parseForkCommand(stripped);
  return parsed.ok || parsed.reason === "empty";
}
