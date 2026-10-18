import fs from 'fs';
import path from 'path';
import { DEFAULT_ADULT_KEYWORDS } from '@/src/utils/keywordFilter';
import { DEFAULT_RESTRICTED_KEYWORDS } from '@/src/utils/moderation';

export interface ContentSettings {
  hideAdultContent: boolean;
  substitutionCategory: string;
  updatedAt: string;
  updatedBy: string;
}

const DATA_DIR = path.join(process.cwd(), '.data');
const SETTINGS_FILE = path.join(DATA_DIR, 'nexus-content-settings.json');

declare global {
  // eslint-disable-next-line no-var
  var __nexusContentSettings: ContentSettings | undefined;
}

const DEFAULT_SETTINGS: ContentSettings = {
  // Default to false so adult groups are visible by default while allowing users/admins to toggle hiding
  hideAdultContent: false,
  substitutionCategory: 'Tech & Programming',
  updatedAt: new Date().toISOString(),
  updatedBy: 'system',
};

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[CONTENT SETTINGS] Failed to create .data directory:', err);
  }
}

function loadSettingsFromDisk(): ContentSettings {
  try {
    ensureDataDir();
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf-8');
      return DEFAULT_SETTINGS;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (!raw.trim()) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      hideAdultContent: typeof parsed.hideAdultContent === 'boolean' ? parsed.hideAdultContent : DEFAULT_SETTINGS.hideAdultContent,
      substitutionCategory: typeof parsed.substitutionCategory === 'string' ? parsed.substitutionCategory : DEFAULT_SETTINGS.substitutionCategory,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy || 'system',
    };
  } catch (err) {
    console.error('[CONTENT SETTINGS] Error reading settings from disk:', err);
    return DEFAULT_SETTINGS;
  }
}

function saveSettingsToDisk(settings: ContentSettings): boolean {
  try {
    ensureDataDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[CONTENT SETTINGS] Error saving settings to disk:', err);
    return false;
  }
}

/**
 * Returns current content settings with 0ms in-memory latency.
 */
export function getContentSettings(): ContentSettings {
  if (!globalThis.__nexusContentSettings) {
    globalThis.__nexusContentSettings = loadSettingsFromDisk();
  }
  return globalThis.__nexusContentSettings;
}

/**
 * Updates content settings and persists immediately to disk.
 */
export function updateContentSettings(partial: Partial<ContentSettings>): ContentSettings {
  const current = getContentSettings();
  const updated: ContentSettings = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };

  globalThis.__nexusContentSettings = updated;
  saveSettingsToDisk(updated);
  return updated;
}

/**
 * Convenience getter for adult content hidden state (AdSense Safe Mode).
 */
export function isAdultContentHidden(): boolean {
  return getContentSettings().hideAdultContent;
}

/**
 * Convenience setter for adult content hidden state.
 */
export function setAdultContentHidden(hidden: boolean, updatedBy = 'admin'): boolean {
  updateContentSettings({
    hideAdultContent: hidden,
    updatedBy,
  });
  return hidden;
}

/**
 * Set of normalized adult keyword tokens for fast O(1) matching.
 */
const ADULT_KEYWORD_SET = new Set<string>([
  ...DEFAULT_ADULT_KEYWORDS.map(k => k.trim().toLowerCase()),
  ...DEFAULT_RESTRICTED_KEYWORDS.map(k => k.trim().toLowerCase()),
  'adult',
  '18+',
  '18plus',
  'nsfw',
  'xxx',
  'porn',
  'porno',
  'hentai',
  'erotic',
  'sex',
  'sexy',
  'nude',
  'nudes',
  'onlyfans',
  'fansly',
  'camgirl',
  'escort',
  'boobs',
  'milf',
  'hookup',
  'naked',
  'playboy',
  'mature',
]);

/**
 * Checks whether a word, tag, or phrase is related to adult content.
 */
export function isAdultKeywordOrTag(text: string): boolean {
  if (!text) return false;
  const clean = text.toLowerCase().replace(/^[#@]+/, '').trim();
  if (ADULT_KEYWORD_SET.has(clean)) return true;

  for (const kw of ADULT_KEYWORD_SET) {
    if (kw.length >= 3 && clean.includes(kw)) {
      return true;
    }
  }

  if (/\b(18\+|18plus|nsfw|xxx|porn|erotic|sex|sexy|nude|nudes|onlyfans|fansly|hentai|milf|camgirl|hookup)\b/i.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Filters out any adult-related keywords or tags from a list.
 */
export function filterAdultKeywords(keywords: string[]): string[] {
  if (!Array.isArray(keywords)) return [];
  return keywords.filter(k => !isAdultKeywordOrTag(k));
}
