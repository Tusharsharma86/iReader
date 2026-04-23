import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { useColors } from "@/hooks/useColors";

function ArticleViewer({
  url,
  onLoadEnd,
  onError,
}: {
  url: string;
  onLoadEnd: () => void;
  onError: () => void;
}) {
  if (Platform.OS === "web") {
    return (
      <iframe
        src={url}
        onLoad={onLoadEnd}
        onError={onError}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          backgroundColor: "transparent",
        }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <WebView
      source={{ uri: url }}
      style={styles.webview}
      onLoadEnd={onLoadEnd}
      onError={onError}
      onHttpError={onError}
      originWhitelist={["*"]}
      javaScriptEnabled
      domStorageEnabled
      startInLoadingState={false}
      allowsInlineMediaPlayback
      setSupportMultipleWindows={false}
      decelerationRate="normal"
    />
  );
}

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

  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  const url = typeof params.url === "string" ? params.url : "";
  const image = typeof params.image === "string" ? params.image : "";
  const headline = typeof params.headline === "string" ? params.headline : "";
  const source = typeof params.source === "string" ? params.source : "";
  const category = typeof params.category === "string" ? params.category : "";
  const hostname = url ? tryHostname(url) : "";

  const topPad = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: insets.bottom + 24,
        }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
      >
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
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace("/");
              }
            }}
            style={({ pressed }) => [
              styles.backBtn,
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
            {hostname ? (
              <Text
                style={[styles.topMetaText, { color: colors.mutedForeground }]}
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
                styles.backBtn,
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
            <View style={styles.backBtn} />
          )}
        </View>

        {image ? (
          <View style={styles.heroWrap}>
            <Image
              source={{ uri: image }}
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
          {headline ? (
            <Text style={[styles.headline, { color: colors.foreground }]}>
              {headline}
            </Text>
          ) : null}
          {source ? (
            <Text style={[styles.source, { color: colors.mutedForeground }]}>
              From {source}
            </Text>
          ) : null}
        </View>

        <View
          style={[
            styles.articleCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.cardBorder,
              borderRadius: colors.radius,
            },
          ]}
        >
          {url && !errored ? (
            <View style={styles.webviewBox}>
              {loading ? (
                <View
                  style={[
                    styles.loadingOverlay,
                    { backgroundColor: colors.card },
                  ]}
                >
                  <ActivityIndicator color={colors.mutedForeground} />
                  <Text
                    style={[
                      styles.loadingText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Loading article…
                  </Text>
                </View>
              ) : null}
              <ArticleViewer
                url={url}
                onLoadEnd={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  setErrored(true);
                }}
              />
            </View>
          ) : (
            <View style={styles.fallback}>
              <Feather
                name="alert-circle"
                size={28}
                color={colors.mutedForeground}
              />
              <Text
                style={[styles.fallbackTitle, { color: colors.foreground }]}
              >
                Can't preview this article
              </Text>
              <Text
                style={[
                  styles.fallbackText,
                  { color: colors.mutedForeground },
                ]}
              >
                The publisher blocks in-app previews. Open it in your browser
                to read the full story.
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
                  <Text
                    style={[
                      styles.openBtnText,
                      { color: colors.background },
                    ]}
                  >
                    Open in browser
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
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
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  topMeta: { flex: 1, alignItems: "center" },
  topMetaText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    letterSpacing: 0.2,
  },
  heroWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "rgba(255,255,255,0.04)",
    marginTop: 4,
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
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 8,
  },
  headline: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  source: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  articleCard: {
    marginHorizontal: 16,
    marginTop: 6,
    borderWidth: 1,
    overflow: "hidden",
  },
  webviewBox: {
    height: 720,
    width: "100%",
  },
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  fallback: {
    paddingVertical: 40,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
  },
  fallbackTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
    marginTop: 6,
  },
  fallbackText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  openBtn: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 999,
  },
  openBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});
