// tests/facing.test.js — 转身换面（正 / 背）的判据与禁区。
//
// 为什么这一组值得单独测：换面会调宿主的 `view.setDir()`，而那会
// `_dropActor()` 后异步重建 SpineActor。在错误的时机调用会造成**渲染丢失 / 只渲染一半**
// （参考实现的服主实测过）。所以"什么时候绝不碰"比"怎么换"重要得多。
//
// 判据与禁区照搬 CyanFish 的 CyanModPack（mods/cyanfish.dj-all/client/frontback.js），
// 常量取自 0.3.0 的 shared/constants.js：
//   ANIM.STUN = 5
//   UF.STUNNED | UF.FROZEN | UF.SLEEP = 2 | 4 | 256 = 262
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isControlView, canFlip, applyFacing, restoreFacing } from '../src/integrations/units.js';
import { createUnitEffect } from '../src/core/unit-effect.js';

/** 造一个"可以换面"的视图：有背面资产、已就绪、非敌人、非备战。 */
function view(over = {}) {
  const setDirCalls = [];
  const v = {
    destroyed: false,
    isEnemy: false,
    prep: false,
    form: null,
    alive: true,
    dying: false,
    dead: false,
    spineReady: true,
    anim: 0,
    flags: 0,
    actor: { spine: {} },
    info: { spine: 'char_123', defId: 'char_123' },
    ctx: { assets: { hasBack: (id) => id === 'char_123' } },
    facing: 1,
    visFacing: 1,
    hasDir: true,
    setDir(d) { setDirCalls.push(d); this.dir = d; },
    _sbFacingBack: false,
    ...over,
  };
  v.__setDirCalls = setDirCalls;
  return v;
}

/** 造一个默认设置下的 effect。 */
function effect(over = {}) {
  const t = {
    scale: { x: 1, y: 1 },
    rotation: 0,
    pivot: { x: 0, y: 0, set() {} },
    position: { x: 0, y: 0, set() {} },
  };
  return createUnitEffect(t, { spinAxis: 'vertical', ...over });
}

// ---- isControlView -------------------------------------------------------------

test('晕眩 / 冻结 / 沉睡都算强控（三位合成一个 stun 静息态）', () => {
  assert.equal(isControlView(view({ anim: 5 })), true, 'ANIM.STUN');
  assert.equal(isControlView(view({ flags: 2 })), true, 'UF.STUNNED');
  assert.equal(isControlView(view({ flags: 4 })), true, 'UF.FROZEN');
  assert.equal(isControlView(view({ flags: 256 })), true, 'UF.SLEEP');
  assert.equal(isControlView(view({ flags: 2 | 256 })), true, '叠加也算');
});

test('其它状态位不算强控（别把普通状态误判成禁止换面）', () => {
  assert.equal(isControlView(view({ flags: 1 })), false, 'UF.BLOCKED 不算');
  assert.equal(isControlView(view({ flags: 16 })), false, 'UF.SKILL 不算');
  assert.equal(isControlView(view({ flags: 512 })), false, 'UF.FLYING 不算');
  assert.equal(isControlView(view({ anim: 1 })), false, 'ANIM.MOVE 不算');
  assert.equal(isControlView(null), false);
});

// ---- canFlip：允许的情况 --------------------------------------------------------

test('条件齐全时可以换面', () => {
  assert.equal(canFlip(view()), true);
});

// ---- canFlip：禁区（每一条都对应一个真实故障）-----------------------------------

test('强控期间绝不换面（否则会替宿主在强控中途重建骨架）', () => {
  assert.equal(canFlip(view({ anim: 5 })), false);
  assert.equal(canFlip(view({ flags: 4 })), false);
});

test('死亡 / 倒地期间绝不换面（背面骨架大多没有 Die 剪辑）', () => {
  assert.equal(canFlip(view({ dying: true })), false);
  assert.equal(canFlip(view({ dead: true })), false);
  assert.equal(canFlip(view({ alive: false })), false);
});

test('备战盘与预览栏绝不换面（那里的 dir 是玩家正在编辑的部署方向）', () => {
  assert.equal(canFlip(view({ prep: true })), false);
});

test('替身 / 形态绝不换面（有自己的模型逻辑）', () => {
  assert.equal(canFlip(view({ form: 'stealth' })), false);
});

test('没有背面资产时一个字节都不写', () => {
  const v = view();
  v.ctx.assets.hasBack = () => false;
  assert.equal(canFlip(v), false);
  assert.equal(applyFacing(v, effect()), false, '不该调用 setDir');
  assert.equal(v.__setDirCalls.length, 0, '★ 一次都不能调');
});

test('宿主没提供 hasBack 时安静降级（不猜路径）', () => {
  const v = view();
  v.ctx = { assets: {} };
  assert.equal(canFlip(v), false);
});

test('敌人不换面（宿主的 setDir 对敌人本就是 no-op，这里也一并挡掉）', () => {
  assert.equal(canFlip(view({ isEnemy: true })), false);
});

test('已销毁 / 模型未就绪 / 骨架正在加载时都不换面', () => {
  assert.equal(canFlip(view({ destroyed: true })), false);
  assert.equal(canFlip(view({ actor: null })), false);
  assert.equal(canFlip(view({ spineReady: false })), false);
  assert.equal(canFlip(view({ _spineBusy: true })), false);
});

// ---- applyFacing：换面与朝向指示的还原 ------------------------------------------

test('切到背面用 setDir("UP")，回正面用 setDir("RIGHT")', () => {
  const v = view();
  const fx = effect();
  // 把 spin 直接推到 cos < 0 的区间（π 处）
  fx.state.spin = Math.PI;
  assert.equal(applyFacing(v, fx), true);
  assert.deepEqual(v.__setDirCalls, ['UP'], '背面用 UP');

  fx.state.spin = 0;
  assert.equal(applyFacing(v, fx), true);
  assert.deepEqual(v.__setDirCalls, ['UP', 'RIGHT'], '回正面用 RIGHT（非 UP）');
});

test('★ 换面后逐值还原朝向指示（facing / visFacing / hasDir）', () => {
  // setDir 会顺手改写这三者，而它们是"朝向指示"（地面橙色箭头、阻挡标记画在哪侧），
  // 不是模型 —— 被我们改掉玩家会看到朝向乱变。
  const v = view({ facing: -1, visFacing: -1, hasDir: false });
  v.setDir = function (d) {
    this.dir = d;
    this.facing = 1;          // 宿主顺手改写
    this.visFacing = 1;
    this.hasDir = true;
  };
  const fx = effect();
  fx.state.spin = Math.PI;
  applyFacing(v, fx);

  assert.equal(v.facing, -1, 'facing 必须还原');
  assert.equal(v.visFacing, -1, 'visFacing 必须还原');
  assert.equal(v.hasDir, false, 'hasDir 必须还原');
});

test('同一面不会重复调 setDir（避免每帧重建骨架）', () => {
  const v = view();
  const fx = effect();
  fx.state.spin = Math.PI;
  applyFacing(v, fx);
  applyFacing(v, fx);
  applyFacing(v, fx);
  assert.equal(v.__setDirCalls.length, 1, '★ 反复调用只应换一次');
});

test('换面失败时不抛异常，也不记成已换面', () => {
  const v = view();
  v.setDir = () => { throw new Error('boom'); };
  const fx = effect();
  fx.state.spin = Math.PI;
  assert.doesNotThrow(() => applyFacing(v, fx));
  assert.equal(v._sbFacingBack, false, '失败就不该记成背面');
});

test('平面内自转不做换面（宽度不过零，没有"翻过来"这回事）', () => {
  const v = view();
  const fx = effect({ spinAxis: 'screen' });
  fx.state.spin = Math.PI;
  assert.equal(fx.facingFor(), 'front');
  assert.equal(applyFacing(v, fx), false);
  assert.equal(v.__setDirCalls.length, 0);
});

// ---- restoreFacing -------------------------------------------------------------

test('restoreFacing 只在确实在背面时才调 setDir', () => {
  const v = view({ _sbFacingBack: false });
  restoreFacing(v);
  assert.equal(v.__setDirCalls.length, 0, '本来就在正面 → 不必调');

  v._sbFacingBack = true;
  restoreFacing(v);
  assert.deepEqual(v.__setDirCalls, ['RIGHT'], '在背面 → 换回正面');
  assert.equal(v._sbFacingBack, false);
});

// ---- 迟滞（死区）----------------------------------------------------------------

test('死区防止在过零处疯狂来回换面', () => {
  const fx = effect({ spinPeriod: 2.7 });
  let flips = 0;
  let prev = fx.facingFor();
  for (let i = 0; i < 600; i++) {          // 10 秒
    fx.update(1 / 60);
    const f = fx.facingFor();
    if (f !== prev) { flips++; prev = f; }
  }
  // 2.7 秒/圈 → 10 秒约 3.7 圈 → 换面约 7.4 次。若死区失效会远高于此（每帧翻转）。
  assert.ok(flips >= 5 && flips <= 10, `换面次数应接近 2×圈数，实际 ${flips}`);
});

test('过了死区就立刻判定为背面（死区只有约 ±2.3°，不会延后一帧以上）', () => {
  const fx = effect();
  // 死区边界：|cos θ| ≤ 0.04 ⇔ θ 距 90° 约 1.5°…，取 0.1 rad 明确越过
  fx.state.spin = Math.PI / 2 + 0.1;
  assert.ok(Math.abs(Math.cos(fx.state.spin)) > 0.04, '前提：确实越过了死区');
  assert.equal(fx.facingFor(), 'back');
});

test('死区之内保持上一次判定（不在 90° 处抖动）', () => {
  const fx = effect();
  // 先明确进入背面
  fx.state.spin = Math.PI / 2 + 0.3;
  assert.equal(fx.facingFor(), 'back');
  // 再回到死区正中（|cos| = 0）—— 应保持背面，而不是立刻翻回正面
  fx.state.spin = Math.PI / 2;
  assert.equal(fx.facingFor(), 'back', '死区里必须保持上一次判定');
  // 明确越过另一侧才回正面
  fx.state.spin = Math.PI / 2 - 0.3;
  assert.equal(fx.facingFor(), 'front');
});
