import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, pushTokensTable, notificationPrefsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "./logger";

const expo = new Expo();

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android-only rich content. `image` shows a big-picture thumbnail. */
  richContent?: { image?: string };
};

// ── Per-token notification log ───────────────────────────────────────────────
// Source of truth for both Android (merged into local history on focus) and
// Web (read via pair code). Captures every push attempted to a token even if
// the device was offline / killed when it landed.
export interface NotifLogEntry {
  id: string;          // article id or clusterId
  kind: string;        // 'breaking' | 'ai-feed' | 'topic' | 'source' | 'digest'
  title: string;
  body: string;
  firedAt: number;
  // Article snapshot — same shape as the in-app NotifHistoryEntry.
  headline?: string;
  summary?: string;
  imageUrl?: string;
  url?: string;
  source?: string;
  publishedAt?: string;
}

const NOTIF_LOG_PATH = "/tmp/notif-log.json";
const NOTIF_LOG_MAX_PER_TOKEN = 200;
const notifLog = new Map<string, NotifLogEntry[]>();

// Disk load (best-effort) — Render free tier wipes /tmp on cold-start.
try {
  if (existsSync(NOTIF_LOG_PATH)) {
    const raw = JSON.parse(readFileSync(NOTIF_LOG_PATH, "utf8")) as Record<string, NotifLogEntry[]>;
    for (const [tk, entries] of Object.entries(raw)) {
      notifLog.set(tk, entries);
    }
  }
} catch { /* ignore */ }

// ── Per-token muted-themes store ─────────────────────────────────────────────
// Backend-side gating: client syncs the user's muted breaking themes here so
// pushes for those themes are NEVER attempted. Local listener-based dismissal
// only works when the app is in foreground; this catches background/killed
// cases too.
//
// Source of truth: notification_prefs.muted_themes column in PostgreSQL.
// /tmp file is a warm-start cache only — never relied upon across restarts.
const MUTED_THEMES_PATH = "/tmp/muted-themes.json";
const mutedThemesByToken = new Map<string, Set<string>>();

// Warm the in-memory map from /tmp on a fresh cold start (best-effort).
try {
  if (existsSync(MUTED_THEMES_PATH)) {
    const raw = JSON.parse(readFileSync(MUTED_THEMES_PATH, "utf8")) as Record<string, string[]>;
    for (const [tk, list] of Object.entries(raw)) {
      mutedThemesByToken.set(tk, new Set(list));
    }
  }
} catch { /* ignore */ }

let mtWriteQueued = false;
function persistMutedThemesToTmp(): void {
  if (mtWriteQueued) return;
  mtWriteQueued = true;
  setTimeout(() => {
    mtWriteQueued = false;
    try {
      const obj: Record<string, string[]> = {};
      for (const [tk, set] of mutedThemesByToken.entries()) obj[tk] = Array.from(set);
      writeFileSync(MUTED_THEMES_PATH, JSON.stringify(obj));
    } catch { /* ignore */ }
  }, 2000);
}

// Called once at server startup — loads all muted-theme rows from DB into the
// in-memory map so the map survives Render restarts/deploys.
export async function initMutedThemesFromDb(): Promise<void> {
  try {
    const rows = await db
      .select({ token: notificationPrefsTable.token, mutedThemes: notificationPrefsTable.mutedThemes })
      .from(notificationPrefsTable);
    for (const row of rows) {
      if (row.mutedThemes.length > 0) {
        mutedThemesByToken.set(row.token, new Set(row.mutedThemes));
      }
    }
    logger.info({ count: rows.length }, "muted-themes: loaded from DB");
  } catch (err) {
    logger.warn({ err }, "muted-themes: DB load failed, falling back to /tmp cache");
  }
}

export function setMutedThemesForToken(token: string, themes: string[]): void {
  if (!token) return;
  mutedThemesByToken.set(token, new Set(themes));
  persistMutedThemesToTmp();
  // Persist to DB (fire-and-forget — in-memory map is already updated above).
  db.update(notificationPrefsTable)
    .set({ mutedThemes: themes, updatedAt: new Date() })
    .where(eq(notificationPrefsTable.token, token))
    .catch((err) => logger.warn({ err, token }, "muted-themes: DB write failed"));
}

export function getMutedThemesForToken(token: string): Set<string> {
  return mutedThemesByToken.get(token) ?? new Set();
}

let writeQueued = false;
function persistNotifLog(): void {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    try {
      const obj: Record<string, NotifLogEntry[]> = {};
      for (const [tk, entries] of notifLog.entries()) obj[tk] = entries;
      writeFileSync(NOTIF_LOG_PATH, JSON.stringify(obj));
    } catch { /* ignore */ }
  }, 2000);
}

function appendNotifLog(token: string, entry: NotifLogEntry): void {
  const arr = notifLog.get(token) ?? [];
  // Dedup by id (newer wins, floats to top).
  const filtered = arr.filter((e) => e.id !== entry.id);
  filtered.unshift(entry);
  notifLog.set(token, filtered.slice(0, NOTIF_LOG_MAX_PER_TOKEN));
  persistNotifLog();
}

export function getNotifHistoryForToken(token: string, limit = 200): NotifLogEntry[] {
  const arr = notifLog.get(token) ?? [];
  return arr.slice(0, limit);
}

function buildLogEntry(payload: PushPayload): NotifLogEntry {
  const data = (payload.data ?? {}) as {
    kind?: string;
    clusterId?: string;
    article?: {
      id?: string; headline?: string; summary?: string;
      imageUrl?: string; url?: string; source?: string; publishedAt?: string;
    };
  };
  const a = data.article ?? {};
  return {
    id: a.id ?? data.clusterId ?? `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: data.kind ?? "unknown",
    title: payload.title,
    body: payload.body,
    firedAt: Date.now(),
    headline: a.headline ?? payload.body,
    summary: a.summary,
    imageUrl: a.imageUrl,
    url: a.url,
    source: a.source,
    publishedAt: a.publishedAt,
  };
}

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
    // Android big-picture thumbnail when image URL provided.
    ...(payload.richContent ? { richContent: payload.richContent } : {}),
  } as ExpoPushMessage));

  // Log against every valid token BEFORE chunked send. We log on attempt, not
  // success — push delivery is async and tickets only confirm queueing. This
  // is the source of truth for history sync.
  const logEntry = buildLogEntry(payload);
  for (const tk of valid) {
    appendNotifLog(tk, { ...logEntry });
  }

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
