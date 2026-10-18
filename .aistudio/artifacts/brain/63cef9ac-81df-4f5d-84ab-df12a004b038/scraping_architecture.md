# Multi-Platform Scraping & Fetching Architecture

This document provides a comprehensive breakdown of how group and community links across Telegram, Reddit, WhatsApp, and other social platforms are fetched, parsed, sanitized, mirrored to Cloudflare R2, and persisted.

---

## 1. Core Fetching Philosophy & Speed Strategy
To maintain sub-200ms API responses and avoid heavy memory consumption, the platform **avoids headless browsers (Puppeteer/Playwright)** for standard link metadata extraction. Instead, it utilizes **lightweight asynchronous HTTP requests** paired with robust HTML/JSON parsers (`node-html-parser`) and fallback heuristics.

---

## 2. Platform-Specific Fetching & Parsing Strategies

### A. Telegram (`t.me / telegram.org`)
* **Endpoint / URL Structure**: `https://t.me/[channel_or_group]` or `https://t.me/s/[channel]`
* **HTTP Request Headers**:
  ```ts
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  ```
* **Avatar & Image Extraction**:
  1. Queries `.tgme_page_photo_image img`, `.tgme_page_photo_image`, or `.tgme_page_photo img` for `src` or `data-src` attributes.
  2. Parses inline `background-image: url(...)` styles on `.tgme_page_photo`.
  3. Falls back to regex matching for `telesco.pe` CDN image URLs or OpenGraph `og:image` tags.
* **Normalization**: Protocol-relative URLs (`//cdn4.telesco.pe/...`) are normalized to `https://cdn4.telesco.pe/...`. Generic Telegram logo placeholders (`t_logo`, `favicon.ico`) are filtered out.
* **Member Counts**: Regex parsing of `.tgme_page_extra` or `.tgme_page_counter` text (e.g., "15.4K subscribers" $\rightarrow$ `15400`).

### B. Reddit (`reddit.com / old.reddit.com`)
* **Multi-Tier Fallback Strategy**:
  1. **Tier 1 (Fast JSON API)**: Requests `https://www.reddit.com/r/[subreddit]/about.json`. Extracts `title`, `public_description`, `subscribers`, `over18`, and prioritizes `sub.community_icon` (styles.redditmedia.com) over generic Snoo avatars.
  2. **Tier 1b (Old Reddit HTML)**: If JSON times out or hits datacenter rate limits, fetches `https://old.reddit.com/r/[subreddit]/` with browser headers and extracts `og:title`, `og:description`, `og:image`, and `#header-img`.
  3. **Tier 2 (RSS Feed)**: Fetches `https://www.reddit.com/r/[subreddit]/.rss` to parse feed title, subtitle, and media thumbnails.
  4. **Tier 3 (Curated Knowledge & Synthetic Fallbacks)**: Uses built-in knowledge maps for popular subreddits combined with deterministic algorithmic avatar generators.

### C. WhatsApp & Other Social Platforms (Discord, Signal, Facebook, Snapchat)
* **General OpenGraph Scraper**:
  * Requests the target invite URL with browser user-agents and `referrerPolicy: 'no-referrer'`.
  * Parses standard HTML meta tags:
    * `meta[property="og:title"]` / `meta[name="twitter:title"]`
    * `meta[property="og:description"]` / `meta[name="twitter:description"]`
    * `meta[property="og:image"]` / `meta[name="twitter:image"]`
  * Cleans and decodes HTML entities (`&amp;` $\rightarrow$ `&`).

---

## 3. Image Sanitization & Cloudflare R2 CDN Mirroring (`cdn.grouplinks.app`)
Once raw image URLs are extracted:
1. **Validation**: `isGenericGroupImage()` checks against known icon sprites, favicons, and placeholder logos.
2. **Mirroring**: `uploadImageToR2()` downloads the external image server-side, re-encodes/optimizes it, and uploads it to Cloudflare R2 (`cdn.grouplinks.app`).
3. **Permanent Link**: The resulting R2 URL (`https://cdn.grouplinks.app/...`) is stored in the database as a permanent, high-speed asset link with zero expiration and zero hotlink restrictions.

---

## 4. Graceful Fallbacks & Anti-Bot Mitigations
* **Deterministic SVG Fallback Avatars (`getCommunityFallbackAvatar`)**: If scraping fails or returns no image, a zero-storage, copyright-free SVG Data URI is generated instantly based on platform color gradients and community initials.
* **Rate Limiting & Concurrency Queues (`mapConcurrent`)**: Bulk imports process links in bounded worker pools (e.g., 5 concurrent requests) with randomized jitter to prevent triggering platform WAF firewalls.
