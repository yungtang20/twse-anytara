# TRINITY TWSE Stock Analysis Platform — Agent Guidelines

## Project Overview

Taiwan stock market unified analysis platform with local-first SQLite architecture, AI-powered analysis (AI Research Router with GLM-5.2), and real-time market data from TWSE/OTC, FinMind, and Yahoo Finance.

## Architecture Principles

- **Single Database Authority**: All local data in `twstock/taiwan_stock_unified.db` (SQLite WAL mode)
- **Data Source Hierarchy**: SQLite (local) → Supabase (cloud) → FinMind/Yahoo (external API)
- **Security**: Sensitive endpoints (AI, sync, TDCC) restricted to localhost via `isLoopbackRequest`

## Code Quality Standards

- TypeScript strict: avoid `any`, use proper interfaces
- Functions < 50 lines, files < 800 lines
- No hardcoded secrets — use environment variables
- All API errors must return `{ success: false, error: "..." }` format
- No fake data fallbacks — return explicit errors when data unavailable

## File Organization

- `server/routes/` — route handlers (thin)
- `server/lib/` — business logic modules
- `server/services.ts` — legacy monolith (being refactored)
- `src/components/views/` — page-level components
- `src/lib/` — frontend utilities
- `scripts/` — data sync/maintenance scripts

## Testing

- Run `npm test` (self-check.ts) before committing
- Run `npm run test:eval` for AI framework evaluation
