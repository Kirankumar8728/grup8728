import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

/**
 * Checks if MySQL database environment variables are configured.
 */
export function isMySQLConfigured(): boolean {
  return Boolean(
    process.env.DB_HOST &&
    process.env.DB_NAME &&
    (process.env.DB_USER || process.env.MYSQL_USER)
  );
}

// Global singleton pool for Hostinger to prevent max_user_connections exhaustion
declare global {
  var __mysqlPool: mysql.Pool | undefined;
}

let poolInstance: mysql.Pool | null = null;

if (isMySQLConfigured()) {
  if (globalThis.__mysqlPool) {
    poolInstance = globalThis.__mysqlPool;
  } else {
    try {
      poolInstance = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER || process.env.MYSQL_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
        database: process.env.DB_NAME,
        port: Number(process.env.DB_PORT || process.env.MYSQL_PORT) || 3306,
        waitForConnections: true,
        connectionLimit: 5,
        maxIdle: 3,
        idleTimeout: 30000,
        enableKeepAlive: true,
        connectTimeout: 10000,
      });
      globalThis.__mysqlPool = poolInstance;
    } catch (err) {
      console.error('[DB] Failed to create MySQL pool:', err);
      poolInstance = null;
    }
  }
}

export const pool: mysql.Pool | null = poolInstance;

/**
 * Returns the MySQL connection pool (or null if not configured).
 */
export function getPool(): mysql.Pool | null {
  return pool;
}

/**
 * Pings the MySQL database to test connectivity.
 */
export async function pingDatabase(): Promise<boolean> {
  const currentPool = getPool();
  if (!currentPool) return false;
  try {
    const connection = await currentPool.getConnection();
    await connection.ping();
    connection.release();
    return true;
  } catch (err) {
    console.error('[DB] Database ping failed:', err);
    return false;
  }
}

const JSON_DIR = path.join(process.cwd(), '.data');
try {
  if (!fs.existsSync(JSON_DIR)) {
    fs.mkdirSync(JSON_DIR, { recursive: true });
  }
} catch {}

/**
 * Execute a read query returning an array of rows.
 */
export async function queryRows<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const currentPool = getPool();
  if (currentPool) {
    try {
      const [results] = await currentPool.execute(sql, params);
      return (results as T[]) || [];
    } catch (err) {
      console.error('[DB] queryRows error:', err);
      return [];
    }
  }
  return [];
}

/**
 * Execute DML (INSERT, UPDATE, DELETE) query.
 */
export async function executeDml(sql: string, params: any[] = []): Promise<any> {
  const currentPool = getPool();
  if (currentPool) {
    try {
      const [result] = await currentPool.execute(sql, params);
      return result;
    } catch (err) {
      console.error('[DB] executeDml error:', err);
      return null;
    }
  }
  return null;
}

const db = {
  isMySQLConfigured,
  pool,
  getPool,
  pingDatabase,
  queryRows,
  executeDml,
};

export default db;
