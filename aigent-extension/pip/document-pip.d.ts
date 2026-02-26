/**
 * Type declarations for the Document Picture-in-Picture API.
 * https://developer.chrome.com/docs/web-platform/document-picture-in-picture
 * Chrome 116+
 */

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

declare const documentPictureInPicture: DocumentPictureInPicture;
