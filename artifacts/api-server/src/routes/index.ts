import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/news", newsRouter);
router.use("/push", pushRouter);

export default router;
