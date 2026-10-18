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
import { verifySameOrigin, sanitizeFileName } from '@/src/lib/security';
import { Group, GroupComment } from '@/src/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const THREE_MONTHS_DAYS = 90;
const THREE_MONTHS_MS = THREE_MONTHS_DAYS * 24 * 60 * 60 * 1000; // 90 days (3 months) in milliseconds

interface DriveFileItem {
  id: string;
  name: string;
  size?: string;
  createdTime: string;
  webViewLink?: string;
  webContentLink?: string;
  isExpired?: boolean;
  daysOld?: number;
  daysRemaining?: number;
}

// Helper to extract Google OAuth token from custom header or body
function getGoogleDriveOAuthToken(req: NextRequest, body?: any): string | null {
  const gDriveTokenHeader = req.headers.get('x-google-drive-token');
  if (gDriveTokenHeader) return gDriveTokenHeader.trim();
  if (body && typeof body.googleToken === 'string') return body.googleToken.trim();
  
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] && !match[1].startsWith('gl_adm_')) {
      return match[1].trim();
    }
  }
  return null;
}

// Generate the complete site backup snapshot JSON
function generateFullSiteBackupSnapshot() {
  const db = getGroupsDatabase();
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
          groupPlatform: g.platform
        });
      });
    }
    if (typeof g.ratingCount === 'number') {
      totalRatings += g.ratingCount;
    }
    if (g.isSticky) totalSticky++;
    if (g.isNsfw || g.category === 'Adult / 18+') totalNsfw++;
  });

  return {
    appName: 'Group Links Community Master Backup',
    version: '2.5.0',
    exportedAt: new Date().toISOString(),
    backupType: 'google_drive_auto_backup',
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
  };
}

// List all backup files in user's Google Drive created by this app
async function listDriveBackups(token: string): Promise<DriveFileItem[]> {
  const query = encodeURIComponent("name contains 'grouplinks_backup_' and trashed = false");
  const fields = encodeURIComponent("files(id, name, size, createdTime, webViewLink, webContentLink)");
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=createdTime desc&pageSize=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to list Google Drive files: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const files: DriveFileItem[] = (data.files || []).map((f: any) => {
    const createdMs = new Date(f.createdTime).getTime();
    const ageMs = Date.now() - createdMs;
    const daysOld = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const isExpired = ageMs >= THREE_MONTHS_MS;
    const daysRemaining = Math.max(0, THREE_MONTHS_DAYS - daysOld);

    return {
      id: f.id,
      name: f.name,
      size: f.size,
      createdTime: f.createdTime,
      webViewLink: f.webViewLink,
      webContentLink: f.webContentLink,
      isExpired,
      daysOld,
      daysRemaining,
    };
  });

  return files;
}

// Delete files older than 3 months (90 days) from Google Drive
async function cleanExpiredBackups(token: string, existingFiles?: DriveFileItem[]): Promise<DriveFileItem[]> {
  const files = existingFiles || await listDriveBackups(token);
  const deletedFiles: DriveFileItem[] = [];

  for (const file of files) {
    if (file.isExpired) {
      try {
        const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (delRes.ok || delRes.status === 204) {
          deletedFiles.push(file);
        }
      } catch (delErr) {
        console.warn(`Failed to delete expired backup ${file.id}:`, delErr);
      }
    }
  }

  return deletedFiles;
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  const gToken = getGoogleDriveOAuthToken(req);
  if (!gToken) {
    return NextResponse.json({ success: false, error: 'Google Drive authorization token required' }, { status: 400 });
  }

  try {
    const files = await listDriveBackups(gToken);
    return NextResponse.json({
      success: true,
      files,
      retentionPolicy: '90 days (3 months)',
      expiredCount: files.filter(f => f.isExpired).length
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'backup';

    // Local DB pruning does not require Google Drive token
    if (action === 'prune_database_data') {
      const db = getGroupsDatabase();
      const nowMs = Date.now();
      let prunedCommentsCount = 0;
      let cleanedStickyCount = 0;

      const updatedDb = db.map(g => {
        let changed = false;
        let newComments = g.comments;
        if (Array.isArray(g.comments) && g.comments.length > 0) {
          const filtered = g.comments.filter(c => {
            const commentTime = new Date(c.createdAt).getTime();
            if (!isNaN(commentTime) && (nowMs - commentTime) > THREE_MONTHS_MS) {
              prunedCommentsCount++;
              return false;
            }
            return true;
          });
          if (filtered.length !== g.comments.length) {
            newComments = filtered;
            changed = true;
          }
        }

        let newStickyUntil = g.stickyUntil;
        let newIsSticky = g.isSticky;
        if (g.stickyUntil) {
          const stickyTime = new Date(g.stickyUntil).getTime();
          if (!isNaN(stickyTime) && (nowMs - stickyTime) > THREE_MONTHS_MS) {
            newStickyUntil = undefined;
            newIsSticky = false;
            cleanedStickyCount++;
            changed = true;
          }
        }

        if (changed) {
          return {
            ...g,
            comments: newComments,
            isSticky: newIsSticky,
            stickyUntil: newStickyUntil
          };
        }
        return g;
      });

      if (prunedCommentsCount > 0 || cleanedStickyCount > 0) {
        replaceGroupsDatabase(updatedDb);
      }

      return NextResponse.json({
        success: true,
        message: `Pruned site database: ${prunedCommentsCount} comment(s) and ${cleanedStickyCount} stale record(s) older than 3 months removed.`,
        prunedCommentsCount,
        cleanedStickyCount
      });
    }

    const gToken = getGoogleDriveOAuthToken(req, body);
    if (!gToken) {
      return NextResponse.json({ success: false, error: 'Google Drive authorization token required' }, { status: 400 });
    }

    // 1. ACTION: BACKUP
    if (action === 'backup') {
      const snapshot = generateFullSiteBackupSnapshot();
      const jsonContent = JSON.stringify(snapshot, null, 2);

      const now = new Date();
      const dateStr = now.toISOString().replace(/[:.]/g, '-');
      const fileName = `grouplinks_backup_${dateStr}.json`;

      // Multipart upload to Google Drive v3
      const boundary = '-------GroupLinksDriveBackupBoundary314159';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const metadata = {
        name: fileName,
        mimeType: 'application/json',
        description: `GroupLinks Community Full Backup Snapshot - ${now.toLocaleDateString()}`,
        properties: {
          app: 'grouplinks',
          type: 'full_site_backup',
          version: '2.5.0',
          groupsCount: String(snapshot.totalGroups),
        }
      };

      const multipartRequestBody = 
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        jsonContent +
        closeDelimiter;

      const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime,webViewLink', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return NextResponse.json({ 
          success: false, 
          error: `Google Drive upload failed: ${uploadRes.status} ${errText}` 
        }, { status: uploadRes.status });
      }

      const uploadedFile = await uploadRes.json();

      // Automatically check and delete backups older than 3 months (90 days)
      const allFiles = await listDriveBackups(gToken);
      const deletedExpired = await cleanExpiredBackups(gToken, allFiles);

      // Refresh list after cleanup
      const updatedFiles = await listDriveBackups(gToken);

      return NextResponse.json({
        success: true,
        message: `Successfully backed up site to Google Drive (${snapshot.totalGroups} groups).`,
        file: uploadedFile,
        deletedExpiredCount: deletedExpired.length,
        deletedExpiredFiles: deletedExpired,
        files: updatedFiles,
        timestamp: now.toISOString()
      });
    }

    // 2. ACTION: CLEANUP
    if (action === 'cleanup') {
      const allFiles = await listDriveBackups(gToken);
      const deletedExpired = await cleanExpiredBackups(gToken, allFiles);
      const updatedFiles = await listDriveBackups(gToken);

      return NextResponse.json({
        success: true,
        message: deletedExpired.length > 0 
          ? `Pruned ${deletedExpired.length} backup(s) older than 3 months (90 days).` 
          : 'No backups older than 3 months (90 days) found.',
        deletedCount: deletedExpired.length,
        deletedFiles: deletedExpired,
        files: updatedFiles
      });
    }

    // 3. ACTION: DELETE SINGLE FILE
    if (action === 'delete') {
      const fileId = body.fileId;
      if (!fileId) {
        return NextResponse.json({ success: false, error: 'fileId is required' }, { status: 400 });
      }

      const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${gToken}` }
      });

      if (!delRes.ok && delRes.status !== 204) {
        const errText = await delRes.text();
        return NextResponse.json({ success: false, error: `Delete failed: ${errText}` }, { status: delRes.status });
      }

      const updatedFiles = await listDriveBackups(gToken);
      return NextResponse.json({
        success: true,
        message: 'Backup deleted from Google Drive.',
        files: updatedFiles
      });
    }

    // 4. ACTION: RESTORE FROM DRIVE
    if (action === 'restore') {
      const fileId = body.fileId;
      const mode: 'merge' | 'replace' = body.mode === 'replace' ? 'replace' : 'merge';

      if (!fileId) {
        return NextResponse.json({ success: false, error: 'fileId is required' }, { status: 400 });
      }

      const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${gToken}` }
      });

      if (!downloadRes.ok) {
        return NextResponse.json({ success: false, error: 'Failed to download backup file from Google Drive' }, { status: downloadRes.status });
      }

      const backupData = await downloadRes.json();

      let incomingGroups: Group[] = [];
      if (Array.isArray(backupData)) {
        incomingGroups = backupData;
      } else if (backupData && Array.isArray(backupData.groups)) {
        incomingGroups = backupData.groups;
      } else {
        return NextResponse.json({ success: false, error: 'Invalid backup structure in Drive file' }, { status: 400 });
      }

      if (Array.isArray(backupData.restrictedKeywords)) {
        backupData.restrictedKeywords.forEach((kw: string) => {
          if (typeof kw === 'string' && kw.trim()) {
            addRestrictedKeywordServer(kw.trim());
          }
        });
      }

      if (backupData.customScripts && typeof backupData.customScripts === 'object') {
        saveCustomScriptsServer(backupData.customScripts);
      }

      if (typeof backupData.adsTxt === 'string') {
        saveAdsTxtServer(backupData.adsTxt);
      }

      if (mode === 'replace') {
        const res = replaceGroupsDatabase(incomingGroups);
        return NextResponse.json({
          success: true,
          mode: 'replace',
          total: res.total,
          totalComments: res.totalComments,
          message: `Successfully replaced database from Google Drive backup (${res.total} groups restored).`
        });
      } else {
        const res = mergeGroupsDatabase(incomingGroups);
        return NextResponse.json({
          success: true,
          mode: 'merge',
          added: res.added,
          updated: res.updated,
          total: res.total,
          totalComments: res.totalComments,
          message: `Successfully merged Google Drive backup: ${res.added} added, ${res.updated} updated.`
        });
      }
    }

    return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
