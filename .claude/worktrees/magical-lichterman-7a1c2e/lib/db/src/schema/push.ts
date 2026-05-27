import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

export const pushTokensTable = pgTable("push_tokens", {
  token: text("token").primaryKey(),
  platform: text("platform").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const notificationPrefsTable = pgTable("notification_prefs", {
  token: text("token").primaryKey(),
  digestEnabled: boolean("digest_enabled").notNull().default(false),
  digestHour: integer("digest_hour").notNull().default(8),
  digestMinute: integer("digest_minute").notNull().default(0),
  breakingEnabled: boolean("breaking_enabled").notNull().default(false),
  topicsEnabled: boolean("topics_enabled").notNull().default(false),
  topicsKeywords: text("topics_keywords").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PushToken = typeof pushTokensTable.$inferSelect;
export type InsertPushToken = typeof pushTokensTable.$inferInsert;
export type NotificationPrefs = typeof notificationPrefsTable.$inferSelect;
export type InsertNotificationPrefs =
  typeof notificationPrefsTable.$inferInsert;
