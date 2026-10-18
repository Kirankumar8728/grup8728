import { loadGroupsFromDisk } from './lib/groups-persistence.ts';
import { executeDml } from './lib/db.ts';
import { uploadImageToR2 } from './lib/r2-storage.ts';

async function migrateImagesToCDN() {
  console.log('[MIGRATION] Starting image migration to CDN (Minimal)...');
  const groups = loadGroupsFromDisk();
  
  if (!groups || !Array.isArray(groups)) {
    console.error('Failed to load groups from disk.');
    return;
  }

  let processed = 0;
  let migrated = 0;

  for (const group of groups) {
    processed++;
    if (!group.imageUrl || group.imageUrl.includes('cdn.grouplinks.app') || group.imageUrl.startsWith('data:')) {
      continue;
    }

    console.log(`[MIGRATION] Processing group ${group.id}: ${group.imageUrl}`);

    try {
      const result = await uploadImageToR2(group.imageUrl, `group-${group.id}`);
      if (result.success && result.r2Url) {
        await executeDml('UPDATE groups_dir SET imageUrl = ? WHERE id = ?', [result.r2Url, group.id]);
        console.log(`[MIGRATION] Successfully migrated image for ${group.id}`);
        migrated++;
      } else {
        console.error(`[MIGRATION] Failed to upload image for ${group.id}: ${result.error}`);
      }
    } catch (err) {
      console.error(`[MIGRATION] Error processing ${group.id}:`, err);
    }
  }

  console.log(`[MIGRATION] Finished. Processed: ${processed}, Migrated: ${migrated}`);
}

migrateImagesToCDN().catch(console.error);
