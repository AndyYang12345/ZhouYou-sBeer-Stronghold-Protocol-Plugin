// 探针：走真实 UI 流程进对局，逐步打印状态（只读，不改游戏文件）。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9335;
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,900', '--user-data-dir=/tmp/sb-ui-' + Date.now(), 'about:blank',
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
const send = (m, p = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: process.env.SP_URL || 'http://127.0.0.1:18400' });
await sleep(7000);

const state = () => ev(`JSON.stringify({
  cls: document.documentElement.className,
  pixi: !!globalThis.PIXI, view: !!globalThis.__SP_VIEW__, plugin: !!globalThis.__SP_SPIN_BOUNCE__,
  txt: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,140),
})`);

console.log('① 填代号并点开始');
console.log('  ', await ev(`(() => {
  const inp = document.querySelector('input');
  if (inp) { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(inp, '测量'); inp.dispatchEvent(new Event('input',{bubbles:true})); }
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '开始');
  if (!btn) return '找不到开始按钮';
  // React 的合成事件常常绑在 pointer 系列上，单纯 .click() 不触发；
  // 这里发一整套真实手势序列（并与 CDP 的 Input.dispatchMouseEvent 配合）。
  const r = btn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true,
    clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0, buttons: 1, pointerId: 1, isPrimary: true };
  btn.dispatchEvent(new PointerEvent('pointerdown', opts));
  btn.dispatchEvent(new MouseEvent('mousedown', opts));
  btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  btn.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  return JSON.stringify({ clicked: true, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
})()`));
await sleep(1500);
// 同时用 CDP 发真实鼠标事件（trusted event），双管齐下
const rect = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='开始');
  if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]); })()`);
if (rect && rect !== 'null') {
  const [cx, cy] = JSON.parse(rect);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
  }
  console.log('   CDP 真实点击于', cx, cy);
}
await sleep(4000);
console.log('  ', await state());

console.log('② 找建房/单人入口');
console.log('  ', await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,25))`));
await sleep(1000);
console.log('  ', await state());
try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
