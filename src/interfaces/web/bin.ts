#!/usr/bin/env node
import { startWebDashboardServer } from "./server.js";

const port = process.env.PORT ? Number(process.env.PORT) : undefined;
const host = process.env.HOST || undefined;
const outRoot = process.env.OUT_ROOT || undefined;
const serveStaticFrom = process.env.SERVE_STATIC_FROM || undefined;

startWebDashboardServer({
  ...(typeof port === "number" && !Number.isNaN(port) ? { port } : {}),
  ...(host ? { host } : {}),
  ...(outRoot ? { outRoot } : {}),
  ...(serveStaticFrom ? { serveStaticFrom } : {}),
});
