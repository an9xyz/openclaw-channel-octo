import { normalizeAccountId } from "./account-id.js";
import { ChannelType, type BotMessage } from "./types.js";

const inboundQueues = new Map<string, Promise<void>>();

export function getInboundQueueKey(accountId: string, message: BotMessage): string {
  const id = normalizeAccountId(accountId);
  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    (message.channel_type === ChannelType.Group ||
      message.channel_type === ChannelType.CommunityTopic);
  if (isGroup) return `${id}:group:${message.channel_id}`;

  let spaceId = "";
  if (message.channel_id?.startsWith("s")) {
    const firstPart = message.channel_id.split("@", 1)[0];
    const lastUnderscore = firstPart.lastIndexOf("_");
    if (lastUnderscore > 0) spaceId = firstPart.slice(1, lastUnderscore);
  }
  const sessionId = spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;
  return `${id}:dm:${sessionId}`;
}

/** Serialize work per account/conversation while still returning this task's real outcome. */
export function enqueueInbound(key: string, task: () => Promise<void>): Promise<void> {
  const previous = inboundQueues.get(key) ?? Promise.resolve();
  const execution = previous.catch(() => undefined).then(task);
  const tail = execution
    .catch(() => undefined)
    .finally(() => {
      if (inboundQueues.get(key) === tail) inboundQueues.delete(key);
    });
  inboundQueues.set(key, tail);
  return execution;
}
