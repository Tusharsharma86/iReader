import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, pushTokensTable, notificationPrefsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const expo = new Expo();

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

// Send the same notification to a specific list of tokens. Invalid tokens
// returned by Expo's push service are deleted from BOTH push_tokens and
// notification_prefs so we stop trying to deliver to them.
export async function sendPushToTokens(
  tokens: string[],
  payload: PushPayload,
): Promise<{ sent: number; invalid: number }> {
  const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) return { sent: 0, invalid: 0 };

  // Build a single message list aligned with `valid`, then chunk it. We keep
  // a parallel `chunkTokens` array so each ticket can be mapped back to its
  // exact token even if some chunks fail mid-way (which would otherwise shift
  // indices and cause the wrong tokens to be purged).
  const messages: ExpoPushMessage[] = valid.map((token) => ({
    to: token,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    priority: "high",
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const invalidTokens = new Set<string>();
  let sentCount = 0;

  // Reconstruct the per-chunk token slice from the same chunking result. The
  // SDK chunks deterministically (by message count + size), so we mirror it.
  let cursor = 0;
  for (const chunk of chunks) {
    const chunkTokens = valid.slice(cursor, cursor + chunk.length);
    cursor += chunk.length;
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      ticketChunk.forEach((ticket, i) => {
        const tk = chunkTokens[i];
        if (!tk) return;
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          invalidTokens.add(tk);
        } else {
          sentCount += 1;
        }
      });
    } catch (err) {
      logger.warn({ err }, "expo push chunk failed");
      // Don't mark these tokens invalid — chunk failure is usually transient
      // (network/Expo outage), not a per-token issue.
    }
  }

  if (invalidTokens.size > 0) {
    try {
      for (const t of invalidTokens) {
        await db
          .delete(notificationPrefsTable)
          .where(eq(notificationPrefsTable.token, t));
        await db.delete(pushTokensTable).where(eq(pushTokensTable.token, t));
      }
      logger.info(
        { count: invalidTokens.size },
        "purged invalid push tokens (and prefs)",
      );
    } catch (err) {
      logger.warn({ err }, "failed to purge invalid tokens");
    }
  }

  return { sent: sentCount, invalid: invalidTokens.size };
}

export function isValidExpoPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}
