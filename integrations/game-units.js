// integrations/game-units.js — 把特效接到《卫戍协议：盟约》的 UnitView 上。
//
// 这个文件知道游戏内部结构，src/ 里的东西不知道 —— 这样核心库可以单独复用/测试，
// 游戏改版时也只需要动这一个文件。
//
// 接入点（0.3.0 实测）
//   UnitView (public/js/render/units.js)
//     root   ── 定位 / 可见性 / 深度排序          ← 不要动
//     body   ── 装 fallback 肖像 与 actor.spine   ← 我们驱动它
//     hud    ── 血量条，挂在独立的 bars 层         ← 天然不受形变影响
//   `body.scale` / `body.rotation` 在上游代码里**从未被赋值**（只有 addChild），
//   所以是我们的干净挂载点。
//
// 单位注册表 `views` 是 render/app.js 里的局部变量，外部拿不到，所以这里采用
// **每个 UnitView 自己驱动自己**的方式：在 update() 里推进，不依赖全局遍历。

import { createUnitEffect } from '../src/unit-effect.js';

/** 每个 UnitView 上挂特效实例的属性名。 */
export const EFFECT_KEY = Symbol.for('sp.spinBounce.effect');

/**
 * 确保一个 UnitView 上有特效实例，并返回它。
 *
 * @param {object} view UnitView 实例（需要 `body`，可选 `isEnemy` / `flying` / `hover`）
 * @param {object} settings 运行时设置（见 src/unit-effect.js 的 EFFECT_DEFAULTS）
 * @param {object} [env] 可注入的宿主环境，便于测试
 * @param {(view:object)=>number} [env.measureHeight] 量出模型高度（脚底到头顶）
 * @returns {object} 特效实例
 */
export function ensureEffect(view, settings, env = {}) {
  let fx = view[EFFECT_KEY];
  if (fx) { syncConfig(fx, settings); return fx; }

  fx = createUnitEffect(view.body, {
    ...settings.effect,
    // 敌方单位行进中更"欢快"：自转略快，呼应"边行进边弹跳自转"
    ...(view.isEnemy ? { spinPeriod: (settings.effect?.spinPeriod ?? 2.7) * 0.85 } : {}),
  });
  view[EFFECT_KEY] = fx;

  // 模型高度用来定旋转支点（身体中部）。飞行单位要把它悬停的高度也算进去，
  // 否则支点会落在"脚下的空气"上，转起来像在绕圈。
  applyModelHeight(view, fx, env);
  return fx;
}

/** 设置变了就同步到已有的实例上，不必重建。 */
export function syncConfig(fx, settings) {
  const e = settings.effect ?? {};
  if (e.enabled === false) { fx.setEnabled(false); return; }
  fx.setEnabled(true);
  if (typeof e.spinPeriod === 'number') fx.setSpinPeriod(e.spinPeriod);
  if (e.spinAxis) fx.state.cfg.spinAxis = e.spinAxis;
  if (typeof e.strength === 'number') fx.state.cfg.strength = e.strength;
  if (typeof e.hopAmplitude === 'number') fx.state.cfg.hopAmplitude = e.hopAmplitude;
  if (typeof e.deadBounce === 'boolean') fx.state.cfg.deadBounce = e.deadBounce;
  if (typeof e.deadSpinScale === 'number') fx.state.cfg.deadSpinScale = e.deadSpinScale;
}

/**
 * 量模型高度并设置支点。
 *
 * 优先用宿主注入的 `measureHeight`；否则退回 Spine 边界的近似：
 * Spine 的 `height` 属性在多数情况下就是模型的自然高度。
 */
export function applyModelHeight(view, fx, env = {}) {
  let h = 0;
  if (typeof env.measureHeight === 'function') {
    h = env.measureHeight(view);
  } else {
    const actor = view.actor;
    const spine = actor?.spine;
    if (spine) {
      // pixi-spine 的 Spine 对象有 height / width（来自 skeleton 数据）
      if (typeof spine.height === 'number' && spine.height > 0) h = spine.height;
      else if (typeof spine.skeleton?.data?.height === 'number') h = spine.skeleton.data.height;
    }
    if (!(h > 0) && view.fallback?.height > 0) h = view.fallback.height;
  }
  // 飞行单位的模型悬浮在 z 上，支点要跟着抬（hover 是"格"为单位的高度）
  if (view.flying && typeof view.hover === 'number') h += 0;
  if (h > 0) fx.setModelHeight(h);
  return h;
}

/**
 * 每帧推进一个单位的特效。宿主在 `UnitView.update()` 的末尾调用。
 *
 * @param {object} view
 * @param {number} dt 秒
 * @param {object} settings
 * @param {object} [env]
 */
export function updateUnitEffect(view, dt, settings, env = {}) {
  if (!settings?.effect?.enabled) {
    const existing = view[EFFECT_KEY];
    if (existing) existing.setEnabled(false);
    return;
  }
  if (!view.body) return;
  const fx = ensureEffect(view, settings, env);

  // 模型可能刚加载完（之前量不到高度），这里补一次
  if (!fx.state.pivotReady && env.retryPivot !== false) applyModelHeight(view, fx, env);

  // 死亡：停弹跳、继续自转（用户明确要求）
  const alive = view.dying !== true && view.dead !== true;
  fx.setAlive(alive);

  // 行进中的单位转得略快一点 —— "边行进边弹跳自转"
  const moving = typeof view.speed === 'number' && view.speed > 0 ? 1.15 : 1;
  fx.update(dt, moving);
}

/** 单位被回收时清掉引用，避免泄漏。 */
export function releaseEffect(view) {
  const fx = view[EFFECT_KEY];
  if (fx) { fx.setEnabled(false); delete view[EFFECT_KEY]; }
}
