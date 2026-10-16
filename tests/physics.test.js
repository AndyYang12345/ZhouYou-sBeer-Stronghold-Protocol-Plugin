// tests/physics.test.js — 弹簧与形变的性质测试。
//
// 这些测试不检查"看起来对不对"（那要看眼睛），而是检查**数值性质**：
// 守恒、收敛、稳定、有界。手感参数可以随便调，但这些性质一旦破坏就是 bug。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPRING_DEFAULTS, FIXED_STEP, createDeformState, springStep, kick,
  stepFixed, scaleFor, squashLimitOf, hopFor, hopVelocityFor,
} from '../plugin/spin-bounce/core/physics.js';

const run = (state, seconds, strength = 1, step = FIXED_STEP) => {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) springStep(state, step, strength);
  return state;
};

test('静止状态不产生形变', () => {
  const s = createDeformState();
  run(s, 1);
  assert.equal(s.squash, 0);
  assert.equal(s.sv, 0);
});

test('一次冲量后必然收敛回静止（欠阻尼但稳定）', () => {
  const s = createDeformState();
  kick(s, 1);
  assert.ok(s.sv < 0, '冲量应让 squash 往负方向（被压扁）走');
  run(s, 5);
  assert.ok(Math.abs(s.squash) < 1e-3, `应回到静止，实际 ${s.squash}`);
  assert.ok(Math.abs(s.sv) < 1e-3, `速度应归零，实际 ${s.sv}`);
});

test('欠阻尼会过冲：压下去之后必须出现拉伸（这是"Q弹"的来源）', () => {
  const s = createDeformState();
  kick(s, 1);
  let min = 0, max = 0;
  for (let i = 0; i < Math.round(2 / FIXED_STEP); i++) {
    springStep(s, FIXED_STEP, 1);
    min = Math.min(min, s.squash);
    max = Math.max(max, s.squash);
  }
  assert.ok(min < -0.05, `应有明显压扁，实际最小 ${min}`);
  assert.ok(max > 0.01, `应有过冲拉伸，实际最大 ${max}`);
});

test('形变始终有界（限幅生效，且越界后速度被衰减）', () => {
  for (const strength of [0.3, 1, 1.8, 5, 100]) {
    const s = createDeformState();
    const limit = squashLimitOf(s, strength);
    for (let i = 0; i < 200; i++) {
      kick(s, strength, 3);              // 疯狂连续冲击
      springStep(s, FIXED_STEP, strength);
      assert.ok(Math.abs(s.squash) <= limit + 1e-9,
        `strength=${strength} 时 squash=${s.squash} 超出限幅 ${limit}`);
      assert.ok(Number.isFinite(s.squash) && Number.isFinite(s.sv), '不应出现 NaN/Infinity');
    }
  }
});

test('限幅随强度增长但有硬上限', () => {
  const s = createDeformState();
  const l1 = squashLimitOf(s, 0.3);
  const l2 = squashLimitOf(s, 1.15);
  const l3 = squashLimitOf(s, 1.8);
  assert.ok(l1 < l2 && l2 < l3, '强度越大压得越扁');
  assert.ok(l3 <= SPRING_DEFAULTS.maxLimit + 1e-9, '不得超过硬上限');
});

test('固定步长积分与调用频率无关（掉帧不改变手感轨迹）', () => {
  // 同样推进 0.5 秒：一次大 dt 切成小步 vs 多次小 dt，轨迹应当几乎一致
  const a = createDeformState(); kick(a, 1); stepFixed(a, 0.5, 1);
  const b = createDeformState(); kick(b, 1);
  for (let i = 0; i < 30; i++) stepFixed(b, 0.5 / 30, 1);
  assert.ok(Math.abs(a.squash - b.squash) < 1e-6,
    `同一时刻的形变应一致：${a.squash} vs ${b.squash}`);
});

test('体积守恒：压扁时横向变胖，且乘积近似不变', () => {
  for (const squash of [-0.2, -0.05, 0, 0.05, 0.2]) {
    const { x, y } = scaleFor(squash);
    assert.ok(Math.abs(x * x * y - 1) < 1e-9, `squash=${squash} 时 x²y 应恒为 1，实际 ${x * x * y}`);
    assert.ok(y > 0, '纵向缩放必须为正，否则模型会翻面');
  }
});

test('极端形变下缩放不发散（有安全下限）', () => {
  for (const squash of [-0.99, -5, -1e6]) {
    const { x, y } = scaleFor(squash);
    assert.ok(Number.isFinite(x) && Number.isFinite(y), '不得出现 Infinity');
    assert.ok(x > 0 && x < 10, `横向缩放应在合理范围，实际 ${x}`);
  }
});

test('离地弹跳与脉冲同周期，且从地面起跳', () => {
  const amp = 0.115, per = 2;
  assert.equal(hopFor(0, amp, per), 0, 't=0 应在地面');
  assert.ok(Math.abs(hopFor(0.5 / per, amp, per) - amp) < 1e-9, '半周期时应到最高点');
  assert.ok(Math.abs(hopFor(1 / per, amp, per)) < 1e-9, '整周期回到地面');
});

test('弹跳速度是位移的正确导数（数值微分校验）', () => {
  const amp = 0.115, per = 2, h = 1e-6;
  for (const t of [0, 0.05, 0.1, 0.2, 0.3]) {
    const numeric = (hopFor(t + h, amp, per) - hopFor(t - h, amp, per)) / (2 * h);
    const analytic = hopVelocityFor(t, amp, per);
    assert.ok(Math.abs(numeric - analytic) < 1e-6,
      `t=${t} 处导数不符：数值 ${numeric} vs 解析 ${analytic}`);
  }
});

test('起跳瞬间速度为零、最高点速度为零、中段最快', () => {
  const amp = 0.115, per = 2, T = 1 / per;
  assert.ok(Math.abs(hopVelocityFor(0, amp, per)) < 1e-12, '地面处速度为 0');
  assert.ok(Math.abs(hopVelocityFor(T / 2, amp, per)) < 1e-12, '最高点速度为 0');
  const quarter = hopVelocityFor(T / 4, amp, per);
  assert.ok(quarter > 0, '上升段速度为正');
  assert.ok(Math.abs(hopVelocityFor(T * 0.75, amp, per) + quarter) < 1e-12, '下降段速度对称');
});

test('自定义参数被接受，非法值回落到默认', () => {
  const s = createDeformState({ stiffness: 300, damping: 4, squashLimit: 'bad' });
  assert.equal(s.opts.stiffness, 300);
  assert.equal(s.opts.damping, 4);
  assert.equal(s.opts.squashLimit, SPRING_DEFAULTS.squashLimit, '非法值应回落');
});
