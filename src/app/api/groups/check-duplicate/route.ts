import { NextRequest, NextResponse } from 'next/server';
import { findDuplicateGroupInDb, getGroupsDatabase } from '@/src/lib/groups-dal';
import { checkDuplicateCommunity } from '@/src/utils/helpers';
import { Platform } from '@/src/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const url = searchParams.get('url') || '';
    const title = searchParams.get('title') || '';
    const platform = (searchParams.get('platform') as Platform) || undefined;
    const currentId = searchParams.get('id') || undefined;

    if (!url && !title) {
      return NextResponse.json({ isDuplicate: false });
    }

    const cleanUrl = url && !url.includes(' ') && url.length < 500 ? url : '';
    const cleanTitle = title && title.length < 300 ? title : '';

    if (!cleanUrl && !cleanTitle) {
      return NextResponse.json({ isDuplicate: false });
    }

    // 1. Fast direct MySQL query for exact URL/title match (0ms latency, zero cache overhead)
    const directMatch = await findDuplicateGroupInDb(cleanUrl, cleanTitle, currentId);
    if (directMatch) {
      return NextResponse.json({
        isDuplicate: true,
        reason: `This community invite link is already listed as "${directMatch.title}".`,
        matchedGroup: {
          id: directMatch.id,
          title: directMatch.title,
          slug: directMatch.slug,
          platform: directMatch.platform,
          category: directMatch.category,
          language: directMatch.language,
          region: directMatch.region,
          url: directMatch.url,
          imageUrl: directMatch.imageUrl,
          bannerUrl: directMatch.bannerUrl,
          description: directMatch.description,
          rulesSummary: directMatch.rulesSummary,
          memberCount: directMatch.memberCount,
          customTags: directMatch.customTags,
        },
      });
    }

    // 2. Fallback check against in-memory store without triggering Next.js 2MB unstable_cache
    const localDb = getGroupsDatabase();
    const result = checkDuplicateCommunity(
      { url: cleanUrl, title: cleanTitle, platform, id: currentId },
      localDb
    );

    if (result.isDuplicate && result.matchedGroup) {
      const g = result.matchedGroup;
      return NextResponse.json({
        isDuplicate: true,
        reason: result.reason,
        matchedGroup: {
          id: g.id,
          title: g.title,
          slug: g.slug,
          platform: g.platform,
          category: g.category,
          language: g.language,
          region: g.region,
          url: g.url,
          imageUrl: g.imageUrl,
          bannerUrl: g.bannerUrl,
          description: g.description,
          rulesSummary: g.rulesSummary,
          memberCount: g.memberCount,
          customTags: g.customTags,
        },
      });
    }

    return NextResponse.json({ isDuplicate: false });
  } catch (error: any) {
    return NextResponse.json({ isDuplicate: false, error: error.message }, { status: 500 });
  }
}
