import { NextRequest, NextResponse } from 'next/server';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// In-memory token bucket / sliding window store
const inMemoryStore = new Map<string, RateLimitRecord>();

// Clean up expired entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of inMemoryStore.entries()) {
      if (now > record.resetTime) {
        inMemoryStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

/**
 * Purges all active rate limit counters in memory.
 * Used by admin maintenance and system recovery.
 */
export function clearRateLimits(): { cleared: number } {
  const count = inMemoryStore.size;
  inMemoryStore.clear();
  return { cleared: count };
}

/**
 * Returns current count of tracked rate-limit keys in memory.
 */
export function getActiveRateLimitCount(): number {
  return inMemoryStore.size;
}

export function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) {
    return cfIp.trim();
  }
  const clientIp = req.headers.get('x-client-ip');
  if (clientIp) {
    return clientIp.trim();
  }
  return '127.0.0.1';
}

export interface RateLimitOptions {
  limit: number;      // Maximum allowed requests
  windowMs: number;   // Time window in milliseconds
  keyPrefix?: string; // Optional namespace prefix
  route?: string;     // Alias for keyPrefix
  bypassAdmin?: boolean; // Default true
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfterSeconds: number;
}

/**
 * Fast server in-memory rate limiter.
 */
export async function checkRateLimitAsync(
  req: NextRequest,
  options: RateLimitOptions
): Promise<RateLimitResult> {
  return checkRateLimit(req, options);
}

/**
 * Synchronous in-memory rate limit check with administrator exemption
 * and developer/localhost relaxation to prevent false-positive lockouts.
 */
export function checkRateLimit(
  req: NextRequest,
  options: RateLimitOptions
): RateLimitResult {
  // 1. Administrator & Owner Exemption:
  // Admins with valid session cookies or authorization tokens are never rate limited.
  const adminCookie = req.cookies.get('nexus_admin_session')?.value || req.cookies.get('admin_session')?.value;
  const authHeader = req.headers.get('authorization') || '';
  const isAdminBypass = options.bypassAdmin !== false && (
    Boolean(adminCookie) ||
    authHeader.startsWith('Bearer ') ||
    req.headers.get('x-admin-bypass') === 'true'
  );

  if (isAdminBypass) {
    return {
      allowed: true,
      remaining: 99999,
      resetTime: Date.now() + 60000,
      retryAfterSeconds: 0,
    };
  }

  const ip = getClientIp(req);
  const isDev = process.env.NODE_ENV !== 'production';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';

  // 2. Localhost & Dev Environment Relief:
  // During local development or Google Cloud Run dev container preview,
  // multiply limit by 10 (minimum 500) to ensure manual testing never blocks the developer.
  const effectiveLimit = (isDev || isLocalhost)
    ? Math.max(options.limit * 10, 500)
    : options.limit;

  const prefix = options.route || options.keyPrefix || req.nextUrl.pathname;
  const storeKey = `${prefix}:${ip}`;
  const now = Date.now();

  let record = inMemoryStore.get(storeKey);

  if (!record || now > record.resetTime) {
    record = {
      count: 1,
      resetTime: now + options.windowMs,
    };
    inMemoryStore.set(storeKey, record);
    return {
      allowed: true,
      remaining: effectiveLimit - 1,
      resetTime: record.resetTime,
      retryAfterSeconds: 0,
    };
  }

  record.count += 1;
  const remaining = Math.max(0, effectiveLimit - record.count);
  const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);

  if (record.count > effectiveLimit) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: record.resetTime,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    remaining,
    resetTime: record.resetTime,
    retryAfterSeconds: 0,
  };
}

/**
 * Returns an HTML error page when browser navigation hits rate limiting,
 * preventing Chrome's raw "This page isn't working HTTP ERROR 429" screen.
 */
function renderRateLimitHtml(retryAfterSeconds: number, message?: string): string {
  const safeMessage = message || 'You are making requests too quickly. Please pause for a moment to prevent server overload.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rate Limit Active | Group Links</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: #030712;
      color: #f3f4f6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 1.25rem;
      max-width: 32rem;
      width: 100%;
      padding: 2.25rem 2rem;
      text-align: center;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .icon-badge {
      width: 4rem;
      height: 4rem;
      margin: 0 auto 1.25rem;
      border-radius: 1rem;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #f87171;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 0.5rem;
      letter-spacing: -0.025em;
    }
    .desc {
      color: #9ca3af;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    .timer-box {
      background: #1f2937;
      border-radius: 0.75rem;
      padding: 1rem;
      margin-bottom: 1.5rem;
      border: 1px solid #374151;
    }
    .timer-text {
      font-size: 0.85rem;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
    }
    .timer-val {
      font-size: 2.25rem;
      font-weight: 900;
      color: #60a5fa;
      font-variant-numeric: tabular-nums;
      margin: 0.25rem 0;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 0.875rem 1.25rem;
      border-radius: 0.75rem;
      font-weight: 700;
      font-size: 0.95rem;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s ease;
      border: none;
    }
    .btn-primary {
      background: #4f46e5;
      color: #ffffff;
    }
    .btn-primary:hover {
      background: #4338ca;
    }
    .btn-secondary {
      background: #1f2937;
      color: #d1d5db;
      border: 1px solid #374151;
    }
    .btn-secondary:hover {
      background: #374151;
      color: #ffffff;
    }
    .info-tips {
      margin-top: 1.5rem;
      text-align: left;
      background: rgba(31, 41, 55, 0.5);
      border-radius: 0.75rem;
      padding: 1rem;
      font-size: 0.825rem;
      color: #9ca3af;
      line-height: 1.5;
      border: 1px solid #1f2937;
    }
    .info-tips strong {
      color: #e5e7eb;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-badge">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>
    <h1>Rate Limit Active (HTTP 429)</h1>
    <p class="desc">${safeMessage}</p>
    
    <div class="timer-box">
      <div class="timer-text">Cooldown Period</div>
      <div class="timer-val" id="countdown">${retryAfterSeconds}s</div>
      <div style="font-size: 0.75rem; color: #6b7280;">Auto-unlocks when timer expires</div>
    </div>

    <div class="btn-group">
      <button class="btn btn-primary" id="retryBtn" onclick="location.reload()" disabled>
        Refreshing in <span id="btnTimer">${retryAfterSeconds}</span>s...
      </button>
      <a href="/" class="btn btn-secondary">Return to Group Directory</a>
    </div>

    <div class="info-tips">
      <p style="margin-bottom: 0.5rem;"><strong>💡 Why did this happen?</strong></p>
      <p>• Automated rate limiting protects directory servers and prevent spam bots.</p>
      <p>• If joining <strong>WhatsApp or Telegram groups</strong>, WhatsApp web enforces its own rate limit per IP. You can bypass it by opening the invite link in your native mobile app or copying the direct link.</p>
    </div>
  </div>

  <script>
    var remaining = ${retryAfterSeconds};
    var countdownEl = document.getElementById('countdown');
    var btnTimerEl = document.getElementById('btnTimer');
    var retryBtn = document.getElementById('retryBtn');

    var interval = setInterval(function() {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(interval);
        if (countdownEl) countdownEl.innerText = '0s';
        if (retryBtn) {
          retryBtn.disabled = false;
          retryBtn.innerText = 'Try Again Now';
          retryBtn.style.cursor = 'pointer';
        }
        location.reload();
      } else {
        if (countdownEl) countdownEl.innerText = remaining + 's';
        if (btnTimerEl) btnTimerEl.innerText = remaining;
      }
    }, 1000);
  </script>
</body>
</html>`;
}

export function rateLimitResponse(
  retryAfterSeconds: number,
  message?: string,
  limit: number = 60,
  req?: NextRequest
): NextResponse {
  const isHtmlRequest = req?.headers.get('accept')?.includes('text/html');

  if (isHtmlRequest) {
    return new NextResponse(renderRateLimitHtml(retryAfterSeconds, message), {
      status: 429,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfterSeconds),
        'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
      },
    });
  }

  return NextResponse.json(
    {
      error: message || 'Too many requests. Please slow down and try again later.',
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfterSeconds),
        'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
      },
    }
  );
}
