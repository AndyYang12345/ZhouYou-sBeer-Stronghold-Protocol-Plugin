// tests/unit-effect.test.js — 控制器行为测试。
//
// 用一个最小的"假显示对象"代替 PIXI Container：只要 scale / rotation / pivot / position 可写即可。
// 这正是把渲染依赖抽象掉的意义 —— 手感逻辑可以脱离浏览器验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnitEffect, EFFECT_DEFAULTS } from '../src/unit-effect.js';

/** 最小的显示对象替身。 */
function fakeTarget() {
  return {
    scale: { x: 1, y: 1 },
    rotation: 0,
    pivot: { x: 0, y: 0 },
    position: { x: 0, y: 0 },
  };
}

const advance = (fx, seconds, dt = 1 / 60, aliveScale = 1) => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) fx.update(dt, aliveScale);
};

test('默认参数与参考实现一致', () => {
  assert.equal(EFFECT_DEFAULTS.strength, 1.15);
  assert.equal(EFFECT_DEFAULTS.spinPeriod, 2.7);
  assert.equal(EFFECT_DEFAULTS.pulsesPerSecond, 2);
});

test('开启后会自转，并且约一个周期转满一圈', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinPeriod: 2, spinAxis: 'screen' });
  advance(fx, 1);
  const half = t.rotation;
  advance(fx, 1);
  // 2 秒应转满 2π；rotation 会被归一到 [0, 2π)
  assert.ok(Math.abs(half - Math.PI) < 0.2, `1 秒应转约半圈，实际 ${half}`);
});

test('自转速度受 spinPeriod 控制', () => {
  const fast = fakeTarget(), slow = fakeTarget();
  const a = createUnitEffect(fast, { spinPeriod: 1, spinAxis: 'screen' });
  const b = createUnitEffect(slow, { spinPeriod: 4, spinAxis: 'screen' });
  advance(a, 0.5); advance(b, 0.5);
  assert.ok(Math.abs(a.state.spin) > Math.abs(b.state.spin) * 3, '周期短的应转得快得多');
});

test('关闭后立刻回到静止姿态', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  advance(fx, 0.3);
  fx.setEnabled(false);
  fx.update(1 / 60);
  assert.equal(t.scale.x, 1);
  assert.equal(t.scale.y, 1);
  assert.equal(t.rotation, 0);
});

test('挤压与自转解耦：停掉弹跳不影响自转（用户要求"死亡继续旋转"）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { deadBounce: false, spinAxis: 'screen' });
  advance(fx, 0.2);
  const spinBefore = fx.state.spin;

  fx.setAlive(false);          // 死亡：不再注入脉冲，弹簧自然衰减，但自转继续
  advance(fx, 2.5);            // 给弹簧足够时间收敛

  assert.ok(fx.state.spin > spinBefore + 1, `死亡后仍应持续自转，实际 ${spinBefore} → ${fx.state.spin}`);
  assert.ok(Math.abs(t.scale.y - 1) < 0.01, `弹跳应收敛到静止，实际 y=${t.scale.y}`);
});

test('死亡后弹跳默认停止', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  fx.setAlive(false);
  advance(fx, 1.5);
  assert.ok(Math.abs(t.scale.y - 1) < 0.02, `死亡后应基本恢复原状，实际 y=${t.scale.y}`);
});

test('开启 deadBounce 后死亡仍继续弹跳', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { deadBounce: true });
  fx.setAlive(false);
  let maxDev = 0;
  for (let i = 0; i < 180; i++) { fx.update(1 / 60); maxDev = Math.max(maxDev, Math.abs(t.scale.y - 1)); }
  assert.ok(maxDev > 0.03, `应仍在弹跳，实际最大偏离 ${maxDev}`);
});

test('死亡后自转速度受 deadSpinScale 控制', () => {
  const normal = fakeTarget(), slower = fakeTarget();
  const a = createUnitEffect(normal, { deadSpinScale: 1, spinAxis: 'screen' });
  const b = createUnitEffect(slower, { deadSpinScale: 0.25, spinAxis: 'screen' });
  a.setAlive(false); b.setAlive(false);
  advance(a, 1); advance(b, 1);
  assert.ok(Math.abs(a.state.spin) > Math.abs(b.state.spin) * 3, 'deadSpinScale 应生效');
});

test('竖轴自转用水平镜像近似（正反面交替）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 2 });
  const signs = new Set();
  for (let i = 0; i < 120; i++) { fx.update(1 / 60); signs.add(Math.sign(t.scale.x)); }
  assert.ok(signs.has(1) && signs.has(-1), '应出现正反两个方向（镜像翻转）');
});

test('设置旋转支点会同时平移对象，视觉位置不变', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  fx.setModelHeight(64);
  assert.equal(t.pivot.y, 32, '支点应移到身体中部');
  assert.equal(t.position.y, -32, '对象应下移同样的距离以保持视觉位置');
});

test('未设置模型高度时不动 pivot / position（不破坏原有布局）', () => {
  const t = fakeTarget();
  t.position.y = 7; t.pivot.y = 3;
  const fx = createUnitEffect(t);
  advance(fx, 0.3);
  assert.equal(t.position.y, 7);
  assert.equal(t.pivot.y, 3);
});

test('巨大的 dt（切后台再回来）不会让弹簧发散', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  fx.update(30);   // 切回标签页
  assert.ok(Number.isFinite(t.scale.x) && Number.isFinite(t.scale.y));
  assert.ok(t.scale.y > 0.5 && t.scale.y < 2, `缩放应仍有界，实际 ${t.scale.y}`);
});

test('reset() 让一切归零', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'screen' });
  advance(fx, 0.4);
  fx.reset();
  assert.equal(fx.state.spin, 0);
  assert.equal(fx.state.deform.squash, 0);
  assert.equal(t.scale.x, 1);
  assert.equal(t.rotation, 0);
});

test('kick() 可手动触发一次弹动（点击/落地用）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  fx.kick(1);
  fx.update(1 / 60);
  assert.ok(t.scale.y < 1, '应被压扁');
});

test('aliveScale 会加快自转（行进中的单位更欢快）', () => {
  const slow = fakeTarget(), fast = fakeTarget();
  const a = createUnitEffect(slow, { spinAxis: 'screen' });
  const b = createUnitEffect(fast, { spinAxis: 'screen' });
  advance(a, 0.5, 1 / 60, 1);
  advance(b, 0.5, 1 / 60, 2);
  assert.ok(Math.abs(b.state.spin) > Math.abs(a.state.spin) * 1.8, 'aliveScale 应生效');
});
