import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';

/**
 * Acquires a Screen Wake Lock while the agent is streaming and the
 * user has enabled the "Keep screen awake" setting.
 *
 * The wake lock prevents the screen from dimming/sleeping.
 * It's automatically released when streaming stops or the setting is toggled off.
 * Re-acquired on visibility change (Chrome releases wake locks when tab is hidden).
 */
export function useWakeLock(): void {
  const isStreaming = useChatStore(s => s.streaming.active);
  const enabled = useSettingsStore(s => s.clientSettings.wake_lock ?? false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    if (!enabled || !isStreaming) {
      // Release if we have one
      sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
      return;
    }

    let cancelled = false;

    async function acquire() {
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = null;
          }
        });
      } catch {
        // Ignore — may fail on low battery or if not supported
      }
    }

    acquire();

    // Re-acquire on visibility change (Chrome releases wake locks when tab is hidden)
    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && !cancelled && !sentinelRef.current) {
        acquire();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
    };
  }, [enabled, isStreaming]);
}
