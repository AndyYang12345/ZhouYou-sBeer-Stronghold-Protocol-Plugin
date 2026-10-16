// tools/profile-in-match.mjs — 在服务器上用无头 Chrome 实测「每轮开始」的耗时构成。
//
// 目的：把「卡顿归谁」从猜测变成测量。
//   · 游戏自身（视图/棋盘/模型加载）
//   · 插件的 tick（collectUnits / attachEffect / driveUnit / 换面）
//
// 用 CDP 直接驱动，不开 UI：走 WebSocket 建房 → 同意插件 → 开局 → 采样 Long Task。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_BASE = process.env.SP_URL || 'http://127.0.0.1:3000';
const PORT = 9333;
const args = process.argv.slice(2);
const DISABLE_PLUGIN = args.includes('--no-plugin');

const chrome = spawn(process.env.CHROME || 'chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1600,900',
  '--user-data-dir=/tmp/sb-prof-' + Date.now(), 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const die = (msg, code = 1) => { try { chrome.kill('SIGKILL'); } catch {} console.log(msg); process.exit(code); };
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

// 等 CDP 起来
let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* 还没起来 */ }
}
if (!target) die('无法连接 Chrome CDP：' + chromeErr.slice(-400));

const { WebSocket } = globalThis;
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

const url = DISABLE_PLUGIN ? `${URL_BASE}/?sbn=0` : URL_BASE;
console.log(`打开 ${url}${DISABLE_PLUGIN ? '（插件已用 ?sbn=0 关闭）' : ''}`);
await send('Page.navigate', { url });
await sleep(6000);

// 装 Long Task 探针 + 进房间
console.log('进房间并开启插件…');
const setup = await evalJs(`(async () => {
  const out = [];
  globalThis.__LT__ = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__LT__.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) { out.push('longtask 不支持: ' + e.message); }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const wait = (f, ms = 12000) => new Promise(res => {
    const t = setTimeout(() => res(null), ms);
    const on = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (f(m)) { clearTimeout(t); sock.removeEventListener('message', on); res(m); } };
    sock.addEventListener('message', on);
  });
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  sock.send(JSON.stringify({ t: 'hello', name: '性能测量', version: 1 }));
  await wait(m => m.t === 'welcome');
  sock.send(JSON.stringify({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' }));
  const st = await wait(m => m.t === 'room.state');
  sock.send(JSON.stringify({ t: 'room.setPlugins', plugins: [{ id: 'spin-bounce' }] }));
  await wait(m => m.t === 'room.state' && m.content && m.content.cs !== st.content.cs);
  sock.send(JSON.stringify({ t: 'room.consent', cs: (await wait(m => m.t === 'room.state')).content.cs, accept: true }));
  await sleep(300);
  sock.send(JSON.stringify({ t: 'room.ready', ready: true }));
  await sleep(600);
  sock.send(JSON.stringify({ t: 'room.start', }));
  globalThis.__SOCK__ = sock;
  out.push('已开局');
  return out.join(' | ');
})()`);
console.log('  ', setup);

// 等对局真正开始（PIXI + 视图 + 单位）
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const st = await evalJs(`(() => {
    const a = globalThis.__SP_SPIN_BOUNCE__;
    return JSON.stringify({
      pixi: !!globalThis.PIXI,
      view: !!globalThis.__SP_VIEW__,
      hasHook: a ? !!a : false,
      status: (() => { try { return a.status(); } catch (e) { return String(e.message); } })(),
      lt: (globalThis.__LT__ || []).length,
      clicks: document.querySelectorAll('button').length,
    });
  })()`);
  const o = typeof st === 'string' ? JSON.parse(st) : st;
  console.log(`  t+${i + 1}s  PIXI=${o.pixi}  视图=${o.view}  状态=${JSON.stringify(o.status)}  长任务=${o.lt}`);
  if (o.view && o.status && o.status.units > 0) break;
}

const report = await evalJs(`(() => {
  const lt = (globalThis.__LT__ || []).slice().sort((a, b) => b.d - a.d).slice(0, 12);
  const a = globalThis.__SP_SPIN_BOUNCE__;
  return JSON.stringify({
    longTasks: lt,
    total: (globalThis.__LT__ || []).length,
    stats: (() => { try { return a.stats(); } catch (e) { return String(e.message); } })(),
    status: (() => { try { return a.status(); } catch (e) { return String(e.message); } })(),
  }, null, 2);
})()`);
console.log('\n===== 结果 =====');
console.log(report);
die('', 0);
