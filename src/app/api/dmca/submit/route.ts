import { NextRequest, NextResponse } from 'next/server';
import { REALTIME_NO_CACHE_HEADERS } from '@/src/lib/cache-control';
import { sanitizeInput } from '@/src/lib/security';
import { sendGroupFeedbackEmail } from '@/src/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const name = sanitizeInput(body.name || '').trim();
    const email = sanitizeInput(body.email || '').trim();
    const groupUrl = sanitizeInput(body.groupUrl || '').trim();
    const imageUrl = sanitizeInput(body.imageUrl || '').trim();
    const description = sanitizeInput(body.description || '').trim();

    if (!name || !email || !description) {
      return NextResponse.json(
        { success: false, error: 'Name, email, and description are required.' },
        { status: 400, headers: REALTIME_NO_CACHE_HEADERS }
      );
    }

    const emailDetails = `
Claimant Name: ${name}
Claimant Email: ${email}
Listing URL: ${groupUrl || 'Not provided'}
Infringing Image URL: ${imageUrl || 'Not provided'}

Declaration & Details:
${description}
    `.trim();

    // Dispatch notification to administrator inbox via multi-provider email system
    await sendGroupFeedbackEmail({
      feedbackType: 'other',
      message: emailDetails,
      userEmail: email,
      groupTitle: groupUrl ? `[DMCA] ${groupUrl}` : 'DMCA Takedown Notice',
    });

    console.log('[DMCA API] DMCA Notice dispatched successfully:', { name, email, groupUrl });

    return NextResponse.json({
      success: true,
      message: 'DMCA removal notice dispatched successfully to Copyright Agent.',
    }, { status: 200, headers: REALTIME_NO_CACHE_HEADERS });
  } catch (err: any) {
    console.error('[DMCA API Error]:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to submit DMCA request.' },
      { status: 500, headers: REALTIME_NO_CACHE_HEADERS }
    );
  }
}
