// E1 手测/实验用静态服务：三个端口 = 三个不同源，嵌套成 9401 → 9402 → 9403。
import http from 'node:http';

const PORTS = { top: 9401, mid: 9402, leaf: 9403 };

const pages = {
  [PORTS.top]: `<!doctype html><body style="margin:0;padding:0">
<div style="height:30px"></div>
<iframe id="f1" src="http://127.0.0.1:${PORTS.mid}/" style="position:absolute;left:40px;top:70px;width:520px;height:420px;border:7px solid #36c;margin:0"></iframe>`,

  [PORTS.mid]: `<!doctype html><body style="margin:0">
<div style="height:25px"></div>
<iframe id="f2" src="http://127.0.0.1:${PORTS.leaf}/" style="position:absolute;left:20px;top:30px;width:400px;height:300px;border:5px solid #c63;transform:scale(.5);transform-origin:0 0"></iframe>
<div style="height:900px"></div>`,

  [PORTS.leaf]: `<!doctype html><body style="margin:0">
<div id="box" style="width:380px;height:280px;overflow:auto">
  <div style="height:600px;position:relative">
    <button id="near" style="position:absolute;left:30px;top:20px;width:80px;height:30px">near</button>
    <button id="far" style="position:absolute;left:200px;top:450px;width:90px;height:30px">far</button>
  </div>
</div>
<script>
window.__clicks = [];
addEventListener('click', e => { const c = { x: e.clientX, y: e.clientY, id: e.target.id, trusted: e.isTrusted }; window.__clicks.push(c); top.postMessage({ bmcpClick: c }, '*'); }, true);
addEventListener('click', e => { if (e.target.tagName === 'BUTTON') e.target.textContent = 'clicked:' + e.target.id + (e.isTrusted ? ':trusted' : ':synthetic'); });
</script>`,
};

for (const [port, html] of Object.entries(pages)) {
  http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }).listen(Number(port), '127.0.0.1');
}
console.log('e1 fixtures on', Object.values(PORTS).join(', '));
