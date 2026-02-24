const dot = document.getElementById('dot')!;
const label = document.getElementById('label')!;

async function update(): Promise<void> {
  const result = await chrome.storage.session.get('connected');
  const connected = result['connected'] === true;
  dot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  label.className = `label ${connected ? 'connected' : 'disconnected'}`;
  label.textContent = connected ? 'Connected to aigent' : 'Not connected';
}

update().catch(console.error);
