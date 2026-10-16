// tools/measure-battle-start.js — 测「进入战斗那一下」的耗时构成。
//
// 用法：进游戏 → F12 → Console → 粘贴本文件全部内容 → 回车。
// 它会装一组只读探针，然后提示你「现在去开一局」，把进战斗前后的时间线打出来。
// 不改任何游戏状态。
//
// 为什么要这样测：进战斗的耗时由几部分构成，只有分开量才知道哪部分可省：
//   ① 游戏加载 PIXI + pixi-spine（按需加载，必然成本）
//   ② 游戏建视图 / 建棋盘 / 首批单位
//   ③ 插件在这一段的开销（挂钩、收集单位、首次 attachEffect、首次量高度）
(() => {
  const marks = [];
  const t0 = performance.now();
  const mark = (name) => marks.push({ name, t: performance.now() - t0 });

  // ---- 探针 1：PIXI 何时出现（= 游戏开始加载渲染器）----
  let pixiAt = null;
  const pollPixi = setInterval(() => {
    if (globalThis.PIXI) { pixiAt = performance.now() - t0; mark('PIXI 就绪'); clearInterval(pollPixi); }
  }, 16);
  if (globalThis.PIXI) { pixiAt = 0; mark('PIXI 已存在'); clearInterval(pollPixi); }

  // ---- 探针 2：__SP_VIEW__ 何时出现（= 视图挂载完成）----
  let viewAt = null;
  const pollView = setInterval(() => {
    if (globalThis.__SP_VIEW__) { viewAt = performance.now() - t0; mark('__SP_VIEW__ 就绪'); clearInterval(pollView); }
  }, 16);
  if (globalThis.__SP_VIEW__) { viewAt = 0; mark('__SP_VIEW__ 已存在'); clearInterval(pollView); }

  // ---- 探针 3：插件每帧的自身开销（长任务观测）----
  const longTasks = [];
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime - t0, dur: e.duration });
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* 部分浏览器不支持 longtask */ }

  // ---- 探针 4：插件自身 tick 的耗时累计 ----
  const api = globalThis.__SP_SPIN_BOUNCE__;
  const before = api?.stats ? api.stats() : null;

  console.info('%c[测量] 探针已装好。现在去开一局，然后回来执行：__SP_MEASURE__()',
    'color:#4ed8af;font-weight:bold');

  globalThis.__SP_MEASURE__ = () => {
    const stats = globalThis.__SP_SPIN_BOUNCE__?.stats?.();
    const host = globalThis.__SP_SPIN_BOUNCE__?.status?.();
    console.log('%c===== 进战斗耗时构成 =====', 'color:#4ed8af;font-weight:bold');
    console.log('时间线（相对粘贴时刻，ms）:');
    for (const m of marks) console.log(`  ${String(Math.round(m.t)).padStart(6)} ms  ${m.name}`);
    if (pixiAt != null && viewAt != null) {
      console.log(`\n  渲染器加载 → 视图就绪: ${Math.round(viewAt - pixiAt)} ms  ← 这一段是游戏自己的成本`);
    }
    if (longTasks.length) {
      const worst = longTasks.slice().sort((a, b) => b.dur - a.dur).slice(0, 8);
      console.log(`\n长任务（>50ms，共 ${longTasks.length} 个），最长的几个:`);
      for (const t of worst) console.log(`  起于 ${String(Math.round(t.start)).padStart(6)} ms  持续 ${Math.round(t.dur)} ms`);
    } else {
      console.log('\n没有观测到长任务（>50ms）。');
    }
    console.log('\n插件自身:');
    console.log('  stats:', JSON.stringify(stats));
    console.log('  status:', JSON.stringify(host));
    if (before) console.log('  粘贴时刻的 stats:', JSON.stringify(before));
    console.log('\n→ 把以上全部内容发我');
    return { marks, pixiAt, viewAt, longTasks, stats, host };
  };
})();
