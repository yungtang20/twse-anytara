# AI Coding & Collaboration Rules

This document specifies mandatory coding patterns, styling parameters, system constraints, and collaborative protocols within the Taiwan Stock Unified codebase.

## 1. Design & Styling Philosophy
- Modern High-Contrast Dark Slate Theme: Colors must adhere strictly to deep slate-grays and clean high-contrast white text accents.
- Layout Margins & Negatives: Ensure rhythm and density through generous padding, clear responsive flex columns, and standard spacing. Avoid telemetry text, mock log streams in main layouts, or cluttered system ports. Keep displays visually clean.
- Native Icons: All icon widgets must be imported exclusively from lucide-react. No custom SVG elements.

## 2. Database Restrictions & Code Safety
- Production Cloud Authority: The deployed web runtime reads and writes approved cloud data through Supabase and server-side external providers. It must not open or depend on a local persistent SQLite database.
- Test-Only SQLite: `MARKET_DATA_MODE=test` may use SQLite only under the operating-system temporary directory. It must never point to a production or sibling-project database.
- Cloud Backfill Boundary: Local SQLite is not a production authority and must not be used as a cloud-backfill source.
- Input Boundaries Verification: Check parameters at trust borders (API route parameters, query variables) and handle errors cleanly to prevent runtime crashes.

## 3. State Management & Side-Effects in React
- Primitive useEffect Dependency Targets: Ensure React hook arrays only capture stable primitive values (strings, numbers, booleans) or memoized dependencies. Avoid arrays or raw objects in the lists to prevent infinite loop execution.
- Modular File Distribution: Keep core domain services separated. Do not combine database calculations, crawlers, and server endpoints in single, monolithic scripts.

## 4. Workflows & Continuous Deployment
- Daily Scheduling Automation: Daily crawls are automated using a GitHub Actions trigger executing a cron schedule.
- Verification Protocol: Always run npm run lint and build compilation cycles to verify changes before completing tasks.
