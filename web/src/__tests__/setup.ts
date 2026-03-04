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

// Notification stub — constructable so `new Notification()` works in tests
if (typeof globalThis.Notification === 'undefined') {
  const NotificationStub = function(this: unknown, _title: string, _opts?: NotificationOptions) {
    // no-op constructor
  } as unknown as typeof Notification;
  Object.assign(NotificationStub, {
    permission: 'default' as NotificationPermission,
    requestPermission: () => Promise.resolve('denied' as NotificationPermission),
  });
  (globalThis as Record<string, unknown>).Notification = NotificationStub;
}
