import { useQuery } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { StoryCardView } from "@/components/StoryCard";
import { StorySkeleton } from "@/components/StorySkeleton";
import { useColors } from "@/hooks/useColors";
import {
  fetchFeed,
  fetchSources,
  type NewsSource,
  type StoryCard,
} from "@/lib/api";

const TAB_BAR_HEIGHT = Platform.OS === "web" ? 84 : 60;
const ALL_SOURCE: NewsSource = { id: "__all__", name: "All sources" };

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const topInset = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;
  const [sourceId, setSourceId] = useState<string>(ALL_SOURCE.id);

  // The list of available sources rarely changes — give it a long stale time.
  const sourcesQuery = useQuery({
    queryKey: ["news-sources"],
    queryFn: fetchSources,
    staleTime: 60 * 60 * 1000,
  });

  const sources: NewsSource[] = [
    ALL_SOURCE,
    ...(sourcesQuery.data ?? []),
  ];

  const filterSource = sourceId === ALL_SOURCE.id ? null : sourceId;
  const feedQuery = useQuery({
    queryKey: ["feed", "technology", filterSource],
    queryFn: () => fetchFeed("technology", false, filterSource),
  });

  const stories: StoryCard[] = feedQuery.data?.stories ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={stories}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <StoryCardView story={item} index={index} />
        )}
        contentContainerStyle={{
          paddingTop: topInset + 4,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
        }}
        ListHeaderComponent={
          <View>
            <ScreenHeader
              eyebrow="Discover"
              title="Explore"
              subtitle="Browse by publisher. Same clustering, focused source."
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.topicsRow}
            >
              {sources.map((s) => {
                const active = sourceId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => setSourceId(s.id)}
                    style={({ pressed }) => [
                      styles.topicChip,
                      {
                        backgroundColor: active
                          ? colors.foreground
                          : colors.card,
                        borderColor: active
                          ? colors.foreground
                          : colors.cardBorder,
                        opacity: pressed ? 0.75 : 1,
                      },
                    ]}
                  >
                    {s.id === ALL_SOURCE.id ? (
                      <Feather
                        name="grid"
                        size={13}
                        color={active ? colors.background : colors.foreground}
                      />
                    ) : null}
                    <Text
                      style={[
                        styles.topicText,
                        {
                          color: active
                            ? colors.background
                            : colors.foreground,
                        },
                      ]}
                    >
                      {s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={{ height: 14 }} />
          </View>
        }
        ListEmptyComponent={
          feedQuery.isLoading ? (
            <View>
              <StorySkeleton />
              <StorySkeleton />
            </View>
          ) : feedQuery.isError ? (
            <View style={styles.empty}>
              <Feather
                name="alert-circle"
                size={32}
                color={colors.destructive}
              />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                Couldn&apos;t load
              </Text>
              <Pressable
                onPress={() => feedQuery.refetch()}
                style={({ pressed }) => [
                  styles.retryBtn,
                  {
                    backgroundColor: colors.foreground,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Text style={[styles.retryText, { color: colors.background }]}>
                  Try again
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.empty}>
              <Feather name="search" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                No stories from this source right now
              </Text>
              <Text
                style={[styles.emptyText, { color: colors.mutedForeground }]}
              >
                Try another publisher or check back later.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          feedQuery.isFetching && stories.length > 0 ? (
            <View style={{ paddingVertical: 18, alignItems: "center" }}>
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={feedQuery.isRefetching}
            onRefresh={() => feedQuery.refetch()}
            tintColor={colors.mutedForeground}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topicsRow: {
    paddingHorizontal: 20,
    gap: 8,
    paddingTop: 8,
    paddingBottom: 4,
  },
  topicChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  topicText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  empty: {
    alignItems: "center",
    paddingHorizontal: 32,
    paddingVertical: 60,
    gap: 10,
  },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 16, marginTop: 6 },
  emptyText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
