import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { getSiteUrl, generateWebSiteJsonLd, generateOrganizationJsonLd } from '@/src/lib/rank';
import { getCustomScriptsServer } from '@/src/lib/server-scripts-persistence';
import AppProviders from '@/src/components/AppProviders';

function getSanitizedGaId(customId?: string): string | null {
  const candidate = (
    process.env.NEXT_PUBLIC_GA_ID ||
    process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID ||
    process.env.GA_MEASUREMENT_ID ||
    process.env.GOOGLE_ANALYTICS_ID ||
    customId ||
    ''
  ).trim();

  if (!candidate) return null;

  // Sanitize: allow only valid alphanumeric and hyphens (e.g., G-1234568)
  if (/^[A-Za-z0-9_-]+$/.test(candidate)) {
    return candidate;
  }

  return null;
}

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
  display: 'swap',
});

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'WhatsApp, Telegram & Discord Groups | Group Links Directory',
    template: '%s | Group Links',
  },
  description:
    'Discover active WhatsApp groups, Telegram channels, Discord servers and online communities by category, language and region. Browse verified group links and join communities that match your interests.',
  keywords: [
    'WhatsApp groups',
    'Telegram channels',
    'Discord servers',
    'Signal groups',
    'Reddit communities',
    'Facebook groups',
    'Snapchat groups',
    'social discovery',
    'group invite links',
    'verified groups',
  ],
  authors: [{ name: 'Group Links' }],
  creator: 'Group Links',
  publisher: 'Group Links',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'GroupLinks',
  },
  icons: {
    apple: 'https://api.dicebear.com/7.x/identicon/svg?seed=grouplinks&backgroundColor=6366f1',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: siteUrl,
    siteName: 'Group Links',
    title: 'WhatsApp, Telegram & Discord Groups | Group Links Directory',
    description:
      'Discover active WhatsApp groups, Telegram channels, Discord servers and online communities by category, language and region.',
    images: [
      {
        url: `${siteUrl}/og-image.png`,
        width: 1200,
        height: 630,
        alt: 'Group Links Community Discovery',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WhatsApp, Telegram & Discord Groups | Group Links Directory',
    description:
      'Discover active WhatsApp groups, Telegram channels, Discord servers and online communities by category, language and region.',
    images: [`${siteUrl}/og-image.png`],
  },
};

export const viewport: Viewport = {
  themeColor: '#020617',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const websiteSchema = generateWebSiteJsonLd();
  const orgSchema = generateOrganizationJsonLd();
  const customScripts = getCustomScriptsServer();
  const gaId = getSanitizedGaId(customScripts?.googleAnalyticsId);

  return (
    <html lang="en" suppressHydrationWarning className={`dark scroll-smooth ${plusJakartaSans.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn.discordapp.com" />
        <link rel="dns-prefetch" href="https://cdn.discordapp.com" />
        <link rel="llms-txt" href="/llms.txt" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('error', function(e) {
                if (e && e.message && (e.message.indexOf('ChunkLoadError') !== -1 || e.message.indexOf('Loading chunk') !== -1)) {
                  var lastReload = sessionStorage.getItem('gl_chunk_retry');
                  var now = Date.now();
                  if (!lastReload || now - parseInt(lastReload, 10) > 8000) {
                    sessionStorage.setItem('gl_chunk_retry', String(now));
                    window.location.reload();
                  }
                }
              });
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-slate-950 text-slate-100 antialiased font-sans flex flex-col selection:bg-emerald-500 selection:text-white">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
        />
        {gaId && (
          <>
            <script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`}
            />
            <script
              id="google-analytics-init"
              dangerouslySetInnerHTML={{
                __html: `
                  window.dataLayer = window.dataLayer || [];
                  function gtag(){dataLayer.push(arguments);}
                  gtag('js', new Date());
                  gtag('config', '${gaId.replace(/'/g, "\\'")}', { page_path: window.location.pathname });
                `,
              }}
            />
          </>
        )}
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
