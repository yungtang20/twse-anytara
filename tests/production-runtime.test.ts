import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("Render service contract matches the existing cloud-only Docker runtime", () => {
  const render = read("render.yaml");
  assert.match(render, /type:\s*web/);
  assert.match(render, /runtime:\s*docker/);
  assert.match(render, /dockerfilePath:\s*\.\/Dockerfile/);
  assert.match(render, /dockerContext:\s*\./);
  assert.match(render, /healthCheckPath:\s*\/api\/health/);
  for (const [key, value] of [["NODE_ENV", "production"], ["MARKET_DATA_MODE", "cloud"], ["HOST", "0.0.0.0"]]) {
    assert.match(render, new RegExp(`key: ${key}\\s+value: ${value}`));
  }
  for (const secret of ["HCNSEC_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.match(render, new RegExp(`key: ${secret}\\s+sync: false`));
  }
});

test("production Docker image builds artifacts separately and installs runtime dependencies only", () => {
  const dockerfile = read("Dockerfile");
  const dockerignore = read(".dockerignore");
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS build/);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS runtime/);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /COPY --from=build (?:--chown=node:node )?\/app\/dist \.\/dist/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["npm", "start"\]/);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^dist$/m);
  assert.match(dockerignore, /^twstock\/$/m);
  assert.match(dockerignore, /^\*\.db$/m);
  assert.match(dockerignore, /^\*\.db-shm$/m);
  assert.match(dockerignore, /^\*\.db-wal$/m);
  assert.match(dockerignore, /^CLAUDE\.md$/m);
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /docker build --tag trinity-production-smoke:\$\{\{ github\.sha \}\} \./);
  assert.match(workflow, /docker run --detach/);
  assert.match(workflow, /curl --fail --retry/);
});

test("environment and README document default HCNSEC BYOK privacy and abuse limits", () => {
  const env = read(".env.example");
  const readme = read("README.md");
  for (const item of ["HCNSEC_API_KEY=", "HCNSEC_BASE_URL=https://api.hcnsec.cn/v1",
    "HCNSEC_MODEL=auto", "HCNSEC_MAX_OUTPUT_TOKENS=65536", "AI_RATE_LIMIT_REQUESTS=10",
    "AI_RATE_LIMIT_WINDOW_MS=600000", "AI_SHARED_DAILY_LIMIT=100", "AI_MAX_CONCURRENCY=2"]) {
    assert.match(env, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(readme, /AI_RESEARCH_API_KEY|glm-5\.2.*固定|max_tokens[^\n]*16,384|整體報告逾時 315/);
  assert.match(readme, /sessionStorage/);
  assert.match(readme, /180 天/);
  assert.match(readme, /65,536/);
  assert.match(readme, /正式環境.*Supabase/);
  assert.match(readme, /不得.*正式.*SQLite/);
  assert.match(readme, /既有 Docker runtime/);
});

test("approved design documents are trackable and production launcher forces NODE_ENV", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /!docs\/superpowers\/specs\/\*\.md/);
  assert.match(ignore, /!docs\/superpowers\/plans\/\*\.md/);
  const launcher = read("scripts/start-production.mjs");
  assert.match(launcher, /process\.env\.NODE_ENV = "production"/);
  assert.doesNotMatch(launcher, /NODE_ENV \?\?=/);
});

test("legacy settings authorization is scoped and cannot intercept public health or SPA routes", () => {
  const settingsRoutes = read("server/routes/settings.ts");
  assert.doesNotMatch(settingsRoutes, /router\.use\(requireAdminRequest\)/);
  assert.match(settingsRoutes, /router\.use\("\/api\/settings", requireAdminRequest\)/);
});
