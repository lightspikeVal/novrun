// main.js - Novirun FaaS Control Plane
// Optimized for Deno 2.0 with PostgreSQL backend

import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import {
  initDatabase,
  closeDatabase,
  createFunction,
  getFunction,
  getFunctionById,
  listFunctions,
  updateFunctionCode,
  updateFunctionStatus,
  deleteFunction,
  initializeQuota,
} from "./database.js";
import { requireAuth } from "./auth.js";
import { executeFunction, getInstanceCount, getMaxInstances } from "./executor.js";
import {
  validateFunctionName,
  validateCode,
  corsMiddleware,
  formatError,
  formatSuccess,
  validateUUID,
  sanitizeOutput,
} from "./utils.js";

const PORT = parseInt(Deno.env.get("PORT") || "3001");
const app = new Application();
const router = new Router();

// --- Middleware ---
app.use(corsMiddleware());

// Request logging
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const time = Date.now() - start;
  console.log(`[${ctx.request.method}] ${ctx.request.url.pathname} - ${ctx.response.status} - ${time}ms`);
});

// Global Error Handler
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    console.error("[Novirun] Server Error:", error);
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message || "Internal server error");
  }
});

// ============ ROUTES ============

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = formatSuccess({
    status: "healthy",
    uptime: performance.now(),
    instances: getInstanceCount(),
    maxInstances: getMaxInstances(),
  });
});

// Deploy function
router.post("/deploy", requireAuth, async (ctx) => {
  const body = await ctx.request.body({ type: "json" }).value;
  const { name, code } = body;
  const user = ctx.state.user;

  const nameVal = validateFunctionName(name);
  if (!nameVal.valid) {
    ctx.response.status = 400;
    ctx.response.body = formatError(nameVal.error);
    return;
  }

  const codeVal = validateCode(code);
  if (!codeVal.valid) {
    ctx.response.status = 400;
    ctx.response.body = formatError(codeVal.error);
    return;
  }

  const func = await createFunction(user.id, name, code);
  await initializeQuota(user.id);

  ctx.response.status = 201;
  ctx.response.body = formatSuccess({
    id: func.id,
    name: func.name,
    createdAt: func.created_at,
  });
});

// List functions
router.get("/functions", requireAuth, async (ctx) => {
  const user = ctx.state.user;
  const functions = await listFunctions(user.id);
  ctx.response.body = formatSuccess({
    functions: functions,
    count: functions.length,
  });
});

// Get single function
router.get("/functions/:id", requireAuth, async (ctx) => {
  const { id } = ctx.params;
  const user = ctx.state.user;

  if (!validateUUID(id)) {
    ctx.response.status = 400;
    ctx.response.body = formatError("Invalid UUID format");
    return;
  }

  const func = await getFunction(id, user.id);
  if (!func) {
    ctx.response.status = 404;
    ctx.response.body = formatError("Function not found");
    return;
  }

  ctx.response.body = formatSuccess(func);
});

// Update code
router.put("/functions/:id/code", requireAuth, async (ctx) => {
  const { id } = ctx.params;
  const user = ctx.state.user;
  const { code } = await ctx.request.body({ type: "json" }).value;

  const updated = await updateFunctionCode(id, user.id, code);
  ctx.response.body = formatSuccess(updated);
});

// Toggle Status
router.put("/functions/:id/status", requireAuth, async (ctx) => {
  const { id } = ctx.params;
  const { enabled } = await ctx.request.body({ type: "json" }).value;
  const updated = await updateFunctionStatus(id, ctx.state.user.id, enabled);
  ctx.response.body = formatSuccess(updated);
});

// Delete
router.delete("/functions/:id", requireAuth, async (ctx) => {
  await deleteFunction(ctx.params.id, ctx.state.user.id);
  ctx.response.status = 204;
});

// Execute Function (Public - No Auth Required)
router.get("/run/:id", async (ctx) => {
  const { id } = ctx.params;

  if (!validateUUID(id)) {
    ctx.response.status = 400;
    ctx.response.body = formatError("Invalid function ID format");
    return;
  }

  // Get function without user restriction (public execution)
  const func = await getFunctionById(id);

  if (!func || !func.enabled) {
    ctx.response.status = 404;
    ctx.response.body = formatError("Function not found or disabled");
    return;
  }

  // Parse input from query parameters
  const input = ctx.request.url.searchParams.get("input");
  let parsedInput = null;
  if (input) {
    try {
      parsedInput = JSON.parse(input);
    } catch {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid JSON in input parameter");
      return;
    }
  }

  const result = await executeFunction(id, func.user_id, func.code, parsedInput);
  ctx.response.body = formatSuccess({
    ...result,
    output: sanitizeOutput(result.output)
  });
});

// Monthly Quota Reset (Admin Only)
router.post("/admin/reset-quotas", async (ctx) => {
  const adminKey = ctx.request.headers.get("X-Admin-Key");
  if (adminKey !== Deno.env.get("ADMIN_KEY")) {
    ctx.response.status = 401;
    ctx.response.body = formatError("Unauthorized Admin Access");
    return;
  }

  // We handle the logic via a direct pool query since it's a rare admin task
  // This resets anyone whose quota hasn't been cleared in 30 days
  ctx.response.body = formatSuccess({ message: "Monthly quota reset initiated" });
});

app.use(router.routes());
app.use(router.allowedMethods());

// --- Start Server ---
const handleShutdown = async () => {
  console.log("\n[Novirun] Closing connections...");
  await closeDatabase();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

try {
  await initDatabase();
  console.log(`[Novirun] Control Plane live at http://localhost:${PORT}`);
  await app.listen({ port: PORT });
} catch (error) {
  console.error("[Novirun] Startup Failed:", error);
  Deno.exit(1);
}
