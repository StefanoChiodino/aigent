const frame = document.getElementById('frame');
const offline = document.getElementById('offline');

// Pass extension ID so the iframe can use chrome.runtime.sendMessage back to us
frame.src = 'http://localhost:3141?extId=' + chrome.runtime.id;

// Relay mic commands from the iframe to the background worker.
// chrome.runtime.sendMessage only works from top-level frames, not iframes,
// so the iframe postMessages here and we forward via chrome.runtime.
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return;
  const type = e.data?.type;
  if (typeof type === 'string' && type.startsWith('aigent-')) {
    chrome.runtime.sendMessage({ type });
  }
});

frame.onerror = () => showOffline();

// Detect load failure via a fetch check — iframe doesn't reliably fire onerror
async function checkOnline() {
  try {
    const res = await fetch('http://localhost:3141/', { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    if (!res.ok) showOffline();
  } catch {
    showOffline();
  }
}

function showOffline() {
  frame.style.display = 'none';
  offline.style.display = 'flex';
}

function retry() {
  offline.style.display = 'none';
  frame.style.display = '';
  frame.src = 'http://localhost:3141?extId=' + chrome.runtime.id + '&t=' + Date.now();
}

document.getElementById('retry-btn').addEventListener('click', retry);

checkOnline();
