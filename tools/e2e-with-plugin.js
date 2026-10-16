/* tools/e2e-with-plugin.js — 在浏览器里自动进一局「已启用弹跳自转」的对局，并监听卡顿。
 *
 * 用法：
 *   1. 打开游戏、停在**大厅/标题页**（不要手动进房间）
 *   2. F12 → Console → 粘贴本文件全部内容 → 回车
 *   3. 它会自己：建房 → 启用插件 → 同意 → 开局 → 并把卡顿数据记下来
 *   4. 想自己接着打就接着打；结束后执行 __SBW__.report() 取报告
 *
 * 它靠**直接发游戏的 WebSocket 协议消息**驱动，不去点 UI ——
 * 无头测试里我试过点击，React 的合成事件在被脚本点击时并不可靠；
 * 而协议消息是权威的，房间状态确实会变。
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[自动开局]', 'color:#4ec9b0', ...a);

  // ---------- 装监听（与 watch-my-match.js 同源，抽成内联版）----------
  const T0 = performance.now();
  const rel = (t) => Math.round(t - T0);
  const inMatch = () => { try { return document.documentElement.classList.contains('sp-in-match'); } catch { return false; } };
  const S = { longTasks: [], fps: [], matchEdges: [{ rel: 0, in: inMatch() }], errors: [] };
  const snapshot = () => {
    const a = globalThis.__SP_SPIN_BOUNCE__;
    if (!a) return { plugin: false };
    let status = null;
    try { status = a.status(); } catch (e) { status = String(e.message); }
    return { plugin: true, status };
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const r = { rel: rel(e.startTime), dur: Math.round(e.duration), match: inMatch(), state: snapshot() };
        S.longTasks.push(r);
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { S.errors.push('longtask 不支持: ' + e.message); }
  let frames = 0, lastFps = performance.now();
  (function tick() {
    frames++;
    const now = performance.now();
    if (now - lastFps >= 1000) { S.fps.push({ rel: rel(lastFps), fps: Math.round((frames * 1000) / (now - lastFps)), match: inMatch() }); frames = 0; lastFps = now; }
    requestAnimationFrame(tick);
  })();
  let wasIn = inMatch();
  try {
    new MutationObserver(() => { const n = inMatch(); if (n !== wasIn) { wasIn = n; S.matchEdges.push({ rel: rel(performance.now()), in: n }); } })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch {}

  // ---------- 驱动游戏 ----------
  let sock = null;
  const sent = [];
  const attach = () => {
    const Orig = globalThis.WebSocket;
    globalThis.WebSocket = function (...a) {
      const s = new Orig(...a);
      if (String(a[0]).includes('/ws')) {
        sock = s;
        const os = s.send.bind(s);
        s.send = (d) => { try { const m = JSON.parse(d); if (m && m.t) sent.push(m.t); } catch {} return os(d); };
      }
      return s;
    };
    globalThis.WebSocket.prototype = Orig.prototype;
  };
  attach();

  const wait = (pred, ms = 15000) => new Promise((res) => {
    if (!sock) return res(null);
    const t = setTimeout(() => { sock.removeEventListener('message', on); res(null); }, ms);
    const on = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (pred(m)) { clearTimeout(t); sock.removeEventListener('message', on); res(m); } };
    sock.addEventListener('message', on);
  });

  (async () => {
    // 等连接出现
    for (let i = 0; i < 60 && !sock; i++) await sleep(500);
    if (!sock) { log('✗ 15 秒内没看到 /ws 连接 —— 请先在大厅页面上点一下「开始」进入房间，然后重跑本脚本'); return; }
    log('已挂上 WebSocket，消息：', sock.readyState === 1 ? '已连接' : `状态 ${sock.readyState}`);

    const stateOf = async () => {
      if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'ping' }));
      return null;
    };

    // 建房（若已在房间里，服务端会回错误，忽略即可）
    log('建房…');
    sock.send(JSON.stringify({ t: 'hello', name: globalThis.localStorage?.getItem('sp.name') || '测量', version: 1 }));
    await sleep(500);
    sock.send(JSON.stringify({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' }));
    const st0 = await wait((m) => m.t === 'room.state');
    if (!st0) { log('✗ 建房无回应。请手动进到「选择模拟协议」页面后再重跑'); return; }
    log('房间已建，当前内容集：', String(st0.content?.cs || '').slice(0, 12));

    // ★ 启用插件
    log('启用插件 spin-bounce…');
    sock.send(JSON.stringify({ t: 'room.setPlugins', plugins: [{ id: 'spin-bounce' }] }));
    const st1 = await wait((m) => m.t === 'room.state' && m.content && m.content.cs !== st0.content.cs);
    if (!st1) { log('✗ 启用插件后内容集没变 —— 服务端可能没装/没加载该插件'); return; }
    const cs = st1.content.cs;
    log('新内容集：', String(cs).slice(0, 12));

    // ★ 同意受信任插件（每内容集一次）
    sock.send(JSON.stringify({ t: 'room.consent', cs, accept: true }));
    await sleep(600);
    try { globalThis.localStorage.setItem('sp.plugin.consent.' + cs, 'yes'); } catch {}

    // 就绪 + 开局
    log('就绪并开局…');
    sock.send(JSON.stringify({ t: 'room.ready', ready: true }));
    await sleep(800);
    sock.send(JSON.stringify({ t: 'room.start', }));

    // 等插件真的被导入
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (globalThis.__SP_SPIN_BOUNCE__) { log(`✓ 插件已加载（${(i * 0.5).toFixed(1)}s）`, snapshot().status); break; }
    }
    if (!globalThis.__SP_SPIN_BOUNCE__) log('⚠ 30 秒内插件没加载 —— 页面上可能有「受信任插件」提示需要你点一下同意');

    log('完成。正常打几轮，然后执行 __SBW__.report() 取报告。');
  })();

  // ---------- 报告 ----------
  const fmtState = (s) => {
    if (!s || s.plugin === false) return '插件未加载';
    const st = s.status || {};
    return `视图${st.views ?? '?'}/单位${st.units ?? '?'}/ticker=${st.ticker ? 'Y' : 'N'}`;
  };
  globalThis.__SBW__ = {
    data: S, snapshot,
    report() {
      const lt = S.longTasks.slice().sort((a, b) => b.dur - a.dur);
      const big = lt.filter((x) => x.dur >= 200);
      const out = ['# 对局卡顿监听报告', '',
        `监听时长：${Math.round((performance.now() - T0) / 1000)} 秒`,
        `插件是否加载：${globalThis.__SP_SPIN_BOUNCE__ ? '是' : '否'}`,
        `插件状态：${fmtState(snapshot())}`, '',
        `## 卡顿（>50ms 共 ${lt.length}，>200ms 共 ${big.length}）`, '',
        '| 时刻(s) | 持续(ms) | 对局中 | 卡住时状态 |', '|---|---|---|---|'];
      for (const x of lt.slice(0, 25)) out.push(`| ${(x.rel / 1000).toFixed(1)} | **${x.dur}** | ${x.match ? '是' : '否'} | ${fmtState(x.state)} |`);
      const low = S.fps.filter((f) => f.fps < 40);
      out.push('', `## FPS < 40 的秒（共 ${low.length}）`, '', '| 时刻(s) | FPS | 对局中 |', '|---|---|---|');
      for (const f of low.slice(0, 25)) out.push(`| ${(f.rel / 1000).toFixed(1)} | ${f.fps} | ${f.match ? '是' : '否'} |`);
      out.push('', '## 对局进出', '', S.matchEdges.map((e) => `${(e.rel / 1000).toFixed(1)}s ${e.in ? '进入' : '离开'}`).join(' → '));
      out.push('', '## 房间消息序列', '', sent.join(', '));
      if (S.errors.length) out.push('', '## 错误', S.errors.join('\n'));
      const text = out.join('\n');
      console.log('%c' + text, 'font-family:monospace');
      try { copy(text); console.log('%c✓ 已复制到剪贴板', 'color:#4ed8af;font-weight:bold'); } catch { console.log('（复制失败，请手动选中）'); }
      return text;
    },
  };
  console.log('%c[自动开局脚本已启动] 它会在 15 秒内接管：建房 → 启用插件 → 开局',
    'color:#4ed8af;font-weight:bold;font-size:13px');
})();
