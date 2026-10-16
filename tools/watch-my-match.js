/* tools/watch-my-match.js — 后台监听你的真实对局（粘一次，之后不用管）。
 *
 * 用法：
 *   1. 进游戏（在大厅或已经在对局里都行）→ F12 → Console
 *   2. 粘贴本文件全部内容 → 回车
 *   3. **正常打几轮**（重点是"回合开始时那一下卡顿"）
 *   4. 打完执行：__SBW__.report()
 *      → 报告会打印出来，同时尽量复制到剪贴板，直接粘给我即可
 *
 * 它只读、不改游戏状态；除了你自己调用 report() 之外不会干扰任何东西。
 *
 * 为什么要在你的浏览器里跑：无头浏览器测不出这个卡顿（它的软件渲染路径、
 * 资源加载时机都和真实环境不同，我实测过：无头里那个尖峰在**没装插件**时也有）。
 */
(() => {
  const T0 = performance.now();
  const rel = (t) => Math.round(t - T0);

  const S = {
    longTasks: [],            // { rel, dur }  —— 主线程被占住的事件
    fps: [],                  // { rel, fps }   —— 每秒采样
    matchEdges: [],           // 进入/离开对局的时刻
    samples: [],              // 与长任务对齐的插件状态快照
    errors: [],
    started: new Date().toISOString(),
  };

  // ---- 长任务：主线程被阻塞 >50ms 就会记录 ----
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const rec = { rel: rel(e.startTime), dur: Math.round(e.duration), match: inMatch() };
        S.longTasks.push(rec);
        // 顺带抓一份"卡住时"的状态快照，用于判断归属
        try { rec.state = snapshot(); } catch { /* ignore */ }
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { S.errors.push('longtask 不支持: ' + e.message); }

  // ---- 每秒 FPS ----
  let frames = 0, lastFpsAt = performance.now();
  const tick = () => {
    frames++;
    const now = performance.now();
    if (now - lastFpsAt >= 1000) {
      S.fps.push({ rel: rel(lastFpsAt), fps: Math.round((frames * 1000) / (now - lastFpsAt)), match: inMatch() });
      frames = 0; lastFpsAt = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- 对局进出（回合开始卡顿的高发时刻）----
  function inMatch() {
    try { return document.documentElement.classList.contains('sp-in-match'); } catch { return false; }
  }
  let wasIn = inMatch();
  S.matchEdges.push({ rel: 0, in: wasIn });
  try {
    new MutationObserver(() => {
      const now = inMatch();
      if (now !== wasIn) { wasIn = now; S.matchEdges.push({ rel: rel(performance.now()), in: now }); }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch { /* ignore */ }

  // ---- 插件状态快照 ----
  function snapshot() {
    const a = globalThis.__SP_SPIN_BOUNCE__;
    if (!a) return { plugin: false };
    let status = null, stats = null;
    try { status = a.status(); } catch (e) { status = String(e.message); }
    try { stats = a.stats(); } catch (e) { stats = String(e.message); }
    return { plugin: true, status, stats, settings: { syncBounce: a.settings?.effect?.syncBounce, syncSpin: a.settings?.effect?.syncSpin } };
  }

  // ---- 报告 ----
  const fmtState = (s) => {
    if (!s || s.plugin === false) return '插件未加载';
    const st = s.status || {};
    return `视图${st.views ?? '?'}/预览${st.penViews ?? '?'}/单位${st.units ?? '?'} ticker=${st.ticker ? 'Y' : 'N'}`;
  };

  globalThis.__SBW__ = {
    data: S,
    snapshot,
    /** 打印并复制报告。 */
    report() {
      const lt = S.longTasks.slice().sort((a, b) => b.dur - a.dur);
      const big = lt.filter((x) => x.dur >= 200);
      const inMatchLt = lt.filter((x) => x.match);
      const out = [];
      out.push('# 对局卡顿监听报告');
      out.push('');
      out.push(`监听时长：${Math.round((performance.now() - T0) / 1000)} 秒`);
      out.push(`插件是否加载：${globalThis.__SP_SPIN_BOUNCE__ ? '是' : '否'}`);
      const st = snapshot();
      if (st.plugin) out.push(`插件状态：${fmtState(st)}，设置=${JSON.stringify(st.settings)}`);
      out.push('');
      out.push(`## 卡顿事件（>50ms 共 ${lt.length} 个，其中 >200ms 共 ${big.length} 个，对局中 ${inMatchLt.length} 个）`);
      out.push('');
      out.push('| 时刻(s) | 持续(ms) | 在对局中 | 卡住时状态 |');
      out.push('|---|---|---|---|');
      for (const x of lt.slice(0, 25)) {
        out.push(`| ${(x.rel / 1000).toFixed(1)} | **${x.dur}** | ${x.match ? '是' : '否'} | ${fmtState(x.state)} |`);
      }
      out.push('');
      out.push('## FPS（低于 40 的段落）');
      out.push('');
      const low = S.fps.filter((f) => f.fps < 40);
      if (!low.length) out.push('（没有低于 40 的秒）');
      else {
        out.push('| 时刻(s) | FPS | 在对局中 |');
        out.push('|---|---|---|');
        for (const f of low.slice(0, 25)) out.push(`| ${(f.rel / 1000).toFixed(1)} | ${f.fps} | ${f.match ? '是' : '否'} |`);
      }
      out.push('');
      out.push('## 对局进出时刻');
      out.push('');
      out.push(S.matchEdges.map((e) => `${(e.rel / 1000).toFixed(1)}s ${e.in ? '进入' : '离开'}`).join(' → '));
      if (S.errors.length) { out.push(''); out.push('## 错误'); out.push(S.errors.join('\n')); }
      const text = out.join('\n');
      console.log('%c' + text, 'font-family:monospace');
      try {
        copy(text);   // DevTools 的 copy()：直接进剪贴板
        console.log('%c✓ 报告已复制到剪贴板，直接粘给对方即可', 'color:#4ed8af;font-weight:bold');
      } catch {
        console.log('（剪贴板复制失败，请手动选中上面的报告）');
      }
      return text;
    },
    /** 清空重新开始计数。 */
    reset() { S.longTasks.length = 0; S.fps.length = 0; S.samples.length = 0; S.matchEdges.length = 0; S.started = new Date().toISOString(); },
  };

  console.log('%c[监听已启动] 正常打几轮，然后执行：__SBW__.report()',
    'color:#4ed8af;font-weight:bold;font-size:13px');
})();
