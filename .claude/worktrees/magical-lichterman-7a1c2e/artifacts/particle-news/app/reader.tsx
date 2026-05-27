import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useImageTint } from "@/hooks/useImageTint";
import { fetchArticle, proxiedImageUrl } from "@/lib/api";

const FALLBACK_DOMINANT = "#1F2128";

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

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

function parseColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return hexToRgb(trimmed);
  const rgbMatch = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i,
  );
  if (rgbMatch) {
    const r = Math.round(parseFloat(rgbMatch[1]));
    const g = Math.round(parseFloat(rgbMatch[2]));
    const b = Math.round(parseFloat(rgbMatch[3]));
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return [r, g, b];
  }
  return null;
}

function toHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) =>
        Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"),
      )
      .join("")
  );
}

function rgbaFromHex(input: string, alpha: number): string {
  const rgb = parseColor(input);
  if (!rgb) return `rgba(31,33,40,${alpha})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function darken(input: string, amount: number): string {
  const rgb = parseColor(input);
  if (!rgb) return "#101013";
  return toHex(
    rgb.map((c) => Math.round(c * (1 - amount))) as [number, number, number],
  );
}

function lighten(input: string, amount: number): string {
  const rgb = parseColor(input);
  if (!rgb) return "#FFFFFF";
  return toHex(
    rgb.map((c) => Math.round(c + (255 - c) * amount)) as [
      number,
      number,
      number,
    ],
  );
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

export default function ReaderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    url?: string;
    image?: string;
    headline?: string;
    source?: string;
    category?: string;
    publishedAt?: string;
  }>();

  const url = typeof params.url === "string" ? params.url : "";
  const image = typeof params.image === "string" ? params.image : "";
  const headline = typeof params.headline === "string" ? params.headline : "";
  const source = typeof params.source === "string" ? params.source : "";
  const category = typeof params.category === "string" ? params.category : "";
  const publishedAt =
    typeof params.publishedAt === "string" ? params.publishedAt : "";
  const hostname = url ? tryHostname(url) : "";

  const proxiedHero = proxiedImageUrl(image);
  const tint = useImageTint(proxiedHero);
  const dominant = image ? tint.dominant : FALLBACK_DOMINANT;

  // Color system derived from the image's dominant color.
  const screenBg = darken(dominant, 0.7);
  const cardBg = darken(dominant, 0.82);
  const accentText = lighten(dominant, 0.55);
  const subtleText = lighten(dominant, 0.35);

  const article = useQuery({
    queryKey: ["article", url],
    queryFn: () => fetchArticle(url),
    enabled: Boolean(url),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;
  const title = article.data?.title || headline;
  const timeAgo = publishedAt ? formatTimeAgo(publishedAt) : "";

  // Always render the publisher's original article. Older cached entries that
  // only have the deduped `paragraphs` field still render via the fallback.
  const visibleParagraphs =
    article.data?.originalParagraphs ?? article.data?.paragraphs ?? [];
  // Treat a successful response with zero paragraphs as an extraction failure
  // (e.g. Cloudflare-blocked publishers) so the user gets the same friendly
  // "Open in Browser" prompt as a hard fetch error.
  const extractionEmpty =
    !article.isLoading &&
    !article.isError &&
    Boolean(article.data) &&
    visibleParagraphs.length === 0;

  const openOriginal = () => {
    if (!url) return;
    if (Platform.OS !== "web") {
      Haptics.selectionAsync().catch(() => {});
    }
    WebBrowser.openBrowserAsync(url).catch(() => {});
  };

  const goBack = () => {
    if (Platform.OS !== "web") {
      Haptics.selectionAsync().catch(() => {});
    }
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  return (
    <View style={[styles.container, { backgroundColor: screenBg }]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: insets.bottom + 110,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero image with floating glassmorphic action buttons. */}
        <View style={styles.heroWrap}>
          {proxiedHero ? (
            <Image
              source={{ uri: proxiedHero }}
              style={styles.hero}
              contentFit="cover"
              transition={400}
            />
          ) : (
            <View style={[styles.hero, { backgroundColor: cardBg }]} />
          )}
          {/* Tint wash to push the image toward the dominant color */}
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: rgbaFromHex(dominant, 0.18) },
            ]}
          />
          {/* Bottom-fade gradient that bleeds the hero into the screen tint */}
          <LinearGradient
            pointerEvents="none"
            colors={["rgba(0,0,0,0)", "rgba(0,0,0,0)", screenBg]}
            locations={[0, 0.55, 1]}
            style={StyleSheet.absoluteFill}
          />

          {/* Floating glass buttons */}
          <View
            style={[
              styles.floatingBar,
              { top: topPad + 6 },
            ]}
          >
            <GlassButton onPress={goBack}>
              <Feather name="chevron-left" size={20} color="#FFFFFF" />
            </GlassButton>
            <View style={{ flex: 1 }} />
            {url ? (
              <GlassButton onPress={openOriginal}>
                <Feather name="share" size={17} color="#FFFFFF" />
              </GlassButton>
            ) : null}
            {url ? (
              <GlassButton onPress={openOriginal}>
                <Feather name="more-horizontal" size={20} color="#FFFFFF" />
              </GlassButton>
            ) : null}
          </View>
        </View>

        {/* Source brand display */}
        {source ? (
          <View style={styles.brandWrap}>
            <Text
              style={[
                styles.brandText,
                {
                  color: "#FFFFFF",
                  textShadowColor: rgbaFromHex(accentText, 0.45),
                },
              ]}
              numberOfLines={1}
            >
              {source}
            </Text>
          </View>
        ) : null}

        {/* Meta row: lightning + time ago */}
        <View style={styles.metaRow}>
          <Feather name="zap" size={11} color={accentText} />
          {timeAgo ? (
            <Text style={[styles.metaText, { color: accentText }]}>
              {timeAgo.toUpperCase()}
            </Text>
          ) : null}
          {category ? (
            <>
              <View
                style={[styles.metaDot, { backgroundColor: subtleText }]}
              />
              <Text style={[styles.metaText, { color: accentText }]}>
                {category.toUpperCase()}
              </Text>
            </>
          ) : null}
        </View>

        {/* Headline */}
        {title ? (
          <Text style={[styles.headline, { color: "#FFFFFF" }]}>{title}</Text>
        ) : null}

        {/* Dek / source line */}
        {hostname ? (
          <Text style={[styles.dek, { color: subtleText }]}>
            From {hostname}
          </Text>
        ) : null}

        {/* Content card */}
        <View
          style={[
            styles.contentCard,
            {
              backgroundColor: cardBg,
              shadowColor: dominant,
              ...Platform.select({
                web: {
                  boxShadow: `0 18px 40px ${rgbaFromHex(dominant, 0.45)}`,
                },
                default: {},
              }),
            },
          ]}
        >
          {article.isLoading ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator color={accentText} />
              <Text style={[styles.loadingText, { color: subtleText }]}>
                Fetching the article…
              </Text>
            </View>
          ) : article.isError || extractionEmpty ? (
            <View style={styles.errorBlock}>
              <Feather name="alert-circle" size={24} color={subtleText} />
              <Text style={[styles.errorTitle, { color: "#FFFFFF" }]}>
                Couldn't extract this article
              </Text>
              <Text style={[styles.errorText, { color: subtleText }]}>
                {article.error instanceof Error
                  ? article.error.message
                  : "The publisher may be blocking automated reads."}
              </Text>
              {url ? (
                <Pressable
                  onPress={openOriginal}
                  style={({ pressed }) => [
                    styles.openBtn,
                    {
                      backgroundColor: "#FFFFFF",
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.openBtnText, { color: "#0A0A0A" }]}>
                    Open in browser
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View style={styles.articleBody}>
              {visibleParagraphs.map((p, i) => (
                <Animated.Text
                  key={`p-${i}`}
                  entering={FadeInDown.delay(Math.min(i, 8) * 30).duration(280)}
                  style={[styles.paragraph, { color: "#F2F2F4" }]}
                >
                  {p}
                </Animated.Text>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Bottom floating action bar */}
      <View
        style={[
          styles.bottomBarWrap,
          {
            paddingBottom: Math.max(insets.bottom, 14),
          },
        ]}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.bottomBar,
            {
              backgroundColor: rgbaFromHex(lighten(dominant, 0.15), 0.88),
              shadowColor: "#000000",
            },
          ]}
        >
          <BottomAction
            icon="bookmark"
            label="Save Article"
            onPress={() => {
              // Save logic lives on the home tile already; here it's a no-op
              // hint to the user.
              if (Platform.OS !== "web") {
                Haptics.selectionAsync().catch(() => {});
              }
            }}
          />
          <View style={styles.bottomBarDivider} />
          <BottomAction
            icon="external-link"
            label="Open in Browser"
            onPress={openOriginal}
          />
        </View>
      </View>
    </View>
  );
}

function GlassButton({
  onPress,
  children,
}: {
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [
        styles.glassBtn,
        {
          backgroundColor: "rgba(20,22,28,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

function BottomAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.bottomAction,
        { opacity: pressed ? 0.65 : 1 },
      ]}
    >
      <Feather name={icon} size={15} color="#0A0A0A" />
      <Text style={styles.bottomActionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroWrap: {
    width: "100%",
    aspectRatio: 16 / 10,
    overflow: "hidden",
  },
  hero: { width: "100%", height: "100%" },
  floatingBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  glassBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  brandWrap: {
    paddingHorizontal: 22,
    paddingTop: 18,
    alignItems: "center",
  },
  brandText: {
    fontFamily: "Inter_700Bold",
    fontSize: 26,
    letterSpacing: -0.4,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  metaRow: {
    paddingHorizontal: 22,
    paddingTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    letterSpacing: 1.1,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    marginHorizontal: 4,
    opacity: 0.6,
  },
  headline: {
    paddingHorizontal: 22,
    paddingTop: 8,
    fontFamily: "Inter_700Bold",
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.5,
  },
  dek: {
    paddingHorizontal: 22,
    paddingTop: 8,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 21,
  },
  contentCard: {
    marginHorizontal: 16,
    marginTop: 22,
    borderRadius: 22,
    padding: 18,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 28,
    elevation: 10,
  },
  loadingBlock: {
    paddingVertical: 50,
    alignItems: "center",
    gap: 10,
  },
  loadingText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  errorBlock: {
    paddingVertical: 40,
    paddingHorizontal: 18,
    alignItems: "center",
    gap: 10,
  },
  errorTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    marginTop: 4,
  },
  errorText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  openBtn: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  openBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  articleBody: { gap: 14 },
  paragraph: {
    fontFamily: "Inter_400Regular",
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.1,
  },
  bottomBarWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 280,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 22,
    elevation: 12,
  },
  bottomBarDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: "rgba(0,0,0,0.18)",
    marginHorizontal: 4,
  },
  bottomAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  bottomActionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: "#0A0A0A",
  },
});
