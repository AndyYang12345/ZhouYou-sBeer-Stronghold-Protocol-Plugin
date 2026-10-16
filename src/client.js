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
        if (!looksLikeUnitView(child)) continue;
        // ⚠️ 注意这里**不要**把 `this` 当成"单位层"。
        // 时序陷阱（实测踩过）：UnitView 构造时先 `layers.units.addChild(root)`，
        // 紧接着执行 `this.root.addChild(this.body)` —— 后者也会进这个钩子，
        // 于是若把 `this` 记为单位层，就会把 **root** 当成单位层，
        // 之后遍历它的 children 只会拿到 body/aura/plate 这些内部零件，一个单位都认不出。
        //
        // 正确做法：onUnit 拿到的就是 view 自己，**注册表以 view 为准**，不依赖容器遍历。
        state.onUnit?.(child);
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

/**
 * 已发现的单位（活跃集合）。
 *
 * 为什么用 Set 而不是每帧遍历场景图里的 children：单位是在构造时通过 addChild 钩子
 * 逐个发现的，而"单位层"本身难以稳妥认定（见 installUnitDiscovery 的时序陷阱注释）。
 * 以 view 为准既准确，又省掉每帧对一堆子对象做形状判断。
 */
const units = new Set();

/** 单位层的父容器引用，**仅用于状态显示**，不参与驱动。 */
let cachedLayer = null;
const layerRef = () => cachedLayer;

/** 登记一个单位；返回是否新登记。 */
function trackUnit(view) {
  if (!looksLikeUnitView(view) || units.has(view)) return false;
  units.add(view);
  if (!cachedLayer && view.root?.parent) cachedLayer = view.root.parent;
  return true;
}

/** 当前帧的 dt（秒），由帧循环写入。 */
let frameDt = 1 / 60;

/** 性能诊断开关（settings.debug 或 localStorage 的 sp.plugin.spinBounce.debug = '1'）。 */
function debugOn(storage = globalThis.localStorage) {
  try { return storage?.getItem(SETTINGS_KEY + '.debug') === '1'; } catch { return false; }
}
const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0 };
export const getStats = () => ({ ...stats });

/** 推进所有已登记单位的特效。 */
export function tickEffects(storage) {
  if (!storage.settings.effect.enabled) return;
  const t0 = storage.debug ? performance.now() : 0;
  let n = 0;
  for (const view of units) {
    // 单位被回收后其 root 会脱离场景图：顺手清理，避免集合无限增长
    if (view.destroyed === true || (view.root && view.root.parent === null)) {
      units.delete(view);
      effects.delete(view);
      continue;
    }
    let fx = effects.get(view);
    if (!fx) {
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
        `注册单位 ${units.size}`);
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
    for (const view of units) effects.get(view)?.reset();
  };
  const mo = new MutationObserver(reset);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  reset();
  return () => mo.disconnect();
}

// ---- 设置改动即时生效（不必重载页面）----------------------------------------

export function applyLiveSettings(storage) {
  const e = storage.settings.effect;
  // 以已登记的单位为准：打开开关时**立刻**给在场单位补上特效，
  // 否则玩家会以为开关没反应（要等下一个单位出现才看到效果）。
  for (const view of units) {
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

  // ============================ 初始化顺序很重要 ============================
  // 面板与音乐**必须先挂**，且绝不依赖 PIXI。
  // 之前的版本把面板放在 PIXI 分支之后，而 PIXI 要等进入对局才加载 —— 一旦那条路
  // 出问题（或只是还没进对局），玩家就**看不到任何开关**，连关掉它的入口都没有。
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

  const panel = attachSettingsPanel({
    doc,
    settings: storage.settings,
    music,
    storage: env.storage ?? globalThis.localStorage,
    status: () => statusOf(storage),
    onChange: (next) => {
      storage.settings = next;
      writeSettings(next, env.storage ?? globalThis.localStorage);
      applyLiveSettings(storage);
    },
  });
  console.info(`${LOG} 设置面板已挂载（右下角「弹」按钮）`);

  // 对外的逃生舱：玩家/作者可在控制台直接开关，不必依赖界面
  const api = {
    version: PLUGIN_VERSION,
    get settings() { return storage.settings; },
    on() { storage.settings.effect.enabled = true; writeSettings(storage.settings); applyLiveSettings(storage); return 'effect on'; },
    off() { storage.settings.effect.enabled = false; writeSettings(storage.settings); applyLiveSettings(storage); return 'effect off'; },
    musicOn() { storage.settings.music.enabled = true; writeSettings(storage.settings); music.setEnabled(true); return music.play(); },
    musicOff() { storage.settings.music.enabled = false; writeSettings(storage.settings); music.setEnabled(false); music.pause(); return 'music off'; },
    stats: getStats,
  };
  globalThis.__SP_SPIN_BOUNCE__ = api;

  // 帧循环**总是**启动：tickEffects 在找不到单位层时直接返回，所以等 PIXI 到位后
  // 不需要重启循环，它会自然开始工作。
  const stopLoop = startFrameLoop(storage, env.requestAnimationFrame);
  const stopWatch = watchMatchState(storage, doc);

  // PIXI 是进入对局时才按需加载的：这里只负责"等它并挂钩"，不再决定整个插件是否启动。
  function wire(disc) {
    // 始终登记：这样"先建了单位、之后才打开开关"也能立刻生效
    disc.onUnit = (view) => { trackUnit(view); };
  }
  let waitTimer = 0;
  const initial = installUnitDiscovery(env.PIXI ?? globalThis.PIXI);
  if (initial) {
    wire(initial);
  } else {
    console.info(`${LOG} 等待 PIXI（进入对局时才会加载）…；设置面板已可用`);
    waitTimer = setInterval(() => {
      const found = installUnitDiscovery(env.PIXI ?? globalThis.PIXI);
      if (!found) return;
      clearInterval(waitTimer); waitTimer = 0;
      console.info(`${LOG} PIXI 已就绪，开始挂钩`);
      wire(found);
    }, 500);
  }

  console.info(`${LOG} v${PLUGIN_VERSION} 已启动（弹跳自转${storage.settings.effect.enabled ? '开启' : '关闭'}，`
    + `音乐${storage.settings.music.enabled ? '开启' : '关闭'}）`);

  started = {
    ok: true,
    get settings() { return storage.settings; },
    api, music, panel,
    stop() {
      if (waitTimer) clearInterval(waitTimer);
      stopLoop(); stopWatch(); panel?.destroy?.();
      started = null;
    },
  };
  return started;
}

/** 面板上显示的状态行（让玩家一眼看出插件到底有没有在工作）。 */
function statusOf(storage) {
  return {
    hooked: !!globalThis.PIXI?.Container?.prototype?.__sbPatched,
    layer: !!layerRef(),
    units: units.size,
    degraded: storage.degraded === true,
  };
}
