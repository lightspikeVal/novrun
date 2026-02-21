// database.js - PostgreSQL connection and schema management
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

let pool;

/**
 * Initializes the database connection pool and sets up the schema.
 */
export async function initDatabase() {
  try {
    const connectionString = Deno.env.get("DATABASE_URL");
    
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    // Using 1 connection for the pool to conserve RAM on 4GB laptop
    // Lazy-loading (true) ensures we don't hog memory until needed
    pool = new Pool(connectionString, 1, true);

    const connection = await pool.connect();
    console.log("[Novirun] Connected to PostgreSQL database");
    connection.release();

    // Initialize schema
    await createSchema();
  } catch (error) {
    console.error("[Novirun] Database connection failed:", error.message);
    throw error;
  }
}

/**
 * Creates tables and indexes if they do not exist.
 * Does NOT drop tables to ensure data persistence.
 */
async function createSchema() {
  const connection = await pool.connect();
  try {
    // 1. Users table
    await connection.queryObject`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        appwrite_user_id TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 2. Functions table
    await connection.queryObject`
      CREATE TABLE IF NOT EXISTS functions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      )
    `;

    // 3. Executions table
    await connection.queryObject`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        execution_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 4. Quotas table
    await connection.queryObject`
      CREATE TABLE IF NOT EXISTS quotas (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cpu_time_used_ms INTEGER DEFAULT 0,
        concurrent_count INTEGER DEFAULT 0,
        last_reset_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      )
    `;

    // 5. Indexes for performance
    await connection.queryObject`CREATE INDEX IF NOT EXISTS idx_functions_user_id ON functions(user_id)`;
    await connection.queryObject`CREATE INDEX IF NOT EXISTS idx_executions_function_id ON executions(function_id)`;
    await connection.queryObject`CREATE INDEX IF NOT EXISTS idx_executions_user_id ON executions(user_id)`;

    console.log("[Novirun] Database schema initialized successfully");
  } catch (error) {
    console.error("[Novirun] Schema creation error:", error.message);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * DATABASE OPERATIONS
 */

export async function getUser(appwriteUserId) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      SELECT * FROM users WHERE appwrite_user_id = ${appwriteUserId}
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function createOrUpdateUser(appwriteUserId, email) {
  const connection = await pool.connect();
  try {
    const userId = crypto.randomUUID();
    const result = await connection.queryObject`
      INSERT INTO users (id, appwrite_user_id, email)
      VALUES (${userId}, ${appwriteUserId}, ${email})
      ON CONFLICT (appwrite_user_id) DO UPDATE
      SET email = ${email}, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function createFunction(userId, name, code) {
  const connection = await pool.connect();
  try {
    const functionId = crypto.randomUUID();
    const result = await connection.queryObject`
      INSERT INTO functions (id, user_id, name, code)
      VALUES (${functionId}, ${userId}, ${name}, ${code})
      RETURNING *
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function getFunction(functionId, userId) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      SELECT * FROM functions WHERE id = ${functionId} AND user_id = ${userId}
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function getFunctionById(functionId) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      SELECT * FROM functions WHERE id = ${functionId}
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function listFunctions(userId) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      SELECT id, name, enabled, created_at, updated_at FROM functions WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return result.rows;
  } finally {
    connection.release();
  }
}

export async function updateFunctionCode(functionId, userId, code) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      UPDATE functions SET code = ${code}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${functionId} AND user_id = ${userId}
      RETURNING *
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function deleteFunction(functionId, userId) {
  const connection = await pool.connect();
  try {
    await connection.queryObject`
      DELETE FROM functions WHERE id = ${functionId} AND user_id = ${userId}
    `;
    return true;
  } finally {
    connection.release();
  }
}

export async function logExecution(functionId, userId, status, output, error, executionTimeMs) {
  const connection = await pool.connect();
  try {
    const executionId = crypto.randomUUID();
    await connection.queryObject`
      INSERT INTO executions (id, function_id, user_id, status, output, error, execution_time_ms)
      VALUES (${executionId}, ${functionId}, ${userId}, ${status}, ${output}, ${error}, ${executionTimeMs})
    `;
  } finally {
    connection.release();
  }
}

export async function getQuota(userId) {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      SELECT * FROM quotas WHERE user_id = ${userId}
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

export async function initializeQuota(userId) {
  const connection = await pool.connect();
  try {
    const quotaId = crypto.randomUUID();
    await connection.queryObject`
      INSERT INTO quotas (id, user_id) VALUES (${quotaId}, ${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;
  } finally {
    connection.release();
  }
}

export async function updateQuota(userId, cpuTimeUsedMs, concurrentCount) {
  const connection = await pool.connect();
  try {
    await connection.queryObject`
      UPDATE quotas 
      SET cpu_time_used_ms = cpu_time_used_ms + ${cpuTimeUsedMs},
          concurrent_count = ${concurrentCount}
      WHERE user_id = ${userId}
    `;
  } finally {
    connection.release();
  }
}

export async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log("[Novirun] Database connection closed");
  }
}
