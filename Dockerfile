# Use official Deno image as base
FROM denoland/deno:latest

# Set working directory
WORKDIR /app

# 1. Copy config files first (to optimize caching)
COPY deno.json .

# 2. Copy the rest of your application logic
COPY main.js database.js auth.js executor.js utils.js .

# 3. Cache dependencies 
# Note: No permission flags needed here! Deno downloads imports automatically.
RUN deno cache main.js

# Expose the internal port Novirun listens on
EXPOSE 3001

# 4. Optimized Healthcheck
# Instead of downloading a file server, we use a tiny internal check 
# that verifies the server is responding on port 3001.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD deno eval "try { const conn = await Deno.connect({ port: 3001 }); conn.close(); Deno.exit(0); } catch { Deno.exit(1); }"

# 5. Run the application
# We keep your specific permission requirements intact.
CMD ["run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "--unstable-worker-options", "main.js"]
