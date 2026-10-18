'use client';

import { useState, useEffect, useCallback } from 'react';

export interface GroupStatItem {
  upvotes: number;
  shares: number;
  clicks: number;
}

export function useLiveStats(groupIds: string[]) {
  const [statsMap, setStatsMap] = useState<Record<string, GroupStatItem>>({});

  const fetchStats = useCallback(async (ids: string[]) => {
    if (!ids || ids.length === 0) return;
    try {
      const res = await fetch(`/api/stats/batch?ids=${encodeURIComponent(ids.join(','))}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.stats) {
          setStatsMap(prev => ({ ...prev, ...data.stats }));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!groupIds || groupIds.length === 0) return;
    fetchStats(groupIds);

    const timer = setInterval(() => {
      fetchStats(groupIds);
    }, 10000);

    return () => clearInterval(timer);
  }, [groupIds, fetchStats]);

  const optimisticallyIncrement = useCallback((groupId: string, action: 'upvote' | 'share' | 'join' | 'click') => {
    setStatsMap(prev => {
      const current = prev[groupId] || { upvotes: 0, shares: 0, clicks: 0 };
      const updated = { ...current };
      if (action === 'upvote') updated.upvotes += 1;
      if (action === 'share') updated.shares += 1;
      if (action === 'join' || action === 'click') updated.clicks += 1;
      return { ...prev, [groupId]: updated };
    });

    // Fire non-blocking background fetch
    fetch('/api/stats/increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, action }),
    }).catch(() => {});
  }, []);

  return { statsMap, optimisticallyIncrement, refetch: () => fetchStats(groupIds) };
}
