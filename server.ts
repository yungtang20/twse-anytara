import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { initDb, closeDb } from "./server/db";
import { initMcp } from "./server/lib/mcpClient";
import { resumeInterruptedJobs, shutdownJobQueue } from "./server/lib/jobQueue";
import { resolveRuntimeMode } from "./server/lib/runtimeMode";
import apiRouter from "./server/routes";

// Load environment variables from .env
dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "127.0.0.1";
  const runtimeMode = resolveRuntimeMode();

  if (runtimeMode === "test") {
    initDb();
  }

  // Only the CSV import route accepts a large body.
  app.use("/api/upload-tdcc", express.json({ limit: "50mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Mount API router
  app.use(apiRouter);

  // Vite Middleware for Development or Static Files for Production
  if (process.env.NODE_ENV !== "production") {
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
    // MVP: 连 remote MCP server (失败不卡 server)
    if (process.env.MCP_ENABLED !== "false") {
      initMcp().then((ok) => console.log(`[MVP] MCP init ${ok ? "OK" : "FAIL (server 仍可用)"}`));
    }

    if (runtimeMode === "test") {
      try { resumeInterruptedJobs(); } catch (e: any) { console.warn("[jobQueue] resume 失敗:", e.message); }
    }
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[FULL-STACK] ${signal}: graceful shutdown started`);
    if (runtimeMode === "test") await shutdownJobQueue();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (runtimeMode === "test") closeDb();
    console.log("[FULL-STACK] graceful shutdown complete");
  };
  process.once("SIGINT", () => { shutdown("SIGINT").then(() => process.exit(0)); });
  process.once("SIGTERM", () => { shutdown("SIGTERM").then(() => process.exit(0)); });
}

startServer().catch((error) => {
  console.error("[FULL-STACK] startup failed", error);
  process.exitCode = 1;
});
