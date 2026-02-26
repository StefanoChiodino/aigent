/**
 * aigent PiP Launcher
 *
 * This page loads the aigent web UI in a full-page iframe and overlays a small
 * "Float" button. Clicking it opens a Document Picture-in-Picture window
 * (always-on-top) with the web UI, then minimizes this window.
 *
 * The launcher window must stay alive — PiP closes if its opener is destroyed.
 * If un-minimized, the user sees the full web UI and can re-float it.
 *
 * If PiP is unavailable, the button is hidden and the window works as a
 * regular popup showing the web UI.
 */

const AIGENT_URL = 'http://localhost:3141';
const PIP_WIDTH = 520;
const PIP_HEIGHT = 720;

const floatBtn = document.getElementById('float-btn')!;

// Hide float button if Document PiP is not supported
if (!('documentPictureInPicture' in window)) {
  floatBtn.style.display = 'none';
}

async function launchPiP(): Promise<void> {
  if (!('documentPictureInPicture' in window)) return;

  try {
    const pipWindow = await documentPictureInPicture.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
      disallowReturnToOpener: true,
    });

    // Style the PiP document — iframe fills the entire window
    const style = pipWindow.document.createElement('style');
    style.textContent = `
      *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #1a1a1a; }
      iframe { width: 100%; height: 100%; border: none; }
    `;
    pipWindow.document.head.appendChild(style);
    pipWindow.document.title = 'aigent';

    // Load the aigent web UI in an iframe inside PiP
    const iframe = pipWindow.document.createElement('iframe');
    iframe.src = AIGENT_URL;
    iframe.allow = 'microphone; clipboard-write; clipboard-read; display-capture; camera';
    pipWindow.document.body.appendChild(iframe);

    // Notify background worker — it will minimize this window
    chrome.runtime.sendMessage({ type: 'pip-opened' });
    floatBtn.style.display = 'none';

    // When PiP closes, restore the float button
    pipWindow.addEventListener('pagehide', () => {
      chrome.runtime.sendMessage({ type: 'pip-closed' });
      floatBtn.style.display = '';
    });
  } catch (err) {
    console.error('[aigent] PiP failed:', err);
    chrome.runtime.sendMessage({ type: 'pip-unavailable' });
  }
}

floatBtn.addEventListener('click', () => launchPiP());
