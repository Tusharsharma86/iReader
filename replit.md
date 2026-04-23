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

- **api-server** (`artifacts/api-server`): Express API. Exposes `/api/news/feed?topic=X` which fetches NewsData.io articles, clusters and summarizes via Gemini (`gemini-2.5-flash`), 10-min in-memory cache.
- **particle-news** (`artifacts/particle-news`): Expo React Native mobile-first news aggregator inspired by Particle News. Dark glassmorphism UI, Inter typography, three tabs (For You / Explore / Saved), StoryCard with 5Ws / Key Highlights / ELI5 modes, Perspective Bar showing source diversity (mainstream/tech/niche). Uses `EXPO_PUBLIC_DOMAIN` to call the API.
- **mockup-sandbox** (`artifacts/mockup-sandbox`): Vite component preview server.

## Secrets

- `NEWSDATA_API_KEY` — newsdata.io API key (used by api-server).
- Gemini AI uses Replit's AI integrations proxy — no key needed.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
