// worker.js - Deno Worker wrapper for executing user functions
// This runs in an isolated V8 context with restricted permissions

self.onmessage = async (e) => {
  const { code, input, functionId } = e.data;
  const startTime = performance.now();

  try {
    // Wrap user code in Deno.serve handler
    const wrappedCode = `
      const input = ${JSON.stringify(input)};
      
      // User's Deno.serve handler
      const handler = async (req) => {
        ${code}
      };
      
      // Start ephemeral server
      const server = Deno.serve({ 
        port: 0,
        hostname: "127.0.0.1",
        onListen: () => {}
      }, handler);
      
      // Make internal request to capture response
      try {
        const response = await fetch("http://127.0.0.1:" + server.addr.port);
        const body = await response.text();
        
        // Collect headers
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        
        // Return captured response
        const result = {
          status: response.status,
          headers: headers,
          body: body
        };
        
        await server.shutdown();
        
        // Output to stdout for parent to capture
        console.log(JSON.stringify(result));
      } catch (err) {
        await server.shutdown();
        throw err;
      }
    `;

    // Create blob URL for dynamic import
    const blob = new Blob([wrappedCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);

    try {
      // Import and execute
      await import(url);
      
      // Worker will output via console.log, parent captures it
      const executionTime = performance.now() - startTime;
      
      self.postMessage({
        status: "success",
        executionTimeMs: executionTime
      });
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
    // Self-terminate (FaaS pattern)
    self.close();
  }
};
