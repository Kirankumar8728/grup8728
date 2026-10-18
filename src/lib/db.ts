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

// MySQL Pool setup
export let pool: mysql.Pool | null = null;

if (isMySQLConfigured()) {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER || process.env.MYSQL_USER || 'root',
      password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || process.env.MYSQL_PORT) || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000,
    });
  } catch (err) {
    console.error('[DB] Failed to create MySQL pool:', err);
    pool = null;
  }
}

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
  if (!pool) return false;
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return true;
  } catch (err) {
    console.error('[DB] Database ping failed:', err);
    return false;
  }
}

// Ensure tables exist if MySQL is configured
async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS groups (
      id VARCHAR(255) PRIMARY KEY,
      slug VARCHAR(255) UNIQUE,
      title VARCHAR(255),
      description TEXT,
      url VARCHAR(2048),
      platform VARCHAR(50),
      category VARCHAR(100),
      imageUrl VARCHAR(2048),
      bannerUrl VARCHAR(2048),
      memberCount INT,
      isActive BOOLEAN DEFAULT true,
      healthStatus VARCHAR(50) DEFAULT 'active',
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS group_reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id VARCHAR(255),
      rating INT,
      review TEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS group_interactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id VARCHAR(255),
      ip_hash VARCHAR(255),
      type VARCHAR(50),
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (err) {
    console.error('[DB] Failed to initialize MySQL tables:', err);
  }
}

// Non-blocking initialization
if (pool) {
  initDb().catch((err) => {
    console.error('[DB] initDb error:', err);
  });
}

// JSON Fallback path
const JSON_DIR = path.join(process.cwd(), '.data');
const JSON_PATH = path.join(JSON_DIR, 'nexus-groups.json');

try {
  if (!fs.existsSync(JSON_DIR)) {
    fs.mkdirSync(JSON_DIR, { recursive: true });
  }
} catch {}

/**
 * Execute a read query returning an array of rows.
 * Fallback to empty array if DB is not configured or query fails.
 */
export async function queryRows<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (pool) {
    try {
      const [results] = await pool.execute(sql, params);
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
 * Fallback to null if DB is not configured or query fails.
 */
export async function executeDml(sql: string, params: any[] = []): Promise<any> {
  if (pool) {
    try {
      const [result] = await pool.execute(sql, params);
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

