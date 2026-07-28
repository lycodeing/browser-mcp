// popup.js
function updateUI(status) {
  const dot = document.getElementById('dot');
  const badge = document.getElementById('status-badge');
  if (status.connected) {
    dot.className = 'green';
    badge.className = 'badge badge-green';
    badge.textContent = 'Connected';
  } else {
    dot.className = 'red';
    badge.className = 'badge badge-red';
    badge.textContent = 'Disconnected';
  }
}

chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
  if (res) updateUI(res);
});

document.getElementById('retry-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (res) updateUI(res);
  });
});
