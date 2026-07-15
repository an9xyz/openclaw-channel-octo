import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import { ackBotEvent, fetchBotEvents } from "./api-fetch.js";
import { CHANNEL_ID } from "./constants.js";
import { parseCardAction, type CardAction } from "./card-action.js";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LIMIT = 50;

export interface EventCursorStore {
  load(): Promise<number>;
  save(eventId: number): Promise<void>;
}

export function createFileEventCursorStore(params: {
  accountId: string;
  baseDir?: string;
}): EventCursorStore {
  const baseDir = params.baseDir ?? join(homedir(), ".openclaw", "workspace", CHANNEL_ID);
  const dir = join(baseDir, normalizeAccountId(params.accountId));
  const file = join(dir, "events.cursor.json");
  return {
    async load(): Promise<number> {
      try {
        const raw = JSON.parse(await readFile(file, "utf8")) as { event_id?: unknown };
        return typeof raw.event_id === "number" && Number.isSafeInteger(raw.event_id) && raw.event_id >= 0
          ? raw.event_id
          : 0;
      } catch {
        return 0;
      }
    },
    async save(eventId: number): Promise<void> {
      if (!Number.isSafeInteger(eventId) || eventId < 0) {
        throw new Error(`invalid event cursor: ${eventId}`);
      }
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.events.cursor.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(tmp, `${JSON.stringify({ event_id: eventId })}\n`, "utf8");
      await rename(tmp, file);
    },
  };
}

export interface EventPollerOptions {
  apiUrl: string;
  botToken: string;
  cursorStore: EventCursorStore;
  onCardAction: (action: CardAction) => void | Promise<void>;
  intervalMs?: number;
  limit?: number;
  ack?: boolean;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

export interface EventPoller {
  ready: Promise<void>;
  stop(): void;
  cursor(): number;
}

const pollStarters = new Map<string, () => void>();

export function setCardEventPollStarter(accountId: string, starter: (() => void) | undefined): void {
  const id = normalizeAccountId(accountId);
  if (starter) pollStarters.set(id, starter);
  else pollStarters.delete(id);
}

export function requestCardEventPolling(accountId: string): void {
  pollStarters.get(normalizeAccountId(accountId))?.();
}

/**
 * Start one non-overlapping short-poll loop. Cursor persistence happens before ack so a process
 * crash can at worst replay an action; it cannot acknowledge an event that it forgot locally.
 */
export function startEventPoller(options: EventPollerOptions): EventPoller {
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  let cursor = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const events = await fetchBotEvents({
        apiUrl: options.apiUrl,
        botToken: options.botToken,
        sinceEventId: cursor,
        limit,
      });
      let cardActions = 0;
      for (const event of [...events].sort((a, b) => a.event_id - b.event_id)) {
        if (!Number.isSafeInteger(event.event_id) || event.event_id <= cursor) continue;
        const action = parseCardAction(event);
        if (action) {
          cardActions += 1;
          await options.onCardAction(action);
        }

        await options.cursorStore.save(event.event_id);
        cursor = event.event_id;

        if (action && options.ack !== false) {
          try {
            await ackBotEvent({
              apiUrl: options.apiUrl,
              botToken: options.botToken,
              eventId: event.event_id,
            });
          } catch (error) {
            options.log?.error?.(
              `octo: ack event ${event.event_id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      if (events.length > 0) {
        options.log?.info?.(
          `octo: event poll batch events=${events.length} card_actions=${cardActions} cursor=${cursor}`,
        );
      }
    } catch (error) {
      options.log?.error?.(
        `octo: event poll failed at cursor=${cursor}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      schedule();
    }
  };

  const ready = options.cursorStore.load()
    .then((loaded) => {
      cursor = Number.isSafeInteger(loaded) && loaded >= 0 ? loaded : 0;
      options.log?.info?.(`octo: card event poller ready at cursor=${cursor}`);
      schedule();
    })
    .catch((error) => {
      options.log?.error?.(
        `octo: event cursor load failed, starting from zero: ${error instanceof Error ? error.message : String(error)}`,
      );
      cursor = 0;
      schedule();
    });

  return {
    ready,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    cursor(): number {
      return cursor;
    },
  };
}
