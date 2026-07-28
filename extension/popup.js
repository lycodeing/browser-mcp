// popup.js
function updateUI(status) {
  const dot = document.getElementById('dot');
  const badge = document.getElementById('status-badge');
  const relayUrl = document.getElementById('relay-url');
  const retryCount = document.getElementById('retry-count');

  if (status.connected) {
    dot.className = 'green';
    badge.className = 'badge badge-green';
    badge.textContent = 'Connected';
  } else {
    dot.className = 'red';
    badge.className = 'badge badge-red';
    badge.textContent = 'Disconnected';
  }

  if (relayUrl) relayUrl.textContent = status.relayUrl || '';
  if (retryCount && !status.connected) {
    retryCount.textContent = status.reconnectAttempt > 0
      ? `已重试 ${status.reconnectAttempt} 次` : '';
  } else if (retryCount) {
    retryCount.textContent = '';
  }
}

chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
  if (res) updateUI(res);
});

document.getElementById('retry-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    // 300ms 后刷新状态
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
        if (res) updateUI(res);
      });
    }, 300);
  });
});
