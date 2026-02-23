// Module-level screen capture state — hardware resources, not UI state.

export let screenStream: MediaStream | null = null;
export let screenVideo: HTMLVideoElement | null = null;

let screenCapActiveCallback: ((active: boolean) => void) | null = null;

export function registerScreenCapCallback(cb: (active: boolean) => void): void {
  screenCapActiveCallback = cb;
}

export function setScreenCapState(active: boolean): void {
  if (!active) {
    screenStream = null;
    screenVideo = null;
  }
  screenCapActiveCallback?.(active);
}

export function isScreenCapActive(): boolean {
  return screenStream !== null && screenVideo !== null;
}

export async function startScreenShare(): Promise<void> {
  if (screenStream && screenVideo) return; // already active
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  screenVideo = document.createElement('video');
  screenVideo.srcObject = screenStream;
  screenVideo.muted = true;
  await new Promise<void>(resolve => { screenVideo!.onloadedmetadata = () => resolve(); });
  await screenVideo.play();
  await new Promise<void>(resolve => {
    if (screenVideo!.readyState >= 3) resolve();
    else screenVideo!.oncanplay = () => resolve();
  });
  screenStream.getVideoTracks()[0]!.addEventListener('ended', () => {
    setScreenCapState(false);
  });
  setScreenCapState(true);
}

export function captureScreenshot(): string | null {
  if (!screenStream || !screenVideo || screenVideo.videoWidth === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = screenVideo.videoWidth;
  canvas.height = screenVideo.videoHeight;
  canvas.getContext('2d')!.drawImage(screenVideo, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.split(',')[1] ?? null;
}
