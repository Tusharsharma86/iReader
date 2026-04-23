import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/news", newsRouter);

export default router;
