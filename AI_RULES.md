# AI Coding & Collaboration Rules

This document specifies mandatory coding patterns, styling parameters, system constraints, and collaborative protocols within the Taiwan Stock Unified codebase.

## 1. Design & Styling Philosophy
- Modern High-Contrast Dark Slate Theme: Colors must adhere strictly to deep slate-grays and clean high-contrast white text accents.
- Layout Margins & Negatives: Ensure rhythm and density through generous padding, clear responsive flex columns, and standard spacing. Avoid telemetry text, mock log streams in main layouts, or cluttered system ports. Keep displays visually clean.
- Native Icons: All icon widgets must be imported exclusively from lucide-react. No custom SVG elements.

## 2. Database Restrictions & Code Safety
- Single-Database Authority: All local persistent structures must reside in the unified SQLite DB file at twstock/taiwan_stock_unified.db. No parallel databases.
- Better-SQLite3 WAL Mode: Always utilize write-ahead-logging (WAL) to ensure reliable connections and avoid locked databases during heavy crawls.
- Input Boundaries Verification: Check parameters at trust borders (API route parameters, query variables) and handle errors cleanly to prevent runtime crashes.

## 3. State Management & Side-Effects in React
- Primitive useEffect Dependency Targets: Ensure React hook arrays only capture stable primitive values (strings, numbers, booleans) or memoized dependencies. Avoid arrays or raw objects in the lists to prevent infinite loop execution.
- Modular File Distribution: Keep core domain services separated. Do not combine database calculations, crawlers, and server endpoints in single, monolithic scripts.

## 4. Workflows & Continuous Deployment
- Daily Scheduling Automation: Daily crawls are automated using a GitHub Actions trigger executing a cron schedule.
- Verification Protocol: Always run npm run lint and build compilation cycles to verify changes before completing tasks.
