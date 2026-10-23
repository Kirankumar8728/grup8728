# Implementation Plan - Block Expired WhatsApp Groups & Display Red Inline Error Banner

## Goal
Ensure that when a user attempts to submit or scrape an expired WhatsApp group link (such as `https://chat.whatsapp.com/invite/GlKFjqZ0Fm8FgdrgGhpWAU`), the system:
1. Instantly detects the expired status (title containing "Expired WhatsApp Group" or `isExpired === true`).
2. **Never publishes** the expired group to the database or public listings.
3. Displays a **prominent red inline error banner** directly on the submit form stating: `"This invite link got expired add other active link"`.

## Proposed Changes

### 1. Backend Validation & Scraping (`src/lib/metadata-scraper.ts` & `src/app/actions/submit-group.ts` & `src/app/api/groups/route.ts`)
- Verify `scrapeWhatsAppDirect` explicitly flags `isExpired: true` and sets title to `"Expired WhatsApp Group"` when WhatsApp link is dead or lacks an active `h3` title/avatar.
- Ensure `submit-group` action and `/api/groups/route.ts` check for `fetchedMetadata?.isExpired` or `cleanTitle.includes('Expired WhatsApp Group')` and return `{ success: false, error: 'This invite link got expired add other active link' }`.

### 2. Frontend Submit Form UI (`src/components/SubmitGroupView.tsx`)
- Capture the error response when submission or live preview scraping returns an expired link notice.
- Render a prominent **red inline error alert banner** directly on the submit form with the message: `"This invite link got expired add other active link"`.

## Verification Plan
- Run `npm run lint` (`npx tsc --noEmit`) to verify type safety.
- Test submitting an expired WhatsApp link to confirm publication is blocked and the red inline error banner appears.
