// plugin/spin-bounce/client.js — 《卫戍协议：盟约》trusted 插件入口（「弹跳自转」）。
//
// ===================== 为什么这是 trusted 而不是 ui 插件 =====================
//
// 本插件要改变**单位容器的变换矩阵**，也就是要拿到每一帧的渲染对象。插件系统里只有
// `trusted` 类做得到：
//
//   * public/js/content.js:546 —— `await import(scriptUrl(cs, p.id, m.entry.client))`
//     也就是说 trusted 的 `entry.client` 会被动态 import 成**主页面里的原生 ES 模块**
//     （不是沙箱 iframe）。于是相对 import 可用，`globalThis.PIXI` 可用。
//   * `ui` 类的 iframe 带 UI_FRAME_CSP（`default-src 'none'`、`connect-src 'none'`、
//     且没有 `media-src`、无 allow-same-origin），看得到但碰不到 —— 做不了渲染，也放不了音乐。
//   * `cosmetic` 只能替换素材，`content` 只能改数据，`script` 在战斗 Worker 里 —— 都碰不到渲染。
//
// 自身 URL 形如 /cs/<cs>/scripts/spin-bounce/client.js，由服务器按文件字节下发（不打包），
// 所以下面全部使用相对 import。
//
// ===================== 不修改任何随包文件 =====================
//
// 本插件**不改动游戏的任何文件**，因此与 MANIFEST.json 校验、更新包、`UPDATE.json.removed`
// 全都无冲突：上游更新后无需重打任何补丁。发现渲染层的方式是运行期挂钩
// `PIXI.Container.prototype.addChild`，不落地任何文件。

import { attachEffect, driveUnit, looksLikeUnitView, optionsFor } from './integrations/units.js';
import { createMusicController } from './integrations/audio.js';
import { attachSettingsPanel } from './integrations/panel.js';

/** 插件 id，同时用作所有 DOM / localStorage 键的前缀，避免与游戏或其他插件撞名。 */
export const PLUGIN_ID = 'spin-bounce';
export const PLUGIN_VERSION = '0.1.0';
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
  out.effect.enabled = applySafetySwitches(out.effect.enabled);
  return out;
}

/**
 * 安全阀（按优先级）：
 *   1. URL 带 `?sbn=0` → 强制关闭并**持久化**（出问题时刷新一下就能救回来，不必进设置面板）
 *   2. 系统「减少动态效果」→ 默认关闭（用户可再手动开启）
 *   3. 系统「减少动态效果」+ URL `?sbn=1` → 尊重显式请求，开启
 *
 * 之所以要做第 1 条：这个特效每帧改写所有单位的变换，一旦性能出问题，玩家最需要的是
 * **一个不用点进任何界面就能关掉它的开关**。
 */
function applySafetySwitches(current, storage = globalThis.localStorage, loc = globalThis.location) {
  let on = current;
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
  return on;
}

export function writeSettings(s, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 无痕模式等 */ }
}

// ---- 单位发现：挂钩 PIXI 原型，不改任何游戏文件 ------------------------------

/**
 * 挂钩 `PIXI.Container.prototype.addChild` 以发现单位层。
 *
 * 为什么要这样绕：单位注册表 `views` 是 `render/app.js` 里的**局部变量**，外部拿不到；
 * `app` / `stage` 也没挂到全局。而 `globalThis.PIXI` 是全局的（`units.js:561` 自己就在用
 * `globalThis.PIXI.Texture.WHITE`）。
 *
 * `addChild` 是所有对象进入场景图的必经之路。我们只关心「带 body/root/hud 的容器」
 * （= UnitView 自己）被加进场景图的那一刻 —— 它的父容器就是 units 层。
 *
 * 幂等：重复调用返回同一份状态，不会重复包装原型。
 */
export function installUnitDiscovery(PIXI = globalThis.PIXI) {
  const proto = PIXI?.Container?.prototype;
  if (!proto) return null;
  if (proto.__sbPatched) return proto.__sbState;

  const state = {
    unitsLayer: null,
    onUnit: null,          // 发现新单位时的回调
  };

  const original = proto.addChild;
  proto.addChild = function patchedAddChild(...args) {
    const result = original.apply(this, args);
    try {
      for (const child of args) {
        if (looksLikeUnitView(child)) {
          if (!state.unitsLayer) {
            state.unitsLayer = this;
            cachedLayer = this;
            console.info(`${LOG} 已定位单位层（当前 ${this.children.length} 个子对象）`);
          }
          state.onUnit?.(child);
        }
      }
    } catch (err) {
      console.warn(`${LOG} 单位发现出错（不影响游戏）`, err);
    }
    return result;
  };
  proto.__sbPatched = true;
  proto.__sbState = state;
  return state;
}

// ---- 逐帧驱动 ----------------------------------------------------------------

/**
 * 单位 → 特效实例。用 WeakMap 而不是给 view 挂属性：
 * 不污染游戏对象、单位被回收时自动释放、也不会与其他插件抢同一个属性名。
 */
const effects = new WeakMap();

/** 单位层引用（挂钩时记录，避免每帧走原型链）。 */
let cachedLayer = null;
const layerRef = () => cachedLayer || (cachedLayer = globalThis.PIXI?.Container?.prototype?.__sbState?.unitsLayer || null);

/** 当前帧的 dt（秒），由帧循环写入。 */
let frameDt = 1 / 60;

/** 性能诊断开关（settings.debug 或 localStorage 的 sp.plugin.spinBounce.debug = '1'）。 */
function debugOn(storage = globalThis.localStorage) {
  try { return storage?.getItem(SETTINGS_KEY + '.debug') === '1'; } catch { return false; }
}
const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0 };
export const getStats = () => ({ ...stats });

/** 遍历当前单位层，推进所有特效。 */
export function tickEffects(storage) {
  // 层引用提到循环外：原来每单位都要走一次原型链查找
  const layer = layerRef();
  if (!layer) return;
  if (!storage.settings.effect.enabled) return;
  const t0 = storage.debug ? performance.now() : 0;
  const list = layer.children;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const view = list[i];
    let fx = effects.get(view);
    if (!fx) {
      if (!looksLikeUnitView(view)) continue;
      fx = attachEffect(view, storage.settings.effect);
      if (!fx) continue;
      effects.set(view, fx);
    }
    driveUnit(view, fx, frameDt);
    n++;
  }
  if (storage.debug) {
    const ms = performance.now() - t0;
    stats.ticks++; stats.units += n; stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    const now = performance.now();
    if (!stats.at) stats.at = now;
    if (now - stats.at >= 2000) {
      console.info(`${LOG} 诊断：${stats.ticks} 帧 / ${(now - stats.at).toFixed(0)}ms，` +
        `平均 ${(stats.ms / Math.max(1, stats.ticks)).toFixed(2)}ms/帧，最慢 ${stats.maxMs.toFixed(2)}ms，` +
        `平均单位数 ${(stats.units / Math.max(1, stats.ticks)).toFixed(1)}`);
      stats.ticks = 0; stats.units = 0; stats.ms = 0; stats.maxMs = 0; stats.at = now;
    }
  }
}

// ---- 帧循环 ------------------------------------------------------------------

/**
 * 自适应降级：连续多帧耗时超过预算就**自动关掉特效**并明确告知玩家。
 *
 * 宁可功能自己退场，也不能把整局拖到"服务器接管" —— 那会直接毁掉玩家的对局。
 * 阈值取得比一帧预算（16.7ms）宽，避免偶发抖动误杀。
 */
const BUDGET_MS = 4;          // 特效自己每帧的时间预算
const BUDGET_STRIKES = 90;    // 连续超预算这么多帧就降级（约 1.5 秒）

function startFrameLoop(storage, raf = globalThis.requestAnimationFrame?.bind(globalThis)) {
  if (!raf) return () => {};
  let last = 0;
  let stopped = false;
  let strikes = 0;
  let degraded = false;
  const step = (now) => {
    if (stopped) return;
    // 切后台再回来时 dt 会很大 —— core 里也有一道防护，这里先夹一次
    frameDt = last ? Math.min((now - last) / 1000, 0.25) : 1 / 60;
    last = now;
    const t0 = performance.now();
    try { tickEffects(storage); } catch (err) { console.warn(`${LOG} 帧驱动出错`, err); }
    const cost = performance.now() - t0;
    if (!degraded) {
      strikes = cost > BUDGET_MS ? strikes + 1 : 0;
      if (strikes >= BUDGET_STRIKES) {
        degraded = true;
        storage.settings.effect.enabled = false;
        try { writeSettings(storage.settings); } catch { /* ignore */ }
        console.warn(`${LOG} 特效每帧耗时持续超过 ${BUDGET_MS}ms，已**自动关闭**以免拖慢对局。` +
          `可在设置面板重新开启，或用 ?sbn=0 永久关闭。`);
        try { globalThis.dispatchEvent?.(new CustomEvent('spin-bounce-degraded')); } catch { /* ignore */ }
      }
    }
    raf(step);
  };
  raf(step);
  return () => { stopped = true; };
}

// ---- 离开对局时复位 ----------------------------------------------------------

/**
 * 盯 `html.sp-in-match`（游戏自己维护，见 `screens/game.js` 的 `useDocClass`）。
 * 离开对局时把仍在场景里的单位复位，避免它们保持压扁姿态被复用。
 */
function watchMatchState(storage, doc = globalThis.document) {
  if (!doc?.documentElement) return () => {};
  const reset = () => {
    if (doc.documentElement.classList.contains('sp-in-match')) return;
    const layer = globalThis.PIXI?.Container?.prototype?.__sbState?.unitsLayer;
    if (!layer) return;
    for (const view of layer.children) effects.get(view)?.reset();
  };
  const mo = new MutationObserver(reset);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  reset();
  return () => mo.disconnect();
}

// ---- 设置改动即时生效（不必重载页面）----------------------------------------

export function applyLiveSettings(storage) {
  const layer = globalThis.PIXI?.Container?.prototype?.__sbState?.unitsLayer;
  if (!layer) return;
  const e = storage.settings.effect;
  for (const view of layer.children) {
    if (!looksLikeUnitView(view)) continue;
    let fx = effects.get(view);
    if (!e.enabled) { fx?.setEnabled(false); continue; }
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
      hopAmplitude: e.hopAmplitude,
      pulsesPerSecond: e.pulsesPerSecond,
      deadSpinScale: e.deadSpinScale,
      deadBounce: e.deadBounce,
    });
  }
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
  const settings = env.settings ?? readSettings(env.storage ?? globalThis.localStorage);
  const storage = { settings, debug: env.debug ?? debugOn(env.storage ?? globalThis.localStorage) };

  // **PIXI 是进入对局时才按需加载的**（render/app.js: "PixiJS 7 (global PIXI) +
  // pixi-spine, loaded on demand"）。而 trusted 插件在房间内容集就绪时就导入，
  // 那时页面多半还停在大厅 —— 所以不能只查一次就放弃，必须等它出现。
  const PIXI = env.PIXI ?? globalThis.PIXI;
  if (!PIXI) console.info(`${LOG} 等待 PIXI（进入对局时才会加载）…`);
  const discovery = installUnitDiscovery(PIXI);
  if (!discovery) {
    // 轮询等待；进入对局后游戏会注入 globalThis.PIXI
    const timer = setInterval(() => {
      const found = installUnitDiscovery(env.PIXI ?? globalThis.PIXI);
      if (!found) return;
      clearInterval(timer);
      console.info(`${LOG} PIXI 已就绪，开始挂钩`);
      wire(found);
    }, 500);
    started = { ok: true, deferred: true, stop() { clearInterval(timer); started = null; } };
    return started;
  }

  function wire(disc) {
    // 新单位出现时立刻建实例，避免第一帧没特效
    disc.onUnit = (view) => {
      if (!storage.settings.effect.enabled) return;
      if (effects.has(view)) return;
      const fx = attachEffect(view, storage.settings.effect);
      if (fx) effects.set(view, fx);
    };
  }
  wire(discovery);

  const stopLoop = startFrameLoop(storage, env.requestAnimationFrame, storage);
  const stopWatch = watchMatchState(storage, doc);

  const music = createMusicController({
    settings: storage.settings.music,
    doc,
    elementId: env.musicElementId ?? 'sp-spin-music',
    src: env.musicSrc,
    storage: env.storage,
  });
  music.setEnabled(storage.settings.music.enabled);
  music.armAutoStart();

  const panel = attachSettingsPanel({
    doc,
    settings: storage.settings,
    music,
    onChange: (next) => {
      storage.settings = next;
      writeSettings(next, env.storage ?? globalThis.localStorage);
      applyLiveSettings(storage);
    },
  });

  console.info(`${LOG} v${PLUGIN_VERSION} 已启动（弹跳自转默认开启，音乐默认关闭）`);

  started = {
    ok: true,
    get settings() { return storage.settings; },
    music,
    discovery,
    stop() { stopLoop(); stopWatch(); panel?.destroy?.(); started = null; },
  };
  return started;
}

// trusted 插件：导入即生效。
start();
