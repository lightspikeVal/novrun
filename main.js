// main.js - Novirun FaaS Control Plane
// Standalone Deno HTTP server with PostgreSQL backend and Appwrite authentication

import { Application, Router } from "oak";
import {
  initDatabase,
  closeDatabase,
  getUser,
  createFunction,
  getFunction,
  listFunctions,
  updateFunctionCode,
  updateFunctionStatus,
  deleteFunction,
  initializeQuota,
  resetDailyQuotas,
} from "./database.js";
import { requireAuth, getAuthUser } from "./auth.js";
import { executeFunction, getInstanceCount, getMaxInstances } from "./executor.js";
import {
  validateFunctionName,
  validateCode,
  validateInputData,
  corsMiddleware,
  formatError,
  formatSuccess,
  maskSensitiveData,
  validateUUID,
  sanitizeOutput,
} from "./utils.js";

const PORT = parseInt(Deno.env.get("PORT") || "3001");
const app = new Application();
const router = new Router();

// Middleware
app.use(corsMiddleware());

// Request logging middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const time = Date.now() - start;
  console.log(`[${ctx.request.method}] ${ctx.request.url.pathname} - ${ctx.response.status} - ${time}ms`);
});

// Error handling middleware
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    console.error("[Novirun] Error:", error);
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message || "Internal server error");
  }
});

// ============ ROUTES ============

// Health check (no auth required)
router.get("/health", (ctx) => {
  ctx.response.body = formatSuccess({
    status: "healthy",
    instances: getInstanceCount(),
    maxInstances: getMaxInstances(),
  });
});

// Deploy function (auth required)
router.post("/deploy", requireAuth, async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { name, code } = body;
    const user = ctx.state.user;

    // Validate inputs
    const nameValidation = validateFunctionName(name);
    if (!nameValidation.valid) {
      ctx.response.status = 400;
      ctx.response.body = formatError(nameValidation.error);
      return;
    }

    const codeValidation = validateCode(code);
    if (!codeValidation.valid) {
      ctx.response.status = 400;
      ctx.response.body = formatError(codeValidation.error);
      return;
    }

    // Create function
    const func = await createFunction(user.id, name, code);
    await initializeQuota(user.id);

    ctx.response.status = 201;
    ctx.response.body = formatSuccess({
      id: func.id,
      name: func.name,
      enabled: func.enabled,
      createdAt: func.created_at,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// List functions (auth required)
router.get("/functions", requireAuth, async (ctx) => {
  try {
    const user = ctx.state.user;
    const functions = await listFunctions(user.id);

    ctx.response.body = formatSuccess({
      functions: functions.map((f) => ({
        id: f.id,
        name: f.name,
        enabled: f.enabled,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
      })),
      count: functions.length,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Get function details (auth required)
router.get("/functions/:id", requireAuth, async (ctx) => {
  try {
    const { id } = ctx.params;
    const user = ctx.state.user;

    if (!validateUUID(id)) {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid function ID format");
      return;
    }

    const func = await getFunction(id, user.id);
    if (!func) {
      ctx.response.status = 404;
      ctx.response.body = formatError("Function not found");
      return;
    }

    ctx.response.body = formatSuccess({
      id: func.id,
      name: func.name,
      code: func.code,
      enabled: func.enabled,
      createdAt: func.created_at,
      updatedAt: func.updated_at,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Edit function code (auth required)
router.put("/functions/:id/code", requireAuth, async (ctx) => {
  try {
    const { id } = ctx.params;
    const user = ctx.state.user;
    const body = await ctx.request.body({ type: "json" }).value;
    const { code } = body;

    if (!validateUUID(id)) {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid function ID format");
      return;
    }

    const codeValidation = validateCode(code);
    if (!codeValidation.valid) {
      ctx.response.status = 400;
      ctx.response.body = formatError(codeValidation.error);
      return;
    }

    const func = await getFunction(id, user.id);
    if (!func) {
      ctx.response.status = 404;
      ctx.response.body = formatError("Function not found");
      return;
    }

    const updated = await updateFunctionCode(id, user.id, code);
    ctx.response.body = formatSuccess({
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      updatedAt: updated.updated_at,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Disable/Enable function (auth required)
router.put("/functions/:id/status", requireAuth, async (ctx) => {
  try {
    const { id } = ctx.params;
    const user = ctx.state.user;
    const body = await ctx.request.body({ type: "json" }).value;
    const { enabled } = body;

    if (!validateUUID(id)) {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid function ID format");
      return;
    }

    if (typeof enabled !== "boolean") {
      ctx.response.status = 400;
      ctx.response.body = formatError("enabled must be a boolean");
      return;
    }

    const func = await getFunction(id, user.id);
    if (!func) {
      ctx.response.status = 404;
      ctx.response.body = formatError("Function not found");
      return;
    }

    const updated = await updateFunctionStatus(id, user.id, enabled);
    ctx.response.body = formatSuccess({
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      updatedAt: updated.updated_at,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Delete function (auth required)
router.delete("/functions/:id", requireAuth, async (ctx) => {
  try {
    const { id } = ctx.params;
    const user = ctx.state.user;

    if (!validateUUID(id)) {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid function ID format");
      return;
    }

    const func = await getFunction(id, user.id);
    if (!func) {
      ctx.response.status = 404;
      ctx.response.body = formatError("Function not found");
      return;
    }

    await deleteFunction(id, user.id);
    ctx.response.status = 204;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Execute function (NO AUTH - public endpoint)
router.post("/functions/:id/run", async (ctx) => {
  try {
    const { id } = ctx.params;
    const body = await ctx.request.body({ type: "json" }).value;
    const { input } = body;

    if (!validateUUID(id)) {
      ctx.response.status = 400;
      ctx.response.body = formatError("Invalid function ID format");
      return;
    }

    const inputValidation = validateInputData(input);
    if (!inputValidation.valid) {
      ctx.response.status = 400;
      ctx.response.body = formatError(inputValidation.error);
      return;
    }

    // Get function from database (no auth, but need to check if enabled)
    // For public execution, we need to fetch without user constraint
    // This is a security consideration - you might want to add auth here
    // For now, we'll fetch directly from DB (consider adding API keys in production)
    
    // Get user from auth header if provided (optional)
    const user = await getAuthUser(ctx.request);
    if (!user) {
      ctx.response.status = 401;
      ctx.response.body = formatError("Authorization required to execute functions");
      return;
    }

    const func = await getFunction(id, user.id);
    if (!func) {
      ctx.response.status = 404;
      ctx.response.body = formatError("Function not found");
      return;
    }

    if (!func.enabled) {
      ctx.response.status = 403;
      ctx.response.body = formatError("Function is disabled");
      return;
    }

    // Execute the function
    const result = await executeFunction(id, user.id, func.code, input);

    if (result.status === "error") {
      ctx.response.status = 400;
      ctx.response.body = formatSuccess({
        status: result.status,
        error: result.error,
        executionTimeMs: result.executionTimeMs,
      });
    } else {
      ctx.response.body = formatSuccess({
        status: result.status,
        output: sanitizeOutput(result.output),
        error: result.error,
        executionTimeMs: result.executionTimeMs,
      });
    }
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Get user info (auth required)
router.get("/user", requireAuth, async (ctx) => {
  try {
    const user = ctx.state.user;
    ctx.response.body = formatSuccess({
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
    });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

// Reset daily quotas (for admin/scheduled tasks)
router.post("/admin/reset-quotas", async (ctx) => {
  try {
    const adminKey = ctx.request.headers.get("X-Admin-Key");
    if (adminKey !== Deno.env.get("ADMIN_KEY")) {
      ctx.response.status = 401;
      ctx.response.body = formatError("Invalid admin key");
      return;
    }

    await resetDailyQuotas();
    ctx.response.body = formatSuccess({ message: "Daily quotas reset" });
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = formatError(error.message);
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

// Graceful shutdown
const handleShutdown = async () => {
  console.log("\n[Novirun] Shutting down gracefully...");
  await closeDatabase();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

// Start server
try {
  await initDatabase();
  console.log(`[Novirun] FaaS Control Plane running on http://localhost:${PORT}`);
  console.log(`[Novirun] Available endpoints:`);
  console.log(`  POST   /deploy                    - Deploy a new function (auth required)`);
  console.log(`  GET    /functions                 - List all functions (auth required)`);
  console.log(`  GET    /functions/:id             - Get function details (auth required)`);
  console.log(`  PUT    /functions/:id/code        - Edit function code (auth required)`);
  console.log(`  PUT    /functions/:id/status      - Enable/disable function (auth required)`);
  console.log(`  DELETE /functions/:id             - Delete function (auth required)`);
  console.log(`  POST   /functions/:id/run         - Execute function (auth required)`);
  console.log(`  GET    /health                    - Health check (no auth)`);
  console.log(`  GET    /user                      - Get user info (auth required)`);
  console.log(`[Novirun] Max execution time: 15 seconds per invocation`);
  console.log(`[Novirun] Max CPU time: 2 hours per user (resets daily)`);
  console.log(`[Novirun] Max concurrent: 10 per user, 50 per machine`);
  
  await app.listen({ port: PORT });
} catch (error) {
  console.error("[Novirun] Fatal error:", error);
  Deno.exit(1);
}
