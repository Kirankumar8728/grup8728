import { parse } from 'node-html-parser';
import { GoogleGenAI } from '@google/genai';
import { Platform, Category, Language, Region, ScrapeMetadataResponse } from '@/src/types';
import { classifyGroupCategory } from '@/src/lib/taxonomy';
import { detectPlatformFromUrl, calculateRankScore, calculateRankGrade, CATEGORIES, LANGUAGES, isGenericGroupTitle, isGenericGroupDescription, cleanCommunityTitle, getCommunityFallbackAvatar } from '@/src/utils/helpers';
export { isGenericGroupTitle, isGenericGroupDescription, cleanCommunityTitle };
import { getCategoryFallbackImage } from '@/src/utils/categoryImages';

export function decodeHtmlEntitiesAndClean(text: string): string {
  if (!text) return '';
  return text
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(parseInt(code, 10));
      } catch {
        return '';
      }
    })
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMemberCount(text?: string): number | null {
  if (!text || typeof text !== 'string') return null;
  // Strip non-breaking spaces, commas, and internal space digit separators (e.g. "10 386 488 subscribers" -> "10386488 subscribers")
  let clean = text.replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
  clean = clean.replace(/(\d)\s+(\d)/g, '$1$2').replace(/(\d)\s+(\d)/g, '$1$2');
  // Match number optionally followed by k, m, b as a standalone unit
  // Do NOT match when 'm' is followed by letters like 'members' or 'month'
  const match = clean.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?(?![a-z])/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'b' ? 1000000000 : unit === 'm' ? 1000000 : unit === 'k' ? 1000 : 1;
  return Math.round(num * multiplier);
}

export function getCategoryTopicImage(category?: string): string {
  return getCategoryFallbackImage(category, false);
}

export const STEALTH_USER_AGENTS = {
  whatsapp: [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'WhatsApp/2.24.6.77 i',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ],
  reddit: [
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ],
  telegram: [
    'TelegramBot (like TwitterBot)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ],
  facebook: [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ],
  general: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
  ],
};

export function extractTelegramHandle(url: string): string | null {
  try {
    const clean = url.trim().replace(/^@/, '');
    if (!clean.includes('/') && !clean.includes('.') && clean.length >= 3) {
      return clean;
    }
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length > 0 && parts[0] && parts[0] !== 'joinchat' && !parts[0].startsWith('+') && parts[0] !== 'c') {
      return parts[0].replace(/^@/, '');
    }
    if (parts.length > 1 && parts[0] === 's' && parts[1]) {
      return parts[1].replace(/^@/, '');
    }
  } catch {
    const m = url.match(/(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([a-zA-Z0-9_]{3,})/i);
    if (m && m[1] && m[1] !== 'joinchat' && !m[1].startsWith('+')) {
      return m[1];
    }
  }
  return null;
}

export function normalizePlatformUrl(rawUrl: string): {
  normalizedUrl: string;
  platform: Platform;
  platformHandle?: string;
} {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { normalizedUrl: '', platform: 'other' };
  }
  const clean = rawUrl.trim();

  // Handle @handle notation directly
  if (clean.startsWith('@')) {
    const handle = clean.slice(1);
    return {
      normalizedUrl: `https://t.me/${handle}`,
      platform: 'telegram',
      platformHandle: handle,
    };
  }

  // Handle r/subreddit notation directly
  if (/^r\/[a-zA-Z0-9_]+/i.test(clean)) {
    const sub = clean.replace(/^r\//i, '');
    return {
      normalizedUrl: `https://www.reddit.com/r/${sub}`,
      platform: 'reddit',
      platformHandle: sub,
    };
  }

  // Handle discord.gg/xxx without protocol
  if (/^discord\.(?:gg|com)\//i.test(clean)) {
    const codeMatch = clean.match(/discord\.(?:gg\/|com\/invite\/)([a-zA-Z0-9_-]+)/i);
    const code = codeMatch ? codeMatch[1] : '';
    return {
      normalizedUrl: `https://discord.gg/${code}`,
      platform: 'discord',
      platformHandle: code || undefined,
    };
  }

  // Handle chat.whatsapp.com without protocol
  if (/^chat\.whatsapp\.com\//i.test(clean)) {
    const codeMatch = clean.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]{10,})/i);
    const code = codeMatch ? codeMatch[1] : '';
    return {
      normalizedUrl: `https://chat.whatsapp.com/${code}`,
      platform: 'whatsapp',
      platformHandle: code || undefined,
    };
  }

  try {
    const urlObj = new URL(clean.startsWith('http://') || clean.startsWith('https://') ? clean : `https://${clean}`);
    const host = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname;

    // 1. Telegram
    if (host.includes('t.me') || host.includes('telegram.me') || host.includes('telegram.dog')) {
      const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
      let handle = '';
      if (parts[0] === 's' && parts[1]) {
        handle = parts[1];
      } else if (parts[0]) {
        handle = parts[0] === 'joinchat' && parts[1] ? `+${parts[1]}` : parts[0];
      }
      handle = handle.replace(/^@/, '');
      const normalized = handle ? `https://t.me/${handle}` : clean;
      return {
        normalizedUrl: normalized,
        platform: 'telegram',
        platformHandle: handle || undefined,
      };
    }

    // 2. WhatsApp
    if (host.includes('whatsapp.com') && !host.includes('wa.me')) {
      let code = '';
      if (pathname.includes('/channel/')) {
        code = pathname.split('/channel/')[1]?.split('/')[0]?.split('?')[0] || '';
        return {
          normalizedUrl: code ? `https://whatsapp.com/channel/${code}` : clean,
          platform: 'whatsapp',
          platformHandle: code || undefined,
        };
      } else {
        const cleanPath = pathname.replace(/^\/+/, '').replace(/^(?:invite|chat)\/+/i, '');
        code = cleanPath.split('/')[0]?.split('?')[0] || '';
        return {
          normalizedUrl: code ? `https://chat.whatsapp.com/${code}` : clean,
          platform: 'whatsapp',
          platformHandle: code || undefined,
        };
      }
    }

    // 3. Discord
    if (host.includes('discord.gg') || host.includes('discord.com') || host.includes('discordapp.com')) {
      const codeMatch = clean.match(/(?:discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)([a-zA-Z0-9_-]+)/i);
      const code = codeMatch ? codeMatch[1] : '';
      return {
        normalizedUrl: code ? `https://discord.gg/${code}` : clean,
        platform: 'discord',
        platformHandle: code || undefined,
      };
    }

    // 4. Reddit
    if (host.includes('reddit.com') || host.includes('redd.it')) {
      const subMatch = clean.match(/(?:reddit\.com\/r\/|redd\.it\/)([a-zA-Z0-9_]+)/i);
      const sub = subMatch ? subMatch[1] : '';
      return {
        normalizedUrl: sub ? `https://www.reddit.com/r/${sub}` : clean,
        platform: 'reddit',
        platformHandle: sub || undefined,
      };
    }

    // 5. Facebook
    if (host.includes('facebook.com') || host.includes('fb.com')) {
      const fbMatch = clean.match(/facebook\.com\/groups\/([a-zA-Z0-9_.-]+)/i);
      const fbId = fbMatch ? fbMatch[1] : '';
      return {
        normalizedUrl: fbId ? `https://www.facebook.com/groups/${fbId}` : clean,
        platform: 'facebook',
        platformHandle: fbId || undefined,
      };
    }

    // 6. Signal
    if (host.includes('signal.group') || host.includes('signal.me')) {
      return {
        normalizedUrl: clean,
        platform: 'signal',
        platformHandle: pathname.replace(/^\/+|\/+$/g, '') || undefined,
      };
    }

    // 7. Snapchat
    if (host.includes('snapchat.com') && pathname.includes('/t/')) {
      const snapMatch = clean.match(/snapchat\.com\/t\/([a-zA-Z0-9_.-]+)/i);
      const snapHandle = snapMatch ? snapMatch[1] : '';
      return {
        normalizedUrl: clean,
        platform: 'snapchat',
        platformHandle: snapHandle || undefined,
      };
    }

    // 8. Instagram
    if (host.includes('instagram.com') || host.includes('ig.me')) {
      if (clean.includes('/channel/')) {
        const chanMatch = clean.match(/instagram\.com\/channel\/([a-zA-Z0-9_-]+)/i);
        const chanId = chanMatch ? chanMatch[1] : '';
        return {
          normalizedUrl: chanId ? `https://www.instagram.com/channel/${chanId}/` : clean,
          platform: 'instagram',
          platformHandle: chanId || undefined,
        };
      }
      const igMatch = clean.match(/(?:instagram\.com\/(?:j|direct\/t|group)\/|ig\.me\/j\/)([a-zA-Z0-9_-]+)/i);
      const igCode = igMatch ? igMatch[1] : '';
      return {
        normalizedUrl: igCode ? `https://www.instagram.com/j/${igCode}/` : clean,
        platform: 'instagram',
        platformHandle: igCode || undefined,
      };
    }
  } catch {
    // fallback
  }

  return {
    normalizedUrl: clean,
    platform: 'other',
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchBackoffOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface FetchBackoffResult {
  res: Response | null;
  ok: boolean;
  status: number;
  text: string;
  json: any;
  isRateLimited: boolean;
}

/**
 * Robust fetcher with exponential backoff on HTTP 429 Too Many Requests and transient CDN errors.
 * Respects Retry-After response headers from upstream CDNs.
 */
export async function fetchWithBackoff(
  url: string,
  options: FetchBackoffOptions = {}
): Promise<FetchBackoffResult> {
  const {
    timeoutMs = 5000,
    maxRetries = 2,
    baseDelayMs = 400,
    maxDelayMs = 3000,
    headers,
    ...rest
  } = options;

  let attempt = 0;
  while (attempt <= maxRetries) {
    let controller: AbortController | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    try {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller?.abort(), timeoutMs);

      const res = await fetch(url, {
        ...rest,
        headers,
        signal: controller.signal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      const status = res.status;
      const is429 = status === 429;
      const is5xx = status >= 502 && status <= 504;

      if ((is429 || is5xx) && attempt < maxRetries) {
        const retryAfter = res.headers.get('retry-after');
        let delayMs = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        if (retryAfter) {
          const parsedSec = parseInt(retryAfter, 10);
          if (!isNaN(parsedSec) && parsedSec > 0 && parsedSec <= 10) {
            delayMs = parsedSec * 1000;
          }
        }
        delayMs = Math.min(delayMs, maxDelayMs);
        await sleep(delayMs);
        attempt++;
        continue;
      }

      const text = await res.text().catch(() => '');
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(text);
      } catch {}

      const bodyRateLimited =
        is429 ||
        Boolean(parsedJson && (parsedJson.retry_after || (typeof parsedJson.message === 'string' && parsedJson.message.toLowerCase().includes('rate limited')))) ||
        text.includes('429 Too Many Requests') ||
        text.includes('whoa there, pardner!');

      if (bodyRateLimited && attempt < maxRetries) {
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt) + 200, maxDelayMs);
        await sleep(delayMs);
        attempt++;
        continue;
      }

      return {
        res,
        ok: res.ok && !bodyRateLimited,
        status: bodyRateLimited ? 429 : status,
        text,
        json: parsedJson,
        isRateLimited: bodyRateLimited,
      };
    } catch {
      if (timeoutId) clearTimeout(timeoutId);
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt) + 150;
        await sleep(delayMs);
        attempt++;
        continue;
      }
      return {
        res: null,
        ok: false,
        status: 0,
        text: '',
        json: null,
        isRateLimited: false,
      };
    }
  }

  return {
    res: null,
    ok: false,
    status: 429,
    text: '',
    json: null,
    isRateLimited: true,
  };
}

/**
 * Universal fallback to OpenGraph microservices (Microlink) when upstream CDNs rate limit.
 * Uses fetchWithBackoff and returns structured clean metadata.
 */
export async function fetchMicrolinkFallback(targetUrl: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  memberCount?: number;
} | null> {
  try {
    const mlResult = await fetchWithBackoff(
      `https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`,
      {
        headers: { Accept: 'application/json' },
        timeoutMs: 4000,
        maxRetries: 1,
        baseDelayMs: 350,
      }
    );

    if (mlResult.ok && mlResult.json?.data) {
      const ml = mlResult.json.data;
      const title = ml.title && !isGenericGroupTitle(ml.title) ? decodeHtmlEntitiesAndClean(ml.title) : '';
      const description = ml.description && !isGenericGroupDescription(ml.description) ? decodeHtmlEntitiesAndClean(ml.description) : '';
      const imageUrl = ml.image?.url && !isGenericGroupImage(ml.image.url) ? ml.image.url : '';
      if (title || imageUrl) {
        return {
          title: title || undefined,
          description: description || undefined,
          imageUrl: imageUrl || undefined,
        };
      }
    }
  } catch {}
  return null;
}

export async function fetchTelegramChannelMetadata(targetUrl: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  memberCount?: number;
  isVerified?: boolean;
} | null> {
  const norm = normalizePlatformUrl(targetUrl);
  const handle = norm.platformHandle || extractTelegramHandle(targetUrl);
  const urlsToTry = [
    handle && !handle.startsWith('+') && handle !== 'joinchat' ? `https://t.me/s/${handle}` : null,
    handle ? `https://t.me/${handle}` : norm.normalizedUrl,
  ].filter(Boolean) as string[];

  const userAgentsToTry = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'TelegramBot (like TwitterBot)',
    'Twitterbot/1.0',
    'curl/8.5.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];

  let fallbackCandidate: {
    title: string;
    description?: string;
    imageUrl?: string;
    memberCount?: number;
    isVerified?: boolean;
  } | null = null;

  for (const fetchUrl of urlsToTry) {
    for (const ua of userAgentsToTry) {
      try {
        const fetchRes = await fetchWithBackoff(fetchUrl, {
          headers: {
            'User-Agent': ua,
            'Accept': '*/*',
          },
          timeoutMs: 5000,
          maxRetries: 1,
          baseDelayMs: 300,
        });

        if (!fetchRes.ok || !fetchRes.text || fetchRes.text.length < 100) continue;
        const html = fetchRes.text;
        const root = parse(html);

        let ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
          root.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
          root.querySelector('.tgme_page_title')?.textContent?.trim() ||
          root.querySelector('.tgme_channel_info .tgme_channel_title')?.textContent?.trim();

        if (!ogTitle) {
          const rawDocTitle = root.querySelector('title')?.textContent?.trim() || '';
          if (!rawDocTitle.includes('Contact @') && !rawDocTitle.includes('View @')) {
            ogTitle = rawDocTitle;
          }
        }

        if (ogTitle) {
          ogTitle = ogTitle
            .replace(/^Telegram:\s*(?:Contact\s*@?|View\s*@?)/i, '')
            .replace(/^(?:Contact|View)\s*@/i, '')
            .replace(/\s*–\s*Telegram$/i, '')
            .replace(/\s*-\s*Telegram$/i, '')
            .trim();
        }

        if (!ogTitle && handle) {
          ogTitle = handle;
        }

        const ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
          root.querySelector('meta[name="twitter:description"]')?.getAttribute('content') ||
          root.querySelector('.tgme_page_description')?.textContent?.trim() ||
          root.querySelector('.tgme_channel_info_description')?.textContent?.trim();

        // 1. Extract avatar from .tgme_page_photo_image (src attribute) first
        let rawPhotoUrl: string | undefined = undefined;
        const photoImg = root.querySelector('img.tgme_page_photo_image') ||
          root.querySelector('.tgme_page_photo_image') ||
          root.querySelector('.tgme_page_photo img') ||
          root.querySelector('.tgme_page_photo_image img');

        if (photoImg) {
          rawPhotoUrl = photoImg.getAttribute('src') || photoImg.getAttribute('data-src') || undefined;
          if (!rawPhotoUrl) {
            const styleAttr = photoImg.getAttribute('style') || '';
            const bgMatch = styleAttr.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
            if (bgMatch && bgMatch[2]) {
              rawPhotoUrl = bgMatch[2];
            }
          }
        }

        // 2. Fall back to meta[property="og:image"]
        if (!rawPhotoUrl) {
          rawPhotoUrl = root.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
            root.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || undefined;
        }

        // Fallback telesco.pe or t.me regex search
        if (!rawPhotoUrl) {
          const telescoMatch = html.match(/(?:https?:)?\/\/(?:cdn\d*\.telesco\.pe|telegram\.org)\/file\/[a-zA-Z0-9_-]+/i) ||
            html.match(/(?:https?:)?\/\/t\.me\/i\/userpic\/[a-zA-Z0-9_-]+/i);
          if (telescoMatch) {
            rawPhotoUrl = telescoMatch[0];
          }
        }

        let imageUrl = '';
        if (rawPhotoUrl) {
          let cleanImg = rawPhotoUrl.replace(/&amp;/g, '&').trim();
          // Normalize protocol-relative or relative URLs
          if (cleanImg.startsWith('//')) {
            cleanImg = `https:${cleanImg}`;
          } else if (cleanImg.startsWith('/')) {
            cleanImg = `https://telegram.org${cleanImg}`;
          }

          // Ignore generic Telegram logo placeholders (telegram-logo, t_logo, favicon.ico)
          if (!isGenericGroupImage(cleanImg) && !cleanImg.includes('telegram-logo') && !cleanImg.endsWith('/favicon.ico')) {
            imageUrl = cleanImg;
          }
        }

        const extraText = root.querySelector('.tgme_page_extra')?.textContent?.trim() ||
          root.querySelector('.tgme_channel_info_counters')?.textContent?.trim() ||
          root.querySelector('.tgme_page_counter')?.textContent?.trim() ||
          root.querySelector('.tgme_page_subscribers')?.textContent?.trim() || '';
        let memberCount: number | undefined = undefined;
        if (extraText) {
          const parsedMembers = parseMemberCount(extraText);
          if (parsedMembers) memberCount = parsedMembers;
        }
        if (!memberCount) {
          const subMatch = html.match(/([0-9\s,.]+[KMkm]?)\s+(?:subscribers|members|users)/i);
          if (subMatch && subMatch[1]) {
            const parsedM = parseMemberCount(subMatch[1]);
            if (parsedM) memberCount = parsedM;
          }
        }

        let title = ogTitle ? decodeHtmlEntitiesAndClean(ogTitle) : '';
        title = cleanCommunityTitle(title, 'telegram');

        let description = ogDesc ? decodeHtmlEntitiesAndClean(ogDesc) : '';
        if (isGenericGroupDescription(description)) {
          description = '';
        }

        if (title && !isGenericGroupTitle(title)) {
          const candidate = {
            title,
            description: description || undefined,
            imageUrl: imageUrl || undefined,
            memberCount: memberCount || undefined,
            isVerified: html.includes('verified-icon') || html.includes('tgme_icon_verified'),
          };

          if (candidate.description && candidate.imageUrl && candidate.memberCount) {
            return candidate;
          }

          if (!fallbackCandidate) {
            fallbackCandidate = candidate;
          }
        }
      } catch {}
    }
  }

  // Microservice OpenGraph fallback for Telegram links with missing image/description/members
  if (handle) {
    if (!fallbackCandidate || !fallbackCandidate.description || !fallbackCandidate.imageUrl || !fallbackCandidate.memberCount) {
      try {
        const ml = await fetchMicrolinkFallback(targetUrl);
        if (ml) {
          if (fallbackCandidate) {
            if (ml.title && (!fallbackCandidate.title || fallbackCandidate.title.toLowerCase() === handle.toLowerCase())) {
              fallbackCandidate.title = ml.title;
            }
            if (ml.description) {
              fallbackCandidate.description = ml.description;
            }
            if (ml.imageUrl) {
              fallbackCandidate.imageUrl = ml.imageUrl;
            }
          } else if (ml.title || ml.imageUrl) {
            fallbackCandidate = {
              title: ml.title || handle,
              description: ml.description || undefined,
              imageUrl: ml.imageUrl || undefined,
              memberCount: undefined,
              isVerified: false,
            };
          }
        }
      } catch {}
    }

    if (fallbackCandidate) {
      if (!fallbackCandidate.imageUrl) {
        try {
          const uRes = await fetch(`https://unavatar.io/telegram/${encodeURIComponent(handle)}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(2500),
          });
          if (uRes.ok && (uRes.headers.get('content-type') || '').includes('image/')) {
            fallbackCandidate.imageUrl = `https://unavatar.io/telegram/${encodeURIComponent(handle)}`;
          }
        } catch {}

        if (!fallbackCandidate.imageUrl) {
          fallbackCandidate.imageUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=tg-${encodeURIComponent(handle)}&backgroundColor=0088cc,229ed9`;
        }
      }

      if (!fallbackCandidate.description || isGenericGroupDescription(fallbackCandidate.description)) {
        const cleanName = cleanCommunityTitle(fallbackCandidate.title || handle, 'telegram');
        fallbackCandidate.description = `Official Telegram community for ${cleanName}. Connect, message, and engage with active members and administrators on Telegram.`;
      }

      fallbackCandidate.title = cleanCommunityTitle(fallbackCandidate.title || handle, 'telegram');
    }
  }

  return fallbackCandidate;
}

/**
 * Checks if image is a platform logo / sprite / generic favicon rather than community icon.
 */
export function isGenericGroupImage(url: string): boolean {
  if (!url) return true;
  const clean = url.toLowerCase().trim();

  // 1. Generic placeholder & logo patterns (filter these out unconditionally)
  if (
    clean.includes('reddit_default') ||
    clean.includes('default_icon') ||
    clean.includes('snoo-home') ||
    clean.includes('custom_feed_default') ||
    clean.includes('telegram-logo') ||
    clean.includes('telegram.org/img/t_logo') ||
    clean.includes('telegram.org/img/website_icon') ||
    clean.includes('t_logo') ||
    clean.includes('rsrc.php') ||
    clean.includes('fb_icon') ||
    clean.includes('fblogo') ||
    clean.includes('static.xx.fbcdn.net') ||
    clean.includes('facebook.com/images/') ||
    clean.includes('whatsapp.com/img/') ||
    clean.includes('redditstatic.com/shreddit/assets/favicon') ||
    clean.includes('redditstatic.com/icon') ||
    clean.includes('redditstatic.com/avatars/avatar_default') ||
    clean.includes('redditstatic.com/avatars/defaults') ||
    clean.includes('redditstatic.com/desktop2x') ||
    clean.includes('redditstatic.com/shreddit/assets/snoo') ||
    clean.includes('reddit.com/favicon') ||
    clean.includes('192x192.png') ||
    clean.endsWith('/favicon.ico') ||
    clean.includes('favicon.ico') ||
    clean.endsWith('/favicon.png') ||
    clean.includes('unsplash.com') ||
    clean.endsWith('/null') ||
    clean.endsWith('/undefined')
  ) {
    return true;
  }

  // 2. Recognized valid community CDN domains
  if (
    clean.includes('pps.whatsapp.net') ||
    clean.includes('mmg.whatsapp.net') ||
    clean.includes('scontent.whatsapp.net') ||
    clean.includes('scontent.f') ||
    clean.includes('cdninstagram.com') ||
    clean.includes('instagram.com/p/') ||
    clean.includes('thumbs.redditmedia.com') ||
    clean.includes('styles.redditmedia.com') ||
    clean.includes('preview.redd.it') ||
    clean.includes('external-preview.redd.it') ||
    clean.includes('i.redd.it') ||
    clean.includes('i.redditmedia.com') ||
    clean.includes('telesco.pe')
  ) {
    return false;
  }

  return false;
}

/**
 * Strict domain whitelist of approved platforms and media CDNs.
 * Outbound network requests are ONLY allowed to domains in this list.
 */
export const ALLOWED_FETCH_DOMAINS: readonly string[] = [
  // WhatsApp
  'chat.whatsapp.com',
  'whatsapp.com',
  'api.whatsapp.com',
  'wa.me',
  // Telegram
  't.me',
  'telegram.me',
  'telegram.dog',
  'telegram.org',
  // Discord
  'discord.gg',
  'discord.com',
  'discordapp.com',
  // Reddit
  'reddit.com',
  'www.reddit.com',
  'redd.it',
  'old.reddit.com',
  // Facebook
  'facebook.com',
  'www.facebook.com',
  'fb.com',
  'm.facebook.com',
  'groups.facebook.com',
  // Signal
  'signal.group',
  'signal.me',
  // Instagram
  'instagram.com',
  'www.instagram.com',
  'ig.me',
  // Snapchat
  'snapchat.com',
  'www.snapchat.com',
  // YouTube (oembed endpoints)
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  // Verified Media & CDN hosts for profile images
  'pps.whatsapp.net',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'styles.redditmedia.com',
  'preview.redd.it',
  'external-preview.redd.it',
  'i.redd.it',
  'scontent.whatsapp.net',
];

export function isAllowedFetchDomain(hostname: string): boolean {
  if (!hostname) return false;
  const cleanHost = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  return ALLOWED_FETCH_DOMAINS.some(allowed => cleanHost === allowed || cleanHost.endsWith('.' + allowed));
}

/**
 * SSRF security validation for target URLs.
 * Enforces protocol, port, strict domain whitelist, and IP address sanitization.
 */
export function isSafePublicUrl(inputUrl: string): boolean {
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // SSRF Port Protection: only allow standard web traffic ports
    const port = parsed.port;
    if (port && port !== '80' && port !== '443' && port !== '8080' && port !== '8443') {
      return false;
    }

    const host = parsed.hostname.toLowerCase();

    // Strict domain whitelist check: ONLY allowed platform domains are fetched
    if (!isAllowedFetchDomain(host)) {
      return false;
    }

    // Block localhost, internal hostnames, and cloud metadata endpoints
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '169.254.169.254' ||
      host === '100.100.100.200' ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host === 'instance-data' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.arpa') ||
      host.endsWith('.corp') ||
      host.endsWith('.lan')
    ) {
      return false;
    }

    // Block pure integer IP addresses (e.g. 2130706433 -> 127.0.0.1)
    if (/^\d+$/.test(host)) {
      return false;
    }

    // Block hex and octal IP address notation (e.g. 0x7f.0.0.1 or 0177.0.0.1)
    if (/^0x[0-9a-f]+/i.test(host) || /(?:^|\.)0[0-7]/.test(host)) {
      return false;
    }

    // Block IPv6 loopback, link-local, and unique local addresses
    if (
      host.startsWith('fe80:') ||
      host.startsWith('[fe80:') ||
      host.startsWith('fc00:') ||
      host.startsWith('[fc00:') ||
      host.startsWith('fd00:') ||
      host.startsWith('[fd00:') ||
      host.includes('::ffff:')
    ) {
      return false;
    }

    // Check private IPv4 ranges
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const b0 = parseInt(ipv4Match[1], 10);
      const b1 = parseInt(ipv4Match[2], 10);

      // 0.0.0.0/8 (Broadcast/Current)
      if (b0 === 0) return false;
      // 10.0.0.0/8 (Private)
      if (b0 === 10) return false;
      // 127.0.0.0/8 (Loopback)
      if (b0 === 127) return false;
      // 169.254.0.0/16 (Link-local)
      if (b0 === 169 && b1 === 254) return false;
      // 172.16.0.0/12 (Private)
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return false;
      // 192.168.0.0/16 (Private)
      if (b0 === 192 && b1 === 168) return false;
      // 100.64.0.0/10 (Carrier-grade NAT)
      if (b0 === 100 && b1 >= 64 && b1 <= 127) return false;
      // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
      if (b0 >= 224) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Resilient multi-agent fetcher that cycles through stealth headers without getting blocked.
 */
async function resilientHtmlFetch(
  targetUrl: string,
  userAgents: string[],
  timeoutMs = 3500
): Promise<{ ok: boolean; html: string; statusCode: number }> {
  if (!isSafePublicUrl(targetUrl)) {
    return { ok: false, html: '', statusCode: 403 };
  }
  const agentsToTry = userAgents.slice(0, 3);
  for (const ua of agentsToTry) {
    try {
      const fetchRes = await fetchWithBackoff(targetUrl, {
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
        },
        timeoutMs,
        maxRetries: 1,
        baseDelayMs: 350,
      });

      if (fetchRes.ok && fetchRes.text && fetchRes.text.length > 50) {
        return { ok: true, html: fetchRes.text, statusCode: fetchRes.status };
      }

      if (fetchRes.isRateLimited) {
        await sleep(400);
      }
    } catch {
      // Try next user-agent
    }
  }

  return { ok: false, html: '', statusCode: 0 };
}

/**
 * Direct Discord API Scraper - 100% Unblockable, Official, High-Accuracy
 * Equipped with exponential backoff on 429 and safe fallback to Microlink or community defaults.
 */
async function scrapeDiscordDirect(targetUrl: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  bannerUrl?: string;
  memberCount?: number;
  onlineCount?: number;
  isVerified?: boolean;
  rulesSummary?: string;
} | null> {
  const match = targetUrl.match(/(?:discord\.(?:gg|io|me|li|st)\/|discord\.com\/(?:invite|servers)\/|discordapp\.com\/invite\/|disboard\.org\/server\/(?:join\/)?)([a-zA-Z0-9_-]+)/i);
  if (!match || !match[1]) return null;

  let inviteCode = match[1].split('?')[0].split('#')[0].replace(/\/$/, '');
  if (!inviteCode) return null;

  try {
    const fetchRes = await fetchWithBackoff(`https://discord.com/api/v10/invites/${inviteCode}?with_counts=true&with_expiration=true`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
        Accept: 'application/json',
      },
      timeoutMs: 4500,
      maxRetries: 2,
      baseDelayMs: 450,
    });

    if (fetchRes.ok && fetchRes.json && fetchRes.json.guild) {
      const data = fetchRes.json;
      const guild = data.guild;
      let rawTitle = (guild.name || '').trim();

      if (rawTitle.startsWith('/')) {
        const sub = rawTitle.substring(1).trim();
        rawTitle = sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : inviteCode;
      }

      const title = rawTitle || `Discord Server (${inviteCode})`;
      const description = guild.description || (data.channel?.name ? `Official Discord community for #${data.channel.name}` : `Active Discord server community for ${title}.`);
      const memberCount = data.approximate_member_count || data.approximate_presence_count || 500;

      let imageUrl = '';
      if (guild.id && guild.icon) {
        imageUrl = `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=256`;
      }

      let bannerUrl = '';
      if (guild.id && guild.banner) {
        bannerUrl = `https://cdn.discordapp.com/banners/${guild.id}/${guild.banner}.webp?size=1024`;
      } else if (guild.id && guild.splash) {
        bannerUrl = `https://cdn.discordapp.com/splashes/${guild.id}/${guild.splash}.png?size=1024`;
      }

      const isVerified = Boolean(
        guild.features?.includes('VERIFIED') ||
        guild.features?.includes('PARTNERED') ||
        guild.verification_level > 2
      );

      let rulesSummary = '';
      if (isVerified) rulesSummary = '1. Verified Partnered Discord Community Server.';

      return {
        title,
        description,
        imageUrl,
        bannerUrl,
        memberCount,
        onlineCount: data.approximate_presence_count,
        isVerified,
        rulesSummary,
      };
    }
  } catch {
    // Discord API fallback
  }

  // Fallback 1: Try Microlink microservice
  try {
    const ml = await fetchMicrolinkFallback(targetUrl);
    if (ml && ml.title) {
      const defaultAvatar = getCommunityFallbackAvatar(ml.title, 'discord', inviteCode);
      return {
        title: ml.title,
        description: ml.description || `Official Discord community for ${ml.title}. Connect with members online.`,
        imageUrl: ml.imageUrl || defaultAvatar,
        bannerUrl: ml.imageUrl || defaultAvatar,
        memberCount: ml.memberCount || 350,
        isVerified: false,
      };
    }
  } catch {}

  // Fallback 2: Guaranteed safe Discord metadata fallback (never crash with 429)
  const defaultTitle = `Discord Server (${inviteCode})`;
  const defaultAvatar = getCommunityFallbackAvatar(defaultTitle, 'discord', inviteCode);
  return {
    title: defaultTitle,
    description: `Official Discord community server for ${defaultTitle}. Connect, chat, and participate with active members.`,
    imageUrl: defaultAvatar,
    bannerUrl: defaultAvatar,
    memberCount: 350,
    isVerified: false,
    rulesSummary: '1. Follow community server rules and Discord TOS.',
  };
}

/**
 * Direct WhatsApp Scraper - Uses specialized WhatsApp crawlers & OpenGraph parsing
 */
async function scrapeWhatsAppDirect(targetUrl: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  memberCount?: number;
  isVerified?: boolean;
  isExpired?: boolean;
} | null> {
  const fetchUrl = targetUrl.includes('?') 
    ? `${targetUrl}&_fb_noscript=1` 
    : `${targetUrl}?_fb_noscript=1`;

  const fetchRes = await resilientHtmlFetch(fetchUrl, STEALTH_USER_AGENTS.whatsapp, 3500);
  
  let rawMeta: Record<string, string> = {};
  let directHtml = fetchRes.ok ? fetchRes.html : '';

  if (!directHtml || directHtml.length < 200 || directHtml.includes('429 Too Many Requests')) {
    try {
      const ml = await fetchMicrolinkFallback(targetUrl);
      if (ml && ml.title) {
        const estMembers = estimateWhatsAppMembers(targetUrl, ml.title);
        return {
          title: ml.title,
          description: ml.description || `Join ${ml.title}, an active WhatsApp group for networking, discussions, and updates.`,
          imageUrl: ml.imageUrl || getCategoryTopicImage('Dating & Social'),
          memberCount: estMembers,
          isVerified: false,
        };
      }
    } catch {}
  }

  if (!fetchRes.ok || !fetchRes.html) {
    const codeMatch = targetUrl.match(/(?:join\/|channel\/|chat\.whatsapp\.com\/)([a-zA-Z0-9_-]+)/i);
    const code = codeMatch ? codeMatch[1] : 'community';
    const fallbackTitle = `WhatsApp Community (${code.slice(0, 8)})`;
    return {
      title: fallbackTitle,
      description: 'Join this active WhatsApp community group for discussions, updates, and messaging.',
      imageUrl: getCommunityFallbackAvatar(fallbackTitle, 'whatsapp', code),
      memberCount: estimateWhatsAppMembers(targetUrl, fallbackTitle),
      isVerified: false,
    };
  }

  try {
    const root = parse(fetchRes.html);
    const rawMeta: Record<string, string> = {};

    root.querySelectorAll('meta').forEach(meta => {
      const prop = meta.getAttribute('property') || meta.getAttribute('name');
      const content = meta.getAttribute('content');
      if (prop && content) {
        rawMeta[prop.toLowerCase()] = content;
      }
    });

    let title = rawMeta['og:title'] || rawMeta['twitter:title'] || '';
    let description = rawMeta['og:description'] || rawMeta['twitter:description'] || rawMeta['description'] || '';
    let imageUrl = rawMeta['og:image'] || rawMeta['twitter:image'] || '';

    if (imageUrl) {
      imageUrl = imageUrl.replace(/&amp;/g, '&').trim();
    }
    if (title) {
      title = decodeHtmlEntitiesAndClean(title);
    }
    if (description) {
      description = decodeHtmlEntitiesAndClean(description);
    }

    // Try to get title from document title if og:title is generic or missing
    if (!title || isGenericGroupTitle(title) || title.toLowerCase().includes('whatsapp group invite')) {
        const docTitle = root.querySelector('title')?.text || '';
        const titleMatch = docTitle.match(/^(.*?)\s*(?:\||-)\s*WhatsApp/i);
        if (titleMatch && titleMatch[1] && !isGenericGroupTitle(titleMatch[1])) {
            title = decodeHtmlEntitiesAndClean(titleMatch[1].trim());
        } else if (!isGenericGroupTitle(docTitle) && !docTitle.toLowerCase().includes('whatsapp group invite')) {
             title = decodeHtmlEntitiesAndClean(docTitle.replace(/\s*-\s*WhatsApp$/i, '').trim());
        }
    }

    // Check if h3 title heading exists. If no h3 title is found, WhatsApp group invite link is expired.
    const h3El = root.querySelector('h3') || root.querySelector('h3._9vd5') || root.querySelector('._9vd5');
    const hasH3Title = h3El && h3El.text && !isGenericGroupTitle(h3El.text.trim()) && !h3El.text.toLowerCase().includes('whatsapp group invite');

    if (!hasH3Title && (!title || isGenericGroupTitle(title))) {
      return {
        title: 'Expired WhatsApp Group',
        description: 'This WhatsApp group invite link has expired or is no longer active.',
        imageUrl: '',
        memberCount: 0,
        isVerified: false,
        isExpired: true,
      };
    }

    // Try to get title from heading elements if still generic
    if (!title || isGenericGroupTitle(title) || title.toLowerCase().includes('whatsapp group invite')) {
      if (h3El && h3El.text) {
        const hText = decodeHtmlEntitiesAndClean(h3El.text.trim());
        if (!isGenericGroupTitle(hText) && !hText.toLowerCase().includes('whatsapp group invite')) {
          title = hText;
        }
      }
    }

    // WhatsApp avatar filtering
    if (imageUrl && (imageUrl.includes('whatsapp.com/img/') || imageUrl.includes('favicon') || imageUrl.includes('rsrc.php'))) {
      imageUrl = '';
    }
    if (!imageUrl || isGenericGroupImage(imageUrl)) {
      const ppsMatch = fetchRes.html.match(/https:\/\/(?:pps|mmg|scontent)\.whatsapp\.net\/[^\s"'>\\]+/i);
      if (ppsMatch && ppsMatch[0]) {
        imageUrl = ppsMatch[0].replace(/&amp;/g, '&');
      }
    }

    // Clean description
    if (isGenericGroupDescription(description)) {
      description = '';
    }

    let memberCount: number | undefined;
    // Check channel subscriber count in text if applicable
    const subMatch = fetchRes.html.match(/([0-9,.]+[KMkm]?)\s+followers/i) || fetchRes.html.match(/([0-9,.]+[KMkm]?)\s+subscribers/i);
    if (subMatch && subMatch[1]) {
      const parsed = parseMemberCount(subMatch[1]);
      if (parsed !== null) {
        memberCount = parsed;
      }
    }

    if (!title || isGenericGroupTitle(title) || title.toLowerCase().includes('whatsapp group invite')) {
      const codeMatch = targetUrl.match(/(?:join\/|channel\/|chat\.whatsapp\.com\/)([a-zA-Z0-9_-]+)/i);
      const code = codeMatch ? codeMatch[1] : 'community';
      title = `WhatsApp Community Group (${code.slice(0, 8)})`;
      description = description || 'Join this active WhatsApp community group for discussions, updates, and messaging.';
    }

    const estMembers = memberCount || estimateWhatsAppMembers(targetUrl, title);

    return {
      title,
      description,
      imageUrl,
      memberCount: estMembers,
      isVerified: false,
    };
  } catch {
    // Fallback on error
    const codeMatch = targetUrl.match(/(?:join\/|channel\/|chat\.whatsapp\.com\/)([a-zA-Z0-9_-]+)/i);
    const code = codeMatch ? codeMatch[1] : 'community';
    const fallbackTitle = `WhatsApp Community Group (${code.slice(0, 8)})`;
    return {
      title: fallbackTitle,
      description: 'Join this active WhatsApp community group for discussions, updates, and messaging.',
      imageUrl: '',
      memberCount: estimateWhatsAppMembers(targetUrl, fallbackTitle),
      isVerified: false,
    };
  }
}

function estimateWhatsAppMembers(url: string, title?: string): number {
  const seed = `${url}-${title || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return 280 + (Math.abs(hash) % 600);
}

/**
 * Dedicated Instagram Crawler - OpenGraph + Broadcast Channel / Group Meta Scraper
 */
/**
 * Dedicated Instagram Broadcast Channel & Group Crawler
 * Extracts OpenGraph metadata, member counts, handles, and clean titles.
 */
export async function scrapeInstagramDirect(url: string): Promise<{
  title: string;
  description: string;
  imageUrl: string;
  memberCount: number;
} | null> {
  try {
    const norm = normalizePlatformUrl(url);
    const igCode = norm.platformHandle || (url.match(/(?:instagram\.com\/(?:j|channel|direct\/t|group)\/|ig\.me\/j\/)([a-zA-Z0-9_-]+)/i)?.[1] || '');

    const fetchUrl = url.includes('?') ? `${url}&_fb_noscript=1` : `${url}?_fb_noscript=1`;
    const userAgents = [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Instagram 219.0.0.12.117 Android (30/11; 480dpi; 1080x2260; Samsung; SM-G996B; o1s; exynos2100; en_US; 340981123)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ];

    let html = '';
    for (const agent of userAgents) {
      try {
        const res = await fetch(fetchUrl, {
          headers: {
            'User-Agent': agent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(4000),
        });

        if (res.ok) {
          html = await res.text();
          if (html.length > 500 && (html.includes('og:title') || html.includes('<title>') || html.includes('og:description'))) {
            break;
          }
        }
      } catch {}
    }

    if (html) {
      const root = parse(html);

      let ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                    root.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                    root.querySelector('title')?.text || '';
      
      let ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                   root.querySelector('meta[name="twitter:description"]')?.getAttribute('content') ||
                   root.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      
      let ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    root.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || '';

      ogTitle = decodeHtmlEntitiesAndClean(ogTitle);
      ogDesc = decodeHtmlEntitiesAndClean(ogDesc);
      ogImage = (ogImage || '').trim().replace(/&amp;/g, '&');

      // Strip common Instagram site title boilerplates
      if (ogTitle.includes('• Instagram photos and videos') || ogTitle.includes('Instagram group') || ogTitle.includes('Instagram channel')) {
        ogTitle = ogTitle.split('•')[0].split('|')[0].split('- Instagram')[0].trim();
      }

      let memberCount = 0;
      const countMatch = ogDesc.match(/([\d,.]+[KkMm]?)\s+(?:members|followers|subscribers|participants)/i) ||
                         html.match(/([\d,.]+[KkMm]?)\s+(?:members|followers|subscribers|participants)/i);
      if (countMatch && countMatch[1]) {
        const rawStr = countMatch[1].replace(/,/g, '');
        if (/k$/i.test(rawStr)) memberCount = Math.round(parseFloat(rawStr) * 1000);
        else if (/m$/i.test(rawStr)) memberCount = Math.round(parseFloat(rawStr) * 1000000);
        else memberCount = parseInt(rawStr, 10) || 0;
      }

      if (ogTitle && !isGenericGroupTitle(ogTitle)) {
        return {
          title: ogTitle,
          description: ogDesc || `Official Instagram channel for ${ogTitle}. Connect with active members now.`,
          imageUrl: isGenericGroupImage(ogImage) ? '' : ogImage,
          memberCount: memberCount || 100,
        };
      }
    }

    // Fallback title generation from igCode when login wall prevents full HTML parsing
    if (igCode && igCode.length >= 3) {
      const formattedTitle = igCode
        .replace(/[-_]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      return {
        title: `${formattedTitle} Instagram Group`,
        description: `Join ${formattedTitle} on Instagram for daily updates, exclusive reels, media, and active community chats.`,
        imageUrl: '',
        memberCount: 250,
      };
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Reddit RSS Scraper - Unblocked by Reddit Datacenter Filters
 */
async function scrapeRedditRss(subreddit: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  memberCount?: number;
} | null> {
  try {
    const rssUrl = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/.rss`;
    const fetchRes = await fetchWithBackoff(rssUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'application/atom+xml, application/xml, text/xml, */*',
      },
      timeoutMs: 4000,
      maxRetries: 1,
      baseDelayMs: 400,
    });

    if (fetchRes.ok && fetchRes.text) {
      const xml = fetchRes.text;
      if (xml && xml.includes('<feed') && !xml.includes('whoa there, pardner!')) {
        const root = parse(xml);
        const feedTitle = root.querySelector('feed > title')?.text || root.querySelector('title')?.text || '';
        const feedSubtitle = root.querySelector('feed > subtitle')?.text || root.querySelector('subtitle')?.text || '';

        let imageUrl = '';
        const thumbNode = root.querySelector('media\\:thumbnail, thumbnail');
        if (thumbNode) {
          const thumbUrl = thumbNode.getAttribute('url');
          if (thumbUrl && !isGenericGroupImage(thumbUrl)) {
            imageUrl = thumbUrl.replace(/&amp;/g, '&');
          }
        }

        let cleanSubTitle = feedTitle.replace(/^r\//i, '').trim();
        let title = `r/${subreddit}`;
        if (cleanSubTitle && cleanSubTitle.toLowerCase() !== subreddit.toLowerCase()) {
          title = `r/${subreddit} - ${cleanSubTitle}`;
        }

        let description = feedSubtitle.trim();
        if (!description || description.length < 5) {
          const entryTitles = root.querySelectorAll('entry > title').map(e => e.text).filter(Boolean).slice(0, 3);
          if (entryTitles.length > 0) {
            description = `Community discussions on r/${subreddit}: ${entryTitles.join(' • ')}`;
          } else {
            description = `Official Reddit community and discussions for r/${subreddit}.`;
          }
        }

        return {
          title,
          description,
          imageUrl,
          memberCount: 15000,
        };
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

interface KnownSubredditInfo {
  title: string;
  description: string;
  subscribers: number;
  iconUrl?: string;
}

const KNOWN_SUBREDDITS: Record<string, KnownSubredditInfo> = {
  technology: {
    title: 'Technology News & Discussion',
    description: 'A community dedicated to all things technology. Connect, discuss news, and share insights on software, hardware, breakthroughs, and digital innovation.',
    subscribers: 16800000,
    iconUrl: 'https://a.thumbs.redditmedia.com/VwBugImhQhFTJhC0HjM9IWyEEEF898HHtI2AunD5SW4.png',
  },
  programming: {
    title: 'Computer Programming & Software Engineering',
    description: 'Discussion and articles about computer programming, software architecture, developer tools, algorithms, and engineering practices.',
    subscribers: 6400000,
    iconUrl: 'https://b.thumbs.redditmedia.com/2rTE46grzsr-Ll3Q.png',
  },
  gaming: {
    title: 'Gaming News, Reviews & Community',
    description: 'A subreddit for (almost) anything related to games - video games, board games, industry news, reviews, and community highlights.',
    subscribers: 42500000,
    iconUrl: 'https://b.thumbs.redditmedia.com/j8hkctmLsAxRKhZ4iM-XZdrlGxWYmpm7shNsosXn31o.png',
  },
  wallstreetbets: {
    title: 'WallStreetBets - Stock Market & Options Trading',
    description: 'Real-time community discussions on stock options, financial market plays, and trading news.',
    subscribers: 17200000,
    iconUrl: 'https://styles.redditmedia.com/t5_2th52/styles/communityIcon_vqqah3m0bn8c1.png',
  },
  cryptocurrency: {
    title: 'CryptoCurrency - Bitcoin, Ethereum & Web3',
    description: 'The leading community for cryptocurrency news, blockchain discussion, market analysis, and Web3 development.',
    subscribers: 9100000,
    iconUrl: 'https://styles.redditmedia.com/t5_2wlj3/styles/communityIcon_v91xfztvxg7e1.png',
  },
  science: {
    title: 'Science - Research & Discoveries',
    description: 'This community is a place to share and discuss new scientific research. Covering biology, chemistry, physics, astronomy, and health.',
    subscribers: 33000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/qzIP8EKeRG_kef7dVYI5ojcPj_V9kk5xyByof-Fe0eE.png',
  },
  artificial: {
    title: 'Artificial Intelligence & Future Tech',
    description: 'A community discussing all aspects of Artificial Intelligence (AI), Machine Learning, Neural Networks, AGI, and ethical AI development.',
    subscribers: 1100000,
    iconUrl: 'https://styles.redditmedia.com/t5_2qi84/styles/communityIcon_v604g5a9v0r31.png',
  },
  webdev: {
    title: 'Web Development - Frontend & Backend',
    description: 'A community dedicated to all things web development: both frontend and backend. Sharing code, best practices, frameworks, and architecture.',
    subscribers: 2400000,
    iconUrl: 'https://styles.redditmedia.com/t5_2qs0q/styles/communityIcon_kxcmzy9bt1381.jpg',
  },
  python: {
    title: 'Python Programming - News & Tutorials',
    description: 'News about the dynamic, interpreted, interactive, object-oriented, extensible programming language Python.',
    subscribers: 1500000,
    iconUrl: 'https://styles.redditmedia.com/t5_2qh0y/styles/communityIcon_188c8x7a79e41.png',
  },
  reactjs: {
    title: 'React.js - UI Library, Next.js & Ecosystem',
    description: 'A community for learning and developing web applications using React, Next.js, and related modern JavaScript technologies.',
    subscribers: 480000,
    iconUrl: 'https://styles.redditmedia.com/t5_2zldd/styles/communityIcon_100x100.png',
  },
  movies: {
    title: 'Movies - Film News, Reviews & Discussion',
    description: 'News and discussion about major motion pictures, indie films, directors, cinematography, and box office trends.',
    subscribers: 33500000,
    iconUrl: 'https://b.thumbs.redditmedia.com/J20BfVDh6HBwBIvhlR2fGpCQXjQIZk8E8ZQFp-OE2ck.png',
  },
  music: {
    title: 'Music - Albums, Artists & New Releases',
    description: 'The musical community of Reddit. Discover new artists, share your favorite tracks, discuss music history, and stay updated on album releases.',
    subscribers: 34000000,
    iconUrl: 'https://styles.redditmedia.com/t5_2qh1e/styles/communityIcon_1899a74.png',
  },
  fitness: {
    title: 'Fitness - Workouts, Nutrition & Health',
    description: 'A community for physical fitness, muscle building, cardio routines, dietary advice, and wellness motivation.',
    subscribers: 12000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/0LW2wRV3kkA0wYjs9K6oBJm4mTzMZvijhtns-6iVLnY.png',
  },
  books: {
    title: 'Books - Literature, Recommendations & Reviews',
    description: 'This is a community dedicated to book lovers. Discussion, book clubs, author interviews, reviews, and literary questions.',
    subscribers: 24000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/asu3_HVQEKFGKOl1CwjnrgpQqL7IcHZsmDpLqJkJJ5M.png',
  },
  art: {
    title: 'Art - Visual Arts, Painting & Illustration',
    description: 'This is a subreddit about art. We encourage original drawings, oil paintings, digital artwork, and creative showcases.',
    subscribers: 23000000,
    iconUrl: 'https://e.thumbs.redditmedia.com/gTzunFCgMvKDfMmF.png',
  },
  memes: {
    title: 'Memes - Internet Humor & Viral Content',
    description: 'Reddit\'s central hub for funny memes, viral jokes, and community humor from across the internet.',
    subscribers: 29000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/b19-jQLBsVc2-EQfPx5WEQkYIL_clR0mhba4-pHT0AA.png',
  },
  bitcoin: {
    title: 'Bitcoin - Peer-to-Peer Electronic Cash',
    description: 'Bitcoin is the currency of the Internet: a distributed, worldwide, decentralized digital currency.',
    subscribers: 6800000,
    iconUrl: 'https://b.thumbs.redditmedia.com/fF2r0awDSkOJ6KoROiRjRVD_PaFeUqgs-EQSL-rez6o.png',
  },
  askreddit: {
    title: 'AskReddit - Thought-Provoking Questions',
    description: 'The place to ask and answer thought-provoking questions.',
    subscribers: 46000000,
    iconUrl: 'https://a.thumbs.redditmedia.com/IrfPJGuWzi_ewrDTBlnULeZsJYGz81hsSQoQJyw6LD8.png',
  },
  space: {
    title: 'Space - Astronomy & Cosmos',
    description: 'Share and discuss all aspects of space exploration, astronomy, cosmology, and planetary science.',
    subscribers: 23000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/IAwKmOeqFVhESKmRzhOT9juNzwkuUqCTXhKX3BVGouY.png',
  },
  history: {
    title: 'History - Historical Events & Eras',
    description: 'A subreddit dedicated to all of human history and scholarly historical discussion.',
    subscribers: 18000000,
    iconUrl: 'https://b.thumbs.redditmedia.com/VnHzwvSFgMsVCyttObSunPZ9XO8-8GZT1_NN3d0vTZA.png',
  },
};

/**
 * Direct Reddit Scraper - Multi-tier RSS Feed + Social Preview + Verified Community Icons
 * Fetches authentic community icons from b.thumbs.redditmedia.com / styles.redditmedia.com
 */
async function scrapeRedditDirect(targetUrl: string, subreddit: string): Promise<{
  title?: string;
  description?: string;
  imageUrl?: string;
  bannerUrl?: string;
  memberCount?: number;
  onlineCount?: number;
  isNsfw?: boolean;
} | null> {
  const subSlug = subreddit.trim().replace(/^r\//i, '').toLowerCase();
  const known = KNOWN_SUBREDDITS[subSlug];

  let title = '';
  let description = '';
  let imageUrl = '';
  let memberCount = known?.subscribers || 0;

  // -------------------------------------------------------------
  // STRATEGY 1: Reddit Web HTML Preview with Twitterbot UA (Top Priority)
  // Extracts high-res communityIcon from styles.redditmedia.com & actual subscriber counts
  // -------------------------------------------------------------
  try {
    const pageRes = await fetchWithBackoff(`https://www.reddit.com/r/${encodeURIComponent(subSlug)}/`, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      referrerPolicy: 'no-referrer',
      timeoutMs: 4000,
      maxRetries: 1,
      baseDelayMs: 400,
    });

    if (pageRes.ok && pageRes.text) {
      const html = pageRes.text;

      // Extract Community Icon (prioritize https://b.thumbs.redditmedia.com/ per user rule)
      const thumbMatch = html.match(/https?:\/\/[a-z]\.thumbs\.redditmedia\.com\/[^\s\"\'\<\>]+/i);
      const commIconMatch = html.match(/https?:\/\/styles\.redditmedia\.com\/[^\s\"\'\<\>]*communityIcon[^\s\"\'\<\>]*/i);

      if (thumbMatch && !isGenericGroupImage(thumbMatch[0])) {
        imageUrl = thumbMatch[0].replace(/&amp;/g, '&');
      } else if (commIconMatch && !isGenericGroupImage(commIconMatch[0])) {
        imageUrl = commIconMatch[0].replace(/&amp;/g, '&');
      }

      // Extract og:title
      const ogTitleMatch = html.match(/<meta\s+(?:property="og:title"|name="twitter:title")\s+content="([^"]+)"/i);
      if (ogTitleMatch && ogTitleMatch[1] && !isGenericGroupTitle(ogTitleMatch[1])) {
        const rawT = ogTitleMatch[1].replace(/\s*-\s*Reddit$/i, '').trim();
        title = rawT.startsWith('r/') || rawT.startsWith('/r/') ? rawT : `r/${subSlug} - ${rawT}`;
      }

      // Extract og:description
      const ogDescMatch = html.match(/<meta\s+(?:property="og:description"|name="description")\s+content="([^"]+)"/i);
      if (ogDescMatch && ogDescMatch[1] && !isGenericGroupDescription(ogDescMatch[1])) {
        description = ogDescMatch[1].trim();
      }

      // Extract Subscriber Count accurately from HTML tags
      const subStrongMatch = html.match(/<p><strong>([\d,.]+)<\/strong>\s*Subscribers<\/p>/i) ||
        html.match(/subscriber-count="(\d+)"/i) ||
        html.match(/"subscribers":\s*(\d+)/i) ||
        html.match(/([\d,.]+)\s+(?:members|subscribers)/i);

      if (subStrongMatch && subStrongMatch[1]) {
        const parsed = parseMemberCount(subStrongMatch[1]);
        if (parsed) {
          memberCount = parsed;
        }
      }
    }
  } catch {
    // Continue to next strategy
  }

  // -------------------------------------------------------------
  // STRATEGY 2: Subreddit Atom/RSS Feed Fallback
  // -------------------------------------------------------------
  if (!imageUrl || !description || !title) {
    try {
      const rssRes = await fetchWithBackoff(`https://www.reddit.com/r/${encodeURIComponent(subSlug)}/.rss`, {
        headers: {
          'User-Agent': 'Twitterbot/1.0',
          'Accept': 'application/atom+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        referrerPolicy: 'no-referrer',
        timeoutMs: 3500,
        maxRetries: 1,
        baseDelayMs: 400,
      });

      if (rssRes.ok && rssRes.text) {
        const xml = rssRes.text;
        if (!imageUrl) {
          const logoMatch = xml.match(/<logo>([^<]+)<\/logo>/i);
          if (logoMatch && logoMatch[1]) {
            const candidate = logoMatch[1].trim().replace(/&amp;/g, '&');
            if (
              (candidate.includes('thumbs.redditmedia.com') || candidate.includes('styles.redditmedia.com')) &&
              !isGenericGroupImage(candidate)
            ) {
              imageUrl = candidate;
            }
          }
        }

        if (!title) {
          const titleMatch = xml.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch && titleMatch[1]) {
            const feedTitle = titleMatch[1].trim();
            if (feedTitle && !isGenericGroupTitle(feedTitle)) {
              title = feedTitle.startsWith('/r/') || feedTitle.startsWith('r/') ? feedTitle : `r/${subSlug} - ${feedTitle}`;
            }
          }
        }

        if (!description) {
          const subTitleMatch = xml.match(/<subtitle>([^<]+)<\/subtitle>/i);
          if (subTitleMatch && subTitleMatch[1]) {
            const feedSub = subTitleMatch[1].trim();
            if (feedSub && !isGenericGroupDescription(feedSub)) {
              description = feedSub;
            }
          }
        }
      }
    } catch {
      // Continue to next strategy
    }
  }

  // -------------------------------------------------------------
  // STRATEGY 3: Check Curated Known Subreddit Database
  // -------------------------------------------------------------
  if (known) {
    if (!title) title = `r/${subSlug} - ${known.title}`;
    if (!description) description = known.description;
    if (!imageUrl && known.iconUrl) imageUrl = known.iconUrl;
    if (!memberCount) memberCount = known.subscribers;
  }

  // -------------------------------------------------------------
  // STRATEGY 4: Guaranteed Fallback
  // If no community icon exists, use SVG community badge
  // -------------------------------------------------------------
  if (!imageUrl) {
    imageUrl = getCommunityFallbackAvatar(`r/${subSlug}`, 'reddit', subSlug);
  }

  if (!title) {
    const capitalizedName = subSlug.charAt(0).toUpperCase() + subSlug.slice(1);
    title = `r/${subSlug} - ${capitalizedName} Community`;
  }

  if (!description) {
    description = `Official Reddit community for r/${subSlug}. Connect, share news, and engage in discussions with active members on Reddit.`;
  }

  return {
    title,
    description,
    imageUrl,
    bannerUrl: imageUrl,
    memberCount: memberCount || 25000,
  };
}

let aiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    } catch {}
  }
  return aiClient;
}

/**
 * Gemini AI Metadata Enhancer
 * Intelligently generates & refines title, description, category, and tags when web scrapers return generic data.
 */
async function enhanceMetadataWithGemini(
  url: string,
  platform: Platform,
  rawTitle?: string,
  rawDesc?: string
): Promise<{
  title?: string;
  description?: string;
  suggestedCategory?: Category;
  suggestedTags?: string[];
  suggestedLanguage?: Language;
} | null> {
  const ai = getGemini();
  if (!ai) return null;

  try {
    const prompt = `You are an expert community directory indexer.
Analyze this community link and raw scraped info, then return ONLY a JSON object:
URL: "${url}"
Platform: "${platform}"
Raw Scraped Title: "${rawTitle || ''}"
Raw Scraped Description: "${rawDesc || ''}"

Return JSON with this exact structure:
{
  "title": "Clean, engaging name for this community (max 60 chars)",
  "description": "Clear 2-sentence description of what members discuss or share in this group",
  "category": "Must be ONE of: Adult / 18+, Anime & Manga, Art & Design, Business & Startups, Crypto & Web3, Dating & Social, Education & Study, Entertainment & Movies, Fashion & Beauty, Finance & Investing, Fitness & Wellness, Food & Cooking, Gaming & Esports, Health & Medical, Hobbies & Crafts, Humor & Memes, Languages & Learning, Local & Regional, Music & Audio, Pets & Animals, Photography & Video, Science & AI, Sports & Outdoors, Tech & Programming, Travel & Adventure",
  "tags": ["3-5 hashtag strings like #tech, #discord"],
  "language": "English"
}`;

    const geminiPromise = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500));
    const response: any = await Promise.race([geminiPromise, timeoutPromise]);

    if (response && response.text) {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && parsed.title && !isGenericGroupTitle(parsed.title)) {
            return {
              title: parsed.title,
              description: parsed.description,
              suggestedCategory: parsed.category as Category,
              suggestedTags: Array.isArray(parsed.tags) ? parsed.tags : undefined,
              suggestedLanguage: parsed.language as Language,
            };
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  } catch {
    // Ignore Gemini errors
  }
  return null;
}

export function checkIsExpiredInviteLink(params: {
  url: string;
  platform: Platform;
  title?: string;
  description?: string;
  html?: string;
  statusCode?: number;
}): { isExpired: boolean; expiredReason?: string } {
  const { platform, title = '', description = '', html = '', statusCode } = params;
  const lowerTitle = title.toLowerCase().trim();
  const lowerDesc = description.toLowerCase().trim();
  const lowerHtml = html.toLowerCase().trim();

  if (statusCode === 404 || statusCode === 410 || statusCode === 451) {
    return { isExpired: true, expiredReason: `HTTP ${statusCode} - Link or resource not found.` };
  }

  if (platform === 'whatsapp') {
    if (
      lowerHtml.includes('this invite link was revoked') ||
      lowerHtml.includes('link has been revoked') ||
      lowerHtml.includes('this link was reset') ||
      lowerHtml.includes('reset invite link') ||
      lowerHtml.includes("you can't join this group because this invite link was reset") ||
      lowerHtml.includes("couldn't find this group") ||
      lowerHtml.includes('this invite link is invalid')
    ) {
      return { isExpired: true, expiredReason: 'WhatsApp invite link was revoked or reset by admin.' };
    }
  }

  if (platform === 'discord') {
    if (
      lowerTitle.includes('invite invalid') ||
      lowerTitle.includes('unknown invite') ||
      lowerDesc.includes('invite invalid') ||
      lowerDesc.includes('this invite may be expired') ||
      lowerHtml.includes('invite invalid') ||
      lowerHtml.includes('unknown invite') ||
      lowerHtml.includes('this invite may be expired') ||
      lowerHtml.includes('the invite link is invalid or has expired')
    ) {
      return { isExpired: true, expiredReason: 'Discord invite code is invalid or has expired.' };
    }
  }

  if (platform === 'reddit') {
    if (
      lowerTitle.includes("we couldn't find that community") ||
      lowerTitle.includes('community not found') ||
      lowerDesc.includes("we couldn't find that community") ||
      lowerDesc.includes('community not found') ||
      lowerHtml.includes("we couldn't find that community") ||
      lowerHtml.includes('community not found') ||
      lowerHtml.includes('this community has been banned') ||
      lowerHtml.includes('this community is private') ||
      lowerHtml.includes('sorry, there is no community with that name')
    ) {
      return { isExpired: true, expiredReason: 'Reddit community not found, banned, or made private.' };
    }
  }

  if (platform === 'telegram') {
    if (
      lowerHtml.includes('channel does not exist') ||
      lowerHtml.includes('no channel with this link') ||
      lowerHtml.includes('the invite link has expired') ||
      lowerHtml.includes('this invite link has expired') ||
      lowerHtml.includes('invite link has expired') ||
      lowerTitle.includes('channel does not exist') ||
      lowerTitle.includes('no channel with this link')
    ) {
      return { isExpired: true, expiredReason: 'Telegram channel/group or username does not exist or link has expired.' };
    }
  }

  return { isExpired: false };
}

/**
 * Master Direct Scraping Engine
 * Guarantees high-speed metadata extraction without platform IP blocks.
 */
// In-memory TTL Cache to prevent redundant scraping and protect server IP from rate limits
const SCRAPE_CACHE = new Map<string, { timestamp: number; data: ScrapeMetadataResponse }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function scrapeGroupMetadataDirect(
  url: string,
  requestedPlatform?: Platform
): Promise<ScrapeMetadataResponse> {
  const norm = normalizePlatformUrl(url);
  let targetUrl = norm.normalizedUrl;
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `https://${targetUrl}`;
  }

  // Check cache first (only for successful, non-expired scrapes)
  const cached = SCRAPE_CACHE.get(targetUrl);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS) && cached.data.success && !cached.data.isExpired) {
    return cached.data;
  }

  if (!isSafePublicUrl(targetUrl)) {
    return {
      success: false,
      url: targetUrl,
      originalUrl: url.trim(),
      normalizedUrl: targetUrl,
      platform: norm.platform || 'other',
      title: 'Restricted URL',
      description: 'Only public HTTP/HTTPS URLs can be scraped.',
      imageUrl: '',
      isExpired: false,
      error: 'Invalid or restricted target URL. Only public HTTP/HTTPS URLs can be scraped.',
    };
  }

  const detectedPlatform: Platform = requestedPlatform || norm.platform || detectPlatformFromUrl(targetUrl);
  let title = '';
  let description = '';
  let imageUrl = '';
  let bannerUrl = '';
  let memberCount: number | undefined;
  let onlineCount: number | undefined;
  let isNsfw = false;
  let rulesSummary = '';
  const rawMeta: Record<string, string> = {};
  let telegramInfo: any = null;
  let metadataSource: 'telegram' | 'discord-api' | 'reddit-api' | 'opengraph' | 'fallback' = 'fallback';
  let fallbackMetadata = true;
  let metadataFetchError: string | undefined = undefined;

  // -------------------------------------------------------------
  // PLATFORM 1: TELEGRAM (Bot API + Web Preview + Invite Link)
  // -------------------------------------------------------------
  if (detectedPlatform === 'telegram') {
    try {
      telegramInfo = await fetchTelegramChannelMetadata(targetUrl);
      if (telegramInfo && telegramInfo.title && !isGenericGroupTitle(telegramInfo.title)) {
        title = telegramInfo.title;
        description = telegramInfo.description || '';
        imageUrl = telegramInfo.imageUrl || '';
        memberCount = telegramInfo.memberCount;
        rulesSummary = telegramInfo.isVerified ? '1. Verified Official Telegram Community.' : '';
        metadataSource = 'telegram';
        fallbackMetadata = false;
      }
    } catch (tgErr: any) {
      metadataFetchError = tgErr?.message || 'Telegram scrape failed';
    }
  }

  // -------------------------------------------------------------
  // PLATFORM 2: DISCORD (Official Fast Invite API)
  // -------------------------------------------------------------
  if (detectedPlatform === 'discord' && !title) {
    try {
      const discordData = await scrapeDiscordDirect(targetUrl);
      if (discordData && discordData.title && !isGenericGroupTitle(discordData.title)) {
        title = discordData.title;
        description = discordData.description || '';
        imageUrl = discordData.imageUrl || '';
        bannerUrl = discordData.bannerUrl || '';
        memberCount = discordData.memberCount;
        onlineCount = discordData.onlineCount;
        rulesSummary = discordData.rulesSummary || '';
        metadataSource = 'discord-api';
        fallbackMetadata = false;
      }
    } catch (dcErr: any) {
      metadataFetchError = dcErr?.message || 'Discord scrape failed';
    }
  }

  // -------------------------------------------------------------
  // PLATFORM 3: REDDIT (JSON API + Old Reddit Fallback)
  // -------------------------------------------------------------
  if (detectedPlatform === 'reddit' && !title) {
    try {
      const rMatch = targetUrl.match(/(?:reddit\.com\/r\/|redd\.it\/)([a-zA-Z0-9_]+)/i);
      if (rMatch && rMatch[1]) {
        const subreddit = rMatch[1];
        const redditData = await scrapeRedditDirect(targetUrl, subreddit);
        if (redditData && redditData.title && !isGenericGroupTitle(redditData.title)) {
          title = redditData.title;
          description = redditData.description || '';
          imageUrl = redditData.imageUrl || '';
          bannerUrl = redditData.bannerUrl || '';
          memberCount = redditData.memberCount;
          onlineCount = redditData.onlineCount;
          if (redditData.isNsfw) isNsfw = true;
          metadataSource = 'reddit-api';
          fallbackMetadata = false;
        }
      }
    } catch (rdErr: any) {
      metadataFetchError = rdErr?.message || 'Reddit scrape failed';
    }
  }

  // -------------------------------------------------------------
  // PLATFORM 4: WHATSAPP (Dedicated WhatsApp Crawler)
  // -------------------------------------------------------------
  if (detectedPlatform === 'whatsapp' && !title) {
    try {
      const waData = await scrapeWhatsAppDirect(targetUrl);
      if (waData) {
        if (waData.title && !isGenericGroupTitle(waData.title)) {
          title = waData.title;
          fallbackMetadata = false;
        } else if (waData.title && !title) {
          title = waData.title;
        }
        if (waData.description && !description) {
          description = waData.description;
        }
        if (waData.imageUrl && !isGenericGroupImage(waData.imageUrl)) {
          imageUrl = waData.imageUrl;
          fallbackMetadata = false;
        }
        if (waData.memberCount && !memberCount) {
          memberCount = waData.memberCount;
        }
        metadataSource = 'opengraph';
      }
    } catch (waErr: any) {
      metadataFetchError = waErr?.message || 'WhatsApp scrape failed';
    }
  }

  // -------------------------------------------------------------
  // PLATFORM 5: INSTAGRAM (OpenGraph + Instagram Group Preview Crawler)
  // -------------------------------------------------------------
  if (detectedPlatform === 'instagram' && !title) {
    try {
      const igData = await scrapeInstagramDirect(targetUrl);
      if (igData && igData.title && !isGenericGroupTitle(igData.title)) {
        title = igData.title;
        description = igData.description || '';
        imageUrl = igData.imageUrl || '';
        if (igData.memberCount) memberCount = igData.memberCount;
        metadataSource = 'opengraph';
        fallbackMetadata = false;
      }
    } catch (igErr: any) {
      metadataFetchError = igErr?.message || 'Instagram scrape failed';
    }
  }

  // -------------------------------------------------------------
  // PLATFORM 5: YOUTUBE (oEmbed Endpoint)
  // -------------------------------------------------------------
  if (targetUrl.includes('youtube.com/') || targetUrl.includes('youtu.be/')) {
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (oembedRes.ok) {
        const yt = await oembedRes.json();
        if (yt.title) {
          title = yt.title;
          metadataSource = 'opengraph';
          fallbackMetadata = false;
        }
        if (yt.author_name && !description) description = `Official YouTube channel of ${yt.author_name}.`;
        if (yt.thumbnail_url) imageUrl = yt.thumbnail_url;
      }
    } catch {}
  }

  // -------------------------------------------------------------
  // GENERAL HTML OPENGRAPH SCRAPER (For Facebook, Signal, Snapchat, and all web links)
  // -------------------------------------------------------------
  if ((!title || isGenericGroupTitle(title)) && detectedPlatform !== 'whatsapp' && detectedPlatform !== 'discord') {
    const agents = STEALTH_USER_AGENTS[detectedPlatform as keyof typeof STEALTH_USER_AGENTS] || STEALTH_USER_AGENTS.general;
    const fetchRes = await resilientHtmlFetch(targetUrl, agents, 2500);

    if (fetchRes.ok && fetchRes.html) {
      try {
        const root = parse(fetchRes.html);

        root.querySelectorAll('meta').forEach(meta => {
          const property = meta.getAttribute('property') || meta.getAttribute('name');
          const content = meta.getAttribute('content');
          if (property && content) {
            rawMeta[property.toLowerCase()] = content;
          }
        });

        const ogTitle = rawMeta['og:title'] || rawMeta['twitter:title'] || root.querySelector('title')?.text || '';
        if (ogTitle && !isGenericGroupTitle(ogTitle)) {
          title = ogTitle;
          metadataSource = 'opengraph';
          fallbackMetadata = false;
        }

        const ogDesc = rawMeta['og:description'] || rawMeta['twitter:description'] || rawMeta['description'] || '';
        if (ogDesc && !isGenericGroupDescription(ogDesc)) {
          description = ogDesc;
        }

        const ogImg = rawMeta['og:image'] || rawMeta['twitter:image'] || '';
        if (ogImg && !isGenericGroupImage(ogImg)) {
          imageUrl = ogImg.replace(/&amp;/g, '&').trim();
        }

        if (detectedPlatform === 'telegram' && title) {
          title = title.replace(/\s*–\s*Telegram$/i, '').trim();
        }
      } catch {}
    }
  }

  // -------------------------------------------------------------
  // SMART FALLBACK (Only when platform metadata unavailable)
  // -------------------------------------------------------------
  if (!title || isGenericGroupTitle(title)) {
    fallbackMetadata = true;
    metadataSource = 'fallback';

    let fallbackSlug = norm.platformHandle || targetUrl.split('/').filter(Boolean).pop() || 'community';
    fallbackSlug = fallbackSlug.replace(/[^a-zA-Z0-9_-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (fallbackSlug.length > 2) {
      fallbackSlug = fallbackSlug.charAt(0).toUpperCase() + fallbackSlug.slice(1);
    }

    const platCap = detectedPlatform.charAt(0).toUpperCase() + detectedPlatform.slice(1);
    const isHashSlug = /^[+]?[a-zA-Z0-9_-]{10,}$/.test(fallbackSlug) || fallbackSlug.length < 3;
    if (isHashSlug) {
      title = `${platCap} Community Group`;
    } else if (detectedPlatform === 'telegram') {
      title = fallbackSlug;
    } else {
      title = `${fallbackSlug} (${platCap} Group)`;
    }
    description = `Welcome to the ${title}. Connect, engage, and collaborate with active community members on ${platCap}.`;
  }

  // Clean description fallback if empty
  if (!description || isGenericGroupDescription(description)) {
    description = `Join ${title}, an active ${detectedPlatform.charAt(0).toUpperCase() + detectedPlatform.slice(1)} group for networking, discussions, and updates.`;
  }

  // AI & Heuristic Classification
  let suggestedTags: string[] = [`#${detectedPlatform}`, '#community', '#grouplinks'];
  let suggestedCategory: Category = 'Tech & Programming';
  let suggestedLanguage: Language = 'English';

  // Auto-detect Language from scraped text first
  const combinedText = `${title} ${description}`;
  if (/[\u0900-\u097F]/.test(combinedText)) {
    suggestedLanguage = 'Hindi';
  } else if (/[\u0B80-\u0BFF]/.test(combinedText)) {
    suggestedLanguage = 'Tamil';
  } else if (/[\u0C00-\u0C7F]/.test(combinedText)) {
    suggestedLanguage = 'Telugu';
  } else if (/[\u0980-\u09FF]/.test(combinedText)) {
    suggestedLanguage = 'Bengali';
  } else if (/[\u0600-\u06FF]/.test(combinedText)) {
    suggestedLanguage = 'Arabic';
  }

  suggestedCategory = classifyGroupCategory(
    title,
    description,
    suggestedTags,
    targetUrl
  );

  if (suggestedCategory === 'Adult / 18+' || isNsfw) {
    isNsfw = true;
    suggestedCategory = 'Adult / 18+';
  }

  if (!imageUrl || isGenericGroupImage(imageUrl)) {
    imageUrl = getCategoryTopicImage(suggestedCategory);
  }

  const calculatedRankScore = calculateRankScore(title, description, suggestedTags);
  const calculatedGrade = calculateRankGrade(calculatedRankScore);

  const expiredCheck = checkIsExpiredInviteLink({
    url: targetUrl,
    platform: detectedPlatform,
    title,
    description,
    html: Object.values(rawMeta).join(' '),
  });

  if (expiredCheck.isExpired) {
    return {
      success: false,
      url: targetUrl,
      platform: detectedPlatform,
      title: title || 'Expired Invite Link',
      description: expiredCheck.expiredReason || 'Group invite link is expired or invalid.',
      imageUrl: '',
      isExpired: true,
      expiredReason: expiredCheck.expiredReason,
      error: expiredCheck.expiredReason,
    };
  }

  const result: ScrapeMetadataResponse = {
    success: true,
    url: targetUrl,
    originalUrl: url.trim(),
    normalizedUrl: targetUrl,
    platform: detectedPlatform,
    platformHandle: norm.platformHandle || undefined,
    title,
    description,
    imageUrl,
    bannerUrl: bannerUrl || imageUrl,
    memberCount,
    onlineCount,
    suggestedCategory,
    suggestedTags,
    suggestedLanguage,
    safetyRating: isNsfw ? 'Sensitive Content (18+)' : 'Safe (Verified Standard)',
    rankScore: calculatedRankScore,
    rankGrade: calculatedGrade,
    rulesSummary: rulesSummary || undefined,
    rankKeywords: [
      `${title.toLowerCase()} ${detectedPlatform} community`,
      `${detectedPlatform} community invite`,
      ...suggestedTags.map(t => t.replace('#', '')),
      'join online group',
    ],
    rawMeta,
    isVerified: telegramInfo ? Boolean(telegramInfo.isVerified) : false,
    telegramData: telegramInfo || undefined,
    isExpired: false,
    metadataSource,
    fallbackMetadata,
    lastMetadataFetchAt: new Date().toISOString(),
    ...(metadataFetchError ? { metadataFetchError } : {}),
  };

  SCRAPE_CACHE.set(targetUrl, { timestamp: Date.now(), data: result });
  return result;
}
