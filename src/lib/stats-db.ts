import path from 'path';
import fs from 'fs';

let db: any = null;

try {
  // Use node:sqlite if available in Node 22+ via require
  const sqlite = require('node:sqlite');
  if (sqlite && sqlite.DatabaseSync) {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'stats.db');
    db = new sqlite.DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_stats (
        group_id TEXT PRIMARY KEY,
        upvotes INTEGER DEFAULT 0,
        shares INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0
      );
    `);
  }
} catch (err) {
  console.warn('[stats-db] SQLite initialization note:', err);
}

// In-memory fallback if SQLite fails or is unavailable
const memoryStats = new Map<string, { upvotes: number; shares: number; clicks: number }>();

export function getStatsBatch(ids: string[]): Record<string, { upvotes: number; shares: number; clicks: number }> {
  if (!ids || ids.length === 0) return {};
  const map: Record<string, { upvotes: number; shares: number; clicks: number }> = {};
  for (const id of ids) {
    map[id] = { upvotes: 0, shares: 0, clicks: 0 };
  }

  if (db) {
    try {
      const placeholders = ids.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT group_id, upvotes, shares, clicks FROM group_stats WHERE group_id IN (${placeholders})`);
      const rows = stmt.all(...ids) as any[];
      for (const row of rows) {
        map[row.group_id] = {
          upvotes: row.upvotes || 0,
          shares: row.shares || 0,
          clicks: row.clicks || 0,
        };
      }
      return map;
    } catch (err) {
      console.error('[stats-db] getStatsBatch error:', err);
    }
  }

  // Memory fallback
  for (const id of ids) {
    if (memoryStats.has(id)) {
      map[id] = { ...memoryStats.get(id)! };
    }
  }

  return map;
}

export function incrementStat(groupId: string, action: 'upvote' | 'share' | 'join' | 'click') {
  const col = action === 'upvote' ? 'upvotes' : action === 'share' ? 'shares' : 'clicks';
  
  if (db) {
    try {
      const cleanId = (groupId || '').replace(/'/g, "''");
      db.exec(`
        INSERT INTO group_stats (group_id, ${col}) VALUES ('${cleanId}', 1)
        ON CONFLICT(group_id) DO UPDATE SET ${col} = ${col} + 1;
      `);
      const stmt = db.prepare(`SELECT group_id, upvotes, shares, clicks FROM group_stats WHERE group_id = ?`);
      return stmt.get(groupId) || { group_id: groupId, upvotes: 0, shares: 0, clicks: 0 };
    } catch (err) {
      console.error('[stats-db] incrementStat error:', err);
    }
  }

  // Memory fallback
  const current = memoryStats.get(groupId) || { upvotes: 0, shares: 0, clicks: 0 };
  if (action === 'upvote') current.upvotes += 1;
  else if (action === 'share') current.shares += 1;
  else current.clicks += 1;
  memoryStats.set(groupId, current);

  return { group_id: groupId, ...current };
}
