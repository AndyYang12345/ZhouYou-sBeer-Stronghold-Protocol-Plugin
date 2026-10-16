// src/client.js — 《卫戍协议：盟约》trusted 插件入口（「弹跳自转」）。
//
// Copyright (C) 2026 Harekasa（本项目作者）
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 本文件以 GPL-3.0-or-later 发布（全文见仓库根的 LICENSE）。
// 其中**帧驱动方式**（ticker 优先级、每帧写入预算、挂上后停掉自建 rAF）与
// **渲染层抓手的用法**移植自 CyanFish 的 Stronghold-Protocol-CyanModPack
// （mods/cyanfish.dj-all/client/engine-pixi.js，GPL-3.0-or-later，Copyright (C) 2026 CyanFish）：
//     https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack
// 第三方来源汇总见 NOTICE.md。
//
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

import { EFFECT_DEFAULTS } from './core/unit-effect.js';
import { attachEffect, driveUnit, driveUnitDj, resetUnitDj, optionsFor } from './integrations/units.js';
import { resolveHost, collectUnits } from './integrations/host.js';
import { createMusicController } from './integrations/audio.js';
import { attachSettingsPanel } from './integrations/panel.js';

/** 插件 id，同时用作所有 DOM / localStorage 键的前缀，避免与游戏或其他插件撞名。 */
export const PLUGIN_ID = 'spin-bounce';
export const PLUGIN_VERSION = '0.3.0';
const LOG = `[${PLUGIN_ID}]`;

export const SETTINGS_KEY = 'sp.plugin.spinBounce.settings';

/**
 * 默认设置。
 *
 * ★ `effect` 这一组**直接复用 core 的 `EFFECT_DEFAULTS`**，不再各自维护一份副本。
 *
 * 为什么必须这样：这里曾经是一份独立抄写的副本，后来与 core 漂移了 —— 本对象缺少
 * `spinWritesPerSec` / `spinSmooth` 等项，而 `mergeSettings` 只接受
 * "默认值里已有的键" ⇒ 缺的那些**每次读回时都被静默丢弃**：
 * 面板上把"自转顺滑度"拉高、刷新页面就回到默认，玩家会以为设置没生效。
 * 两份默认值必须只有一个来源。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  effect: EFFECT_DEFAULTS,
  music: {
    enabled: false,   // 浏览器会拦自动播放，也不该一进页面就吵
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

/**
 * **全场共享的弹跳时基**（秒）。
 *
 * 为什么需要它：每个 effect 自己的 `st.time` 是**从该单位被创建那一刻**起算的，
 * 所以各单位的弹跳相位互不相同、整场是散开的（加上"每帧最多新接 3 个"的预算，
 * 开始的时刻更是参差）。这里维护一个统一的时钟，所有单位都读它 ⇒ 严格同相。
 *
 * 只在帧循环里累加，且与 `frameDt` 同源，所以不会与渲染节奏漂移。
 */
let sharedPhase = 0;

const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0, attached: 0 };
export const getStats = () => ({ ...stats });

/**
 * 每帧推进。
 *
 * 每帧**重新收集**单位，而不是维护长期注册表：单位随对局生命周期来去匆匆
 * （`views` 是 Map，随时增删），重新收集最稳，开销也不高 —— 一次 Map 遍历加几个字段检查。
 */
/**
 * 每帧推进。
 *
 * ============================ 两个刻意的设计 ============================
 *
 * ① **每帧重新收集单位**（而不是维护长期注册表）：单位随对局生命周期来去匆匆
 *    （`views` 是 Map，随时增删），重新收集最稳，成本也只是一次 Map 遍历。
 *
 * ② **新建特效有每帧预算**（ATTACH_BUDGET_PER_FRAME）。这一条是为"进入战斗那一下的卡顿"加的：
 *    战斗开始时游戏会一次建好全部单位视图，若在同一帧里给每个单位都 attachEffect
 *    （量模型高度、建弹簧状态、建 DOM 样式），30 个单位就是**同一帧里 30 次初始化** —— 一个尖峰。
 *    改成每帧最多新接几个，初始化就被摊到十几帧里，人眼察觉不到，而那一下的卡顿消失。
 *    已在驱动的单位不受预算限制（它们的每帧成本很小）。
 */
const ATTACH_BUDGET_PER_FRAME = 3;

/**
 * 每帧最多**驱动**多少个单位（照抄参考实现的 `BUDGET = 400`）。
 *
 * 它的用意是"固定预算"：无论场上有多少单位，单帧的写入量都有上限，
 * 于是特效永远不会成为掉帧的主因。我们的单位数远到不了 400，
 * 因此这是一道**保险**而不是常态限制 —— 除非将来有人把单位数堆到几百。
 */
export const UNIT_BUDGET_PER_FRAME = 400;

/** 每帧复用的单位列表缓冲（避免每帧新建数组）。 */
const unitScratch = [];

export function tickEffects(storage, host) {
  // ★ 关闭时**在解析宿主之前**就返回：原来看起来是"早退"，但仍会调用 resolveHost()
  //   （每个帧循环一次属性链访问）。关掉开关就该是零成本。
  if (!storage.settings.effect.enabled) return 0;
  const h = host || resolveHost();
  if (!h) return 0;
  const t0 = storage.debug ? performance.now() : 0;
  const list = collectUnits(h, unitScratch);
  const e = storage.settings.effect;
  // ★ 参考实现路径（core/dj.js）：纯时间函数，所有单位读**同一个时刻** ⇒ 天然严格同相。
  //   它没有逐单位的状态推进，所以既不需要 attachEffect、也没有弹簧/阈值/台阶，
  //   每帧只是几次乘加 —— 这正是"单位多时也不掉帧"的原因。
  const useDj = e.djMode !== false;

  // ============================ 加载期让路 ============================
  // "进入战斗"时游戏要解码单位贴图、建骨架、算 impostor 框，主线程本来就满。
  // 此刻我们再往里塞每帧的变换写入，只会把那一帧推得更长。
  // 判据用**宿主自己的自适应负载等级**（`render/app.js` 的 loadLevel，stats().lod）：
  // 它 ≥2 说明游戏已经认为设备吃紧 —— 那我们也该让路，等它缓过来再继续。
  // 这不是"关掉特效"，只是"这一小段时间不写"，每帧成本几乎为零，所以恢复是无感的。
  if (!storage.suspended) storage.suspended = { on: false, t: 0 };
  const susp = storage.suspended;
  let loadLevel = 0;
  try { loadLevel = h.raw?.stats?.().lod ?? 0; } catch { /* 拿不到就当 0 */ }
  if (loadLevel >= 2) { susp.on = true; susp.t = sharedPhase; }
  else if (susp.on && sharedPhase - susp.t > 1.5) susp.on = false;   // 负载降下来 1.5 秒后恢复
  if (susp.on) return 0;

  let attached = 0;
  let driven = 0;
  for (let i = 0; i < list.length; i++) {
    if (driven + attached >= UNIT_BUDGET_PER_FRAME) break;   // 固定预算（不改数组长度，避免污染复用缓冲）
    const view = list[i];
    if (useDj) {
      driveUnitDj(view, sharedPhase, e);
      driven++;
      continue;
    }
    let fx = effects.get(view);
    if (!fx) {
      // 新单位：受每帧预算限制（见上），本帧超了就留到下一帧
      if (attached >= ATTACH_BUDGET_PER_FRAME) continue;
      fx = attachEffect(view, e);
      if (!fx) continue;
      effects.set(view, fx);
      attached++;
    }
    driveUnit(view, fx, frameDt, sharedPhase);
    driven++;
  }
  if (storage.debug) {
    const ms = performance.now() - t0;
    stats.ticks++; stats.units += driven; stats.ms += ms; stats.attached += attached;
    if (ms > stats.maxMs) stats.maxMs = ms;
    const now = performance.now();
    if (!stats.at) stats.at = now;
    if (now - stats.at >= 2000) {
      console.info(`${LOG} 诊断：${stats.ticks} 帧 / ${(now - stats.at).toFixed(0)}ms，`
        + `平均 ${(stats.ms / Math.max(1, stats.ticks)).toFixed(2)}ms/帧，最慢 ${stats.maxMs.toFixed(2)}ms，`
        + `已接管 ${driven} 个，新接入 ${stats.attached}`);
      stats.ticks = 0; stats.units = 0; stats.ms = 0; stats.maxMs = 0; stats.attached = 0; stats.at = now;
    }
  }
  return driven;
}

// ---- 帧循环 ------------------------------------------------------------------

/** 自适应降级：连续多帧超预算就自动关掉，绝不允许把整局拖到"服务器接管"。 */
const BUDGET_MS = 4;
const BUDGET_STRIKES = 90;

/**
 * 挂到宿主 ticker 上的**优先级**。
 *
 * ★ 这是照抄参考实现（CyanFish CyanModPack, `dj-all/client/engine-pixi.js` 的 TICK_PRIORITY）。
 * PIXI v7 的 ticker 按 priority **降序**执行，而宿主自己的帧回调在 NORMAL(0)、渲染在 LOW(-25)。
 *
 * 取 −20 的用意是拿到一个**确定的写入时机**：
 *
 *     宿主更新单位位置(0) → 我写入变换(−20) → 渲染(−25)
 *
 * 也就是说：写完之后**同一帧就会被渲染**，而且绝不和宿主抢同一层优先级。
 * 早先用的是默认优先级 0（与宿主同级），顺序不确定 —— 可能先写后被宿主覆盖，
 * 也可能写完等一帧才渲染。这类不确定性正是"时好时坏"的来源。
 */
const TICK_PRIORITY = -20;

/**
 * 帧循环。优先挂到**宿主自己的 ticker**（`debug.app.ticker`）：不多开一条 rAF，
 * 且写入顺序可控（宿主渲染在 LOW(-25)，我们在它之前写）。拿不到 ticker 时退回自建 rAF。
 */
/**
 * 帧循环。
 *
 * 驱动方式两级（与参考实现一致）：
 *   1. 能拿到宿主 ticker ⇒ 用 `ticker.add(tick, null, TICK_PRIORITY)` 挂上去，
 *      **并停掉自建的 rAF**（不再需要，也不再重复驱动）。
 *   2. 拿不到 ⇒ 退回自建 rAF，并持续尝试接管。
 *
 * ★ 早先的实现有个错误：挂上 ticker 之后**自建的 rAF 仍在继续跑**（只是不调 step）。
 *   虽然不重复执行逻辑，但每帧多一次回调、还多一次 getHost()，纯属白烧。
 */
function startFrameLoop(storage, getHost, env = {}) {
  let stopped = false;
  let strikes = 0;
  let degraded = false;
  let attached = null;      // { ticker, onTick }
  let rafId = 0;
  let last = 0;

  const step = (dtSeconds) => {
    if (stopped) return;
    frameDt = Math.max(0, Math.min(dtSeconds, 0.25));
    // 全场唯一的弹跳时钟。加个上限：切后台回来或断点调试后的巨大 dt 会让相位瞬移，
    // 表现为"回到页面时所有单位突然跳一下"。
    sharedPhase += Math.min(frameDt, 0.25);
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

  const raf = env.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const caf = env.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);

  const stopRaf = () => { if (rafId && caf) { try { caf(rafId); } catch { /* ignore */ } } rafId = 0; };
  const detachFromHost = () => {
    if (!attached) return;
    try { attached.ticker.remove(attached.onTick); } catch { /* ignore */ }
    attached = null;
  };

  /** 尝试改挂到宿主 ticker；成功则停掉自建 rAF。 */
  const attachToHost = () => {
    const h = getHost();
    const ticker = h && h.ticker;
    if (!ticker || (attached && attached.ticker === ticker)) return !!attached;
    detachFromHost();
    const onTick = () => {
      const d = ticker.deltaMS != null ? ticker.deltaMS / 1000 : (ticker.deltaTime || 1) / 60;
      step(d);
    };
    try {
      ticker.add(onTick, null, TICK_PRIORITY);   // ★ 优先级 −20：写完就在同一帧被渲染
    } catch (err) {
      console.warn(`${LOG} 挂载宿主 ticker 失败（退回自建 rAF）`, err);
      return false;
    }
    attached = { ticker, onTick };
    stopRaf();                                    // ★ 不再需要自建循环
    console.info(`${LOG} 已接管宿主 ticker（优先级 ${TICK_PRIORITY}）`);
    return true;
  };

  const loop = (now) => {
    if (stopped) return;
    if (!attached) {
      const dt = last ? (now - last) / 1000 : 1 / 60;
      step(dt);                                   // 兜底：还没接管时自己驱动
      if (!attachToHost() && raf) rafId = raf(loop);
    }
    last = now;
  };
  if (raf) rafId = raf(loop);

  return () => { stopped = true; stopRaf(); detachFromHost(); };
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
    if (!e.enabled) { fx?.setEnabled(false); fx?.reset(); resetUnitDj(view); continue; }
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
      spinWritesPerSec: e.spinWritesPerSec,
      spinSmooth: e.spinSmooth,
      syncBounce: e.syncBounce,
      syncSpin: e.syncSpin,
      movingSpeedScale: e.movingSpeedScale,
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
  let lod = 0;
  try { lod = h.raw?.stats?.().lod ?? 0; } catch { /* ignore */ }
  return {
    host: true,
    ticker: !!h.ticker,
    views: h.views.size,
    penViews: h.penViews ? h.penViews.size : 0,
    units: collectUnits(h).length,
    lod,
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
