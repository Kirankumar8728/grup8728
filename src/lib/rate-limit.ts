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
  return '127.0.0.1';
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
      },
    }
  );
}
