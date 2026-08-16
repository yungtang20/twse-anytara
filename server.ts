import express from "express";
import path from "path";
import dotenv from "dotenv";
import { resolveRuntimeMode } from "./server/lib/runtimeMode";
import apiRouter from "./server/routes";

// Load environment variables from .env
dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "127.0.0.1";
  const runtimeMode = resolveRuntimeMode();
  let closeTestRuntime: (() => Promise<void>) | null = null;

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  if (runtimeMode === "test") {
    const [{ initDb, closeDb }, { resumeInterruptedJobs, shutdownJobQueue }] = await Promise.all([
      import("./server/db"),
      import("./server/lib/jobQueue"),
    ]);
    initDb();
    try {
      resumeInterruptedJobs();
    } catch (error: unknown) {
      console.warn("[TEST-RUNTIME] interrupted jobs were not resumed:", error instanceof Error ? error.message : String(error));
    }
    closeTestRuntime = async () => {
      await shutdownJobQueue();
      closeDb();
    };
  }

  // Only the CSV import route accepts a large body.
  app.use("/api/upload-tdcc", express.json({ limit: "50mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Mount API router
  app.use(apiRouter);

  // Vite Middleware for Development or Static Files for Production
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[FULL-STACK] Express server running on http://${HOST}:${PORT}`);
    // Remote MCP is an explicit opt-in integration. No production route depends on it.
    if (process.env.MCP_ENABLED === "true") {
      import("./server/lib/mcpClient")
        .then(({ initMcp }) => initMcp())
        .then((ok) => console.log(`[MVP] MCP init ${ok ? "OK" : "FAIL (server 仍可用)"}`))
        .catch((error: unknown) => console.warn("[MVP] MCP init failed:", error instanceof Error ? error.message : String(error)));
    }
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[FULL-STACK] ${signal}: graceful shutdown started`);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (closeTestRuntime) await closeTestRuntime();
    console.log("[FULL-STACK] graceful shutdown complete");
  };
  process.once("SIGINT", () => { shutdown("SIGINT").then(() => process.exit(0)); });
  process.once("SIGTERM", () => { shutdown("SIGTERM").then(() => process.exit(0)); });
}

startServer().catch((error) => {
  console.error("[FULL-STACK] startup failed", error);
  process.exitCode = 1;
});
