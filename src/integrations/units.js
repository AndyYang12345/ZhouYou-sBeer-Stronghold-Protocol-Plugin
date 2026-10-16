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
  if (!body) return false;
  // 不要求 body.children 是数组，也不要求 hud 存在：
  // 这两个字段的创建时机都比"body 被挂上"更晚，要求它们会把单位漏掉。
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

  // 行进中单位是否转得更快 —— **默认倍数 1（全场转速一致）**。
  // 曾硬编码 1.15，导致场上"走着的比站着的快"，转起来参差、不整齐。
  // 想要那种"行进更欢快"的效果可以把 movingSpeedScale 调大。
  const mul = typeof fx.state.cfg.movingSpeedScale === 'number' ? fx.state.cfg.movingSpeedScale : 1;
  const moving = mul !== 1 && typeof view.speed === 'number' && view.speed > 0 ? mul : 1;
  fx.update(dt, moving);

  // 转身换面：横向压缩只是"看起来翻过来"，换成**真正的背面资产**才像在绕竖轴转。
  //
  // 死亡时**主动退回正面**：135 个背面骨架里只有 4 个自带 Die 剪辑，其余必须用正面播死亡，
  // 否则会卡在背面没有死亡动画（宿主随后自己也会按 `_wantsBack()` 退回，但那时已经晚了一帧）。
  if (dying) restoreFacing(view);
  else applyFacing(view, fx);
}


// ---- 转身换面（正 / 背）--------------------------------------------------------
//
// 光靠"横向镜像"只能做出"翻过来"的观感；**换成真正的背面资产**才像在绕竖轴转。
// 宿主提供了 `view.setDir(dir)`：原地换骨架（`_syncModel → _loadSpine → _acquireSpine`），
// 中间不闪占位钻石（`public/js/render/units.js:1269`）。
//
// 这一节的判据与禁区照搬 CyanFish 的 CyanModPack（`dj-all/client/frontback.js`）——
// 那是服主逐轮实测调过的定稿，它踩过的坑我不必再踩一遍。

/** `shared/constants.js` —— 宿主 `_baseFromAnim()` 用的同一组常量。 */
const ANIM_STUN = 5;
/** UF.STUNNED | UF.FROZEN | UF.SLEEP —— 宿主把这三位等同成一个 'stun' 静息态。 */
const UF_CONTROL = 2 | 4 | 256;

/**
 * 视图此刻处于**晕眩 / 冻结 / 沉睡**吗（逐字复刻宿主 `_baseFromAnim()` 的判据）。
 *
 * 为什么这三位要单独挡：宿主把它们等同成一个 `'stun'` 静息态，而那是**动画模式**
 * （还可能冻住姿态）。此刻换模型 = 替宿主在强控中途 `_dropActor()` + 异步重建 SpineActor
 * ⇒ 渲染丢失 / 只渲染一半。参考实现的服主实测过，所以**期间一个字节都不碰**。
 */
export function isControlView(v) {
  if (!v || typeof v !== 'object') return false;
  if ((typeof v.anim === 'number' ? v.anim : 0) === ANIM_STUN) return true;
  return ((typeof v.flags === 'number' ? v.flags : 0) & UF_CONTROL) !== 0;
}

/**
 * 这个视图现在**能不能**换面（不能就一个字节都不写）。
 *
 * 禁区逐条：
 *   · 已销毁 / 模型还没就绪 / 精灵还在加载中
 *   · 倒地、死亡、淡出：135 个 Back 骨架里只有 4 个自带 Die 剪辑，其余必须退回 Front 播死亡
 *     ⇒ 决定权完全留给宿主（它下一帧会自己按 `_wantsBack()` 退回正面）
 *   · 强控（晕眩 / 冻结 / 沉睡）：见 isControlView
 *   · 备战盘与预览栏（`view.prep`）：那里 `dir` 是玩家正在编辑的部署方向，宿主每次同步会重设
 *   · 替身 / 形态（`view.form`）：形态切换有自己的模型逻辑
 *   · 没有背面资产：用**宿主自己的判据** `ctx.assets.hasBack(id)`，绝不猜路径
 *   · 敌人：`setDir` 对敌人本就是 no-op（宿主第一行就 return），这里也一并挡掉
 */
export function canFlip(v) {
  if (!v || v.destroyed || !v.actor || !v.spineReady) return false;
  if (v.isEnemy || v.prep || v.form) return false;
  if (v.dying === true || v.dead === true || v.alive === false) return false;
  if (isControlView(v)) return false;
  if (v._spineBusy) return false;              // 正在换骨架，别叠第二次
  const assets = v.ctx && v.ctx.assets;
  const id = v.info && (v.info.spine || v.info.defId);
  if (!assets || typeof assets.hasBack !== 'function' || !id || !assets.hasBack(id)) return false;
  return true;
}

/**
 * 按特效的判定换到正面或背面。
 *
 * ★ `setDir()` 会顺手写 `dir` / `facing` / `visFacing` / `hasDir` —— 后三个是**朝向指示**
 * （地面那个橙色 ›、阻挡标记画在哪侧），不是模型。所以调完要**逐值还原**，
 * 否则玩家的朝向指示会被我们改掉。
 *
 * @returns {boolean} 是否真的换了
 */
export function applyFacing(view, fx) {
  if (!fx || typeof fx.facingFor !== 'function') return false;
  const want = fx.facingFor();                 // 'front' | 'back'，带迟滞
  const wantBack = want === 'back';
  if (wantBack === (view._sbFacingBack === true)) return false;   // 已经是这一面
  if (!canFlip(view)) return false;

  // 记下会被 setDir 改写的朝向指示
  const prev = { facing: view.facing, visFacing: view.visFacing, hasDir: view.hasDir };
  try {
    view.setDir(wantBack ? 'UP' : 'RIGHT');
  } catch (err) {
    console.warn('[spin-bounce] 换面失败（不影响游戏）', err);
    return false;
  }
  // 逐值还原朝向指示：我们只换模型，不动朝向
  if (prev.facing !== undefined) view.facing = prev.facing;
  if (prev.visFacing !== undefined) view.visFacing = prev.visFacing;
  if (prev.hasDir !== undefined) view.hasDir = prev.hasDir;

  view._sbFacingBack = wantBack;
  fx.noteFlipped();
  return true;
}

/** 还原到正面（停用特效 / 离开对局时用）。 */
export function restoreFacing(view) {
  if (!view || view.destroyed || view.isEnemy || !view.actor) return;
  if (view._sbFacingBack !== true) return;
  const prev = { facing: view.facing, visFacing: view.visFacing, hasDir: view.hasDir };
  try { view.setDir('RIGHT'); } catch { /* ignore */ }
  if (prev.facing !== undefined) view.facing = prev.facing;
  if (prev.visFacing !== undefined) view.visFacing = prev.visFacing;
  if (prev.hasDir !== undefined) view.hasDir = prev.hasDir;
  view._sbFacingBack = false;
}
