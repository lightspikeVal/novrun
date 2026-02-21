// utils.js - Shared utility functions and validation
export function validateFunctionName(name) {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Function name is required" };
  }
  if (name.length < 1 || name.length > 64) {
    return { valid: false, error: "Function name must be 1-64 characters" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { valid: false, error: "Function name can only contain alphanumeric characters, hyphens, and underscores" };
  }
  return { valid: true };
}

export function validateCode(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Code is required" };
  }
  if (code.length > 1000000) { // 1MB max
    return { valid: false, error: "Code exceeds maximum size (1MB)" };
  }
  return { valid: true };
}

export function validateInputData(data) {
  try {
    if (data) {
      JSON.stringify(data);
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Input data must be valid JSON" };
  }
}

export async function secureRandomId() {
  return crypto.randomUUID();
}

export function formatError(message) {
  return {
    error: message,
    timestamp: new Date().toISOString(),
  };
}

export function formatSuccess(data) {
  return {
    ...data,
    timestamp: new Date().toISOString(),
  };
}

export function maskSensitiveData(obj) {
  const masked = { ...obj };
  // Mask any field containing 'code' or 'password' or 'key' or 'secret'
  for (const key in masked) {
    if (key.toLowerCase().includes("code") || 
        key.toLowerCase().includes("password") ||
        key.toLowerCase().includes("key") ||
        key.toLowerCase().includes("secret")) {
      masked[key] = "[REDACTED]";
    }
  }
  return masked;
}

export function validateUUID(id) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

export function corsMiddleware() {
  return async (ctx, next) => {
    const origin = ctx.request.headers.get("origin") || "*";
    
    // Set CORS headers
    ctx.response.headers.set("Access-Control-Allow-Origin", origin);
    ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    ctx.response.headers.set("Access-Control-Allow-Credentials", "true");
    
    // Handle preflight
    if (ctx.request.method === "OPTIONS") {
      ctx.response.status = 204;
      return;
    }
    
    await next();
  };
}

export function sanitizeOutput(output) {
  if (!output) return output;
  // Limit output size to 1MB
  if (typeof output === "string" && output.length > 1000000) {
    return output.substring(0, 1000000) + "\n... (output truncated)";
  }
  return output;
}
