/**
 * Vitest setup — provides browser globals (navigator, Notification, etc.)
 * that components expect but jsdom doesn't fully implement.
 */

// navigator.mediaDevices stub (mic tests reference getUserMedia)
if (!navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.reject(new Error('Not available in test')) },
  });
}

// Notification stub
if (typeof globalThis.Notification === 'undefined') {
  (globalThis as Record<string, unknown>).Notification = {
    permission: 'default',
    requestPermission: () => Promise.resolve('denied' as NotificationPermission),
  };
}
