import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/src/lib/admin-auth';
import { clearRateLimits, getActiveRateLimitCount } from '@/src/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const auth = requireAdmin(req);
    if (!auth.authorized) {
      return auth.response!;
    }

    const beforeCount = getActiveRateLimitCount();
    const result = clearRateLimits();

    return NextResponse.json({
      success: true,
      message: `Successfully cleared all rate-limit counters (${result.cleared} keys purged).`,
      clearedKeys: result.cleared,
      beforeCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to clear rate limits' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  const activeCount = getActiveRateLimitCount();
  return NextResponse.json({
    activeRateLimitKeys: activeCount,
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
}
