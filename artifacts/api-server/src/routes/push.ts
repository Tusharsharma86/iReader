// Trigger Render redeploy: 2026-05-28
import { Router, type IRouter } from "express";
import {
  db,
  pushTokensTable,
  notificationPrefsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { isValidExpoPushToken } from "../lib/push-sender";

const router: IRouter = Router();

// Register a device's Expo push token. Idempotent — re-registers update the
// updated_at and create a default preferences row if one doesn't exist.
router.post("/register", async (req, res) => {
  const body = req.body as
    | { token?: string; platform?: string }
    | undefined;
  const token = body?.token;
  const platform = body?.platform ?? "unknown";
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" });
    return;
  }
  if (!isValidExpoPushToken(token)) {
    res.status(400).json({ error: "invalid Expo push token" });
    return;
  }

  try {
    await db
      .insert(pushTokensTable)
      .values({ token, platform })
      .onConflictDoUpdate({
        target: pushTokensTable.token,
        set: { platform, updatedAt: sql`now()` },
      });

    // Ensure a preferences row exists with sensible defaults.
    await db
      .insert(notificationPrefsTable)
      .values({ token })
      .onConflictDoNothing({ target: notificationPrefsTable.token });

    const prefs = await db
      .select()
      .from(notificationPrefsTable)
      .where(eq(notificationPrefsTable.token, token))
      .limit(1);

    res.json({ ok: true, prefs: prefs[0] });
  } catch (err) {
    req.log.error({ err }, "push register failed");
    res.status(500).json({ error: "registration failed" });
  }
});

// Unregister a token (called when the user disables all notifications or
// uninstalls). Best-effort; missing rows are not an error.
router.delete("/unregister", async (req, res) => {
  const body = req.body as { token?: string } | undefined;
  const token = body?.token ?? (req.query["token"] as string | undefined);
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  try {
    await db
      .delete(notificationPrefsTable)
      .where(eq(notificationPrefsTable.token, token));
    await db.delete(pushTokensTable).where(eq(pushTokensTable.token, token));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "push unregister failed");
    res.status(500).json({ error: "unregister failed" });
  }
});

// Update preferences for a token. Accepts a partial — only provided fields are
// updated. Always returns the current full prefs row.
router.post("/preferences", async (req, res) => {
  const body = req.body as
    | {
        token?: string;
        digestEnabled?: boolean;
        digestHour?: number;
        digestMinute?: number;
        breakingEnabled?: boolean;
        aiFeedEnabled?: boolean;
        topicsEnabled?: boolean;
        topicsKeywords?: string[];
        favSourcesEnabled?: boolean;
        favSources?: string[];
        digestEveningEnabled?: boolean;
        digestEveningHour?: number;
        digestEveningMinute?: number;
      }
    | undefined;
  const token = body?.token;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" });
    return;
  }

  // Build a partial update record from the provided body.
  const update: Record<string, unknown> = { updatedAt: sql`now()` };
  if (typeof body?.digestEnabled === "boolean")
    update["digestEnabled"] = body.digestEnabled;
  if (
    typeof body?.digestHour === "number" &&
    body.digestHour >= 0 &&
    body.digestHour < 24
  )
    update["digestHour"] = Math.floor(body.digestHour);
  if (
    typeof body?.digestMinute === "number" &&
    body.digestMinute >= 0 &&
    body.digestMinute < 60
  )
    update["digestMinute"] = Math.floor(body.digestMinute);
  if (typeof body?.breakingEnabled === "boolean")
    update["breakingEnabled"] = body.breakingEnabled;
  if (typeof body?.aiFeedEnabled === "boolean")
    update["aiFeedEnabled"] = body.aiFeedEnabled;
  if (typeof body?.topicsEnabled === "boolean")
    update["topicsEnabled"] = body.topicsEnabled;
  if (Array.isArray(body?.topicsKeywords))
    update["topicsKeywords"] = body.topicsKeywords
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0)
      .slice(0, 500); // was 30 — the real cap that silently dropped most starred topics
  if (typeof body?.digestEveningEnabled === "boolean")
    update["digestEveningEnabled"] = body.digestEveningEnabled;
  if (
    typeof body?.digestEveningHour === "number" &&
    body.digestEveningHour >= 0 &&
    body.digestEveningHour < 24
  )
    update["digestEveningHour"] = Math.floor(body.digestEveningHour);
  if (
    typeof body?.digestEveningMinute === "number" &&
    body.digestEveningMinute >= 0 &&
    body.digestEveningMinute < 60
  )
    update["digestEveningMinute"] = Math.floor(body.digestEveningMinute);
  if (typeof body?.favSourcesEnabled === "boolean")
    update["favSourcesEnabled"] = body.favSourcesEnabled;
  if (Array.isArray(body?.favSources))
    update["favSources"] = body.favSources
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);

  try {
    // Upsert: insert with defaults if missing, otherwise update.
    await db
      .insert(notificationPrefsTable)
      .values({ token, ...(update as Record<string, never>) })
      .onConflictDoUpdate({
        target: notificationPrefsTable.token,
        set: update,
      });

    const rows = await db
      .select()
      .from(notificationPrefsTable)
      .where(eq(notificationPrefsTable.token, token))
      .limit(1);

    res.json({ ok: true, prefs: rows[0] });
  } catch (err) {
    req.log.error({ err }, "push preferences update failed");
    res.status(500).json({ error: "update failed" });
  }
});

router.get("/preferences", async (req, res) => {
  const token = req.query["token"] as string | undefined;
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(notificationPrefsTable)
      .where(eq(notificationPrefsTable.token, token))
      .limit(1);
    res.json({ prefs: rows[0] ?? null });
  } catch (err) {
    req.log.error({ err }, "push preferences fetch failed");
    res.status(500).json({ error: "fetch failed" });
  }
});

// ── Daily digest tick ──────────────────────────────────────────────────────
// Cron hits this every ~15 min. Endpoint finds users whose digestHour matches
// the current UTC hour AND who haven't been sent a digest in the last 23h.
// Sends them a push with today's top breaking headline.
const digestTickHandler = async (_req: import("express").Request, res: import("express").Response) => {
  // Return immediately so cron-job.org (30s timeout) never sees a slow response.
  // Actual work runs in the background.
  res.json({ ok: true, queued: true });

  // Fire-and-forget background work.
  (async () => {
    try {
      const now = new Date();
      const hourNow = now.getUTCHours();
      const minuteNow = now.getUTCMinutes();
      const cutoff = new Date(now.getTime() - 11 * 60 * 60 * 1000);

      const allPrefs = await db.select().from(notificationPrefsTable);
      const morningDue = allPrefs.filter(
        (p) =>
          p.digestEnabled &&
          p.digestHour === hourNow &&
          Math.abs(p.digestMinute - minuteNow) <= 15 &&
          (!p.lastDigestSentAt || new Date(p.lastDigestSentAt) < cutoff),
      );
      const eveningDue = allPrefs.filter(
        (p) =>
          p.digestEveningEnabled &&
          p.digestEveningHour === hourNow &&
          Math.abs(p.digestEveningMinute - minuteNow) <= 15 &&
          (!p.lastDigestEveningSentAt || new Date(p.lastDigestEveningSentAt) < cutoff),
      );
      if (morningDue.length === 0 && eveningDue.length === 0) return;

      // Read top headline from in-memory feed cache via the news route helper.
      // No HTTP self-fetch — avoids the timeout source.
      let headline = "Today's top stories";
      try {
        const newsMod = await import("./news");
        const c = (newsMod as unknown as { feedCache?: Map<string, { data: Array<{ type?: string; articles?: { headline: string }[]; headline?: string }> }> }).feedCache;
        const cached = c?.get("breaking");
        const top = cached?.data?.[0];
        if (top) {
          headline = (top.type === "cluster" ? top.articles?.[0]?.headline : top.headline) ?? headline;
        }
      } catch { /* fall back to default headline */ }

      const { sendPushToTokens } = await import("../lib/push-sender");
      if (morningDue.length > 0) {
        await sendPushToTokens(
          morningDue.map((p) => p.token),
          { title: "🌅 Morning Digest", body: headline, data: { kind: "digest", slot: "morning" } },
        );
        for (const p of morningDue) {
          await db.update(notificationPrefsTable)
            .set({ lastDigestSentAt: sql`now()` })
            .where(eq(notificationPrefsTable.token, p.token));
        }
      }
      if (eveningDue.length > 0) {
        await sendPushToTokens(
          eveningDue.map((p) => p.token),
          { title: "🌙 Evening Digest", body: headline, data: { kind: "digest", slot: "evening" } },
        );
        for (const p of eveningDue) {
          await db.update(notificationPrefsTable)
            .set({ lastDigestEveningSentAt: sql`now()` })
            .where(eq(notificationPrefsTable.token, p.token));
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("digest-tick background failed", err);
    }
  })();
};
router.post("/digest-tick", digestTickHandler);
router.get("/digest-tick", digestTickHandler);

// ── Diagnostics ─────────────────────────────────────────────────────────────
// Counts of registered tokens + per-category opt-ins. Lets us confirm a device
// actually registered + enabled breaking, without exposing tokens.
router.get("/stats", async (req, res) => {
  try {
    const tokens = await db.select().from(pushTokensTable);
    const prefs = await db.select().from(notificationPrefsTable);
    res.json({
      tokens: tokens.length,
      prefs: prefs.length,
      breakingEnabled: prefs.filter((p) => p.breakingEnabled).length,
      aiFeedEnabled: prefs.filter((p) => (p as { aiFeedEnabled?: boolean }).aiFeedEnabled).length,
      topicsEnabled: prefs.filter((p) => p.topicsEnabled).length,
      digestEnabled: prefs.filter((p) => p.digestEnabled).length,
    });
  } catch (err) {
    req.log?.error?.({ err }, "push stats failed");
    res.status(500).json({ error: "stats failed" });
  }
});

// Manual test push — isolates the delivery pipeline (token + FCM + device)
// from the news/cron trigger. ?token=... targets one device; otherwise sends
// to every device with breakingEnabled. Returns immediately; sends in bg.
const testPushHandler = async (req: import("express").Request, res: import("express").Response) => {
  const only = (req.query["token"] as string | undefined)?.trim();
  res.json({ ok: true, queued: true, target: only ? "single token" : "all breakingEnabled" });
  (async () => {
    try {
      let tokens: string[];
      if (only) {
        tokens = [only];
      } else {
        const prefs = await db.select().from(notificationPrefsTable);
        tokens = prefs.filter((p) => p.breakingEnabled).map((p) => p.token);
      }
      if (tokens.length === 0) return;
      const { sendPushToTokens } = await import("../lib/push-sender");
      await sendPushToTokens(tokens, {
        title: "Test · Breaking",
        body: "If you see this, push delivery works. The trigger is the only variable.",
        data: { kind: "breaking", clusterId: "test", fp: "test", article: {} },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[push] test push failed", err);
    }
  })();
};
router.get("/test", testPushHandler);
router.post("/test", testPushHandler);

export default router;
