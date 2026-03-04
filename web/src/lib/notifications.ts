/**
 * Browser notification helper — wraps the Notification API with
 * permission and visibility checks.
 */

/** Show a browser notification if the tab is not focused and permission is granted. */
export function showBrowserNotification(title: string, body?: string): void {
  if (!document.hidden) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  new Notification(title, {
    body,
    tag: 'aigent',
  });
}
