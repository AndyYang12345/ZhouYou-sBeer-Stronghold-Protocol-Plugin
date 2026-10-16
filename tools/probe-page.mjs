// 探针：看无头浏览器里页面停在哪一步（只读，不改游戏状态）。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9334;
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,900', '--user-data-dir=/tmp/sb-probe-' + Date.now(), 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });
let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: process.env.SP_URL || 'http://127.0.0.1:18400' });
await sleep(7000);
console.log(await ev(`JSON.stringify({
  title: document.title,
  htmlClass: document.documentElement.className,
  bodyText: (document.body?.innerText || '').slice(0, 200),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).slice(0, 20),
  pixi: !!globalThis.PIXI,
  view: !!globalThis.__SP_VIEW__,
  plugin: !!globalThis.__SP_SPIN_BOUNCE__,
  ws: typeof WebSocket,
}, null, 2)`));
try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
