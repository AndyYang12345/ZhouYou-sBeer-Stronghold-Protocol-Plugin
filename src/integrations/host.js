// src/integrations/host.js — 通过**宿主自己暴露的调试抓手**访问渲染层。
//
// ============================ 为什么不用挂钩原型 ============================
//
// 我最初的实现是包装 `PIXI.Container.prototype.addChild`，从场景图里"猜"出哪个容器是单位。
// 那条路连踩三个坑：
//   1. UnitView 构造时 `layers.units.addChild(this.root)` 发生在 `this.body` 赋值**之前**，
//      在那一刻判断 `view.body` 永远为 undefined；
//   2. `view.root` **就是 view 自己**（视图对象本身继承 Container），把它当成"装载 root 的容器"
//      会把 root 误认成单位；
//   3. 即便认对了，"单位"其实来自**三处**：战斗 `views`、预览栏 `penViews`、首领 `leader.view` ——
//      遍历单个容器天然覆盖不全。
//
// 而宿主**本来就给了正式抓手**（dev/E2E 用，只读）：
//
//   public/js/ui/fieldHost.js:287   globalThis.__SP_VIEW__ = view;        // guardView 包过的壳
//   public/js/render/app.js:2191    debug: { app, views, penViews, get leader(), tiles, fx, ctx, … }
//
// `__SP_VIEW__.raw` 就是那个含 `debug` 的真视图。这是**官方接缝**，可靠性远高于猜场景图。
//
// 这一节的做法参考了 CyanFish 的 Stronghold-Protocol-CyanModPack（`dj-all/client/engine-pixi.js`
// 的 resolveHost / eachView / collectUnits）—— 它做的是同类效果（压扁 + 旋转），
// 并且给出了逐字段的宿主覆写矩阵（见下）。

import { looksLikeUnitView } from './units.js';

/** 找抓手的轮询间隔（ms）。视图随对局生命周期来去匆匆 ⇒ 必须有独立心跳重新解析。 */
export const DISCOVER_MS = 200;

/**
 * 解析宿主抓手。任何一步拿不到就返回 null（调用方静默降级，绝不抛）。
 *
 * @param {object} [g] globalThis 替身，便于单测
 */
export function resolveHost(g = globalThis) {
  try {
    const safe = g ? g.__SP_VIEW__ : null;
    if (!safe) return null;
    const raw = safe.raw && typeof safe.raw === 'object' ? safe.raw : safe;
    const dbg = raw.debug;
    const views = dbg && dbg.views;
    if (!views || typeof views.values !== 'function') return null;
    const app = dbg.app;
    const ticker = app && app.ticker
      && typeof app.ticker.add === 'function' && typeof app.ticker.remove === 'function'
      ? app.ticker : null;
    return {
      raw,
      views,
      penViews: dbg.penViews && typeof dbg.penViews.values === 'function' ? dbg.penViews : null,
      get leader() { try { return dbg.leader; } catch { return null; } },   // getter：首领随时换人，必须现读
      fx: dbg.fx || null,
      ticker,
    };
  } catch {
    return null;
  }
}

/**
 * 遍历"所有可能出现单位视图的地方"。
 *
 * 三处缺一不可：战斗/备战 `views`、整备区预览栏 `penViews`、首领 `leader.view`。
 * 只遍历 views 会漏掉预览栏里的干员和首领。
 */
export function eachView(host, fn) {
  if (!host) return;
  try {
    if (host.views) for (const v of host.views.values()) fn(v);
    if (host.penViews) for (const v of host.penViews.values()) fn(v);
    const lv = host.leader;
    if (lv && lv.view) fn(lv.view);
  } catch (err) {
    console.warn('[spin-bounce] 遍历视图出错（不影响游戏）', err);
  }
}

/** 视图是否还能安全操作（未被销毁、身体与缩放都在）。 */
export function hasBody(v) {
  return !!(v && !v.destroyed && v.body && v.body.scale);
}

/**
 * "模型加载完"的门：没加载完的视图只算 pending，不动它。
 *
 * 为什么必须等：`body` 里先是占位肖像，Spine 模型是异步换上去的。在模型就绪前改 transform，
 * 量到的尺寸与真实模型不符（支点会错），而且换模型的瞬间会被覆盖一次。
 */
export function modelReady(v) {
  return !!(v && v.actor && v.spineReady && v.actor.spine);
}

/** 单位视图的 kind（渲染层就能拿到）。 */
export function kindOf(v) {
  return v && v.info && typeof v.info.kind === 'string' ? v.info.kind : '';
}

/**
 * 收集当前所有可操作的单位视图。
 * @returns {Array<object>}
 */
export function collectUnits(host) {
  const out = [];
  eachView(host, (v) => {
    if (!hasBody(v) || !modelReady(v)) return;
    if (!looksLikeUnitView(v)) return;
    out.push(v);
  });
  return out;
}
