# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Artifacts

- **api-server** (`artifacts/api-server`): Express API. Exposes `/api/news/feed?topic=X`. For `topic=technology`, fetches RSS from TechCrunch / The Verge / Ars Technica / Gizmodo in parallel (12s timeout each), enriches missing thumbnails by scraping `og:image` (3.5s budget per article, cached 6h), clusters and summarizes via Gemini (`gemini-2.5-flash`) with a `buildFallbackStories` path if Gemini returns malformed JSON. 30-min cache for technology, 10-min for other topics.
  - `/api/news/article?url=…` extracts a clean article body (smart `<article>`/CMS-container/main/body fallback chain), then runs Gemini 2.5 Flash dedup. Dedup uses an **index-only protocol**: Gemini receives numbered paragraphs and returns only the indices to keep (`{"keep":[0,1,3,...]}`); the server reconstructs the deduped article by copying source paragraphs verbatim from those indices. This makes summarising, paraphrasing, or quote-tampering impossible by construction. The response includes both `paragraphs` (deduped) and `originalParagraphs` (raw) so the reader's two tabs share a single fetch. Persistent disk caches: raw extraction at `/tmp/particle-news-article-cache.json` (6h TTL, 300 LRU), AI-deduped at `/tmp/particle-news-dedup-cache.json` (6h TTL, 300 LRU). Dedup is guarded by a 20s hard timeout and a 70%-of-source kept-paragraph floor — failures fall back to raw paragraphs.
  - `/api/news/article/prefetch?url=…` returns 204 instantly and warms both caches in the background; the mobile client calls this on card mount, staggered by index, so taps feel instant.
- **particle-news** (`artifacts/particle-news`): Expo React Native mobile-first news aggregator. Dark glassmorphism UI with `expo-blur` (intensity 25), per-card dynamic color tinting from hero image (dominant + vibrant via `react-native-image-colors`), Inter typography, three tabs (For You / Explore / Saved). Both feeds are wired to `topic=technology`. Reads `EXPO_PUBLIC_API_URL` first (production builds), then `EXPO_PUBLIC_DOMAIN` (Replit dev).
- **mockup-sandbox** (`artifacts/mockup-sandbox`): Vite component preview server.

## Deployment

The API server has a complete `[services.production]` block (build → `pnpm --filter @workspace/api-server run build`, run → `node artifacts/api-server/dist/index.mjs`, healthz → `/api/healthz`). Stateless except for in-memory caches → autoscale is appropriate. Publish from the Publishing pane.

## Mobile APK build (EAS)

`artifacts/particle-news/eas.json` defines three profiles:
- `development` — Expo dev client (APK, internal distribution)
- `preview` — release APK for sideloading (internal distribution). Sets `EXPO_PUBLIC_API_URL`.
- `production` — Android App Bundle for Play Store (auto-increments versionCode). Sets `EXPO_PUBLIC_API_URL`.

Before building, replace `https://CHANGE-ME.replit.app` in `eas.json` with the deployed API URL. Then from `artifacts/particle-news/`: `eas login` → `eas build:configure` → `eas build -p android --profile preview`.

## Secrets

- `NEWSDATA_API_KEY` — newsdata.io API key (used by api-server).
- Gemini AI uses Replit's AI integrations proxy — no key needed.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
