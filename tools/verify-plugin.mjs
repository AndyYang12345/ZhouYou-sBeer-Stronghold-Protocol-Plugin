// tools/verify-plugin.mjs — 用真实 Chrome 验证 trusted 插件端到端可用。
//
// 流程：
//   1. 连上游戏（CDP），先把"已同意"写进 localStorage（否则 trusted 客户端脚本不会加载）
//   2. 走 WebSocket 开一个单人房间，并让房主开启 spin-bounce
//   3. 观察页面控制台里插件自己的日志（[spin-bounce] …）
//   4. 直接问 PIXI 原型：单位层找到了吗、有多少单位、它们的 body 有没有被驱动
//
// 用法：node tools/verify-plugin.mjs <game-url> [--chrome <path>]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
if (!url) { console.error('用法: node tools/verify-plugin.mjs <game-url>'); process.exit(2); }
const chromeIdx = process.argv.indexOf('--chrome');
const CHROME = chromeIdx > 0 ? process.argv[chromeIdx + 1] : (process.env.CHROME_BIN || 'google-chrome-stable');
const PORT = 9400 + Math.floor(Math.random() * 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'sb-verify-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,720', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
const out = { steps: [], console: [], errors: [] };
try {
  // --- 找页面 target
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* 还没起来 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口没就绪');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/spin-bounce|content|plugin/i.test(text)) out.console.push(`[${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      out.errors.push(m.params?.exceptionDetails?.exception?.description
        || m.params?.exceptionDetails?.text || 'unknown');
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const my = ++id; pending.set(my, resolve);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval failed');
    return r?.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // --- 1) 先访问一次，写入"已同意"，再重载
  await send('Page.navigate', { url });
  await sleep(4000);
  out.steps.push('首次载入完成');

  // 内容集 id 从房间状态里拿；这里先用通配：把所有已存在的同意键打印出来
  const stored = await evaluate(`JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('sp.plugin.consent')))`);
  out.steps.push(`已有同意键: ${stored}`);

  // --- 2) 开一个单人房间，并开启 spin-bounce
  const roomResult = await evaluate(`(async () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(proto + '://' + location.host + '/ws');
    const seen = [];
    const wait = (pred, ms=8000) => new Promise((res) => {
      const t = setTimeout(() => res(null), ms);
      const on = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (pred(m)) { clearTimeout(t); sock.removeEventListener('message', on); res(m); } };
      sock.addEventListener('message', on);
    });
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    sock.send(JSON.stringify({ t:'hello', name:'验证机器人', version:1 }));
    const welcome = await wait(m => m.t === 'welcome');
    if (!welcome) return { ok:false, why:'no welcome' };
    sock.send(JSON.stringify({ t:'room.create', mode:'solo', difficulty:'NORMAL' }));
    const state = await wait(m => m.t === 'room.state');
    if (!state) return { ok:false, why:'no room.state' };
    // 房间的插件面板走 room.setPlugins；先看看房间状态里有什么字段
    return { ok:true, code: state.code, content: state.content, fields: Object.keys(state) };
  })()`, true);
  out.room = roomResult;
  out.steps.push(`建房: ${JSON.stringify(roomResult)}`);

  // --- 3) 看插件日志与原型状态
  await sleep(1500);
  const probe = await evaluate(`(() => {
    const proto = globalThis.PIXI?.Container?.prototype;
    const st = proto?.__sbState;
    const layer = st?.unitsLayer;
    const kids = layer ? layer.children.length : 0;
    const units = layer ? layer.children.filter(c => c && c.body && c.root && c.hud) : [];
    const scaled = units.filter(u => u.body.scale.x !== 1 || u.body.scale.y !== 1);
    return JSON.stringify({
      patched: !!proto?.__sbPatched,
      hasState: !!st,
      hasLayer: !!layer,
      kids, units: units.length, scaled: scaled.length,
      sample: units.slice(0,2).map(u => ({ x:+u.body.scale.x.toFixed(3), y:+u.body.scale.y.toFixed(3), rot:+u.body.rotation.toFixed(3), pivotY:u.body.pivot?.y })),
      panel: !!document.getElementById('sbp-button'),
      api: !!globalThis.__SP__,
    });
  })()`);
  out.probe = probe;
  out.steps.push('原型探针完成');
} catch (err) {
  out.errors.push(String(err?.message || err));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(JSON.stringify(out, null, 2));
}
