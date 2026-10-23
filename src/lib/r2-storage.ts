import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

/**
 * Service to process, compress (150x150 WebP) and upload group images
 * directly to Cloudflare R2 Bucket storage (S3 Compatible API).
 *
 * Required Environment Variables:
 * - R2_ACCOUNT_ID (e.g. "a1b2c3d4e5f6...")
 * - R2_ACCESS_KEY_ID
 * - R2_SECRET_ACCESS_KEY
 * - R2_BUCKET_NAME (e.g. "grouplinks-assets")
 * - R2_PUBLIC_DOMAIN (e.g. "https://pub-xyz.r2.dev" or "https://assets.yourdomain.com")
 */

interface R2UploadResult {
  success: boolean;
  r2Url?: string;
  key?: string;
  error?: string;
}

let s3ClientInstance: S3Client | null = null;

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

export function getR2Client(): { client: S3Client; bucket: string; publicDomain: string } | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || 'grouplinks-assets';
  let publicDomain = process.env.R2_PUBLIC_DOMAIN || 'https://cdn.grouplinks.app';

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  if (publicDomain && !publicDomain.startsWith('http://') && !publicDomain.startsWith('https://')) {
    publicDomain = `https://${publicDomain}`;
  }

  if (!s3ClientInstance) {
    s3ClientInstance = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  return { client: s3ClientInstance, bucket, publicDomain };
}

/**
 * Downloads image from remote URL or Base64/SVG data URI, heavily resizes & compresses it
 * to 150x150 WebP format for fair use compliance, and uploads to Cloudflare R2 (cdn.grouplinks.app).
 */
export async function uploadImageToR2(
  sourceImageUrl: string,
  imageKeyPrefix: string = 'group-icon',
  customExactKey?: string
): Promise<R2UploadResult> {
  const r2 = getR2Client();
  if (!r2) {
    return {
      success: false,
      error: 'Cloudflare R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are not configured.',
    };
  }

  if (!sourceImageUrl || typeof sourceImageUrl !== 'string' || !sourceImageUrl.trim()) {
    return { success: false, error: 'Empty source image URL' };
  }

  const cleanUrl = sourceImageUrl.trim().replace(/&amp;/g, '&');

  try {
    let inputBuffer: Buffer;

    if (cleanUrl.startsWith('data:image/')) {
      if (cleanUrl.includes(';base64,')) {
        const base64Data = cleanUrl.split(';base64,')[1];
        if (!base64Data) throw new Error('Invalid base64 data URI');
        inputBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const rawPart = cleanUrl.split(',')[1];
        if (!rawPart) throw new Error('Invalid data URI payload');
        inputBuffer = Buffer.from(decodeURIComponent(rawPart), 'utf-8');
      }
    } else {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (!res || !res.ok) {
        return { success: false, error: `Failed to download source image from ${cleanUrl}` };
      }

      const arrayBuffer = await res.arrayBuffer();
      inputBuffer = Buffer.from(arrayBuffer);
    }

    // Server-side image integrity & validity check
    if (!inputBuffer || inputBuffer.length < 500) {
      return { success: false, error: 'Image file is too small or empty (< 500 bytes)' };
    }

    const metadata = await sharp(inputBuffer).metadata().catch(() => null);
    if (!metadata || !metadata.format || !metadata.width || !metadata.height || metadata.width < 10 || metadata.height < 10) {
      return { success: false, error: 'Invalid, corrupted, or broken image file detected during server-side verification' };
    }

    // 150x150 Heavy WebP Compression (Fair Use Thumbnail Specs)
    const compressedWebpBuffer = await sharp(inputBuffer)
      .resize(150, 150, {
        fit: 'cover',
        position: 'center',
        withoutEnlargement: false,
      })
      .webp({
        quality: 75,
        effort: 6,
      })
      .toBuffer();

    const sanitizePrefix = imageKeyPrefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
    const uniqueKey = customExactKey || `icons/${sanitizePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.webp`;

    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: uniqueKey,
        Body: compressedWebpBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const r2Url = r2.publicDomain
      ? `${r2.publicDomain.replace(/\/+$/, '')}/${uniqueKey}`
      : `https://${r2.bucket}.r2.cloudflarestorage.com/${uniqueKey}`;
    
    console.log('[R2 UPLOAD SUCCESS]', { r2Url, uniqueKey });

    return {
      success: true,
      r2Url,
      key: uniqueKey,
    };
  } catch (err: any) {
    console.error('[R2 UPLOAD ERROR]', err);
    return {
      success: false,
      error: err.message || 'Error executing Cloudflare R2 upload.',
    };
  }
}

/**
 * Deletes an image from Cloudflare R2 bucket.
 */
export async function deleteImageFromR2(imageKeyOrUrl: string): Promise<boolean> {
  const r2 = getR2Client();
  if (!r2 || !imageKeyOrUrl) return false;

  try {
    let key = imageKeyOrUrl;
    if (imageKeyOrUrl.startsWith('http://') || imageKeyOrUrl.startsWith('https://')) {
      const urlObj = new URL(imageKeyOrUrl);
      key = urlObj.pathname.replace(/^\/+/, '');
    }

    if (!key) return false;

    await r2.client.send(
      new DeleteObjectCommand({
        Bucket: r2.bucket,
        Key: key,
      })
    );

    return true;
  } catch (err) {
    console.warn('[R2 DELETE NOTICE]:', err);
    return false;
  }
}
