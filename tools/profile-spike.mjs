// 抓「进对局后那个 ~2 秒长任务」里到底在跑什么（CDP CPU profile）。
// 只读，不改游戏状态。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const PORT = 9337;
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,900', '--user-data-dir=/tmp/sb-pf-' + Date.now(), 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });
let target = null;
for (let i = 0; i < 60; i++) { await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m); };
const send = (m, p = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
async function clickText(text, nth = 0) {
  const rect = await ev(`(() => { const bs=[...document.querySelectorAll('button')].filter(b=>b.innerText.replace(/\\s+/g,' ').includes(${JSON.stringify(text)}));
    const b=bs[${nth}]; if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
    return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]); })()`);
  if (!rect || rect === 'null') return false;
  const [x, y] = JSON.parse(rect);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  return true;
}
await send('Page.enable'); await send('Runtime.enable'); await send('Profiler.enable');
await send('Page.navigate', { url: process.env.SP_URL || 'http://127.0.0.1:18400' });
await sleep(7000);
await ev(`(() => { const inp=document.querySelector('input'); if(inp){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(inp,'测量'); inp.dispatchEvent(new Event('input',{bubbles:true}));} return 1; })()`);
await clickText('开始'); await sleep(3500);
await clickText('险境模拟'); await sleep(1200);
await clickText('独立模拟'); await sleep(1500);
await clickText('开始模拟'); await sleep(1200);
await clickText('准备就绪'); await sleep(1200);
await clickText('确认'); await sleep(500);

// ★ 关键：尖峰出现的**时刻不确定**（取决于模型加载），所以不能在固定时刻开 profiler。
// 改为在页面里埋一个"尖峰侦测器"：一旦观测到 >600ms 的长任务就置位，
// 主控轮询到置位后**立刻**开 profiler —— 这样采样必然覆盖尖峰本身。
await ev(`(() => {
  globalThis.__SPIKE__ = null;
  globalThis.__LT__ = globalThis.__LT__ || [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        globalThis.__LT__.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
        if (e.duration > 600 && !globalThis.__SPIKE__) {
          globalThis.__SPIKE__ = { start: Math.round(e.startTime), dur: Math.round(e.duration) };
        }
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  return 1;
})()`);

console.log('等对局加载 + 侦测尖峰…（最多 90 秒）');
await send('Profiler.setSamplingInterval', { interval: 100 });
let started = false;
let profPromise = null;
for (let i = 0; i < 180; i++) {
  await sleep(500);
  const spike = await ev('JSON.stringify(globalThis.__SPIKE__)');
  if (spike && spike !== 'null' && !started) {
    console.log('\n  侦测到尖峰:', spike, '→ 立刻开 profiler');
    await send('Profiler.start');
    started = true;
    profPromise = sleep(6000).then(() => send('Profiler.stop'));
    break;
  }
  if (i % 10 === 0) process.stdout.write(`\r  等 ${(i / 2).toFixed(0)}s  pixi=${await ev('!!globalThis.PIXI')} view=${await ev('!!globalThis.__SP_VIEW__')} 长任务=${await ev('(globalThis.__LT__||[]).length')}   `);
}
if (!started) {
  console.log('\n  没侦测到 >600ms 的尖峰；直接采 6 秒作为对照');
  await send('Profiler.start');
  profPromise = sleep(6000).then(() => send('Profiler.stop'));
}
const { result } = await send('Profiler.stop').then(r => r || profPromise);
console.log('\n长任务全量:', await ev('JSON.stringify((globalThis.__LT__||[]).sort((a,b)=>b.d-a.d).slice(0,8))'));
const prof = result.profile;
function agg(nodes, samples, timeDeltas, key) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); if (!n) continue;
    const dt = (timeDeltas[i] || 0) / 1000;
    const k = key(n);
    self.set(k, (self.get(k) || 0) + dt);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
}
const byFunc = agg(prof.nodes, prof.samples, prof.timeDeltas, (n) => {
  const f = n.callFrame;
  const u = (f.url || '').replace(/^https?:\/\/[^/]+/, '');
  return `${f.functionName || '(匿名)'}  @${u}:${f.lineNumber + 1}`;
});
console.log('\n\n===== 自身耗时 Top 25（按函数，毫秒）=====');
for (const [k, v] of byFunc) console.log(`  ${Math.round(v).toString().padStart(6)} ms  ${k}`);
const byUrl = agg(prof.nodes, prof.samples, prof.timeDeltas, (n) => {
  const u = (n.callFrame.url || '(无)').replace(/^https?:\/\/[^/]+/, '');
  return u || '(无)';
});
console.log('\n===== 按文件汇总（毫秒）=====');
for (const [k, v] of byUrl) console.log(`  ${Math.round(v).toString().padStart(6)} ms  ${k}`);
fs.writeFileSync('/tmp/sb-profile.json', JSON.stringify(prof));
console.log('\n完整 profile 已存 /tmp/sb-profile.json');
try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
