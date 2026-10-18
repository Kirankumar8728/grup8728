'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Cloud,
  CloudUpload,
  RefreshCw,
  Trash2,
  ExternalLink,
  ShieldCheck,
  Calendar,
  Clock,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  FileJson,
  Check,
  Loader2
} from 'lucide-react';
import {
  signInWithGoogleDrive,
  getDriveAccessToken,
  signOutDrive,
  initDriveAuth
} from '@/src/lib/firebase-drive';

interface DriveFileItem {
  id: string;
  name: string;
  size?: string;
  createdTime: string;
  webViewLink?: string;
  webContentLink?: string;
  isExpired?: boolean;
  daysOld?: number;
  daysRemaining?: number;
}

interface Props {
  onRefreshSiteData?: () => void;
}

export const GoogleDriveBackupSection: React.FC<Props> = ({ onRefreshSiteData }) => {
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userPhoto, setUserPhoto] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isPruning, setIsPruning] = useState(false);
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auto-backup configuration state (persisted locally)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true);
  const [backupIntervalDays, setBackupIntervalDays] = useState(7); // default: 7 = weekly
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [isPruningDb, setIsPruningDb] = useState(false);

  // Destructive Action Modal States
  const [pendingDeleteFile, setPendingDeleteFile] = useState<DriveFileItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [pendingRestoreFile, setPendingRestoreFile] = useState<DriveFileItem | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [isRestoring, setIsRestoring] = useState(false);

  // Load preferences from localStorage on mount
  useEffect(() => {
    try {
      const savedAuto = localStorage.getItem('grouplinks_drive_autobackup_enabled');
      if (savedAuto !== null) setAutoBackupEnabled(savedAuto === 'true');

      const savedInterval = localStorage.getItem('grouplinks_drive_autobackup_interval');
      if (savedInterval) {
        setBackupIntervalDays(Number(savedInterval) || 7);
      } else {
        setBackupIntervalDays(7);
      }

      const savedLast = localStorage.getItem('grouplinks_drive_autobackup_last');
      if (savedLast) setLastBackupTime(savedLast);
    } catch {}
  }, []);

  // Save settings helpers
  const handleToggleAutoBackup = (enabled: boolean) => {
    setAutoBackupEnabled(enabled);
    try {
      localStorage.setItem('grouplinks_drive_autobackup_enabled', String(enabled));
    } catch {}
  };

  const handleChangeInterval = (days: number) => {
    setBackupIntervalDays(days);
    try {
      localStorage.setItem('grouplinks_drive_autobackup_interval', String(days));
    } catch {}
  };

  // Fetch list of backup files from Google Drive
  const fetchDriveBackups = useCallback(async (authToken: string) => {
    setIsLoadingFiles(true);
    try {
      const res = await fetch('/api/admin/drive-backup', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.files)) {
        setFiles(data.files);
      } else if (data.error) {
        setErrorMessage(data.error);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to communicate with Google Drive.');
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  // Initialize Firebase Auth listener
  useEffect(() => {
    const unsubscribe = initDriveAuth(
      (user, existingToken) => {
        setUserEmail(user.email);
        setUserPhoto(user.photoURL);
        const currentToken = existingToken || getDriveAccessToken();
        if (currentToken) {
          setToken(currentToken);
          fetchDriveBackups(currentToken);
        }
      },
      () => {
        setUserEmail(null);
        setUserPhoto(null);
        setToken(null);
        setFiles([]);
      }
    );

    return () => unsubscribe();
  }, [fetchDriveBackups]);

  // Connect Google Drive
  const handleConnectDrive = async () => {
    setIsAuthenticating(true);
    setErrorMessage(null);
    setStatusNotice(null);
    try {
      const { user, accessToken } = await signInWithGoogleDrive();
      setUserEmail(user.email);
      setUserPhoto(user.photoURL);
      setToken(accessToken);
      setStatusNotice(`Connected Google Drive for ${user.email}!`);
      await fetchDriveBackups(accessToken);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to authenticate with Google Drive.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Disconnect Google Drive
  const handleDisconnectDrive = async () => {
    try {
      await signOutDrive();
      setToken(null);
      setUserEmail(null);
      setUserPhoto(null);
      setFiles([]);
      setStatusNotice('Disconnected from Google Drive.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to sign out of Google Drive.');
    }
  };

  // Perform Manual / Triggered Backup to Google Drive
  const handleBackupNow = async (authToken?: string) => {
    const activeToken = authToken || token || getDriveAccessToken();
    if (!activeToken) {
      setErrorMessage('Please connect your Google Drive first to perform backup.');
      return;
    }

    setIsBackingUp(true);
    setErrorMessage(null);
    setStatusNotice(null);

    try {
      const res = await fetch('/api/admin/drive-backup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'backup' })
      });

      const data = await res.json();
      if (data.success) {
        const nowIso = new Date().toISOString();
        setLastBackupTime(nowIso);
        try {
          localStorage.setItem('grouplinks_drive_autobackup_last', nowIso);
        } catch {}

        if (Array.isArray(data.files)) {
          setFiles(data.files);
        } else {
          await fetchDriveBackups(activeToken);
        }

        const prunedMsg = data.deletedExpiredCount > 0 
          ? ` (Automatically pruned ${data.deletedExpiredCount} backup(s) older than 3 months)`
          : ' (All backups within 3-month retention limit)';

        setStatusNotice(`Backup successfully saved to Google Drive!${prunedMsg}`);
      } else {
        setErrorMessage(data.error || 'Failed to backup site to Google Drive.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Network error during Google Drive backup.');
    } finally {
      setIsBackingUp(false);
    }
  };

  // Check & Delete backups older than 3 months (90 days) from Google Drive
  const handlePruneExpiredNow = async () => {
    const activeToken = token || getDriveAccessToken();
    if (!activeToken) return;

    setIsPruning(true);
    setErrorMessage(null);
    setStatusNotice(null);

    try {
      const res = await fetch('/api/admin/drive-backup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'cleanup' })
      });
      const data = await res.json();
      if (data.success) {
        setStatusNotice(data.message);
        if (Array.isArray(data.files)) {
          setFiles(data.files);
        }
      } else {
        setErrorMessage(data.error || 'Failed to prune expired backups.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error executing retention cleanup.');
    } finally {
      setIsPruning(false);
    }
  };

  // Prune database data (comments, stale records) older than 3 months
  const handlePruneDbDataNow = async () => {
    const activeToken = token || getDriveAccessToken();
    if (!activeToken) {
      setErrorMessage('Please connect Google Drive to verify admin credentials.');
      return;
    }

    setIsPruningDb(true);
    setErrorMessage(null);
    setStatusNotice(null);

    try {
      const res = await fetch('/api/admin/drive-backup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'prune_database_data' })
      });
      const data = await res.json();
      if (data.success) {
        setStatusNotice(data.message);
        if (onRefreshSiteData) onRefreshSiteData();
      } else {
        setErrorMessage(data.error || 'Failed to prune database data.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error executing database data cleanup.');
    } finally {
      setIsPruningDb(false);
    }
  };

  // Background Auto-Backup check: runs if enabled and due
  useEffect(() => {
    if (!autoBackupEnabled || !token) return;

    const checkAutoBackupDue = async () => {
      const last = lastBackupTime ? new Date(lastBackupTime).getTime() : 0;
      const intervalMs = backupIntervalDays * 24 * 60 * 60 * 1000;
      const isDue = Date.now() - last >= intervalMs;

      if (isDue && !isBackingUp) {
        console.log('[Google Drive Auto-Backup] Auto-backup interval elapsed. Executing scheduled backup...');
        await handleBackupNow(token);
      }
    };

    checkAutoBackupDue();
    const timer = setInterval(checkAutoBackupDue, 30 * 60 * 1000); // check every 30 mins
    return () => clearInterval(timer);
  }, [autoBackupEnabled, token, backupIntervalDays, lastBackupTime]);

  // Execute Confirmed Delete
  const handleConfirmDelete = async () => {
    if (!pendingDeleteFile || !token) return;
    setIsDeleting(true);
    try {
      const res = await fetch('/api/admin/drive-backup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'delete', fileId: pendingDeleteFile.id })
      });
      const data = await res.json();
      if (data.success) {
        setStatusNotice(`Deleted backup file from Google Drive.`);
        if (Array.isArray(data.files)) {
          setFiles(data.files);
        } else {
          await fetchDriveBackups(token);
        }
        setPendingDeleteFile(null);
      } else {
        setErrorMessage(data.error || 'Failed to delete backup file.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error deleting file.');
    } finally {
      setIsDeleting(false);
    }
  };

  // Execute Confirmed Restore
  const handleConfirmRestore = async () => {
    if (!pendingRestoreFile || !token) return;
    setIsRestoring(true);
    try {
      const res = await fetch('/api/admin/drive-backup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          action: 'restore', 
          fileId: pendingRestoreFile.id,
          mode: restoreMode 
        })
      });
      const data = await res.json();
      if (data.success) {
        setStatusNotice(data.message || 'Site restored successfully from Google Drive backup!');
        setPendingRestoreFile(null);
        if (onRefreshSiteData) onRefreshSiteData();
      } else {
        setErrorMessage(data.error || 'Failed to restore site from Google Drive backup.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error restoring from Google Drive.');
    } finally {
      setIsRestoring(false);
    }
  };

  const formatFileSize = (bytesStr?: string) => {
    if (!bytesStr) return '—';
    const bytes = Number(bytesStr);
    if (isNaN(bytes)) return bytesStr;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-6">
      {/* Main Google Drive Integration Card */}
      <div className="bg-white dark:bg-neutral-900 p-6 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-sm space-y-6">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center shrink-0">
              <svg className="w-6 h-6" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-base text-neutral-900 dark:text-white">
                  Google Drive Auto-Backup &amp; 3-Month Retention
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                  Weekly Schedule
                </span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                Automatically upload complete JSON site snapshots to your Google Drive every week and automatically prune data/backups older than 3 months (90 days).
              </p>
            </div>
          </div>

          {/* Connection Status / Button */}
          <div className="shrink-0">
            {token && userEmail ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>{userEmail}</span>
                </div>
                <button
                  type="button"
                  onClick={handleDisconnectDrive}
                  className="text-xs font-medium text-neutral-500 hover:text-rose-600 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectDrive}
                disabled={isAuthenticating}
                className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold shadow-md shadow-indigo-500/20 transition-all flex items-center gap-2 cursor-pointer"
              >
                {isAuthenticating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Connecting Drive...</span>
                  </>
                ) : (
                  <>
                    <Cloud className="w-4 h-4" />
                    <span>Connect Google Drive</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Notices */}
        {statusNotice && (
          <div className="p-3.5 rounded-2xl bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200 text-xs font-semibold flex items-center gap-2 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="flex-1">{statusNotice}</span>
          </div>
        )}

        {errorMessage && (
          <div className="p-3.5 rounded-2xl bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200 text-xs font-semibold flex items-center gap-2 border border-rose-200 dark:border-rose-800">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span className="flex-1">{errorMessage}</span>
          </div>
        )}

        {/* Configuration & Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* Box A: Auto-Backup Settings */}
          <div className="p-4 rounded-2xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-200 dark:border-neutral-700/80 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-500" />
                <span className="font-bold text-xs text-neutral-800 dark:text-neutral-200">
                  Automated Backup Schedule
                </span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoBackupEnabled}
                  onChange={(e) => handleToggleAutoBackup(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-neutral-300 peer-focus:outline-none rounded-full peer dark:bg-neutral-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600" />
              </label>
            </div>

            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              When enabled, a complete snapshot is automatically pushed to your connected Google Drive without manual action.
            </p>

            <div className="pt-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
                Frequency:
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleChangeInterval(7)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1 ${
                    backupIntervalDays === 7
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700'
                  }`}
                >
                  <span>Every Week (7d)</span>
                  <span className="text-[9px] opacity-80 font-normal">Default</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleChangeInterval(1)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                    backupIntervalDays === 1
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700'
                  }`}
                >
                  Daily (24h)
                </button>
              </div>
            </div>

            {lastBackupTime && (
              <div className="text-[10px] text-neutral-400 dark:text-neutral-500 pt-1 border-t border-neutral-200 dark:border-neutral-700 flex items-center justify-between">
                <span>Last Backup Run:</span>
                <span className="font-mono text-neutral-600 dark:text-neutral-300">
                  {new Date(lastBackupTime).toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {/* Box B: Retention Policy (3-Month Auto Deletion) */}
          <div className="p-4 rounded-2xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-200 dark:border-neutral-700/80 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span className="font-bold text-xs text-neutral-800 dark:text-neutral-200">
                  3-Month Retention Policy
                </span>
              </div>
              <span className="px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">
                Active Enforced
              </span>
            </div>

            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
              Backups and data older than <strong>90 days (3 months)</strong> are automatically removed on every weekly backup run to prevent storage bloat.
            </p>

            <div className="pt-2 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Retention Window: <strong className="text-neutral-900 dark:text-white">90 Days (3 Months)</strong>
                </span>
              </div>
              <div className="flex items-center gap-2 pt-1 border-t border-neutral-200 dark:border-neutral-700">
                <button
                  type="button"
                  onClick={handlePruneExpiredNow}
                  disabled={!token || isPruning}
                  className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                  title="Check and prune Google Drive backups older than 90 days"
                >
                  {isPruning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                  <span>Prune Drive Backups</span>
                </button>
                <span className="text-neutral-300 dark:text-neutral-600">•</span>
                <button
                  type="button"
                  onClick={handlePruneDbDataNow}
                  disabled={!token || isPruningDb}
                  className="text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:underline disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                  title="Prune database comments and stale records older than 90 days"
                >
                  {isPruningDb ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  <span>Prune DB Data (&gt;3 Mos)</span>
                </button>
              </div>
            </div>
          </div>

        </div>

        {/* Action Buttons Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={() => handleBackupNow()}
            disabled={!token || isBackingUp}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold shadow-md shadow-indigo-500/20 transition-all flex items-center gap-2 cursor-pointer"
          >
            {isBackingUp ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Creating Google Drive Backup...</span>
              </>
            ) : (
              <>
                <CloudUpload className="w-4 h-4" />
                <span>Backup to Google Drive Now</span>
              </>
            )}
          </button>

          {token && (
            <button
              type="button"
              onClick={() => fetchDriveBackups(token)}
              disabled={isLoadingFiles}
              className="px-3 py-2 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFiles ? 'animate-spin' : ''}`} />
              <span>Refresh Files</span>
            </button>
          )}
        </div>

        {/* Existing Google Drive Backups List */}
        {token && (
          <div className="space-y-3 pt-4 border-t border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-xs text-neutral-900 dark:text-white flex items-center gap-2">
                <FileJson className="w-4 h-4 text-indigo-500" />
                <span>Site Backups Stored in Google Drive ({files.length})</span>
              </h4>
              <span className="text-[10px] text-neutral-400">
                Sorted by newest first
              </span>
            </div>

            {isLoadingFiles ? (
              <div className="p-8 text-center text-xs text-neutral-500">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-indigo-500" />
                <span>Loading backups from Google Drive...</span>
              </div>
            ) : files.length === 0 ? (
              <div className="p-6 rounded-2xl bg-neutral-50 dark:bg-neutral-800/40 border border-dashed border-neutral-200 dark:border-neutral-700 text-center space-y-2">
                <Cloud className="w-8 h-8 text-neutral-400 mx-auto" />
                <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                  No site backups found in Google Drive yet.
                </p>
                <p className="text-[11px] text-neutral-400">
                  Click &ldquo;Backup to Google Drive Now&rdquo; above to create your first snapshot.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="p-3 rounded-2xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-200 dark:border-neutral-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <FileJson className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                        <span className="font-mono font-semibold text-neutral-900 dark:text-white truncate">
                          {file.name}
                        </span>
                        {file.isExpired ? (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 shrink-0">
                            Expired (&gt;3 mos)
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 shrink-0">
                            Expires in {file.daysRemaining}d
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[10.5px] text-neutral-500 dark:text-neutral-400">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>{new Date(file.createdTime).toLocaleString()}</span>
                        </span>
                        <span>•</span>
                        <span>{formatFileSize(file.size)}</span>
                        <span>•</span>
                        <span>Age: {file.daysOld} days</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      {file.webViewLink && (
                        <a
                          href={file.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-white dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300 transition-colors"
                          title="Open file in Google Drive"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => setPendingRestoreFile(file)}
                        className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] transition-colors flex items-center gap-1 cursor-pointer"
                        title="Restore this backup into site database"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Restore</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteFile(file)}
                        className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-neutral-500 hover:text-rose-600 transition-colors cursor-pointer"
                        title="Delete this backup from Google Drive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Mandatory Destructive Confirmation Dialog: Delete Backup (Per Skill Guidelines) */}
      {pendingDeleteFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-neutral-900 w-full max-w-md p-6 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-2xl bg-rose-50 dark:bg-rose-950 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <h4 className="font-bold text-base text-neutral-900 dark:text-white">
                Delete Backup from Google Drive?
              </h4>
            </div>

            <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
              Are you sure you want to delete <strong className="text-neutral-900 dark:text-white font-mono">{pendingDeleteFile.name}</strong> from your Google Drive? This file will be permanently removed.
            </p>

            <div className="p-3 rounded-xl bg-neutral-50 dark:bg-neutral-800 text-[11px] text-neutral-500 space-y-1">
              <div>Created: <strong className="text-neutral-700 dark:text-neutral-300">{new Date(pendingDeleteFile.createdTime).toLocaleString()}</strong></div>
              <div>Size: <strong className="text-neutral-700 dark:text-neutral-300">{formatFileSize(pendingDeleteFile.size)}</strong></div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPendingDeleteFile(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-md shadow-rose-500/20 transition-all flex items-center gap-1.5"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                <span>Confirm Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mandatory Destructive / Mutation Confirmation Dialog: Restore from Drive */}
      {pendingRestoreFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-neutral-900 w-full max-w-md p-6 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-emerald-600">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center">
                <RotateCcw className="w-5 h-5" />
              </div>
              <h4 className="font-bold text-base text-neutral-900 dark:text-white">
                Restore Site from Google Drive?
              </h4>
            </div>

            <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
              This will load data from <strong className="text-neutral-900 dark:text-white font-mono">{pendingRestoreFile.name}</strong> and update your database. Choose your restore strategy:
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRestoreMode('merge')}
                className={`p-3 rounded-xl border text-left space-y-1 transition-all ${
                  restoreMode === 'merge'
                    ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-950 dark:text-indigo-200'
                    : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
                }`}
              >
                <div className="font-bold text-xs flex items-center justify-between">
                  <span>Merge (Safe)</span>
                  {restoreMode === 'merge' && <Check className="w-3.5 h-3.5 text-indigo-600" />}
                </div>
                <p className="text-[10px] text-neutral-500">
                  Adds missing groups and updates existing records safely without wiping new ones.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setRestoreMode('replace')}
                className={`p-3 rounded-xl border text-left space-y-1 transition-all ${
                  restoreMode === 'replace'
                    ? 'border-rose-600 bg-rose-50/50 dark:bg-rose-950/40 text-rose-950 dark:text-rose-200'
                    : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
                }`}
              >
                <div className="font-bold text-xs flex items-center justify-between">
                  <span>Replace All</span>
                  {restoreMode === 'replace' && <Check className="w-3.5 h-3.5 text-rose-600" />}
                </div>
                <p className="text-[10px] text-neutral-500">
                  Completely overwrites all site data with this exact snapshot.
                </p>
              </button>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPendingRestoreFile(null)}
                disabled={isRestoring}
                className="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-xs font-semibold text-neutral-700 dark:text-neutral-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRestore}
                disabled={isRestoring}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md shadow-emerald-500/20 transition-all flex items-center gap-1.5"
              >
                {isRestoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>Confirm Restore</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
