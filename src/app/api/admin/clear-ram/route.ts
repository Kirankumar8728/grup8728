import { NextRequest, NextResponse } from 'next/server';
import { clearGroupsFromRam } from '@/src/lib/groups-store';
import { requireAdmin } from '@/src/lib/admin-auth';
import { checkRateLimit, rateLimitResponse, clearRateLimits } from '@/src/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // 1. Enforce admin authentication
    const auth = requireAdmin(req);
    if (!auth.authorized) {
      return auth.response!;
    }

    // 2. Rate limit administrative RAM purge
    const rateCheck = checkRateLimit(req, {
      limit: 5,
      windowMs: 60 * 1000,
      route: 'admin_clear_ram',
    });
    if (!rateCheck.allowed) {
      return rateLimitResponse(rateCheck.retryAfterSeconds, 'Too many RAM clear requests. Please wait.');
    }

    // 3. CSRF origin check
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    if (origin && host) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.host !== host) {
          return NextResponse.json(
            { success: false, error: 'Cross-origin administrative request rejected.' },
            { status: 403 }
          );
        }
      } catch {}
    }

    const result = clearGroupsFromRam();
    const rateLimitClear = clearRateLimits();

    return NextResponse.json({
      success: true,
      message: `Successfully purged ${result.freedCount} groups from RAM memory and reset ${rateLimitClear.cleared} rate-limit keys.`,
      freedCount: result.freedCount,
      clearedRateLimits: rateLimitClear.cleared,
      memory: result.memory,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to clear RAM' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { success: false, error: 'Method Not Allowed. State-changing administrative operations require POST.' },
    { status: 405, headers: { Allow: 'POST' } }
  );
}

