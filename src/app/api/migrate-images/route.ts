import { NextResponse } from 'next/server';
import { loadGroupsFromDisk } from '@/src/lib/groups-persistence';
import { executeDml } from '@/src/lib/db';
import { uploadImageToR2 } from '@/src/lib/r2-storage';

export async function GET() {
  console.log('[MIGRATION] Starting image migration to CDN via API...');
  const groups = loadGroupsFromDisk();
  
  if (!groups || !Array.isArray(groups)) {
    return NextResponse.json({ error: 'Failed to load groups' }, { status: 500 });
  }

  let processed = 0;
  let migrated = 0;

  for (const group of groups) {
    processed++;
    if (!group.imageUrl || group.imageUrl.includes('cdn.grouplinks.app') || group.imageUrl.startsWith('data:')) {
      continue;
    }

    try {
      const result = await uploadImageToR2(group.imageUrl, `group-${group.id}`);
      if (result.success && result.r2Url) {
        await executeDml('UPDATE groups_dir SET imageUrl = ? WHERE id = ?', [result.r2Url, group.id]);
        migrated++;
      }
    } catch (err) {
      console.error(`[MIGRATION] Error processing ${group.id}:`, err);
    }
  }

  return NextResponse.json({ success: true, processed, migrated });
}
