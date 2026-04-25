import { useQuery } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
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

export default function ForYouScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const topInset = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;

  const query = useQuery({
    queryKey: ["feed", "technology"],
    queryFn: () => fetchFeed("technology"),
  });

  const stories: StoryCard[] = query.data?.stories ?? [];

  const renderItem = ({
    item,
    index,
  }: {
    item: StoryCard;
    index: number;
  }) => <StoryCardView story={item} index={index} />;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={stories}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingTop: topInset + 4,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
        }}
        ListHeaderComponent={
          <View>
            <View style={styles.gearRow}>
              <Pressable
                onPress={() => router.push("/settings" as never)}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.gearBtn,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.cardBorder,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
                accessibilityLabel="Notification settings"
              >
                <Feather name="settings" size={16} color={colors.foreground} />
              </Pressable>
            </View>
            <ScreenHeader
              eyebrow="Today"
              title="For You"
              subtitle="High-density news, clustered and stripped of fluff."
            />
          </View>
        }
        ListEmptyComponent={
          query.isLoading ? (
            <View style={{ paddingHorizontal: 4 }}>
              <StorySkeleton />
              <StorySkeleton />
              <StorySkeleton />
            </View>
          ) : query.isError ? (
            <ErrorState
              message={
                query.error instanceof Error
                  ? query.error.message
                  : "Couldn't load the feed."
              }
              onRetry={() => query.refetch()}
            />
          ) : (
            <EmptyState />
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
            progressBackgroundColor={colors.surfaceElevated}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

function EmptyState() {
  const colors = useColors();
  return (
    <View style={styles.empty}>
      <Feather name="inbox" size={36} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
        Nothing yet
      </Text>
      <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
        Pull down to refresh and load today's stories.
      </Text>
    </View>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.empty}>
      <Feather name="alert-circle" size={36} color={colors.destructive} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
        Couldn't load stories
      </Text>
      <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
        {message}
      </Text>
      <Pressable
        onPress={onRetry}
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  gearRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  gearBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 60,
    gap: 10,
  },
  emptyTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    marginTop: 8,
  },
  emptyText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  retryBtn: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
