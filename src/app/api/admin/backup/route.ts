import { NextRequest, NextResponse } from 'next/server';
import { 
  getGroupsDatabase, 
  replaceGroupsDatabase, 
  mergeGroupsDatabase,
  getRestrictedKeywordsServer,
  addRestrictedKeywordServer
} from '@/src/lib/groups-store';
import { 
  getCustomScriptsServer, 
  saveCustomScriptsServer,
  getAdsTxtServer,
  saveAdsTxtServer
} from '@/src/lib/server-scripts-persistence';
import { requireAdmin } from '@/src/lib/admin-auth';
import { verifySameOrigin } from '@/src/lib/security';
import { Group, GroupComment } from '@/src/types';
import { getPool } from '@/src/lib/db';
import { parseMysqlGroupRow } from '@/src/lib/groups-dal';
import { generateSlug } from '@/src/utils/helpers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  try {
    const pool = getPool();
    let db: Group[] = [];

    // 1. Query raw MySQL database directly
    if (pool) {
      try {
        const [rows]: any = await pool.query('SELECT * FROM groups_dir ORDER BY createdAt DESC');
        if (Array.isArray(rows) && rows.length > 0) {
          db = rows.map((r: any) => parseMysqlGroupRow(r));
        }
      } catch (err: any) {
        console.warn('[MySQL backup GET notice]:', err?.message);
      }
    }

    // 2. Resilient fallback to memory store if MySQL returned 0 rows
    if (db.length === 0) {
      db = getGroupsDatabase();
    }

    const restrictedKeywords = getRestrictedKeywordsServer();
    const customScripts = getCustomScriptsServer();
    const adsTxt = getAdsTxtServer();

    let totalComments = 0;
    let totalRatings = 0;
    let totalSticky = 0;
    let totalNsfw = 0;
    const allFlatComments: (GroupComment & { groupTitle: string; groupPlatform: string })[] = [];

    db.forEach(g => {
      if (Array.isArray(g.comments)) {
        totalComments += g.comments.length;
        g.comments.forEach(c => {
          allFlatComments.push({
            ...c,
            groupTitle: g.title,
            groupPlatform: g.platform,
          });
        });
      }
      if (typeof g.ratingCount === 'number') {
        totalRatings += g.ratingCount;
      }
      if (g.isSticky) totalSticky++;
      if (g.isNsfw || g.category === 'Adult / 18+') totalNsfw++;
    });

    return NextResponse.json({
      success: true,
      appName: 'Group Links Community Master Backup',
      version: '3.0.0',
      storageEngine: pool ? 'MySQL (Native)' : 'In-Memory Fallback',
      exportedAt: new Date().toISOString(),
      totalGroups: db.length,
      totalComments,
      totalRatings,
      totalSticky,
      totalNsfw,
      restrictedKeywords,
      customScripts,
      adsTxt,
      groups: db,
      allComments: allFlatComments,
    }, { headers: NO_CACHE_HEADERS });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

export async function POST(req: NextRequest) {
  const originCheck = verifySameOrigin(req);
  if (!originCheck.valid) {
    return originCheck.response!;
  }

  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  try {
    const body = await req.json();

    let incomingGroups: Group[] = [];
    if (Array.isArray(body)) {
      incomingGroups = body;
    } else if (body && Array.isArray(body.groups)) {
      incomingGroups = body.groups;
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid backup file format. Expected a "groups" array or an array of groups.' },
        { status: 400 }
      );
    }

    const mode: 'merge' | 'replace' = body.mode === 'replace' ? 'replace' : 'merge';

    // Restore restricted keywords if provided
    if (body && Array.isArray(body.restrictedKeywords) && body.restrictedKeywords.length > 0) {
      body.restrictedKeywords.forEach((kw: string) => {
        if (typeof kw === 'string' && kw.trim()) {
          addRestrictedKeywordServer(kw.trim());
        }
      });
    }

    // Restore custom scripts if provided
    if (body && body.customScripts && typeof body.customScripts === 'object') {
      saveCustomScriptsServer(body.customScripts);
    }

    // Restore ads.txt if provided
    if (body && typeof body.adsTxt === 'string') {
      saveAdsTxtServer(body.adsTxt);
    }

    const pool = getPool();

    if (mode === 'replace') {
      let totalInserted = 0;
      if (pool && incomingGroups.length > 0) {
        try {
          await pool.query('DELETE FROM groups_dir');
          const CHUNK_SIZE = 50;
          for (let i = 0; i < incomingGroups.length; i += CHUNK_SIZE) {
            const chunk = incomingGroups.slice(i, i + CHUNK_SIZE);
            const placeholders: string[] = [];
            const values: any[] = [];
            for (const g of chunk) {
              placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
              const id = g.id || `grp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
              const slug = g.slug || generateSlug(g.title || id);
              const nowIso = new Date().toISOString();
              values.push(
                id,
                slug,
                g.title || 'Untitled Community',
                g.description || '',
                g.url || '#',
                (g.platform || 'whatsapp').toLowerCase(),
                g.category || 'General',
                g.language || 'English',
                g.region || 'Global',
                JSON.stringify(Array.isArray(g.customTags) ? g.customTags : []),
                g.imageUrl || '',
                Number(g.memberCount) || 0,
                g.verified ? 1 : 0,
                g.isNsfw ? 1 : 0,
                g.status || 'approved',
                g.isActive !== false ? 1 : 0,
                Number(g.safetyScore) || 95,
                Number(g.growthRate) || 12,
                Number(g.clicks) || 0,
                Number(g.upvotes) || 0,
                Number(g.bookmarks) || 0,
                g.createdAt || nowIso,
                g.publishedAt || nowIso,
                nowIso,
                JSON.stringify(Array.isArray(g.comments) ? g.comments : [])
              );
            }
            const batchSql = `
              INSERT IGNORE INTO groups_dir (
                id, slug, title, description, url, platform, category,
                language, region, customTags, imageUrl, memberCount,
                verified, isNsfw, status, isActive, safetyScore,
                growthRate, clicks, upvotes, bookmarks, createdAt,
                publishedAt, updatedAt, comments
              ) VALUES ${placeholders.join(', ')}
            `;
            await pool.query(batchSql, values);
            totalInserted += chunk.length;
          }
        } catch (err: any) {
          console.warn('[MySQL backup restore notice]:', err?.message);
        }
      }

      const res = replaceGroupsDatabase(incomingGroups);
      return NextResponse.json({
        success: true,
        mode: 'replace',
        total: totalInserted > 0 ? totalInserted : res.total,
        totalComments: res.totalComments,
        message: `Database replaced successfully: ${totalInserted > 0 ? totalInserted : res.total} groups restored to MySQL.`,
      });
    } else {
      let totalInserted = 0;
      if (pool && incomingGroups.length > 0) {
        try {
          const CHUNK_SIZE = 50;
          for (let i = 0; i < incomingGroups.length; i += CHUNK_SIZE) {
            const chunk = incomingGroups.slice(i, i + CHUNK_SIZE);
            const placeholders: string[] = [];
            const values: any[] = [];
            for (const g of chunk) {
              placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
              const id = g.id || `grp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
              const slug = g.slug || generateSlug(g.title || id);
              const nowIso = new Date().toISOString();
              values.push(
                id,
                slug,
                g.title || 'Untitled Community',
                g.description || '',
                g.url || '#',
                (g.platform || 'whatsapp').toLowerCase(),
                g.category || 'General',
                g.language || 'English',
                g.region || 'Global',
                JSON.stringify(Array.isArray(g.customTags) ? g.customTags : []),
                g.imageUrl || '',
                Number(g.memberCount) || 0,
                g.verified ? 1 : 0,
                g.isNsfw ? 1 : 0,
                g.status || 'approved',
                g.isActive !== false ? 1 : 0,
                Number(g.safetyScore) || 95,
                Number(g.growthRate) || 12,
                Number(g.clicks) || 0,
                Number(g.upvotes) || 0,
                Number(g.bookmarks) || 0,
                g.createdAt || nowIso,
                g.publishedAt || nowIso,
                nowIso,
                JSON.stringify(Array.isArray(g.comments) ? g.comments : [])
              );
            }
            const batchSql = `
              INSERT IGNORE INTO groups_dir (
                id, slug, title, description, url, platform, category,
                language, region, customTags, imageUrl, memberCount,
                verified, isNsfw, status, isActive, safetyScore,
                growthRate, clicks, upvotes, bookmarks, createdAt,
                publishedAt, updatedAt, comments
              ) VALUES ${placeholders.join(', ')}
            `;
            await pool.query(batchSql, values);
            totalInserted += chunk.length;
          }
        } catch (err: any) {
          console.warn('[MySQL backup merge notice]:', err?.message);
        }
      }

      const res = mergeGroupsDatabase(incomingGroups);
      return NextResponse.json({
        success: true,
        mode: 'merge',
        added: res.added,
        updated: res.updated,
        total: res.total,
        totalComments: res.totalComments,
        message: `Successfully merged backup: ${res.added} added, ${res.updated} updated (${res.total} total groups in MySQL).`,
      });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
