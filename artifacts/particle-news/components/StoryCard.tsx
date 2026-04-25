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

import { useColors } from "@/hooks/useColors";
import { useImageTint } from "@/hooks/useImageTint";
import { useSaved } from "@/contexts/SavedContext";
import {
  proxiedImageUrl,
  type Source,
  type StoryCard as StoryCardType,
} from "@/lib/api";

type SummaryMode = "fiveWs" | "eli5" | "keyHighlights";

const MODE_LABELS: { key: SummaryMode; label: string }[] = [
  { key: "fiveWs", label: "The 5Ws" },
  { key: "keyHighlights", label: "Key Highlights" },
  { key: "eli5", label: "ELI5" },
];

const FALLBACK_DOMINANT = "#1F1F22";
const FALLBACK_VIBRANT = "#5A5A66";

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

function rgbaFromHex(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(31,31,34,${alpha})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#101013";
  const [r, g, b] = rgb.map((c) => Math.max(0, Math.round(c * (1 - amount))));
  return `rgb(${r},${g},${b})`;
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#FFFFFF";
  const [r, g, b] = rgb.map((c) =>
    Math.min(255, Math.round(c + (255 - c) * amount)),
  );
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

const FIVE_W_RE = /^\s*(WHO|WHAT|WHEN|WHERE|WHY)\s*[:\-–—]\s*(.+)$/i;

function parseFiveW(line: string): { label: string | null; body: string } {
  const m = line.match(FIVE_W_RE);
  if (m) return { label: m[1]!.toUpperCase(), body: m[2]!.trim() };
  return { label: null, body: line };
}

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
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
  const dominant = hasImage ? tint.dominant : FALLBACK_DOMINANT;
  const vibrant = hasImage ? tint.vibrant : FALLBACK_VIBRANT;

  const surfaceColor = darken(dominant, 0.78);
  const imageWash = rgbaFromHex(dominant, 0.55);
  const accentText = lighten(dominant, 0.55);

  const openReader = (sourceOverride?: Source) => {
    const src = sourceOverride ?? story.sources[0];
    if (!src?.url) return;
    if (Platform.OS !== "web") {
      Haptics.selectionAsync().catch(() => {});
    }
    router.push({
      pathname: "/reader",
      params: {
        url: src.url,
        image: src.imageUrl ?? story.imageUrl ?? "",
        headline: story.headline,
        source: src.name,
        category: story.category ?? "",
      },
    });
  };

  return (
    <Animated.View
      entering={FadeInDown.delay(Math.min(index, 6) * 70)
        .duration(450)
        .springify()
        .damping(18)}
      layout={LinearTransition.springify().damping(20)}
      style={[
        styles.cardShadow,
        {
          borderRadius: colors.radius,
          shadowColor: dominant,
          ...Platform.select({
            web: {
              boxShadow: `0 16px 38px ${rgbaFromHex(dominant, 0.45)}`,
            },
            default: {},
          }),
        },
      ]}
    >
      <Pressable
        onPress={() => openReader()}
        android_ripple={{ color: rgbaFromHex(dominant, 0.25) }}
        style={({ pressed }) => [
          styles.card,
          {
            borderRadius: colors.radius,
            backgroundColor: surfaceColor,
            opacity: pressed && Platform.OS === "ios" ? 0.92 : 1,
          },
        ]}
      >
        <LinearGradient
          colors={[
            rgbaFromHex(dominant, 0.25),
            "rgba(0,0,0,0)",
            rgbaFromHex(dominant, 0.18),
          ]}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
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
            <View
              style={[styles.imageOverlay, { backgroundColor: imageWash }]}
              pointerEvents="none"
            />
            <LinearGradient
              colors={["rgba(0,0,0,0)", surfaceColor]}
              locations={[0.55, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
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
                { backgroundColor: rgbaFromHex(accentText, 0.18) },
              ]}
            >
              <Text style={[styles.categoryText, { color: accentText }]}>
                {story.category?.toUpperCase() ?? "NEWS"}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.body}>
          <View style={styles.metaRow}>
            <Text
              style={[styles.meta, { color: accentText, letterSpacing: 1.1 }]}
            >
              {story.sourceCount}{" "}
              {story.sourceCount === 1 ? "SOURCE" : "SOURCES"}
            </Text>
            <View style={[styles.metaDot, { backgroundColor: accentText }]} />
            <Text style={[styles.meta, { color: accentText }]}>
              {formatTimeAgo(story.publishedAt).toUpperCase()}
            </Text>
          </View>

          <Text style={styles.headline}>{story.headline}</Text>

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
                        ? "#FFFFFF"
                        : "rgba(255,255,255,0.10)",
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.modeText,
                      {
                        color: active ? "#0A0A0A" : "rgba(255,255,255,0.85)",
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
            style={styles.summaryWrap}
          >
            {mode === "fiveWs" ? (
              <FiveWsList lines={story.summaries.fiveWs} accent={accentText} />
            ) : mode === "eli5" ? (
              <SummaryParagraph text={story.summaries.eli5} />
            ) : (
              <SummaryParagraph text={story.summaries.keyHighlights} />
            )}
          </Animated.View>

          <View style={styles.divider} />

          <SourcesList
            sources={story.sources}
            accent={accentText}
            onOpenSource={(s) => openReader(s)}
          />

          <View style={styles.footerRow}>
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
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
                    ? rgbaFromHex(accentText, 0.22)
                    : "rgba(255,255,255,0.08)",
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Feather
                name="bookmark"
                size={16}
                color={saved ? accentText : "rgba(255,255,255,0.75)"}
              />
              <Text
                style={[
                  styles.iconButtonText,
                  {
                    color: saved ? accentText : "rgba(255,255,255,0.75)",
                  },
                ]}
              >
                {saved ? "Saved" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function SummaryParagraph({ text }: { text: string }) {
  if (!text || !text.trim()) {
    return (
      <Text style={[styles.paragraph, { color: "rgba(255,255,255,0.55)" }]}>
        Summary unavailable.
      </Text>
    );
  }
  return <Text style={styles.paragraph}>{text}</Text>;
}

function FiveWsList({ lines, accent }: { lines: string[]; accent: string }) {
  if (!lines || lines.length === 0) {
    return (
      <Text style={[styles.paragraph, { color: "rgba(255,255,255,0.55)" }]}>
        Summary unavailable.
      </Text>
    );
  }
  return (
    <View style={{ gap: 14 }}>
      {lines.map((line, i) => {
        const { label, body } = parseFiveW(line);
        return (
          <View key={i} style={styles.qaBlock}>
            {label ? (
              <Text style={[styles.qaLabel, { color: accent }]}>{label}</Text>
            ) : null}
            <Text style={styles.qaBody}>{body}</Text>
          </View>
        );
      })}
    </View>
  );
}

const SOURCE_TYPE_LABEL: Record<Source["type"], string> = {
  mainstream: "Mainstream",
  tech: "Tech",
  niche: "Niche",
};

function SourcesList({
  sources,
  accent,
  onOpenSource,
}: {
  sources: Source[];
  accent: string;
  onOpenSource: (s: Source) => void;
}) {
  if (!sources || sources.length === 0) return null;
  return (
    <View style={styles.sourcesWrap}>
      <Text style={[styles.sourcesHeader, { color: accent }]}>
        REFERENCED ARTICLES
      </Text>
      <View style={{ gap: 8 }}>
        {sources.map((s, i) => {
          const thumb = proxiedImageUrl(s.imageUrl ?? null);
          const host = tryHostname(s.url);
          return (
            <Pressable
              key={`${i}-${s.url}`}
              onPress={(e) => {
                e.stopPropagation?.();
                onOpenSource(s);
              }}
              style={({ pressed }) => [
                styles.sourceRow,
                {
                  backgroundColor: pressed
                    ? "rgba(255,255,255,0.10)"
                    : "rgba(255,255,255,0.05)",
                },
              ]}
            >
              <View style={styles.sourceThumbWrap}>
                {thumb ? (
                  <Image
                    source={{ uri: thumb }}
                    style={styles.sourceThumb}
                    contentFit="cover"
                    transition={200}
                  />
                ) : (
                  <View
                    style={[
                      styles.sourceThumb,
                      {
                        backgroundColor: "rgba(255,255,255,0.08)",
                        alignItems: "center",
                        justifyContent: "center",
                      },
                    ]}
                  >
                    <Feather
                      name="file-text"
                      size={16}
                      color="rgba(255,255,255,0.45)"
                    />
                  </View>
                )}
              </View>
              <View style={styles.sourceMeta}>
                <Text
                  style={styles.sourceName}
                  numberOfLines={1}
                >
                  {s.name}
                </Text>
                <Text
                  style={styles.sourceSub}
                  numberOfLines={1}
                >
                  {SOURCE_TYPE_LABEL[s.type] ?? "Source"}
                  {host ? ` · ${host}` : ""}
                </Text>
              </View>
              <Feather
                name="chevron-right"
                size={16}
                color="rgba(255,255,255,0.55)"
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardShadow: {
    marginBottom: 16,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 28,
    elevation: 12,
  },
  card: {
    overflow: "hidden",
  },
  imageWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  image: { width: "100%", height: "100%" },
  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  categoryPill: {
    position: "absolute",
    top: 14,
    left: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.45)",
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
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.4,
    color: "#FFFFFF",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  meta: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    opacity: 0.8,
  },
  modeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  modeText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  summaryWrap: { marginTop: 2 },
  paragraph: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 22,
    color: "#F2F2F4",
  },
  qaBlock: { gap: 4 },
  qaLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    letterSpacing: 1.4,
  },
  qaBody: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 21,
    color: "#F2F2F4",
  },
  divider: {
    height: 1,
    marginVertical: 4,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  sourcesWrap: { gap: 10 },
  sourcesHeader: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    letterSpacing: 1.4,
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 8,
    borderRadius: 12,
  },
  sourceThumbWrap: {
    width: 44,
    height: 44,
    borderRadius: 8,
    overflow: "hidden",
  },
  sourceThumb: { width: "100%", height: "100%" },
  sourceMeta: { flex: 1, gap: 2 },
  sourceName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: "#FFFFFF",
  },
  sourceSub: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
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
