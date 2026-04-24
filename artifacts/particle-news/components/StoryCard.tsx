import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  FadeInDown,
  LinearTransition,
} from "react-native-reanimated";

import { PerspectiveBar } from "@/components/PerspectiveBar";
import { useColors } from "@/hooks/useColors";
import { useImageTint } from "@/hooks/useImageTint";
import { useSaved } from "@/contexts/SavedContext";
import { proxiedImageUrl, type StoryCard as StoryCardType } from "@/lib/api";

type SummaryMode = "fiveWs" | "eli5" | "keyHighlights";

const MODE_LABELS: { key: SummaryMode; label: string }[] = [
  { key: "fiveWs", label: "The 5Ws" },
  { key: "keyHighlights", label: "Key Highlights" },
  { key: "eli5", label: "ELI5" },
];

const FALLBACK_BG = "#1A1A1A";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "").trim();
  const full =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [r, g, b];
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(26,26,26,${alpha})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function tintedBase(hex: string, mix = 0.35): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return FALLBACK_BG;
  const base = 26;
  const r = Math.round(base * (1 - mix) + rgb[0] * mix);
  const g = Math.round(base * (1 - mix) + rgb[1] * mix);
  const b = Math.round(base * (1 - mix) + rgb[2] * mix);
  return `rgb(${r},${g},${b})`;
}

function formatTimeAgo(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function StoryCardView({
  story,
  index,
}: {
  story: StoryCardType;
  index: number;
}) {
  const colors = useColors();
  const router = useRouter();
  const proxiedImage = proxiedImageUrl(story.imageUrl);
  const tint = useImageTint(proxiedImage);
  const { isSaved, toggle } = useSaved();
  const [mode, setMode] = useState<SummaryMode>("keyHighlights");
  const saved = isSaved(story.id);

  const hasImage = Boolean(proxiedImage);
  const dominant = hasImage ? tint.dominant : FALLBACK_BG;
  const vibrant = hasImage ? tint.vibrant : "#3A3A3A";

  const bullets = story.summaries[mode] ?? [];

  const headlineShadow = hasImage
    ? {
        textShadowColor: hexToRgba(dominant, 0.55),
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 8,
      }
    : null;

  return (
    <Animated.View
      entering={FadeInDown.delay(Math.min(index, 6) * 70)
        .duration(450)
        .springify()
        .damping(18)}
      layout={LinearTransition.springify().damping(20)}
      style={[
        styles.card,
        {
          backgroundColor: hasImage ? tintedBase(dominant, 0.32) : FALLBACK_BG,
          borderRadius: colors.radius,
        },
      ]}
    >
      <LinearGradient
        colors={[hexToRgba(dominant, 0.35), hexToRgba(dominant, 0.08)]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <View
        style={[styles.accentBar, { backgroundColor: vibrant }]}
        pointerEvents="none"
      />

      {proxiedImage ? (
        <View style={styles.imageWrap}>
          <Image
            source={{ uri: proxiedImage }}
            style={styles.image}
            contentFit="cover"
            transition={300}
          />
          <View style={styles.imageOverlay} />
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>
              {story.category?.toUpperCase() ?? "NEWS"}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.headerRow}>
          <View
            style={[
              styles.categoryPillStandalone,
              { backgroundColor: colors.primaryGlow },
            ]}
          >
            <Text style={[styles.categoryText, { color: colors.primary }]}>
              {story.category?.toUpperCase() ?? "NEWS"}
            </Text>
          </View>
        </View>
      )}

      <View style={styles.body}>
        <Text style={[styles.headline, { color: "#FFFFFF" }, headlineShadow]}>
          {story.headline}
        </Text>

        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {formatTimeAgo(story.publishedAt)}
          </Text>
          <View style={styles.metaDot} />
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {story.sourceCount}{" "}
            {story.sourceCount === 1 ? "source" : "sources"}
          </Text>
        </View>

        <View style={styles.modeRow}>
          {MODE_LABELS.map((m) => {
            const active = m.key === mode;
            return (
              <Pressable
                key={m.key}
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.selectionAsync().catch(() => {});
                  }
                  setMode(m.key);
                }}
                style={({ pressed }) => [
                  styles.modeChip,
                  {
                    backgroundColor: active
                      ? colors.foreground
                      : "rgba(255,255,255,0.06)",
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.modeText,
                    {
                      color: active
                        ? colors.background
                        : colors.mutedForeground,
                    },
                  ]}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Animated.View
          key={mode}
          entering={FadeInDown.duration(280)}
          style={styles.bullets}
        >
          {bullets.map((b, i) => (
            <View key={i} style={styles.bulletRow}>
              <View
                style={[styles.bulletDot, { backgroundColor: vibrant }]}
              />
              <Text
                style={[styles.bulletText, { color: colors.foreground }]}
              >
                {b}
              </Text>
            </View>
          ))}
          {bullets.length === 0 && (
            <Text
              style={[styles.bulletText, { color: colors.mutedForeground }]}
            >
              Summary unavailable.
            </Text>
          )}
        </Animated.View>

        <View
          style={[styles.divider, { backgroundColor: colors.cardBorder }]}
        />

        <PerspectiveBar sources={story.sources} />

        <View style={styles.footerRow}>
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                  () => {},
                );
              }
              toggle(story);
            }}
            style={({ pressed }) => [
              styles.iconButton,
              {
                backgroundColor: saved
                  ? colors.primaryGlow
                  : "rgba(255,255,255,0.06)",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Feather
              name="bookmark"
              size={18}
              color={saved ? colors.primary : colors.mutedForeground}
            />
            <Text
              style={[
                styles.iconButtonText,
                {
                  color: saved ? colors.primary : colors.mutedForeground,
                },
              ]}
            >
              {saved ? "Saved" : "Save"}
            </Text>
          </Pressable>

          {story.sources[0]?.url ? (
            <Pressable
              onPress={() => {
                const src = story.sources[0];
                if (!src?.url) return;
                if (Platform.OS !== "web") {
                  Haptics.selectionAsync().catch(() => {});
                }
                router.push({
                  pathname: "/reader",
                  params: {
                    url: src.url,
                    image: story.imageUrl ?? "",
                    headline: story.headline,
                    source: src.name,
                    category: story.category ?? "",
                  },
                });
              }}
              style={({ pressed }) => [
                styles.iconButton,
                {
                  backgroundColor: "rgba(255,255,255,0.06)",
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Feather
                name="external-link"
                size={18}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.iconButtonText,
                  { color: colors.mutedForeground },
                ]}
              >
                Read
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: "hidden",
    marginBottom: 16,
    position: "relative",
  },
  accentBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    zIndex: 2,
  },
  imageWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  image: { width: "100%", height: "100%" },
  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  categoryPill: {
    position: "absolute",
    top: 14,
    left: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  categoryPillStandalone: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  headerRow: { paddingHorizontal: 18, paddingTop: 18 },
  categoryText: {
    color: "#FFFFFF",
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  body: { padding: 18, gap: 14 },
  headline: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.3,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: -4,
  },
  meta: { fontFamily: "Inter_500Medium", fontSize: 12 },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  modeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  modeText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  bullets: { gap: 10, marginTop: 2 },
  bulletRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 9,
  },
  bulletText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 21,
  },
  divider: { height: 1, marginVertical: 4 },
  footerRow: { flexDirection: "row", gap: 10 },
  iconButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  iconButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
