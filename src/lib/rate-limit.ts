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

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const clean = ip.trim();
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  if (clean.startsWith('172.')) {
    const parts = clean.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function getClientIp(req: NextRequest): string {
  // 1. Cloudflare True Client IP (highest priority on grouplinks.app)
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return cfIp.trim();
  }

  // 2. Hostinger / Nginx Real IP
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  // 3. X-Forwarded-For (extract first non-internal public client IP)
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ips = forwardedFor.split(',').map(ip => ip.trim()).filter(Boolean);
    if (ips.length > 0) {
      const publicIp = ips.find(ip => !isPrivateIp(ip));
      if (publicIp) return publicIp;
      return ips[0];
    }
  }

  // 4. Fallback to User-Agent + Accept-Language fingerprinting to avoid global 127.0.0.1 collision
  const ua = req.headers.get('user-agent') || 'unknown';
  const acceptLang = req.headers.get('accept-language') || 'en';
  let hash = 0;
  const combined = `${ua}|${acceptLang}`;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash) + combined.charCodeAt(i);
    hash |= 0;
  }
  return `fp-${Math.abs(hash)}`;
}

export interface RateLimitOptions {
  limit: number;      // Maximum allowed requests
  windowMs: number;   // Time window in milliseconds
  keyPrefix?: string; // Optional namespace prefix
  route?: string;     // Alias for keyPrefix
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
 * Synchronous in-memory rate limit check.
 */
export function checkRateLimit(
  req: NextRequest,
  options: RateLimitOptions
): RateLimitResult {
  const ip = getClientIp(req);
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
      remaining: options.limit - 1,
      resetTime: record.resetTime,
      retryAfterSeconds: 0,
    };
  }

  record.count += 1;
  const remaining = Math.max(0, options.limit - record.count);
  const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);

  if (record.count > options.limit) {
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

export function rateLimitResponse(retryAfterSeconds: number, message?: string, limit: number = 60): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: message || 'Too many requests. Please slow down and try again later.',
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'CDN-Cache-Control': 'no-store',
        'Surrogate-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfterSeconds),
      },
    }
  );
}
