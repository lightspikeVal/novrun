// executor.js - Deno Worker-based execution with security and quota enforcement
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

    try {
      // Inline worker code as data URL to avoid file system dependency
      const workerCode = `
self.onmessage = async (e) => {
  const { code, input, functionId } = e.data;
  const startTime = performance.now();

  try {
    const wrappedCode = \`
      const input = \${JSON.stringify(input)};
      
      const handler = async (req) => {
        \${code}
      };
      
      const server = Deno.serve({ 
        port: 0,
        hostname: "127.0.0.1",
        onListen: () => {}
      }, handler);
      
      try {
        const response = await fetch("http://127.0.0.1:" + server.addr.port);
        const body = await response.text();
        
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        
        const result = {
          status: response.status,
          headers: headers,
          body: body
        };
        
        await server.shutdown();
        console.log(JSON.stringify(result));
      } catch (err) {
        await server.shutdown();
        throw err;
      }
    \`;

    const blob = new Blob([wrappedCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);

    try {
      await import(url);
      const executionTime = performance.now() - startTime;
      self.postMessage({ status: "success", executionTimeMs: executionTime });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    const executionTime = performance.now() - startTime;
    self.postMessage({
      status: "error",
      error: error.message,
      stack: error.stack,
      executionTimeMs: executionTime
    });
  } finally {
    self.close();
  }
};
      `;
      
      // Create worker from inline code
      const workerBlob = new Blob([workerCode], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(workerBlob);
      
      const worker = new Worker(workerUrl, {
        type: "module",
        deno: {
          permissions: {
            net: true,      // Allow fetch/HTTP
            read: false,    // No filesystem
            write: false,   // No filesystem writes
            env: false,     // No env vars
            run: false,     // No subprocesses
            ffi: false,     // No native code
          },
        },
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        worker.terminate();
      }, MAX_EXECUTION_TIME_MS);

      // Execute and wait for result
      const result = await new Promise((resolve, reject) => {
        let output = "";

        // Capture console output from worker
        worker.addEventListener("message", (e) => {
          const data = e.data;
          
          if (data.status === "success") {
            clearTimeout(timeoutId);
            worker.terminate();
            resolve({
              status: "success",
              output: output,
              executionTimeMs: data.executionTimeMs,
            });
          } else if (data.status === "error") {
            clearTimeout(timeoutId);
            worker.terminate();
            resolve({
              status: "error",
              error: data.error,
              executionTimeMs: data.executionTimeMs,
            });
          }
        });

        worker.addEventListener("error", (e) => {
          clearTimeout(timeoutId);
          worker.terminate();
          resolve({
            status: "error",
            error: e.message || "Worker error",
            executionTimeMs: Date.now() - startTime,
          });
        });

        // Send code to worker
        worker.postMessage({
          code: code,
          input: inputData,
          functionId: functionId,
        });

        // Capture stdout (worker's console.log)
        const originalLog = console.log;
        console.log = (...args) => {
          output += args.join(" ");
          originalLog(...args);
        };

        // Restore after timeout
        setTimeout(() => {
          console.log = originalLog;
        }, MAX_EXECUTION_TIME_MS + 100);
      });

      const executionTimeMs = Date.now() - startTime;

      // Check if execution exceeded CPU time
      if (quota.cpu_time_used_ms + executionTimeMs > MAX_CPU_TIME_MS) {
        return {
          status: "error",
          error: "Execution would exceed CPU time quota",
          executionTimeMs,
        };
      }

      // Update quotas
      await updateQuota(userId, executionTimeMs, quota.concurrent_count - 1);

      // Log execution
      await logExecution(
        functionId,
        userId,
        result.status,
        result.status === "success" ? result.output : null,
        result.status === "error" ? result.error : null,
        executionTimeMs
      );

      return {
        status: result.status,
        output: result.status === "success" ? result.output : null,
        error: result.status === "error" ? result.error : null,
        executionTimeMs,
      };
    } finally {
      currentInstanceCount--;
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
