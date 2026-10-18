# Multi-Platform Scraping Architecture & Fetching Strategy Plan

Create a comprehensive architectural artifact documenting how group links across Telegram, Reddit, WhatsApp, Discord, and other platforms are fetched, parsed, normalized, mirrored to Cloudflare R2, and gracefully fallen back.

## User Review & Critical Decisions

> [!IMPORTANT]
> - **Multi-Tier Scraping**: Documentation will detail specific request headers, DOM selectors, JSON APIs, and fallback chains for Telegram (`t.me`), Reddit (`reddit.com`, `old.reddit.com`), WhatsApp, and general social links.
> - **Artifact Delivery**: The complete architectural guide will be delivered as an easy-to-read markdown artifact detailing HTTP contracts, anti-bot handling, and R2 CDN mirroring.

---

## 1. Overview & Core Concept

- **What It Does**: Details the exact mechanics of how metadata is extracted from social preview pages and official APIs without using heavy headless browsers.
- **Target Audience**: Developers and administrators looking to audit or extend the scraping pipeline.

---

## 2. Technical Architecture & Fetching Mechanics

```
[Target Group URL]
       │
       ├─► Telegram (t.me) ──► HTML Scrape (.tgme_page_photo_image, og:image, telesco.pe)
       ├─► Reddit (r/...)  ──► JSON API (/about.json) ──► Old Reddit HTML Fallback (.rss / og:image)
       └─► Other Socials   ──► OpenGraph Meta Tags (og:title, og:description, og:image)
       │
       ▼
[Sanitization & Normalization]
       │
       ▼
[Cloudflare R2 Storage (cdn.grouplinks.app)]
       │
       ▼
[Persistent Database Storage]
```

- **HTTP Headers**: Simulated modern Chrome User-Agent strings, `Accept` headers, and `referrerPolicy: 'no-referrer'`.
- **Parsing**: `node-html-parser` for DOM querying and regex matching for protocol-relative/telesco.pe URLs.
- **Fallbacks**: Category SVG generators for missing or blocked images.
