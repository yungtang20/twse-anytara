import { Router, type Request, type Response, type NextFunction } from "express";
import analysisTdccRouter from "./routes/analysisTdcc";
import dashboardRouter from "./routes/dashboard";
import fundamentalsRouter from "./routes/fundamentals";
import settingsRouter from "./routes/settings";
import statusRouter from "./routes/status";
import stocksRouter from "./routes/stocks";
import strategiesRouter from "./routes/strategies";
import syncBackfillRouter from "./routes/syncBackfill";
import { isOrdinaryStockId } from "./lib/stockUniverse";

const router = Router();

router.use("/api/stock/:id", (req: Request, res: Response, next: NextFunction) => {
  if (req.params.id === "search") return next();
  if (!isOrdinaryStockId(req.params.id)) {
    return res.status(400).json({ success: false, error: "只支援普通股代號" });
  }
  next();
});

router.use(dashboardRouter);
router.use(fundamentalsRouter);
router.use(stocksRouter);
router.use(strategiesRouter);
router.use(settingsRouter);
router.use(statusRouter);
router.use(syncBackfillRouter);
router.use(analysisTdccRouter);

export default router;
