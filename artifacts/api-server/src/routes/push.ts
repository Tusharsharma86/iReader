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
        topicsEnabled?: boolean;
        topicsKeywords?: string[];
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
  if (typeof body?.topicsEnabled === "boolean")
    update["topicsEnabled"] = body.topicsEnabled;
  if (Array.isArray(body?.topicsKeywords))
    update["topicsKeywords"] = body.topicsKeywords
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0)
      .slice(0, 30);

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

export default router;
