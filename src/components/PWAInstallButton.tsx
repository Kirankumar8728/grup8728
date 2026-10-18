'use client';

import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Download, Smartphone, X, Share } from 'lucide-react';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // User explicitly asked to show only to mobile devices
  const isMobile = typeof window !== 'undefined' && /android|iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());

  if (!isMobile || isInstalled) {
    return null;
  }

  // Chromium / Android flow
  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-bold shadow-md shadow-indigo-600/25 transition-all hover:scale-105 active:scale-95 animate-pulse"
      >
        <Download className="w-3.5 h-3.5" />
        <span>Install App</span>
      </button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600/10 border border-indigo-600/30 text-indigo-600 dark:text-indigo-400 text-xs font-bold transition-all animate-pulse"
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
            <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-neutral-900 p-6 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-in zoom-in-95 duration-200">
              <div className="flex justify-between items-center mb-6">
                <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="p-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <h3 className="text-xl font-black text-neutral-900 dark:text-white mb-2">Install GroupLinks</h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed mb-6">
                Add GroupLinks to your home screen for a fast, native-like experience on your iPhone or iPad.
              </p>

              <div className="space-y-4">
                <div className="flex items-center gap-4 p-3 rounded-2xl bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-100 dark:border-neutral-800">
                  <div className="w-8 h-8 rounded-full bg-white dark:bg-neutral-800 shadow-sm flex items-center justify-center text-sm font-bold">1</div>
                  <div className="flex-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                    Tap the <span className="inline-block p-1 bg-white dark:bg-neutral-700 rounded mx-0.5"><Share className="w-3.5 h-3.5 inline text-indigo-500" /></span> <span className="font-bold">Share</span> button in Safari.
                  </div>
                </div>
                <div className="flex items-center gap-4 p-3 rounded-2xl bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-100 dark:border-neutral-800">
                  <div className="w-8 h-8 rounded-full bg-white dark:bg-neutral-800 shadow-sm flex items-center justify-center text-sm font-bold">2</div>
                  <div className="flex-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                    Scroll down and select <span className="font-bold">Add to Home Screen</span>.
                  </div>
                </div>
              </div>

              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-8 w-full rounded-2xl bg-indigo-600 py-3.5 text-sm font-black text-white shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-95"
              >
                Got it!
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
