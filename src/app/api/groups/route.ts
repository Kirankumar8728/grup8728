import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getGroups, createGroup, deleteMultipleGroups, getGroupById, getGroupBySlug, updateGroup } from '@/src/lib/groups-dal';
import { sanitizeInput } from '@/src/lib/security';
import { categoryToSlug, countryToSlug, languageToSlug, tagToSlug, validateGroupUrl, checkDuplicateCommunity, isGenericGroupTitle, generateSlug } from '@/src/utils/helpers';
import { scrapeGroupMetadataDirect, normalizePlatformUrl, isGenericGroupImage } from '@/src/lib/metadata-scraper';
import { Group, Platform, Category, Language, Region } from '@/src/types';
import { resolveAuthContext } from '@/src/lib/auth-helpers';
import { requireAdmin } from '@/src/lib/admin-auth';
import { checkRateLimit, rateLimitResponse } from '@/src/lib/rate-limit';
import { REALTIME_NO_CACHE_HEADERS } from '@/src/lib/cache-control';
import { isAdultContentHidden } from '@/src/lib/content-settings';
import { uploadImageToR2 } from '@/src/lib/r2-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') || searchParams.get('q') || undefined;
    const platform = (searchParams.get('platform') as Platform | 'all') || undefined;
    const category = (searchParams.get('category') as Category | 'all') || undefined;
    const language = (searchParams.get('language') as Language | 'all') || undefined;
    const region = (searchParams.get('region') as Region | 'all') || undefined;
    const tag = searchParams.get('tag') || undefined;
    const sortBy = searchParams.get('sort') || searchParams.get('sortBy') || 'newest';
    const verifiedOnly = searchParams.get('verifiedOnly') === 'true';
    const rankOptimizedOnly = searchParams.get('rankOptimizedOnly') === 'true';
    const memberRange = searchParams.get('memberRange') || undefined;
    const showAdultOnly = searchParams.get('showAdultOnly') === 'true';
    const includeAdult = searchParams.get('includeAdult') === 'true' || searchParams.get('adminMode') === 'true';
    const stickyOnly = searchParams.get('stickyOnly') === 'true';
    const forDirectPromotedPage = searchParams.get('forDirectPromotedPage') === 'true';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || searchParams.get('limit') || '24', 10)));
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined;

    const result = await getGroups({
      search,
      platform: platform && platform !== 'all' ? platform : undefined,
      category: category && category !== 'all' && (category as string) !== 'All Categories' ? category : undefined,
      language: language && language !== 'all' ? language : undefined,
      region: region && region !== 'all' ? region : undefined,
      tag,
      sort: sortBy,
      verifiedOnly,
      rankOptimizedOnly,
      memberRange,
      showAdultOnly,
      includeAdult,
      stickyOnly,
      forDirectPromotedPage,
      page,
      pageSize,
      offset,
      limit: pageSize,
    });

    return NextResponse.json(result, {
      headers: REALTIME_NO_CACHE_HEADERS,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      {
        status: 500,
        headers: REALTIME_NO_CACHE_HEADERS,
      }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthContext(req);

    // Rate limit: 30 submissions per 10 minutes per IP for non-admins (relaxed to prevent false 429 lockouts)
    if (!auth.isAdmin) {
      const rateLimit = checkRateLimit(req, { limit: 30, windowMs: 10 * 60 * 1000, route: 'api_groups_post' });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds, 'Submission rate limit reached. Please wait before submitting another community.', 30, req);
      }
    }

    const body = await req.json().catch(() => ({}));
    console.log('[API /api/groups POST] Incoming group submission:', {
      title: body.title,
      url: body.url,
      platform: body.platform,
      category: body.category,
      memberCount: body.memberCount,
      updateExisting: body.updateExisting,
    });

    if (!body.url || typeof body.url !== 'string' || !body.url.trim()) {
      console.warn('[API /api/groups POST] Rejected: Missing invite URL');
      return NextResponse.json({ success: false, error: 'Group invite URL is required' }, { status: 400, headers: REALTIME_NO_CACHE_HEADERS });
    }

    if (isAdultContentHidden() && (body.isNsfw || body.category === 'Adult / 18+')) {
      return NextResponse.json(
        { success: false, error: 'Adult communities cannot be submitted at this time while AdSense compliance mode is active.' },
        { status: 400, headers: REALTIME_NO_CACHE_HEADERS }
      );
    }

    const rawUrl = body.url.trim();
    const norm = normalizePlatformUrl(rawUrl);
    const normalizedUrl = norm.normalizedUrl;

    const urlValidation = validateGroupUrl(normalizedUrl);
    if (!urlValidation.isValid) {
      console.warn('[API /api/groups POST] Rejected: Invalid URL pattern:', urlValidation.errorMessage);
      return NextResponse.json(
        { success: false, error: urlValidation.errorMessage || 'Invalid group invite URL provided.' },
        { status: 400, headers: REALTIME_NO_CACHE_HEADERS }
      );
    }

    const detectedPlatform = urlValidation.platform !== 'other'
      ? urlValidation.platform
      : (body.platform || norm.platform || 'other');

    // 1. Live Metadata Re-fetch before saving
    let fetchedMetadata: any = null;
    try {
      fetchedMetadata = await scrapeGroupMetadataDirect(normalizedUrl, detectedPlatform);
    } catch (scErr: any) {
      console.warn('[API /api/groups POST] Live scrape notice:', scErr?.message);
    }

    // Required Debug Log: Before save
    console.log('Fetched metadata', fetchedMetadata);

    // Determine Title: If scraped title exists and is valid, it takes high priority. 
    // Only use userProvidedTitle if it is clearly not a placeholder/hash.
    let rawTitle = '';
    const userProvidedTitle = body.title && typeof body.title === 'string' ? body.title.trim() : '';
    const userTitleIsGenericOrHash = !userProvidedTitle || isGenericGroupTitle(userProvidedTitle) || (/^[+]?[a-zA-Z0-9_-]{10,}$/.test(userProvidedTitle) && !userProvidedTitle.includes(' '));

    if (fetchedMetadata && fetchedMetadata.title && !isGenericGroupTitle(fetchedMetadata.title)) {
        rawTitle = fetchedMetadata.title;
    } else if (userProvidedTitle && !userTitleIsGenericOrHash) {
      rawTitle = userProvidedTitle;
    } else if (userProvidedTitle) {
      rawTitle = userProvidedTitle;
    } else if (fetchedMetadata?.title) {
      rawTitle = fetchedMetadata.title;
    }

    const isInviteCode = !rawTitle || rawTitle.length < 2 || (/^[a-zA-Z0-9_-]{10,}$/.test(rawTitle) && !rawTitle.includes(' '));
    let initialTitle = '';
    if (!isInviteCode) {
      initialTitle = rawTitle;
    } else {
      const platCap = detectedPlatform.charAt(0).toUpperCase() + detectedPlatform.slice(1);
      initialTitle = `${platCap} Community Group (${fetchedMetadata?.suggestedCategory || body.category || 'General'})`;
    }

    // Real-Time Health & Expiration Check during submission
    const { checkGroupLinkHealth } = await import('@/src/lib/link-health');
    const healthCheck = await checkGroupLinkHealth({
      id: 'submission_temp',
      url: normalizedUrl,
      platform: detectedPlatform,
    } as any);

    if (
      !healthCheck.isActive && 
      (healthCheck.status === 'expired' || healthCheck.status === 'revoked' || healthCheck.status === 'dead') &&
      detectedPlatform !== 'snapchat' &&
      detectedPlatform !== 'signal' &&
      detectedPlatform !== 'facebook' &&
      detectedPlatform !== 'other'
    ) {
      console.warn('[API /api/groups POST] Rejected: Link health check failed:', healthCheck.reason);
      return NextResponse.json(
        { 
          success: false, 
          error: `🚫 Submission Blocked: This invite link is expired, inactive, or revoked. Reason: ${healthCheck.reason || 'Invalid link response'}. Please generate a fresh, working invite link from your app and try again.` 
        },
        { status: 400, headers: REALTIME_NO_CACHE_HEADERS }
      );
    }

    const cleanTitle = sanitizeInput(initialTitle).slice(0, 255);
    if (cleanTitle.length < 2) {
      console.warn('[API /api/groups POST] Rejected: Title too short:', cleanTitle);
      return NextResponse.json({ success: false, error: 'Title must be at least 2 characters long.' }, { status: 400, headers: REALTIME_NO_CACHE_HEADERS });
    }

    // Description (user explicit input takes highest priority)
    let cleanDesc = '';
    if (body.description && typeof body.description === 'string' && body.description.trim()) {
      cleanDesc = body.description.trim();
    } else if (fetchedMetadata && fetchedMetadata.description && !fetchedMetadata.fallbackMetadata) {
      cleanDesc = fetchedMetadata.description;
    } else if (fetchedMetadata?.description) {
      cleanDesc = fetchedMetadata.description;
    } else {
      cleanDesc = `Official ${detectedPlatform} community for ${cleanTitle}. Connect with active members now.`;
    }
    cleanDesc = sanitizeInput(cleanDesc).slice(0, 5000);

    // Images (user explicit input takes highest priority)
    // Images (user explicit input takes highest priority unless it was empty or a fallback SVG)
    let rawImageUrl = body.imageUrl || '';
    if ((!rawImageUrl || rawImageUrl.startsWith('data:image/') || rawImageUrl.includes('fallback') || isGenericGroupImage(rawImageUrl)) && fetchedMetadata && fetchedMetadata.imageUrl && !fetchedMetadata.fallbackMetadata) {
      rawImageUrl = fetchedMetadata.imageUrl;
    } else if (!rawImageUrl && fetchedMetadata?.imageUrl) {
      rawImageUrl = fetchedMetadata.imageUrl;
    }

    let rawBannerUrl = body.bannerUrl || '';
    if ((!rawBannerUrl || rawBannerUrl.startsWith('data:image/') || isGenericGroupImage(rawBannerUrl)) && fetchedMetadata && fetchedMetadata.bannerUrl && !fetchedMetadata.fallbackMetadata) {
      rawBannerUrl = fetchedMetadata.bannerUrl;
    } else if (!rawBannerUrl && fetchedMetadata?.bannerUrl) {
      rawBannerUrl = fetchedMetadata.bannerUrl;
    }

    let finalImageUrl = rawImageUrl;
    let finalBannerUrl = rawBannerUrl;

    if (rawImageUrl) {
      try {
        const r2Res = await uploadImageToR2(rawImageUrl, cleanTitle);
        if (r2Res.success && r2Res.r2Url) {
          finalImageUrl = r2Res.r2Url;
          if (!rawBannerUrl || rawBannerUrl === rawImageUrl) {
            finalBannerUrl = r2Res.r2Url;
          }
        }
      } catch (r2Err) {
        console.warn('[R2 SUBMISSION STORAGE] Compress and upload notice:', r2Err);
      }
    }

    // Member & Online counts (Live scraped subscribers take priority if memberCount was left as default 100)
    let finalMemberCount: number | undefined = undefined;
    if (body.memberCount && Number(body.memberCount) > 0 && Number(body.memberCount) !== 100) {
      finalMemberCount = Math.min(500000000, Math.max(1, Number(body.memberCount)));
    } else if (typeof fetchedMetadata?.memberCount === 'number' && fetchedMetadata.memberCount > 0) {
      finalMemberCount = fetchedMetadata.memberCount;
    } else if (body.memberCount && Number(body.memberCount) > 0) {
      finalMemberCount = Math.min(500000000, Math.max(1, Number(body.memberCount)));
    }

    const finalOnlineCount = typeof fetchedMetadata?.onlineCount === 'number' ? fetchedMetadata.onlineCount : undefined;

    let cleanCategory = body.isNsfw
      ? 'Adult / 18+'
      : (body.category || fetchedMetadata?.suggestedCategory || 'General');

    if ((!cleanCategory || cleanCategory === 'Tech & Programming' || cleanCategory === 'General') && fetchedMetadata?.suggestedCategory && fetchedMetadata.suggestedCategory !== 'General') {
      cleanCategory = fetchedMetadata.suggestedCategory;
    }

    const cleanLanguage = body.language || fetchedMetadata?.suggestedLanguage || 'English';
    const cleanRegion = body.region || 'Global';
    const cleanTags = Array.isArray(body.customTags) && body.customTags.length > 0
      ? body.customTags.slice(0, 10).map((t: any) => sanitizeInput(String(t).trim()).slice(0, 30))
      : (fetchedMetadata?.suggestedTags || [`#${detectedPlatform}`, '#community']);

    const cleanRules = sanitizeInput((body.rulesSummary || fetchedMetadata?.rulesSummary || '').trim()).slice(0, 500);
    const cleanAuthor = body.authorName
      ? sanitizeInput(body.authorName.trim()).slice(0, 60)
      : (auth.user?.displayName || 'Community Member');

    let isApproved = true;
    let isVerified = Boolean(fetchedMetadata?.isVerified) || (auth.isAdmin ? Boolean(body.verified) : false);
    let isSticky = auth.isAdmin ? Boolean(body.isSticky) : false;

    // Check if updating an existing group or if duplicate link already exists in database
    let targetGroup: Group | null = null;
    if (body.existingGroupId) {
      targetGroup = await getGroupById(body.existingGroupId);
    }
    if (!targetGroup && norm.platformHandle) {
      const handleSlug = `${detectedPlatform === 'telegram' ? 'tg-' : ''}${norm.platformHandle.toLowerCase()}`;
      targetGroup = await getGroupBySlug(handleSlug) || await getGroupBySlug(norm.platformHandle);
    }
    if (!targetGroup) {
      const { getGroupsDatabase } = await import('@/src/lib/groups-store');
      const storeDb = getGroupsDatabase();
      const dup = checkDuplicateCommunity({
        url: normalizedUrl,
        title: cleanTitle,
        platform: detectedPlatform,
      }, storeDb);
      if (dup.isDuplicate && dup.matchedGroup) {
        targetGroup = dup.matchedGroup;
      }
      if (!targetGroup && norm.platformHandle) {
        targetGroup = storeDb.find((g: Group) => 
          g && g.platform === detectedPlatform && 
          ((g.slug && g.slug.toLowerCase().includes(norm.platformHandle!.toLowerCase())) ||
           (g.url && g.url.toLowerCase().includes(norm.platformHandle!.toLowerCase())))
        ) || null;
      }
    }

    if (targetGroup) {
      // 24-Hour Group Update Restriction Rule:
      // When a user has updated any group, allow it to be updated again after 24 hours only.
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      const lastUpdatedAt = targetGroup.updatedAt ? new Date(targetGroup.updatedAt).getTime() : 0;
      const timeSinceLastUpdate = Date.now() - lastUpdatedAt;

      const isBypass = Boolean(auth.isAdmin || body.forceUpdate || body.bypassCooldown);
      if (!isBypass && lastUpdatedAt > 0 && timeSinceLastUpdate < TWENTY_FOUR_HOURS_MS) {
        const remainingMs = TWENTY_FOUR_HOURS_MS - timeSinceLastUpdate;
        const hoursRemaining = Math.floor(remainingMs / (60 * 60 * 1000));
        const minutesRemaining = Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
        const timeStr = hoursRemaining > 0 
          ? `${hoursRemaining} hour${hoursRemaining > 1 ? 's' : ''} and ${minutesRemaining} minute${minutesRemaining > 1 ? 's' : ''}`
          : `${minutesRemaining} minute${minutesRemaining > 1 ? 's' : ''}`;

        return NextResponse.json(
          {
            success: false,
            cooldown: true,
            error: `⏳ Update Cooldown Active: This community was updated recently. Community details can only be refreshed once every 24 hours. Please try again in ${timeStr}.`,
            retryAfterHours: Math.ceil(remainingMs / (60 * 60 * 1000)),
            group: targetGroup,
          },
          { status: 200, headers: REALTIME_NO_CACHE_HEADERS }
        );
      }

      // Required Debug Log: During update
      console.log('Updating existing group', targetGroup.id, fetchedMetadata);

      const finalUpdateTitle = (cleanTitle && !isGenericGroupTitle(cleanTitle))
        ? cleanTitle
        : (targetGroup.title && !isGenericGroupTitle(targetGroup.title) ? targetGroup.title : cleanTitle);

      const updated = await updateGroup(targetGroup.id, {
        title: finalUpdateTitle,
        url: rawUrl, // Preserve exact user-pasted invite link as-is
        description: cleanDesc || targetGroup.description,
        isUserSubmission: true,
        updateExisting: true,
        category: cleanCategory,
        language: cleanLanguage,
        region: cleanRegion,
        customTags: cleanTags,
        imageUrl: finalImageUrl || targetGroup.imageUrl,
        bannerUrl: finalBannerUrl || targetGroup.bannerUrl || finalImageUrl,
        rulesSummary: cleanRules || targetGroup.rulesSummary,
        memberCount: finalMemberCount || targetGroup.memberCount,
        onlineCount: finalOnlineCount || targetGroup.onlineCount,
        metadataSource: fetchedMetadata?.metadataSource || targetGroup.metadataSource || 'telegram',
        fallbackMetadata: Boolean(fetchedMetadata?.fallbackMetadata),
        lastMetadataFetchAt: fetchedMetadata?.lastMetadataFetchAt || new Date().toISOString(),
        metadataFetchError: fetchedMetadata?.metadataFetchError || null,
        normalizedUrl,
        platformHandle: norm.platformHandle || targetGroup.platformHandle,
        authorName: cleanAuthor || targetGroup.authorName,
        updatedAt: new Date().toISOString(),
      } as any);

      const savedGroup = updated || targetGroup;

      // Required Debug Log: After save
      console.log('Saved group', savedGroup);

      // Revalidate cache & ISR paths across all platform page variants
      try {
        revalidatePath('/', 'layout');
        revalidatePath('/');
        revalidatePath(`/${detectedPlatform}`);
        revalidatePath(`/${detectedPlatform}-groups`);
        revalidatePath(`/${detectedPlatform}-channels`);
        revalidatePath(`/${detectedPlatform}-communities`);
        revalidatePath(`/${detectedPlatform}-servers`);
        if (targetGroup.slug) {
          revalidatePath(`/group/${targetGroup.slug}`);
          revalidatePath(`/community/${targetGroup.slug}`);
          revalidatePath(`/server/${targetGroup.slug}`);
        }
        if (savedGroup.slug) {
          revalidatePath(`/group/${savedGroup.slug}`);
          revalidatePath(`/community/${savedGroup.slug}`);
          revalidatePath(`/server/${savedGroup.slug}`);
        }
        if (targetGroup.id) revalidatePath(`/group/${targetGroup.id}`);
        if (savedGroup.id) revalidatePath(`/group/${savedGroup.id}`);
        revalidatePath(`/category/${categoryToSlug(cleanCategory)}`);
      } catch (revErr) {
        console.warn('[API /api/groups POST] Revalidation warning:', revErr);
      }

      return NextResponse.json({
        success: true,
        updated: true,
        isUpdate: true,
        message: 'Existing group updated with latest platform details.',
        group: savedGroup,
      }, { status: 200, headers: REALTIME_NO_CACHE_HEADERS });
    }

    // Create group in self-hosted server store
    const newGroup = await createGroup({
      title: cleanTitle,
      slug: generateSlug(cleanTitle),
      description: cleanDesc,
      url: rawUrl, // Preserve exact user-pasted invite link as-is
      originalUrl: rawUrl,
      normalizedUrl,
      platformHandle: norm.platformHandle,
      platform: detectedPlatform,
      category: cleanCategory,
      language: cleanLanguage,
      region: cleanRegion,
      customTags: cleanTags,
      imageUrl: finalImageUrl,
      bannerUrl: finalBannerUrl || finalImageUrl,
      verified: isVerified,
      isSticky: isSticky,
      authorName: cleanAuthor,
      authorEmail: body.contactEmail || body.authorEmail || auth.user?.email,
      rulesSummary: cleanRules,
      memberCount: finalMemberCount || 100,
      onlineCount: finalOnlineCount,
      metadataSource: fetchedMetadata?.metadataSource || 'fallback',
      fallbackMetadata: Boolean(fetchedMetadata?.fallbackMetadata),
      lastMetadataFetchAt: fetchedMetadata?.lastMetadataFetchAt || new Date().toISOString(),
      metadataFetchError: fetchedMetadata?.metadataFetchError || null,
      upvotes: 0,
      clicks: 0,
      shares: 0,
      bookmarks: 0,
      rating: 0,
      ratingCount: 0,
      growthRate: 0,
      status: isApproved ? 'approved' : 'pending',
      isActive: isApproved,
      is_active: isApproved,
      updateExisting: Boolean(body.updateExisting),
    } as any);

    // Required Debug Log: After save (for new group)
    console.log('Saved group', newGroup);

    // Revalidate paths for new community across all platforms and routes
    try {
      revalidatePath('/', 'layout');
      revalidatePath('/');
      revalidatePath(`/${detectedPlatform}`);
      revalidatePath(`/${detectedPlatform}-groups`);
      revalidatePath(`/${detectedPlatform}-channels`);
      revalidatePath(`/${detectedPlatform}-communities`);
      revalidatePath(`/${detectedPlatform}-servers`);
      if (newGroup.slug) {
        revalidatePath(`/group/${newGroup.slug}`);
        revalidatePath(`/community/${newGroup.slug}`);
        revalidatePath(`/server/${newGroup.slug}`);
      }
      if (newGroup.id) revalidatePath(`/group/${newGroup.id}`);
      revalidatePath(`/category/${categoryToSlug(cleanCategory)}`);
    } catch (revErr) {
      console.warn('[API /api/groups POST] Revalidation warning:', revErr);
    }

    // If the user is logged in, instantly set them as the owner & verified claimant of the newly submitted group!
    if (auth.isAuthenticated && auth.userId && newGroup.id) {
      const { getPool } = await import('@/src/lib/db');
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `UPDATE groups_dir SET claimedByUserId = ?, owner_id = ?, isClaimed = 1, verified = 1 WHERE id = ?`,
            [auth.userId, auth.userId, newGroup.id]
          );
        } catch (dbErr: any) {
          console.warn('[MySQL assign ownership on submit notice]:', dbErr?.message);
        }
      }

      // Sync local in-memory store
      try {
        const { getGroupsDatabase } = await import('@/src/lib/groups-store');
        const db = getGroupsDatabase();
        const found = db.find((item: any) => item.id === newGroup.id);
        if (found) {
          found.claimedByUserId = auth.userId;
          found.ownerId = auth.userId;
          found.isClaimed = true;
          found.verified = true;
        }
      } catch (err: any) {
        console.warn('[Assign ownership in memory store notice]:', err?.message);
      }

      // Update local object to return correctly in the response
      newGroup.claimedByUserId = auth.userId;
      newGroup.isClaimed = true;
      newGroup.verified = true;
    }

    // Targeted ISR revalidation: only invalidate specific affected routes
    try {
      revalidatePath('/');
      if (newGroup.platform) {
        const plat = newGroup.platform.toLowerCase();
        if (plat === 'whatsapp') revalidatePath('/whatsapp-groups');
        else if (plat === 'telegram') {
          revalidatePath('/telegram-groups');
          revalidatePath('/telegram-channels');
        } else if (plat === 'discord') revalidatePath('/discord-servers');
        else if (plat === 'facebook') revalidatePath('/facebook-groups');
        else if (plat === 'signal') revalidatePath('/signal-groups');
        else if (plat === 'snapchat') revalidatePath('/snapchat-groups');
        else if (plat === 'reddit') revalidatePath('/reddit-communities');
      }
      if (newGroup.category) {
        revalidatePath(`/categories/${categoryToSlug(newGroup.category)}`);
      }
      if (newGroup.region) {
        revalidatePath(`/country/${countryToSlug(newGroup.region)}`);
      }
      if (newGroup.language) {
        revalidatePath(`/language/${languageToSlug(newGroup.language)}`);
      }
      if (Array.isArray(newGroup.customTags)) {
        for (const t of newGroup.customTags) {
          const s = tagToSlug(t);
          if (s) revalidatePath(`/tag/${s}`);
        }
      }
      revalidatePath('/sitemap.xml');
      revalidatePath('/sitemap-groups.xml');
    } catch {}

    return NextResponse.json({ success: true, group: newGroup }, { status: 201, headers: REALTIME_NO_CACHE_HEADERS });
  } catch (error: any) {
    const isRestricted = error.message && (error.message.includes('prohibited') || error.message.includes('restricted') || error.message.includes('rejected') || error.message.includes('Zero tolerance') || error.message.includes('already listed'));
    const isDuplicate = Boolean(error.isDuplicate || (error.message && error.message.includes('already listed')));
    return NextResponse.json({
      success: false,
      error: error.message,
      isDuplicate,
      matchedGroup: error.matchedGroup || null,
    }, { status: isRestricted ? 400 : 500, headers: REALTIME_NO_CACHE_HEADERS });
  }
}

export async function DELETE(req: NextRequest) {
  // Enforce admin permission for batch delete
  const auth = requireAdmin(req);
  if (!auth.authorized) {
    return auth.response!;
  }

  try {
    const body = await req.json();
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const deletedCount = await deleteMultipleGroups(body.ids);
      try {
        revalidatePath('/', 'layout');
      } catch {}
      return NextResponse.json({ success: true, count: deletedCount }, { headers: REALTIME_NO_CACHE_HEADERS });
    }
    return NextResponse.json({ error: 'ids array required' }, { status: 400, headers: REALTIME_NO_CACHE_HEADERS });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: REALTIME_NO_CACHE_HEADERS });
  }
}
