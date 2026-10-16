// 探针：一路点到进对局，并在对局里采样长任务与插件状态。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 9336;
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,900', '--user-data-dir=/tmp/sb-m-' + Date.now(), 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });
let target = null;
for (let i = 0; i < 60; i++) { await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {} }
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
/** 用真实鼠标事件点击某个文字按钮。 */
async function clickText(text, nth = 0) {
  const rect = await ev(`(() => { const bs=[...document.querySelectorAll('button')].filter(b=>b.innerText.replace(/\\s+/g,' ').includes(${JSON.stringify(text)}));
    const b=bs[${nth}]; if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
    return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]); })()`);
  if (!rect || rect === 'null') return false;
  const [x, y] = JSON.parse(rect);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  return true;
}
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: process.env.SP_URL || 'http://127.0.0.1:18400' });
await sleep(7000);
const state = () => ev(`JSON.stringify({ cls: document.documentElement.className, pixi: !!globalThis.PIXI,
  view: !!globalThis.__SP_VIEW__, plugin: !!globalThis.__SP_SPIN_BOUNCE__, lt: (globalThis.__LT__||[]).length,
  txt: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,110) })`);

// 装长任务探针
await ev(`(() => { globalThis.__LT__=[]; try { new PerformanceObserver(l=>{for(const e of l.getEntries()) globalThis.__LT__.push({t:Math.round(e.startTime),d:Math.round(e.duration)});}).observe({entryTypes:['longtask']}); } catch(e){} return 1; })()`);

await ev(`(() => { const inp=document.querySelector('input'); if(inp){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(inp,'测量'); inp.dispatchEvent(new Event('input',{bubbles:true}));} return 1; })()`);
console.log('点开始:', await clickText('开始'), '|', await state());
await sleep(3500);
console.log('选难度(险境模拟):', await clickText('险境模拟'), '|', await state());
await sleep(1500);
console.log('创建/开始:', await clickText('创建同盟'), await clickText('独立模拟'), '|', await state());
await sleep(2500);
console.log('  按钮:', await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,18))`));
// 逐个尝试可能的前进入口
for (const t of ['开始模拟', '开始作战', '进入', '准备就绪', '确认', '出发', '开始']) {
  if (await clickText(t)) { console.log('  点了:', t); await sleep(2500); }
}
console.log('最终:', await state());
// 采样 25 秒
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  const st = await state();
  const o = JSON.parse(st);
  const extra = await ev(`(() => { const a=globalThis.__SP_SPIN_BOUNCE__; if(!a) return 'null';
    try { return JSON.stringify(a.status()); } catch(e){ return '"'+e.message+'"'; } })()`);
  console.log(`  t+${i+1}s pixi=${o.pixi} view=${o.view} 长任务=${o.lt} 状态=${extra}`);
  if (o.view && extra !== 'null' && JSON.parse(extra).units > 0) break;
}
console.log('\n长任务 Top:', await ev(`JSON.stringify((globalThis.__LT__||[]).sort((a,b)=>b.d-a.d).slice(0,10))`));
console.log('插件统计:', await ev(`(() => { const a=globalThis.__SP_SPIN_BOUNCE__; if(!a) return '无';
  try { return JSON.stringify(a.stats()); } catch(e){ return e.message; } })()`));
try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
