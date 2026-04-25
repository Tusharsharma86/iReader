import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
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

import { useColors } from "@/hooks/useColors";
import { fetchArticle, proxiedImageUrl } from "@/lib/api";

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export default function ReaderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const params = useLocalSearchParams<{
    url?: string;
    image?: string;
    headline?: string;
    source?: string;
    category?: string;
  }>();

  const url = typeof params.url === "string" ? params.url : "";
  const image = typeof params.image === "string" ? params.image : "";
  const headline = typeof params.headline === "string" ? params.headline : "";
  const source = typeof params.source === "string" ? params.source : "";
  const category = typeof params.category === "string" ? params.category : "";
  const hostname = url ? tryHostname(url) : "";

  const article = useQuery({
    queryKey: ["article", url],
    queryFn: () => fetchArticle(url),
    enabled: Boolean(url),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;
  const title = article.data?.title || headline;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.topBar,
          {
            paddingTop: topPad + 8,
            backgroundColor: colors.background,
            borderBottomColor: colors.cardBorder,
          },
        ]}
      >
        <Pressable
          onPress={() => {
            if (Platform.OS !== "web") {
              Haptics.selectionAsync().catch(() => {});
            }
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          style={({ pressed }) => [
            styles.iconBtn,
            {
              backgroundColor: "rgba(255,255,255,0.06)",
              opacity: pressed ? 0.7 : 1,
            },
          ]}
          hitSlop={10}
        >
          <Feather name="chevron-left" size={20} color={colors.foreground} />
        </Pressable>

        <View style={styles.topMeta}>
          <Text style={[styles.topMetaLabel, { color: colors.mutedForeground }]}>
            READER
          </Text>
          {hostname ? (
            <Text
              style={[styles.topMetaHost, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {hostname}
            </Text>
          ) : null}
        </View>

        {url ? (
          <Pressable
            onPress={() => WebBrowser.openBrowserAsync(url).catch(() => {})}
            style={({ pressed }) => [
              styles.iconBtn,
              {
                backgroundColor: "rgba(255,255,255,0.06)",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            hitSlop={10}
          >
            <Feather
              name="external-link"
              size={18}
              color={colors.foreground}
            />
          </Pressable>
        ) : (
          <View style={styles.iconBtn} />
        )}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: insets.bottom + 40,
        }}
        showsVerticalScrollIndicator={false}
      >
        {image ? (
          <View style={styles.heroWrap}>
            <Image
              source={{ uri: proxiedImageUrl(image) ?? image }}
              style={styles.hero}
              contentFit="cover"
              transition={300}
            />
            <View style={styles.heroOverlay} />
            {category ? (
              <View style={styles.categoryPill}>
                <Text style={styles.categoryText}>
                  {category.toUpperCase()}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.headerBlock}>
          {title ? (
            <Text style={[styles.headline, { color: colors.foreground }]}>
              {title}
            </Text>
          ) : null}
          <View style={styles.metaRow}>
            {source ? (
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {source}
              </Text>
            ) : null}
            {article.data?.byline ? (
              <>
                <View style={styles.metaDot} />
                <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                  {article.data.byline}
                </Text>
              </>
            ) : null}
          </View>
        </View>

        {article.isLoading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.mutedForeground} />
            <Text
              style={[styles.loadingText, { color: colors.mutedForeground }]}
            >
              Cleaning up the article…
            </Text>
          </View>
        ) : article.isError ? (
          <View style={styles.errorBlock}>
            <Feather
              name="alert-circle"
              size={28}
              color={colors.mutedForeground}
            />
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Couldn't extract this article
            </Text>
            <Text
              style={[styles.errorText, { color: colors.mutedForeground }]}
            >
              {article.error instanceof Error
                ? article.error.message
                : "The publisher may be blocking automated reads."}
            </Text>
            {url ? (
              <Pressable
                onPress={() =>
                  WebBrowser.openBrowserAsync(url).catch(() => {})
                }
                style={({ pressed }) => [
                  styles.openBtn,
                  {
                    backgroundColor: colors.foreground,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Text style={[styles.openBtnText, { color: colors.background }]}>
                  Open in browser
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.articleBlock}>
            {(article.data?.paragraphs ?? []).map((p, i) => (
              <Animated.Text
                key={i}
                entering={FadeInDown.delay(Math.min(i, 8) * 30).duration(280)}
                style={[styles.paragraph, { color: colors.foreground }]}
              >
                {p}
              </Animated.Text>
            ))}
            {(article.data?.paragraphs ?? []).length === 0 ? (
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                No article body available.
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  topMeta: { flex: 1, alignItems: "center" },
  topMetaLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    letterSpacing: 1.4,
  },
  topMetaHost: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    letterSpacing: 0.2,
    marginTop: 2,
  },
  heroWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  hero: { width: "100%", height: "100%" },
  heroOverlay: {
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
  categoryText: {
    color: "#FFFFFF",
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  headerBlock: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 14,
    gap: 10,
  },
  headline: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    lineHeight: 31,
    letterSpacing: -0.3,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  meta: { fontFamily: "Inter_500Medium", fontSize: 13 },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  loadingBlock: {
    paddingVertical: 60,
    alignItems: "center",
    gap: 10,
  },
  loadingText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  errorBlock: {
    paddingVertical: 60,
    paddingHorizontal: 30,
    alignItems: "center",
    gap: 10,
  },
  errorTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
    marginTop: 6,
  },
  errorText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  openBtn: {
    marginTop: 14,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 999,
  },
  openBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  summaryCard: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aiPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  aiPillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  bullets: { gap: 10 },
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
  articleBlock: {
    paddingHorizontal: 22,
    paddingTop: 18,
    gap: 16,
  },
  paragraph: {
    fontFamily: "Inter_400Regular",
    fontSize: 16,
    lineHeight: 27,
    letterSpacing: 0.1,
  },
});
