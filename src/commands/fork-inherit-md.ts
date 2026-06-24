// `/fork` follow-up: inherit the parent location's markdown into the freshly
// created child thread's THREAD.md.
//
// When `/fork` runs in group A (or sub-thread X), after the child thread Y is
// created we copy the "parent location's md" into Y's THREAD.md:
//   - parent is a group  → source is the group's GROUP.md
//   - parent is a thread → source is THAT thread's THREAD.md (decision (a):
//     thread.md ONLY, never fall back to the group's GROUP.md)
//
// Design constraints (owner decisions 2026-06-23):
//   - fire-and-forget: callers do NOT await this on the fork main path;
//   - fully silent: no user-facing receipt marker, warn-level logs only;
//   - assume permission: no pre-flight permission spike; a 403 at write time is
//     caught and reported as `no_permission` (then logged + swallowed).
//
// This helper NEVER throws — every failure mode maps to an InheritMdStatus so a
// caller can `void`-fire it safely.

import { getGroupMd, getThreadMd, updateThreadMd, httpStatusFromApiFetchError } from "../api-fetch.js";
import { extractParentGroupNo, extractThreadShortId, broadcastThreadMdUpdate } from "../group-md.js";
import type { ForkLogger } from "./fork.js";

/** Server-side THREAD.md cap (octo-server GetGroupMdMaxSize), in bytes. */
const THREAD_MD_MAX_BYTES = 10240;

/** Terminal status of an {@link inheritParentMdToChildThread} run. */
export type InheritMdStatus =
  | "ok" // content written to child THREAD.md
  | "skipped_empty" // parent md empty / whitespace / 404 (not found)
  | "skipped_too_large" // parent md exceeds the 10,240-byte cap
  | "no_permission" // updateThreadMd returned 403
  | "fetch_failed" // fetching parent md failed (non-404)
  | "update_failed"; // updateThreadMd failed (non-403)

/**
 * Copy the parent location's md into the child thread's THREAD.md.
 *
 * Never throws: all failures are returned as an {@link InheritMdStatus} and
 * logged at warn level, so the caller can fire-and-forget.
 *
 * @param params.parentChannelId ChannelId of the fork trigger location. A
 *   thread channelId (`<groupNo>____<shortId>`) sources the parent thread's
 *   THREAD.md; a bare group channelId sources the group's GROUP.md.
 * @param params.childGroupNo Group the new child thread lives under.
 * @param params.childShortId Short id of the new child thread.
 * @returns The terminal status of the inheritance attempt.
 */
export async function inheritParentMdToChildThread(params: {
  apiUrl: string;
  botToken: string;
  accountId: string;
  parentChannelId: string;
  childGroupNo: string;
  childShortId: string;
  log?: ForkLogger;
}): Promise<InheritMdStatus> {
  const { apiUrl, botToken, accountId, parentChannelId, childGroupNo, childShortId, log } = params;
  const parentGroupNo = extractParentGroupNo(parentChannelId);
  const parentShortId = extractThreadShortId(parentChannelId);

  // 1) Fetch parent md. Decision (a): when the parent is a thread, read ONLY
  //    that thread's THREAD.md — never fall back to the group's GROUP.md.
  let content: string;
  try {
    const resp = parentShortId
      ? await getThreadMd({ apiUrl, botToken, groupNo: parentGroupNo, shortId: parentShortId })
      : await getGroupMd({ apiUrl, botToken, groupNo: parentGroupNo });
    content = resp.content ?? "";
  } catch (err) {
    if (httpStatusFromApiFetchError(err) === 404) {
      log?.("warn", "[fork] inherit md: parent md not found (404), skipping", { parentChannelId });
      return "skipped_empty";
    }
    log?.("warn", "[fork] inherit md: failed to fetch parent md", {
      parentChannelId,
      error: String(err),
    });
    return "fetch_failed";
  }

  // 2) Empty / whitespace-only parent md → nothing to inherit.
  if (content.trim() === "") {
    log?.("info", "[fork] inherit md: parent md empty, skipping", { parentChannelId });
    return "skipped_empty";
  }

  // 3) Size guard. Pre-check the byte length so we never issue an update that
  //    the server would reject; decision keeps updateThreadMd uncalled here.
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > THREAD_MD_MAX_BYTES) {
    log?.("warn", "[fork] inherit md: parent md exceeds size cap, skipping", {
      parentChannelId,
      byteLength,
    });
    return "skipped_too_large";
  }

  // 4) Write the child thread's THREAD.md.
  try {
    const { version } = await updateThreadMd({ apiUrl, botToken, groupNo: childGroupNo, shortId: childShortId, content });
    // Mirror the write into the local disk cache (P2, Jerry-Xin). updateThreadMd
    // only writes the octo server, but before_prompt_build's getGroupMdForPrompt
    // reads the local cache — without this, the inherited md would be invisible
    // to the child's first dispatch. The server write is the SSOT, so a local
    // cache failure must NOT downgrade the "ok" status (server already has it).
    try {
      broadcastThreadMdUpdate({ accountId, groupNo: childGroupNo, shortId: childShortId, content, version });
    } catch (cacheErr) {
      log?.("warn", "[fork] inherit md: server write ok but local cache update failed", {
        childGroupNo,
        childShortId,
        error: String(cacheErr),
      });
    }
    log?.("info", "[fork] inherit md: copied parent md to child thread.md", {
      childGroupNo,
      childShortId,
      byteLength,
    });
    return "ok";
  } catch (err) {
    if (httpStatusFromApiFetchError(err) === 403) {
      log?.("warn", "[fork] inherit md: no permission to write child thread.md (403)", {
        childGroupNo,
        childShortId,
      });
      return "no_permission";
    }
    log?.("warn", "[fork] inherit md: failed to update child thread.md", {
      childGroupNo,
      childShortId,
      error: String(err),
    });
    return "update_failed";
  }
}
