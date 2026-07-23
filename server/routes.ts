import { Router } from "express";
import analysisTdccRouter from "./routes/analysisTdcc";
import dashboardRouter from "./routes/dashboard";
import fundamentalsRouter from "./routes/fundamentals";
import settingsRouter from "./routes/settings";
import statusRouter from "./routes/status";
import stocksRouter from "./routes/stocks";
import strategiesRouter from "./routes/strategies";
import syncBackfillRouter from "./routes/syncBackfill";

const router = Router();

router.use(dashboardRouter);
router.use(fundamentalsRouter);
router.use(stocksRouter);
router.use(strategiesRouter);
router.use(settingsRouter);
router.use(statusRouter);
router.use(syncBackfillRouter);
router.use(analysisTdccRouter);

export default router;
