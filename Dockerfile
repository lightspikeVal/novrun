# Use official Deno image as base
FROM denoland/deno:latest

# Set working directory
WORKDIR /app

# Copy application files
COPY main.js .
COPY database.js .
COPY auth.js .
COPY executor.js .
COPY utils.js .
COPY deno.json .

# Create cache directory for Deno
RUN deno cache main.js --allow-net --allow-env --allow-run

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD deno run --allow-net https://deno.land/std@0.194.0/http/file_server.ts /dev/null || exit 1

# Run the application
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "main.js"]
