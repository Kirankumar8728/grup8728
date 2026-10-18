import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/src/lib/admin-auth';
import { getContentSettings, updateContentSettings } from '@/src/lib/content-settings';
import { REALTIME_NO_CACHE_HEADERS } from '@/src/lib/cache-control';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  try {
    const settings = getContentSettings();
    return NextResponse.json({
      success: true,
      settings,
    }, { headers: REALTIME_NO_CACHE_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500, headers: REALTIME_NO_CACHE_HEADERS }
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  try {
    const body = await req.json();
    const hideAdultContent = typeof body.hideAdultContent === 'boolean'
      ? body.hideAdultContent
      : undefined;

    if (hideAdultContent === undefined) {
      return NextResponse.json(
        { success: false, error: 'hideAdultContent boolean flag is required' },
        { status: 400, headers: REALTIME_NO_CACHE_HEADERS }
      );
    }

    const updated = updateContentSettings({
      hideAdultContent,
      updatedBy: 'admin',
    });

    try {
      revalidatePath('/');
      revalidatePath('/adult-groups');
      revalidatePath('/categories');
      revalidatePath('/categories/adult-18');
      revalidatePath('/tags');
      revalidatePath('/sitemap.xml');
      revalidatePath('/sitemap-categories.xml');
      revalidatePath('/sitemap-groups.xml');
    } catch (revalidateErr) {
      console.warn('[ADMIN CONTENT SETTINGS] Revalidation notice:', revalidateErr);
    }

    const message = updated.hideAdultContent
      ? 'AdSense Safe Mode ACTIVE: Adult groups, adult keywords, and the Adult / 18+ category are now completely hidden site-wide. Visiting /adult-groups will display Technology & Programming groups.'
      : 'Adult content visibility ENABLED: Adult 18+ groups and category are now visible behind age confirmation.';

    return NextResponse.json({
      success: true,
      settings: updated,
      message,
    }, { headers: REALTIME_NO_CACHE_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500, headers: REALTIME_NO_CACHE_HEADERS }
    );
  }
}
