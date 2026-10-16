// plugin/spin-bounce/integrations/units.js — 把特效适配到游戏的 UnitView 上。
//
// 这一层是**唯一知道游戏内部结构**的地方：core/ 里的东西只认 `scale` / `rotation` / `pivot`，
// 所以核心库可以独立复用与单测；游戏改版时也只需要动这一个文件。
//
// UnitView 的结构（0.3.0 实测，public/js/render/units.js）
//   view.root ── 定位 / 可见性 / 深度排序            ← 不动
//   view.body ── 装 fallback 肖像与 actor.spine       ← 驱动它
//   view.hud  ── 血量条，挂在独立的 bars 层            ← 天然不受形变影响
// `body.scale` / `body.rotation` 在上游代码里**从未被赋值**（只有 addChild），是我们的干净挂载点。

import { createUnitEffect } from '../core/unit-effect.js';

/**
 * 判断一个 PIXI 显示对象是否是一个单位视图（UnitView）。
 *
 * ⚠️ **时序陷阱** —— 本插件最容易写错的一处。`UnitView` 的构造顺序是：
 *
 * ```
 * root = new Container();  layers.units.addChild(root);   ← 发现钩子在这里触发
 * body = new Container();  root.addChild(body);
 * …
 * hud  = new Container();  layers.bars.addChild(hud);     ← hud 比 root 入层更晚
 * ```
 *
 * 所以在「root 入层」那一刻若要求 `body && root && hud` 三者俱全，会**太早**而全部漏掉
 * （实测表现：面板状态一直是"已挂钩，等待单位"，而单位明明在场）。
 *
 * 因此判定只要 `body`（那时已存在）：`body.scale` 可写是 UnitView 独有的特征 ——
 * 同一个 units 层里的道具没有 `body`。
 */
export function looksLikeUnitView(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const body = obj.body;
  if (!body || !Array.isArray(body.children)) return false;
  return !!body.scale && typeof body.scale === 'object';
}

/** 敌方单位转得略快一点，呼应"边行进边弹跳自转"。 */
export const ENEMY_SPIN_FACTOR = 0.85;

/** 从设置里取出适用于这个单位的特效参数。 */
export function optionsFor(view, effectSettings) {
  return {
    ...effectSettings,
    spinPeriod: effectSettings.spinPeriod * (view?.isEnemy ? ENEMY_SPIN_FACTOR : 1),
  };
}

/**
 * 为一个单位建特效实例。
 * @param {object} view UnitView
 * @param {object} effectSettings `settings.effect`
 */
export function attachEffect(view, effectSettings) {
  if (!view?.body) return null;
  return createUnitEffect(view.body, optionsFor(view, effectSettings));
}

/**
 * 量出模型高度，用来把旋转支点放到身体中部。
 *
 * 为什么不设支点会难看：`body` 的原点在脚底，直接 `rotation` 会让单位像钟摆一样
 * 以脚为轴甩出去，而不是"在原地转"。
 *
 * @returns {number} 量到的高度；量不到返回 0（调用方据此保持原布局不动）
 */
export function measureModelHeight(view) {
  let h = 0;
  const spine = view?.actor?.spine;
  if (spine) {
    if (typeof spine.height === 'number' && spine.height > 0) h = spine.height;
    else if (typeof spine.skeleton?.data?.height === 'number') h = spine.skeleton.data.height;
  }
  if (!(h > 0) && typeof view?.fallback?.height === 'number') h = view.fallback.height;
  return h > 0 ? h : 0;
}

/**
 * 每帧驱动一个单位。
 *
 * @param {object} view
 * @param {object} fx 特效实例
 * @param {number} dt 秒
 */
/**
 * 支点测量的重试预算。
 *
 * 为什么要设上限：`measureModelHeight` 要读 Spine 的内部尺寸，而模型是**异步加载**的，
 * 在它就绪前每一帧都测一次是纯浪费；如果模型永远量不到（尺寸异常、结构不同），
 * 那就是**每帧一次的无用功**，会把主线程拖慢。
 */
export const PIVOT_TRIES_MAX = 20;

export function driveUnit(view, fx, dt) {
  // 模型可能刚加载完（之前量不到高度），重试若干次即可，不做无上限的每帧测量
  if (!fx.state.pivotReady) {
    fx.state.pivotTries = (fx.state.pivotTries || 0) + 1;
    if (fx.state.pivotTries <= PIVOT_TRIES_MAX) {
      const h = measureModelHeight(view);
      if (h > 0) fx.setModelHeight(h);
    }
  }

  // 死亡：停弹跳、继续自转（本插件的明确行为）
  const dying = view.dying === true || view.dead === true;
  fx.setAlive(!dying);

  // 行进中的单位转得略快
  const moving = typeof view.speed === 'number' && view.speed > 0 ? 1.15 : 1;
  fx.update(dt, moving);
}
