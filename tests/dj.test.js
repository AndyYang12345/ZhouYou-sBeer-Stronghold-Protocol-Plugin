// tests/dj.test.js — 移植自参考实现的压缩/旋转数学。
//
// 这一组守的是"**逐行照搬**"这个承诺：数学必须与来源一致，否则就是"我理解的它"
// 而不是"它本身"。来源（CyanFish CyanModPack，GPL-3.0-or-later）：
//   · config.js       SQUASH_IN / SQUASH_OUT / squashProfile / DEFAULT_GLOBAL
//   · engine-pixi.js  frameFactors / 写入模式
//
// 下面每条断言都对应来源里的一段原式。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  squashProfile, djFactors, djApply, djRestore,
  FPS, SQUASH_IN, SQUASH_OUT, DJ_DEFAULTS, NO_SPIN_MODES,
} from '../src/core/dj.js';

// ---- 常量必须与来源一致 ---------------------------------------------------------

test('常量与来源一致（40% 压 / 40% 弹 / 20% 停）', () => {
  assert.equal(FPS, 60);
  assert.equal(SQUASH_IN, 0.4);
  assert.equal(SQUASH_OUT, 0.4);
  assert.deepEqual(DJ_DEFAULTS, {
    spinMode: 'axis', spinPeriod: 67, squashPeriod: 38, squashMinPct: 60, widthMaxPct: 110,
  });
  assert.deepEqual([...NO_SPIN_MODES], ['squash']);
});

// ---- squashProfile：三角波 -------------------------------------------------------

test('squashProfile 逐点对照来源的三角波', () => {
  // 来源：
  //   x < 0.4        → x / 0.4
  //   x < 0.8        → 1 - (x - 0.4) / 0.4
  //   否则            → 0
  // 用容差而不是严格相等：`1 - (0.6 - 0.4) / 0.4` 在浮点下是 0.5000000000000001。
  // 这是 IEEE754 的正常结果，不是实现错误（严格相等会误报）。
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(near(squashProfile(0), 0));
  assert.ok(near(squashProfile(0.2), 0.5));
  assert.ok(near(squashProfile(0.4), 1), '0.4 应压到底');
  assert.ok(near(squashProfile(0.6), 0.5));
  assert.ok(near(squashProfile(0.8), 0), '0.8 应弹回原位');
  assert.ok(near(squashProfile(0.9), 0), '0.9 应保持原状');
});

test('squashProfile 对任意实数折回 [0,1)（来源第一行就是 x -= floor(x)）', () => {
  for (const [u, want] of [[1.2, 0.5], [2.4, 1], [-0.8, 0.5], [10.9, 0], [-1.2, 0]]) {
    assert.ok(Math.abs(squashProfile(u) - want) < 1e-9,
      `squashProfile(${u}) 应为 ${want}，实际 ${squashProfile(u)}`);
  }
});

test('squashProfile 非数字输入退化为 0（来源 Number(u) || 0）', () => {
  for (const bad of [undefined, null, NaN, 'x']) {
    assert.equal(squashProfile(bad), 0, `坏输入 ${String(bad)} 应得 0`);
  }
});

test('squashProfile 恒在 [0,1] 内', () => {
  for (let i = 0; i <= 1000; i++) {
    const v = squashProfile(i / 137);
    assert.ok(v >= 0 && v <= 1, `squashProfile 越界: ${v} @ ${i / 137}`);
  }
});

// ---- djFactors：逐式对照 frameFactors -------------------------------------------

test('djFactors 的 yK / xK 逐式对照来源', () => {
  // 来源： yK = 1 - (1 - M) * s ;  xK = 1 + (W - 1) * s
  const c = { spinMode: 'axis', spinPeriod: 67, squashPeriod: 38, squashMinPct: 60, widthMaxPct: 110 };
  const M = 0.6, W = 1.1;
  for (const t of [0, 0.1, 0.3, 0.633, 1.0, 2.5]) {
    const f = djFactors(c, t);
    const s = squashProfile(t / (38 / FPS));
    assert.ok(Math.abs(f.s - s) < 1e-9, `s 应等于 squashProfile，t=${t}`);
    assert.ok(Math.abs(f.yK - (1 - (1 - M) * s)) < 1e-9, `yK 不符，t=${t}`);
    assert.ok(Math.abs(f.xK - (1 + (W - 1) * s)) < 1e-9, `xK 不符，t=${t}`);
  }
});

test('djFactors 的 axisK 只在 axis 模式乘 cos θ（来源三处分支）', () => {
  const base = { spinPeriod: 67, squashPeriod: 38, squashMinPct: 60, widthMaxPct: 110 };
  const t = 0.4;
  const theta = Math.PI * 2 * (t / (67 / FPS));

  assert.ok(Math.abs(djFactors({ ...base, spinMode: 'axis' }, t).axisK - Math.cos(theta)) < 1e-9,
    'axis 模式 axisK 应等于 cos θ');
  assert.equal(djFactors({ ...base, spinMode: 'squash' }, t).axisK, 1, 'squash 模式不乘');
  assert.equal(djFactors({ ...base, spinMode: 'flat' }, t).axisK, 1, 'flat 模式不乘');
});

test('★ axis 模式下宽度允许为负（这就是"转到了背面"）', () => {
  const c = { spinMode: 'axis', spinPeriod: 67, squashPeriod: 38, squashMinPct: 60, widthMaxPct: 110 };
  let sawNegative = false, sawZeroCrossing = false, prev = null;
  // 扫一整圈旋转周期
  for (let i = 0; i <= 400; i++) {
    const f = djFactors(c, (i / 400) * (67 / FPS));
    if (f.axisK < -0.5) sawNegative = true;
    if (prev !== null && Math.sign(prev) !== Math.sign(f.axisK)) sawZeroCrossing = true;
    prev = f.axisK;
  }
  assert.ok(sawNegative, '应出现负宽度（镜像）');
  assert.ok(sawZeroCrossing, '宽度应过零（侧对的那一帧）');
});

test('djFactors 复用传入的输出对象（热路径不该分配）', () => {
  const out = {};
  const r = djFactors(DJ_DEFAULTS, 1, 0, out);
  assert.equal(r, out, '应写进传入的对象并返回它');
});

test('相位偏移整体平移波形（同步模式全传 0 ⇒ 全场同相）', () => {
  const a = djFactors(DJ_DEFAULTS, 0.5, 0);
  const b = djFactors(DJ_DEFAULTS, 0.5 + 38 / FPS, 0);   // 平移一个压缩周期
  assert.ok(Math.abs(a.s - b.s) < 1e-9, '平移整周期后 s 应相同');
  assert.ok(Math.abs(a.yK - b.yK) < 1e-9);
});

test('同一个 t 必得同一个结果（纯时间函数，无状态）', () => {
  const a = djFactors(DJ_DEFAULTS, 3.7);
  const b = djFactors(DJ_DEFAULTS, 3.7);
  assert.deepEqual({ ...a }, { ...b }, '★ 纯函数：同输入必须同输出（没有累积状态）');
});

// ---- djApply / djRestore：写入模式 ----------------------------------------------

/** 最小 PIXI 容器替身。 */
function fakeBody(sx = 1, sy = 1, rot = 0) {
  return {
    scale: { x: sx, y: sy, set(a, b) { this.x = a; this.y = b; } },
    rotation: rot,
  };
}

test('★ 基准只记一次：同一容器反复写入不会累积漂移', () => {
  // 来源 MODE_FREE 的语义：第一次碰到时记下原值当基准，之后写 基准 × 系数。
  // 这是"不需要写回阈值/量化台阶"的根本原因 —— 系数就是当帧真实值。
  const body = fakeBody(1.3, 0.9);     // 假设宿主自己有非 1 的缩放
  const st = {};
  let last = null;
  for (let i = 0; i < 300; i++) {
    const f = djFactors(DJ_DEFAULTS, i / 60);
    djApply(body, st, f);
    last = { x: body.scale.x, y: body.scale.y, f };
  }
  // 最后一帧必须**精确**等于 基准 × 当帧系数（没有任何累积误差）
  assert.ok(Math.abs(last.y - 0.9 * last.f.yK) < 1e-12, '高度不得漂移');
  assert.ok(Math.abs(last.x - 1.3 * last.f.xK * last.f.axisK) < 1e-12, '宽度不得漂移');
});

test('基准就是宿主原本的值（不得擅自归一化）', () => {
  const body = fakeBody(2, 3);
  const st = {};
  const f = djFactors(DJ_DEFAULTS, 0);      // s=0 ⇒ 系数为 1
  djApply(body, st, f);
  assert.ok(Math.abs(body.scale.x - 2) < 1e-12, 's=0 时应回到宿主的原宽');
  assert.ok(Math.abs(body.scale.y - 3) < 1e-12, 's=0 时应回到宿主的原高');
});

test('★ 只有平面内模式才写 rotation（来源：绕竖直轴/仅压缩都不写）', () => {
  const axisBody = fakeBody(1, 1, 0.25);
  djApply(axisBody, {}, djFactors({ ...DJ_DEFAULTS, spinMode: 'axis' }, 0.4));
  assert.equal(axisBody.rotation, 0.25, 'axis 模式不得写 rotation');

  const sqBody = fakeBody(1, 1, 0.25);
  djApply(sqBody, {}, djFactors({ ...DJ_DEFAULTS, spinMode: 'squash' }, 0.4));
  assert.equal(sqBody.rotation, 0.25, 'squash 模式不得写 rotation');

  const flatBody = fakeBody(1, 1, 0.25);
  const st = {};
  const f = djFactors({ ...DJ_DEFAULTS, spinMode: 'flat' }, 0.4);
  djApply(flatBody, st, f);
  assert.ok(Math.abs(flatBody.rotation - (0.25 + f.theta)) < 1e-12,
    'flat 模式应写 基准角 + θ');
});

test('djRestore 精确还原到基准姿态', () => {
  const body = fakeBody(1.7, 0.8, 0.3);
  const st = {};
  for (let i = 0; i < 20; i++) djApply(body, st, djFactors(DJ_DEFAULTS, i / 60));
  djRestore(body, st);
  assert.equal(body.scale.x, 1.7);
  assert.equal(body.scale.y, 0.8);
  assert.equal(body.rotation, 0.3, '未写过 rotation 就不该动它');
});

test('djApply 对缺字段的目标不抛异常', () => {
  assert.doesNotThrow(() => djApply(null, {}, DJ_DEFAULTS));
  assert.doesNotThrow(() => djApply({}, {}, djFactors(DJ_DEFAULTS, 1)));
  assert.doesNotThrow(() => djApply({ scale: { x: 1, y: 1 } }, {}, djFactors(DJ_DEFAULTS, 1)));
});
