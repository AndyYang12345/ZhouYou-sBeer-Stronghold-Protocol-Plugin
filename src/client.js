// src/client.js — 《卫戍协议：盟约》trusted 插件入口（「弹跳自转」）。
//
// ===================== 为什么这是 trusted 而不是 ui 插件 =====================
//
// 本插件要改变**单位容器的变换矩阵**，也就是要拿到每一帧的渲染对象。插件系统里只有
// `trusted` 类做得到：
//
//   * public/js/content.js:546 —— `await import(scriptUrl(cs, p.id, m.entry.client))`
//     也就是说 trusted 的 `entry.client` 会被动态 import 成**主页面里的原生 ES 模块**
//     （不是沙箱 iframe）。于是相对 import 可用，宿主全局对象也可用。
//   * `ui` 类的 iframe 带 UI_FRAME_CSP（`default-src 'none'`、`connect-src 'none'`、
//     且没有 `media-src`、无 allow-same-origin），看得到但碰不到 —— 做不了渲染，也放不了音乐。
//
// ===================== 怎么拿到渲染层 =====================
//
// 用宿主**自己暴露的调试抓手**（`globalThis.__SP_VIEW__.raw.debug`），不挂钩原型、不改任何文件。
// 详见 integrations/host.js 抬头 —— 那里记录了"挂钩原型自己猜"那条路连踩的三个坑。

import { attachEffect, driveUnit, optionsFor } from './integrations/units.js';
import { resolveHost, collectUnits } from './integrations/host.js';
import { createMusicController } from './integrations/audio.js';
import { attachSettingsPanel } from './integrations/panel.js';

/** 插件 id，同时用作所有 DOM / localStorage 键的前缀，避免与游戏或其他插件撞名。 */
export const PLUGIN_ID = 'spin-bounce';
export const PLUGIN_VERSION = '0.3.0';
const LOG = `[${PLUGIN_ID}]`;

export const SETTINGS_KEY = 'sp.plugin.spinBounce.settings';

/** 默认设置：特效**开启**、音乐**关闭**（浏览器会拦自动播放，也不该一进页面就吵）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  effect: {
    enabled: true,
    strength: 1.15,
    spinPeriod: 2.7,
    pulsesPerSecond: 2,
    hopAmplitude: 0.115,
    spinAxis: 'vertical',   // 'vertical' 竖轴自转（梗图效果）| 'screen' 屏幕平面内转
    deadSpinScale: 1,
    deadBounce: false,
  },
  music: {
    enabled: false,
    volume: 0.55,
  },
});

// ---- 设置持久化（仅本浏览器，绝不上报）--------------------------------------

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 深合并，但只接受与默认值**同类型**的字段（挡住旧版本残留的坏值）。 */
export function mergeSettings(base, patch) {
  const out = clone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const [group, val] of Object.entries(patch)) {
    if (!out[group] || typeof out[group] !== 'object' || !val || typeof val !== 'object') continue;
    for (const [k, v] of Object.entries(val)) {
      if (!(k in out[group])) continue;
      if (typeof out[group][k] !== typeof DEFAULT_SETTINGS[group][k]) continue;
      out[group][k] = v;
    }
  }
  return out;
}

export function readSettings(storage = globalThis.localStorage) {
  let out;
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    out = raw ? mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw)) : clone(DEFAULT_SETTINGS);
  } catch {
    out = clone(DEFAULT_SETTINGS);
  }
  out.effect.enabled = applySafetySwitches(out.effect.enabled, storage);
  return out;
}

/**
 * 安全阀（按优先级）：
 *   1. URL 带 `?sbn=0` → 强制关闭并**持久化**（出问题时刷新一下就能救回来，不必进设置面板）
 *   2. 系统「减少动态效果」→ 默认关闭（可用 `?sbn=1` 显式覆盖）
 *
 * 之所以要做第 1 条：这个特效每帧改写所有单位的变换，一旦性能出问题，玩家最需要的是
 * **一个不用点进任何界面就能关掉它的开关**。
 */
function applySafetySwitches(current, storage = globalThis.localStorage, loc = globalThis.location) {
  try {
    const q = new URLSearchParams(loc?.search || '').get('sbn');
    if (q === '0' || q === 'off') {
      try { storage?.setItem(SETTINGS_KEY + '.killed', '1'); } catch { /* ignore */ }
      return false;
    }
    if (q === '1' || q === 'on') {
      try { storage?.removeItem(SETTINGS_KEY + '.killed'); } catch { /* ignore */ }
      return true;
    }
    if (storage?.getItem(SETTINGS_KEY + '.killed') === '1') return false;
  } catch { /* ignore */ }
  try {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
  } catch { /* ignore */ }
  return current;
}

export function writeSettings(s, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 无痕模式等 */ }
}

/** 性能诊断开关（`sp.plugin.spinBounce.settings.debug` = '1'）。 */
function debugOn(storage = globalThis.localStorage) {
  try { return storage?.getItem(SETTINGS_KEY + '.debug') === '1'; } catch { return false; }
}

// ---- 逐帧驱动 ----------------------------------------------------------------

/**
 * 单位 → 特效实例。用 WeakMap 而不是给 view 挂属性：
 * 不污染游戏对象、单位被回收时自动释放、也不会与其他插件抢同一个属性名。
 */
const effects = new WeakMap();

/** 当前帧的 dt（秒），由帧循环写入。 */
let frameDt = 1 / 60;

const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0 };
export const getStats = () => ({ ...stats });

/**
 * 每帧推进。
 *
 * 每帧**重新收集**单位，而不是维护长期注册表：单位随对局生命周期来去匆匆
 * （`views` 是 Map，随时增删），重新收集最稳，开销也不高 —— 一次 Map 遍历加几个字段检查。
 */
export function tickEffects(storage, host) {
  if (!storage.settings.effect.enabled) return 0;
  const h = host || resolveHost();
  if (!h) return 0;
  const t0 = storage.debug ? performance.now() : 0;
  const list = collectUnits(h);
  for (let i = 0; i < list.length; i++) {
    const view = list[i];
    let fx = effects.get(view);
    if (!fx) {
      fx = attachEffect(view, storage.settings.effect);
      if (!fx) continue;
      effects.set(view, fx);
    }
    driveUnit(view, fx, frameDt);
  }
  if (storage.debug) {
    const ms = performance.now() - t0;
    stats.ticks++; stats.units += list.length; stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    const now = performance.now();
    if (!stats.at) stats.at = now;
    if (now - stats.at >= 2000) {
      console.info(`${LOG} 诊断：${stats.ticks} 帧 / ${(now - stats.at).toFixed(0)}ms，`
        + `平均 ${(stats.ms / Math.max(1, stats.ticks)).toFixed(2)}ms/帧，最慢 ${stats.maxMs.toFixed(2)}ms，`
        + `单位数 ${list.length}`);
      stats.ticks = 0; stats.units = 0; stats.ms = 0; stats.maxMs = 0; stats.at = now;
    }
  }
  return list.length;
}

// ---- 帧循环 ------------------------------------------------------------------

/** 自适应降级：连续多帧超预算就自动关掉，绝不允许把整局拖到"服务器接管"。 */
const BUDGET_MS = 4;
const BUDGET_STRIKES = 90;

/**
 * 帧循环。优先挂到**宿主自己的 ticker**（`debug.app.ticker`）：不多开一条 rAF，
 * 且写入顺序可控（宿主渲染在 LOW(-25)，我们在它之前写）。拿不到 ticker 时退回自建 rAF。
 */
function startFrameLoop(storage, getHost, env = {}) {
  let stopped = false;
  let strikes = 0;
  let degraded = false;
  let attached = null;

  const step = (dtSeconds) => {
    if (stopped) return;
    frameDt = Math.max(0, Math.min(dtSeconds, 0.25));
    const t0 = performance.now();
    try { tickEffects(storage, getHost()); } catch (err) { console.warn(`${LOG} 帧驱动出错`, err); }
    const cost = performance.now() - t0;
    if (degraded) return;
    strikes = cost > BUDGET_MS ? strikes + 1 : 0;
    if (strikes >= BUDGET_STRIKES) {
      degraded = true;
      storage.degraded = true;
      storage.settings.effect.enabled = false;
      try { writeSettings(storage.settings); } catch { /* ignore */ }
      console.warn(`${LOG} 特效每帧耗时持续超过 ${BUDGET_MS}ms，已**自动关闭**以免拖慢对局。`
        + `可在设置面板重新开启，或用 ?sbn=0 永久关闭。`);
      try { globalThis.dispatchEvent?.(new CustomEvent('spin-bounce-degraded')); } catch { /* ignore */ }
    }
  };

  const detachFromHost = () => {
    if (!attached) return;
    try { attached.ticker.remove(attached.onTick); } catch { /* ignore */ }
    attached = null;
  };
  const attachToHost = () => {
    const h = getHost();
    const ticker = h && h.ticker;
    if (!ticker || attached === ticker) return;
    detachFromHost();
    const onTick = () => {
      const d = ticker.deltaMS != null ? ticker.deltaMS / 1000 : (ticker.deltaTime || 1) / 60;
      step(d);
    };
    ticker.add(onTick);
    attached = { ticker, onTick };
    console.info(`${LOG} 已接管宿主 ticker 的帧回调`);
  };

  const raf = env.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  let last = 0;
  const loop = (now) => {
    if (stopped) return;
    if (!attached) {
      attachToHost();                       // ticker 随对局视图来去匆匆，要反复尝试接管
      if (!attached) {
        const dt = last ? (now - last) / 1000 : 1 / 60;
        step(dt);
      }
    }
    last = now;
    if (raf) raf(loop);
  };
  if (raf) raf(loop);

  return () => { stopped = true; detachFromHost(); };
}

// ---- 离开对局时复位 ----------------------------------------------------------

/**
 * 盯 `html.sp-in-match`（游戏自己维护，见 `screens/game.js` 的 `useDocClass`）。
 * 离开对局时把在场景里的单位复位，避免它们保持压扁姿态被复用。
 */
function watchMatchState(storage, getHost, doc = globalThis.document) {
  if (!doc?.documentElement) return () => {};
  const reset = () => {
    if (doc.documentElement.classList.contains('sp-in-match')) return;
    const h = getHost();
    if (!h) return;
    for (const view of collectUnits(h)) effects.get(view)?.reset();
  };
  const mo = new MutationObserver(reset);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  reset();
  return () => mo.disconnect();
}

// ---- 设置改动即时生效（不必重载页面）----------------------------------------

/**
 * 打开开关时**立刻**给在场单位补上特效，否则玩家会以为开关没反应
 * （要等下一个单位出现才看到效果）。
 */
export function applyLiveSettings(storage, host) {
  const h = host !== undefined ? host : resolveHost();
  const e = storage.settings.effect;
  const list = h ? collectUnits(h) : [];
  for (const view of list) {
    let fx = effects.get(view);
    if (!e.enabled) { fx?.setEnabled(false); fx?.reset(); continue; }
    if (!fx) {
      fx = attachEffect(view, e);
      if (fx) effects.set(view, fx);
      continue;
    }
    fx.setEnabled(true);
    fx.setSpinPeriod(optionsFor(view, e).spinPeriod);
    Object.assign(fx.state.cfg, {
      strength: e.strength,
      spinAxis: e.spinAxis,
      spinSteps: e.spinSteps,
      hopAmplitude: e.hopAmplitude,
      pulsesPerSecond: e.pulsesPerSecond,
      deadSpinScale: e.deadSpinScale,
      deadBounce: e.deadBounce,
    });
  }
}

// ---- 状态 --------------------------------------------------------------------

/** 面板上显示的状态行（让玩家一眼看出插件到底有没有在工作）。 */
export function statusOf(host) {
  const h = host !== undefined ? host : resolveHost();
  if (!h) return { host: false, units: 0, views: 0, penViews: 0, ticker: false };
  return {
    host: true,
    ticker: !!h.ticker,
    views: h.views.size,
    penViews: h.penViews ? h.penViews.size : 0,
    units: collectUnits(h).length,
  };
}

// ---- 启动 --------------------------------------------------------------------

let started = null;

/**
 * 启动插件。trusted 插件在模块顶层调用它（导入即生效）。
 * @param {object} [env] 可注入的宿主环境，便于测试
 */
export function start(env = {}) {
  if (started) return started;

  const doc = env.document ?? globalThis.document;
  const g = env.global ?? globalThis;
  const settings = env.settings ?? readSettings(env.storage ?? g.localStorage);
  const storage = { settings, debug: env.debug ?? debugOn(env.storage ?? g.localStorage), degraded: false };

  // ============================ 初始化顺序很重要 ============================
  // 面板与音乐**必须先挂**，且绝不依赖渲染层。
  // 之前把面板放在"渲染层就绪"分支之后，而渲染层要等进入对局才可用 —— 一旦那条路
  // 出问题，玩家就**看不到任何开关**，连关掉它的入口都没有。
  // 教训：安全开关必须比被它保护的功能更早、更可靠地存在。

  const music = createMusicController({
    settings: storage.settings.music,
    doc,
    elementId: env.musicElementId ?? 'sp-spin-music',
    src: env.musicSrc,
    storage: env.storage,
  });
  music.setEnabled(storage.settings.music.enabled);
  music.armAutoStart();

  const getHost = () => resolveHost(g);

  const panel = attachSettingsPanel({
    doc,
    settings: storage.settings,
    music,
    storage: env.storage ?? g.localStorage,
    status: () => statusOf(getHost()),
    onChange: (next) => {
      storage.settings = next;
      writeSettings(next, env.storage ?? g.localStorage);
      applyLiveSettings(storage, getHost());
    },
  });
  console.info(`${LOG} 设置面板已挂载（右下角「弹 设置」按钮）`);

  // 对外的逃生舱：玩家/作者可在控制台直接开关，不必依赖界面
  const api = {
    version: PLUGIN_VERSION,
    get settings() { return storage.settings; },
    on() { storage.settings.effect.enabled = true; writeSettings(storage.settings); applyLiveSettings(storage, getHost()); return 'effect on'; },
    off() { storage.settings.effect.enabled = false; writeSettings(storage.settings); applyLiveSettings(storage, getHost()); return 'effect off'; },
    musicOn() { storage.settings.music.enabled = true; writeSettings(storage.settings); music.setEnabled(true); return music.play(); },
    musicOff() { storage.settings.music.enabled = false; writeSettings(storage.settings); music.setEnabled(false); music.pause(); return 'music off'; },
    stats: getStats,
    status: () => statusOf(getHost()),
  };
  g.__SP_SPIN_BOUNCE__ = api;

  const stopLoop = startFrameLoop(storage, getHost, env);
  const stopWatch = watchMatchState(storage, getHost, doc);

  // 渲染层还没出现时只记一条日志：帧循环与状态行会持续重试，不需要额外分支。
  if (!getHost()) console.info(`${LOG} 等待渲染层（进入对局后才会出现）…；设置面板已可用`);

  console.info(`${LOG} v${PLUGIN_VERSION} 已启动（弹跳自转${storage.settings.effect.enabled ? '开启' : '关闭'}，`
    + `音乐${storage.settings.music.enabled ? '开启' : '关闭'}）`);

  started = {
    ok: true,
    get settings() { return storage.settings; },
    api, music, panel, getHost,
    stop() {
      stopLoop(); stopWatch(); panel?.destroy?.();
      started = null;
    },
  };
  return started;
}

// trusted 插件：导入即生效。
start();
