import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';

/**
 * Prevents the computer from sleeping while the agent is streaming,
 * gated by the "Keep awake while working" setting.
 *
 * Two mechanisms:
 * 1. Screen Wake Lock API — prevents screen dimming (may not prevent system sleep)
 * 2. Silent audio loop — playing audio prevents system sleep on most OSes
 *
 * Both are released when streaming stops or the setting is toggled off.
 */
export function useWakeLock(): void {
  const isStreaming = useChatStore(s => s.streaming.active);
  const enabled = useSettingsStore(s => s.clientSettings.wake_lock ?? false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    const active = enabled && isStreaming;

    // --- Screen Wake Lock (prevents screen dimming) ---
    if (!active || !('wakeLock' in navigator)) {
      sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
    }

    // --- Silent audio loop (prevents system sleep) ---
    if (!active) {
      sourceRef.current?.stop();
      sourceRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      return;
    }

    let cancelled = false;

    // Acquire screen wake lock
    async function acquireWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) { sentinel.release().catch(() => {}); return; }
        sentinelRef.current = sentinel;
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch { /* ignore — may fail on low battery */ }
    }

    // Start silent audio to prevent system sleep
    async function startSilentAudio() {
      try {
        const ctx = new AudioContext();
        await ctx.resume(); // ensure context is running (autoplay policy)
        // Create a 1-second silent buffer, looped
        const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        // Connect through a gain node at zero volume (truly silent)
        const gain = ctx.createGain();
        gain.gain.value = 0.001; // near-silent — some OSes ignore true zero
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
        audioCtxRef.current = ctx;
        sourceRef.current = src;
      } catch { /* ignore if AudioContext unavailable */ }
    }

    acquireWakeLock();
    startSilentAudio();

    // Re-acquire wake lock on visibility change (Chrome releases when tab hidden)
    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && !cancelled && !sentinelRef.current) {
        acquireWakeLock();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
      sourceRef.current?.stop();
      sourceRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, [enabled, isStreaming]);
}
