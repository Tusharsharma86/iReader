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
import { fetchFeed, type StoryCard } from "@/lib/api";

const TAB_BAR_HEIGHT = Platform.OS === "web" ? 84 : 60;

const TOPICS = [
  { key: "technology", label: "Technology", icon: "cpu" as const },
];

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const topInset = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;
  const [topic, setTopic] = useState<string>("technology");

  const query = useQuery({
    queryKey: ["feed", topic],
    queryFn: () => fetchFeed(topic),
  });

  const stories: StoryCard[] = query.data?.stories ?? [];

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
              subtitle="Pick a beat. Get the day, summarized."
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.topicsRow}
            >
              {TOPICS.map((t) => {
                const active = topic === t.key;
                return (
                  <Pressable
                    key={t.key}
                    onPress={() => setTopic(t.key)}
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
                    <Feather
                      name={t.icon}
                      size={14}
                      color={active ? colors.background : colors.foreground}
                    />
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
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={{ height: 14 }} />
          </View>
        }
        ListEmptyComponent={
          query.isLoading ? (
            <View>
              <StorySkeleton />
              <StorySkeleton />
            </View>
          ) : query.isError ? (
            <View style={styles.empty}>
              <Feather
                name="alert-circle"
                size={32}
                color={colors.destructive}
              />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                Couldn't load
              </Text>
              <Pressable
                onPress={() => query.refetch()}
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
                Nothing in this beat right now
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          query.isFetching && stories.length > 0 ? (
            <View style={{ paddingVertical: 18, alignItems: "center" }}>
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => query.refetch()}
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
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
