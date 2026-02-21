// executor.js - Deno subprocess execution with security and quota enforcement
import { logExecution, updateQuota, getQuota } from "./database.js";

const MAX_EXECUTION_TIME_MS = 15000; // 15 seconds hard limit
const MAX_CPU_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CONCURRENT_EXECUTIONS = 10; // per user
const MAX_INSTANCES_PER_MACHINE = 50;

let currentInstanceCount = 0;

export async function executeFunction(functionId, userId, code, inputData = null) {
  try {
    // Check machine-level limit
    if (currentInstanceCount >= MAX_INSTANCES_PER_MACHINE) {
      return {
        status: "error",
        error: "Machine at capacity: maximum 50 concurrent instances reached",
        executionTimeMs: 0,
      };
    }

    // Check user quotas
    const quota = await getQuota(userId);
    if (!quota) {
      return {
        status: "error",
        error: "User quota not initialized",
        executionTimeMs: 0,
      };
    }

    if (quota.concurrent_count >= MAX_CONCURRENT_EXECUTIONS) {
      return {
        status: "error",
        error: `User concurrent execution limit (${MAX_CONCURRENT_EXECUTIONS}) reached`,
        executionTimeMs: 0,
      };
    }

    if (quota.cpu_time_used_ms >= MAX_CPU_TIME_MS) {
      return {
        status: "error",
        error: "User CPU time quota exceeded (2 hour limit)",
        executionTimeMs: 0,
      };
    }

    currentInstanceCount++;
    await updateQuota(userId, 0, quota.concurrent_count + 1);

    const startTime = Date.now();
    const tempFile = await Deno.makeTempFile({ suffix: ".js" });
    
    try {
      // Wrap user code with input parameter
      const wrappedCode = `
const input = ${JSON.stringify(inputData)};
${code}
      `;

      await Deno.writeTextFile(tempFile, wrappedCode);

      // Create promise for execution with timeout
      const executionPromise = Deno.run({
        cmd: [
          "deno",
          "run",
          "--allow-net", // Only allow network (outbound)
          "--no-allow-read", // Explicitly deny filesystem read
          "--no-allow-write", // Explicitly deny filesystem write
          "--no-allow-env", // Deny environment variable access
          "--no-allow-run", // Deny subprocess spawning
          tempFile,
        ],
        stdout: "piped",
        stderr: "piped",
      });

      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("Execution timeout: exceeded 15 second limit"));
        }, MAX_EXECUTION_TIME_MS);
      });

      // Race execution against timeout
      const { success, stdout, stderr } = await Promise.race([
        (async () => {
          const [status, stdout, stderr] = await Promise.all([
            executionPromise.status(),
            executionPromise.output(),
            executionPromise.stderrOutput(),
          ]);
          return { success: status.success, stdout, stderr };
        })(),
        timeoutPromise,
      ]);

      const executionTimeMs = Date.now() - startTime;

      // Check if execution exceeded CPU time
      if (quota.cpu_time_used_ms + executionTimeMs > MAX_CPU_TIME_MS) {
        executionPromise.close();
        return {
          status: "error",
          error: "Execution would exceed CPU time quota",
          executionTimeMs,
        };
      }

      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      // Update quotas
      await updateQuota(userId, executionTimeMs, quota.concurrent_count - 1);
      
      // Log execution
      await logExecution(
        functionId,
        userId,
        success ? "success" : "error",
        success ? output : null,
        !success || error ? error : null,
        executionTimeMs
      );

      executionPromise.close();

      return {
        status: success ? "success" : "error",
        output: success ? output : null,
        error: !success || error ? error : null,
        executionTimeMs,
      };
    } finally {
      currentInstanceCount--;
      try {
        await Deno.remove(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    console.error("[Novirun] Execution error:", error.message);
    return {
      status: "error",
      error: error.message,
      executionTimeMs: 0,
    };
  }
}

export function getInstanceCount() {
  return currentInstanceCount;
}

export function getMaxInstances() {
  return MAX_INSTANCES_PER_MACHINE;
}
