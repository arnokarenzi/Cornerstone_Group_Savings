"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./config/db");
const {
  parseAllowedOrigins,
  validateProductionConfig,
  isAllowedOrigin,
} = require("./security/securityControls");
const { apiRateLimit } = require("./middleware/rateLimits");
const { sendRouteError } = require("./utils/routeErrors");

const configProblems = validateProductionConfig(process.env);
if (configProblems.length) {
  console.error("Unsafe production configuration:");
  for (const problem of configProblems) console.error(`- ${problem}`);
  process.exit(1);
}

const allowedOrigins = parseAllowedOrigins(process.env);
const app = express();
const PORT = Number(process.env.PORT || 5000);
app.disable("x-powered-by");

const configuredProxyHops = process.env.TRUST_PROXY_HOPS;
if (configuredProxyHops != null && configuredProxyHops !== "") {
  const proxyHops = Number(configuredProxyHops);
  if (!Number.isSafeInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  }
  app.set("trust proxy", proxyHops);
} else {
  // Development has no reverse proxy by default. Production config validation
  // requires the real proxy topology to be set explicitly.
  app.set("trust proxy", 0);
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Financial data should not be retained in shared/intermediary HTTP caches.
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin, allowedOrigins)) return callback(null, true);
    return callback(new Error("Origin is not allowed by the API CORS policy."));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  credentials: true,
  maxAge: 600,
}));
app.use(express.json({ limit: "256kb", strict: true }));
app.use("/api", apiRateLimit);

const authRoutes = require("./routes/authRoutes");
const groupRoutes = require("./routes/groupRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const loanRoutes = require("./routes/loanRoutes");
const fineRoutes = require("./routes/fineRoutes");
const shareOutRoutes = require("./routes/shareOutRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const cashbookRoutes = require("./routes/cashbookRoutes");
const recordsRoutes = require("./routes/recordsRoutes");
const constitutionRoutes = require("./routes/constitutionRoutes");
const passbookRoutes = require("./routes/passbookRoutes");
const cycleRoutes = require("./routes/cycleRoutes");

app.get("/api/health", (req, res) => res.status(200).json({ success: true, status: "ok" }));
app.get("/api/health/ready", async (req, res) => {
  try {
    await db.query("SELECT 1");
    return res.status(200).json({ success: true, status: "ready" });
  } catch (error) {
    console.error("[readiness-check-failed]", String(error.code || "UNKNOWN"));
    return res.status(503).json({ success: false, status: "not_ready", message: "Database is temporarily unavailable." });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/groups", constitutionRoutes);
app.use("/api/groups", cycleRoutes);
app.use("/api", meetingRoutes);
app.use("/api", loanRoutes);
app.use("/api", fineRoutes);
app.use("/api", shareOutRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", cashbookRoutes);
app.use("/api", recordsRoutes);
app.use("/api", passbookRoutes);
app.use("/api", require("./routes/financialRequestRoutes"));
app.use("/api", require("./routes/memberFinanceRoutes"));

// Keep the old diagnostic URL compatible, but never expose SQL/driver messages.
app.get("/api/test-db", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 + 1 AS solution");
    return res.status(200).json({ success: true, message: "Database connection is successful.", solution: rows[0].solution });
  } catch (error) {
    console.error("[test-db-failed]", String(error.code || "UNKNOWN"));
    return res.status(503).json({ success: false, message: "Database connection is temporarily unavailable." });
  }
});

app.use((req, res) => res.status(404).json({ success: false, message: "API route not found." }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Request body is too large. Reduce the size and try again." });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Request body must contain valid JSON." });
  }
  if (String(error?.message || "").includes("CORS policy")) {
    return res.status(403).json({ success: false, message: "This website origin is not allowed to access the API." });
  }
  return sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`CORNESTONE Co.LTD. API listening on port ${PORT}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`Development CORS origins: ${allowedOrigins.join(", ")}`);
  }
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down gracefully.`);
  server.close(async () => {
    try { await db.end(); } catch (error) { console.error("[shutdown-db-error]", String(error.code || "UNKNOWN")); }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
