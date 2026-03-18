import { Hono } from "hono";
import { getConversionRates } from "../services/telemetry.js";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    uptime: Math.floor(process.uptime()),
    conversionRates: getConversionRates(),
  });
});
