import { Feather } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { router, Stack } from "expo-router";
import React, { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useNotifications } from "@/contexts/NotificationsContext";

function formatTime(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = minute.toString().padStart(2, "0");
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h}:${m} ${ampm}`;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { prefs, status, requestPermission, setPrefs } = useNotifications();
  const [showTimePicker, setShowTimePicker] = useState<boolean>(false);
  const [keywordInput, setKeywordInput] = useState<string>(
    prefs.topicsKeywords.join(", "),
  );

  const needsPermission = status === "idle" || status === "denied";
  const unsupported = status === "unsupported";

  // When the user toggles a notification type ON but hasn't granted permission
  // yet, prompt them. If they reject, we leave the toggle off.
  const guardedSet = async (patch: Partial<typeof prefs>) => {
    const turningSomethingOn = Object.values(patch).some((v) => v === true);
    if (turningSomethingOn && status !== "granted") {
      const ok = await requestPermission();
      if (!ok) return;
    }
    await setPrefs(patch);
  };

  const onTimeChange = async (
    _event: unknown,
    selected?: Date | undefined,
  ) => {
    if (Platform.OS === "android") setShowTimePicker(false);
    if (!selected) return;
    await setPrefs({
      digestHour: selected.getHours(),
      digestMinute: selected.getMinutes(),
    });
  };

  const commitKeywords = async () => {
    const list = keywordInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await setPrefs({ topicsKeywords: list });
  };

  const digestDate = new Date();
  digestDate.setHours(prefs.digestHour, prefs.digestMinute, 0, 0);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.headerBar,
          {
            paddingTop: insets.top + 6,
            borderBottomColor: colors.cardBorder,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.backBtn, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="chevron-left" size={26} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Notifications
        </Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 32,
          paddingTop: 12,
          gap: 18,
        }}
        showsVerticalScrollIndicator={false}
      >
        {unsupported ? (
          <PermissionBanner
            tone="warn"
            title="Push notifications need a real device"
            body="Notifications don't work on simulators or web — install the APK on your phone to enable them."
          />
        ) : needsPermission ? (
          <PermissionBanner
            tone="info"
            title={
              status === "denied"
                ? "Notifications are blocked"
                : "Allow notifications"
            }
            body={
              status === "denied"
                ? "We can't send updates until you re-enable notifications for iReader in your device settings."
                : "Grant permission so iReader can send you the daily digest, breaking news, and topic alerts."
            }
            actionLabel={status === "denied" ? undefined : "Enable"}
            onAction={status === "denied" ? undefined : requestPermission}
          />
        ) : null}

        {/* A: Daily digest */}
        <Section
          icon="sun"
          title="Daily digest"
          subtitle="Get a single morning summary of today's top stories."
        >
          <ToggleRow
            label="Enabled"
            value={prefs.digestEnabled}
            onChange={(v) => guardedSet({ digestEnabled: v })}
          />
          {prefs.digestEnabled ? (
            <Pressable
              onPress={() => setShowTimePicker((s) => !s)}
              style={({ pressed }) => [
                styles.timeRow,
                {
                  backgroundColor: colors.surfaceElevated,
                  borderColor: colors.cardBorder,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Feather name="clock" size={16} color={colors.mutedForeground} />
              <Text style={[styles.timeLabel, { color: colors.foreground }]}>
                Delivered at
              </Text>
              <Text style={[styles.timeValue, { color: colors.primary }]}>
                {formatTime(prefs.digestHour, prefs.digestMinute)}
              </Text>
            </Pressable>
          ) : null}
          {showTimePicker && prefs.digestEnabled ? (
            <DateTimePicker
              value={digestDate}
              mode="time"
              is24Hour={false}
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={onTimeChange}
              themeVariant="dark"
            />
          ) : null}
        </Section>

        {/* B: Breaking news */}
        <Section
          icon="zap"
          title="Breaking news"
          subtitle="Push when 3+ publishers confirm the same story within minutes."
        >
          <ToggleRow
            label="Enabled"
            value={prefs.breakingEnabled}
            onChange={(v) => guardedSet({ breakingEnabled: v })}
          />
        </Section>

        {/* C: Topic alerts */}
        <Section
          icon="bell"
          title="Topic alerts"
          subtitle="Notify me when a story matches one of my keywords."
        >
          <ToggleRow
            label="Enabled"
            value={prefs.topicsEnabled}
            onChange={(v) => guardedSet({ topicsEnabled: v })}
          />
          {prefs.topicsEnabled ? (
            <View style={{ gap: 8 }}>
              <Text
                style={[styles.helperLabel, { color: colors.mutedForeground }]}
              >
                Keywords (comma separated)
              </Text>
              <TextInput
                value={keywordInput}
                onChangeText={setKeywordInput}
                onBlur={commitKeywords}
                onSubmitEditing={commitKeywords}
                placeholder="apple, openai, vision pro"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.input,
                  {
                    color: colors.foreground,
                    backgroundColor: colors.surfaceElevated,
                    borderColor: colors.cardBorder,
                  },
                ]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text
                style={[styles.hint, { color: colors.mutedForeground }]}
              >
                Up to 30 keywords. Lowercased automatically. Tap outside the
                box to save.
              </Text>
            </View>
          ) : null}
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: colors.card, borderColor: colors.cardBorder },
      ]}
    >
      <View style={styles.sectionHeader}>
        <View
          style={[
            styles.sectionIcon,
            { backgroundColor: colors.surfaceElevated },
          ]}
        >
          <Feather name={icon} size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            {title}
          </Text>
          <Text
            style={[styles.sectionSubtitle, { color: colors.mutedForeground }]}
          >
            {subtitle}
          </Text>
        </View>
      </View>
      <View style={{ gap: 12 }}>{children}</View>
    </View>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.toggleRow}>
      <Text style={[styles.toggleLabel, { color: colors.foreground }]}>
        {label}
      </Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "#3a3a3a", true: colors.primary }}
        thumbColor={Platform.OS === "android" ? "#fff" : undefined}
      />
    </View>
  );
}

function PermissionBanner({
  tone,
  title,
  body,
  actionLabel,
  onAction,
}: {
  tone: "info" | "warn";
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const colors = useColors();
  const accent = tone === "warn" ? colors.destructive : colors.primary;
  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: colors.card,
          borderColor: colors.cardBorder,
        },
      ]}
    >
      <View style={[styles.bannerStripe, { backgroundColor: accent }]} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[styles.bannerTitle, { color: colors.foreground }]}>
          {title}
        </Text>
        <Text
          style={[styles.bannerBody, { color: colors.mutedForeground }]}
        >
          {body}
        </Text>
        {actionLabel && onAction ? (
          <Pressable
            onPress={onAction}
            style={({ pressed }) => [
              styles.bannerBtn,
              { backgroundColor: accent, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text
              style={[styles.bannerBtnText, { color: colors.background }]}
            >
              {actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 26, alignItems: "flex-start" },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 17 },
  section: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  sectionIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  sectionSubtitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 2,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  toggleLabel: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  timeLabel: { fontFamily: "Inter_500Medium", fontSize: 13, flex: 1 },
  timeValue: { fontFamily: "Inter_700Bold", fontSize: 15 },
  helperLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  hint: {
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
    lineHeight: 16,
  },
  banner: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  bannerStripe: { width: 4 },
  bannerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    padding: 0,
    paddingTop: 12,
    paddingHorizontal: 14,
  },
  bannerBody: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  bannerBtn: {
    alignSelf: "flex-start",
    marginLeft: 14,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  bannerBtnText: { fontFamily: "Inter_700Bold", fontSize: 12 },
});
