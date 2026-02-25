const dot = document.getElementById('dot')!;
const label = document.getElementById('label')!;
const openBtn = document.getElementById('open-btn')!;

async function update(): Promise<void> {
  const result = await chrome.storage.session.get('connected');
  const connected = result['connected'] === true;
  dot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  label.className = `label ${connected ? 'connected' : 'disconnected'}`;
  label.textContent = connected ? 'Connected to aigent' : 'Not connected';
}

openBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-window' });
  window.close();
});

update().catch(console.error);
