// tests/unit-effect.test.js — 控制器行为测试。
//
// 用一个最小的"假显示对象"代替 PIXI Container：只要 scale / rotation / pivot / position 可写即可。
// 这正是把渲染依赖抽象掉的意义 —— 手感逻辑可以脱离浏览器验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnitEffect, EFFECT_DEFAULTS, WRITE_EPSILON } from '../src/core/unit-effect.js';
import { PIVOT_TRIES_MAX } from '../src/integrations/units.js';

/** 最小的显示对象替身。 */
/** 带 set() 的二维点，模拟 PIXI 的 ObservablePoint。 */
function point(x = 0, y = 0) {
  return { x, y, set(nx, ny) { this.x = nx; this.y = ny; } };
}

function fakeTarget() {
  return {
    scale: { x: 1, y: 1 },
    rotation: 0,
    pivot: point(),
    position: point(),
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

// （已删除："设置旋转支点会同时平移对象" —— 那条测试断言的正是导致单位浮空的错误行为，
//   它让 bug 一路通过。正确断言见文件末尾的"支点"一组。）

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

// ---- 性能回归：写回阈值 ----------------------------------------------------------
// 这一组测试守的是一个**真实事故**：无条件每帧写 scale/rotation 会让 PIXI 每帧重算
// 所有单位的整棵子树，单位一多就把主线程拖死（游戏会判定"插件卡死，由服务器接管本局"）。

test('写回阈值生效：没有新激励时不写变换（PIXI 脏标记不被无谓触发）', () => {
  // 这一组守的是一个**真实事故**：无条件每帧写 scale/rotation 会让 PIXI 每帧重算
  // 所有单位的整棵子树，单位一多就拖死主线程（游戏会判定"插件卡死，由服务器接管本局"）。
  //
  // 测法说明（踩过两次坑）：
  //   1. 替身必须保留真实数值，否则 effect 每次读到的都是错的；
  //   2. 默认参数下弹簧**永远在动**（每秒两次脉冲持续注入能量），所以必须把激励关掉
  //      （strength: 0 → kick 注入 0）才谈得上"没有新变化"。
  const counter = { scale: 0, rotation: 0 };
  const scale = new Proxy({ x: 1, y: 1 }, { set(t, p, v) { counter.scale++; t[p] = v; return true; } });
  const t = { scale, rotation: 0, pivot: { x: 0, y: 0 }, position: { x: 0, y: 0 } };
  Object.defineProperty(t, 'rotation', {
    get() { return this._rot ?? 0; },
    set(v) { counter.rotation++; this._rot = v; },
    configurable: true,
  });

  // 自转极慢（1e9 秒一圈 ≈ 每帧角度变化 1e-11）+ 无脉冲 → 数值恒定
  // 连续模式（默认）不看 strength，要看 squashDepth 才能关掉自动激励
  const fx = createUnitEffect(t, { spinAxis: 'screen', spinPeriod: 1e9, strength: 0, squashDepth: 0 });
  for (let i = 0; i < 240; i++) fx.update(1 / 60);   // 4 秒

  assert.ok(counter.scale <= 2, `数值不变时不应写 scale，实际 ${counter.scale} 次 / 240 帧`);
  assert.ok(counter.rotation <= 2, `数值不变时不应写 rotation，实际 ${counter.rotation} 次 / 240 帧`);
});

test('自转必须可见：量化后仍有足够多的不同角度（同时不能退化成每帧写）', () => {
  // 这一条同时守两侧：
  //   * 下界 —— 量化不能把自转"吃掉"，2 秒内至少要有几十种角度，看起来才是连续转动；
  //   * 上界 —— 不能退化成每帧都写（那正是拖死主线程的原因）。
  // 默认 24 步/2.7 秒的量化在 2 秒内约产生 19 种角度（≈9.5 次/秒），远小于 120 帧。
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'screen', spinPeriod: 2 });
  const seen = new Set();
  for (let i = 0; i < 120; i++) { fx.update(1 / 60); seen.add(t.rotation.toFixed(6)); }
  assert.ok(seen.size >= 12, `角度种类太少，自转会被看出来是卡顿的，实际 ${seen.size}`);
  assert.ok(seen.size <= 60, `写得太频繁，量化没起作用，实际 ${seen.size} 种 / 120 帧`);
});

test('WRITE_EPSILON 很小，不会影响可见精度', () => {
  assert.ok(WRITE_EPSILON <= 1e-3, `阈值应足够小，实际 ${WRITE_EPSILON}`);
});

test('支点测量有重试上限（模型量不到时不做每帧无用功）', () => {
  assert.ok(Number.isInteger(PIVOT_TRIES_MAX) && PIVOT_TRIES_MAX > 0 && PIVOT_TRIES_MAX <= 100,
    `重试上限应是个小整数，实际 ${PIVOT_TRIES_MAX}`);
});

// ---- 支点：默认绝不碰 pivot / position ----------------------------------------
// 这一组守的是一个**两次复发的线上事故**：单位全部浮空。
// 两次都是"把支点移到身体中部好让它绕腰转"这个自作聪明的念头造成的：
//   第一次 pivot.y=+h/2 且 position.y=−h/2 → 浮空
//   第二次 只写 pivot.y=+h/2               → 仍然浮空
// 而参考实现（CyanFish CyanModPack 的 dj-all/client/engine-pixi.js）压根不碰单位 body
// 的 pivot/position —— 它的逐字段表把 op/enemy/token 标为只写 scale 与 rotation。
// 结论：**只写 scale 和 rotation**，位置一律不动。

test('默认绝不碰 pivot / position（这是两次浮空事故的修复）', () => {
  const t = fakeTarget();
  t.pivot.x = 3; t.pivot.y = 5;      // 假设宿主自己有值
  t.position.x = 7; t.position.y = 11;
  const fx = createUnitEffect(t);

  fx.setModelHeight(64);             // 即使量到了高度……

  assert.equal(t.pivot.x, 3, 'pivot 不该被改');
  assert.equal(t.pivot.y, 5, '★ pivot 不该被改 —— 改了就会浮空');
  assert.equal(t.position.x, 7, 'position 不该被改');
  assert.equal(t.position.y, 11, '★ position 不该被改');
});

test('跑很多帧后 pivot / position 依然原封不动', () => {
  const t = fakeTarget();
  t.pivot.y = 5; t.position.y = 11;
  const fx = createUnitEffect(t);
  fx.setModelHeight(64);
  for (let i = 0; i < 240; i++) fx.update(1 / 60);
  assert.equal(t.pivot.y, 5, '帧循环里也不能碰 pivot');
  assert.equal(t.position.y, 11, '帧循环里也不能碰 position');
});

test('模型高度量不到时也不做任何位置补偿', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t);
  fx.setModelHeight(0);
  assert.equal(t.pivot.y, 0);
  assert.equal(t.position.y, 0);
});

test('只有显式开启 spinPivot 才走支点补偿（默认关闭）', () => {
  assert.equal(EFFECT_DEFAULTS.spinPivot, false, '默认必须是关闭的');

  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinPivot: true });
  fx.setModelHeight(64);
  // 开启时按参考实现的写法：pivot 与 position 设成**同一个值**（不是一正一负）
  assert.equal(t.pivot.y, 32);
  assert.equal(t.position.y, 32, '参考实现是两者同值，不是互为相反数');
});

// ---- 绕竖轴旋转（宽度必须真正连续过零）--------------------------------------------
// 这一组守玩家反馈过的一个失败：「绕竖轴旋转没成功」。
// 当时的实现是 `sx * (cos θ >= 0 ? 1 : -1)` —— 只取**符号**，横向只剩 ±1 两种宽度，
// 结果变成"瞬间左右翻"，完全没有收缩过程。
// 正确做法（参考 CyanFish CyanModPack, engine-pixi.js:429-431 与 frontback.js 抬头）：
//     横向 = 原宽 × **带符号的 cos θ**
// 即 θ=0 → 1（正面）、θ=90° → 0（侧对）、θ=180° → −1（镜像=背面）。

/** 把 spin 放到指定角度后跑一帧，读回横向 scale。 */
function widthAt(deg, opts = {}) {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 2.7, squashDepth: 0, ...opts });
  fx.state.spin = (deg * Math.PI) / 180;
  fx.update(1 / 60);
  return t.scale.x;
}

test('★ 横向宽度必须连续过零（不能只有 ±1 两档）', () => {
  const samples = [];
  for (let deg = 0; deg <= 360; deg += 5) samples.push(widthAt(deg));

  const widths = samples.map(Math.abs);
  // 必须存在大量"中间宽度"：若只取符号，|宽度| 只会有 1 和 0 两种值
  const middling = widths.filter((w) => w > 0.08 && w < 0.92).length;
  assert.ok(middling >= 20, `中间宽度应有大量取值（收缩过程），实际只有 ${middling} 个`);
});

test('θ=0 是完整正面，θ=180° 是镜像（负值）', () => {
  assert.ok(Math.abs(widthAt(0) - 1) < 0.02, `0° 应约为 1，实际 ${widthAt(0)}`);
  assert.ok(widthAt(180) < -0.95, `180° 应为负（镜像=背面），实际 ${widthAt(180)}`);
});

test('★ θ=90° 与 270° 宽度必须真正归零（侧对的那一帧）', () => {
  // 台阶数取 4 的倍数才能保证 90° 落在网格点上；否则宽度只压到 0.05 左右就反弹，
  // 看起来"没转到位"。
  assert.ok(Math.abs(widthAt(90)) < 0.02, `90° 宽度应≈0，实际 ${widthAt(90)}`);
  assert.ok(Math.abs(widthAt(270)) < 0.02, `270° 宽度应≈0，实际 ${widthAt(270)}`);
});

test('一整圈里宽度单调地"收窄→过零→张开"（不是跳变）', () => {
  // 每 2° 采一次，相邻两次的宽度差不应出现大跳（连续性的直接检验）
  let prev = widthAt(0);
  let maxJump = 0;
  for (let deg = 2; deg <= 360; deg += 2) {
    const w = widthAt(deg);
    maxJump = Math.max(maxJump, Math.abs(w - prev));
    prev = w;
  }
  assert.ok(maxJump < 0.2, `相邻采样宽度不应有大跳，实际最大跳变 ${maxJump.toFixed(3)}`);
});

test('★ 绕竖轴模式不写 rotation（参考实现的口径：只有平面内才写）', () => {
  const t = fakeTarget();
  let rotWrites = 0;
  Object.defineProperty(t, 'rotation', {
    get() { return this._rot ?? 0; },
    set(v) { rotWrites++; this._rot = v; },
    configurable: true,
  });
  const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 2.7 });
  for (let i = 0; i < 120; i++) fx.update(1 / 60);
  assert.ok(rotWrites <= 1, `竖轴模式不应写 rotation（写了会把贴图倾斜、破坏轴转读感），实际 ${rotWrites} 次`);
});

test('平面内模式仍然写 rotation（那种效果就是要转角度）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'screen', spinPeriod: 2.7 });
  let seen = new Set();
  for (let i = 0; i < 120; i++) { fx.update(1 / 60); seen.add(t.rotation.toFixed(4)); }
  assert.ok(seen.size > 5, `平面内模式应产生多个角度，实际 ${seen.size}`);
});

test('宽度不会因挤压而丢失符号（挤压与轴转可叠加）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 2.7, strength: 1.5 });
  fx.state.spin = Math.PI;            // 180°，应为负
  for (let i = 0; i < 10; i++) fx.update(1 / 60);
  assert.ok(t.scale.x < 0, `180° 时叠加挤压也应保持负号，实际 ${t.scale.x}`);
});

// ---- 整齐：横向只由角度决定，不被挤压污染 ------------------------------------------
// 玩家反馈"能让旋转更整齐一点吗"。查证发现横向有**两个来源在相乘**：
//   `sx * cos θ`，而 `sx = 1/√y` —— 等于把挤压的横向补偿又乘了一次
//   （横向实际是 cos θ · 1.18），压缩被放大，且挤压的抖动直接叠在宽度上。
// 轴转的横向应当只有**一个来源：角度**。挤压在轴转模式下只作用于纵向。

test('★ 轴转模式下横向与挤压强度无关（只有一个来源：角度）', () => {
  const widths = [];
  for (const strength of [0.3, 1.15, 1.8]) {
    const t = fakeTarget();
    const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 100, strength });
    fx.state.spin = Math.PI / 3;                 // 固定在同一角度
    fx.update(1 / 600);                          // 极小步长，角度几乎不动
    widths.push(t.scale.x);
  }
  const spread = Math.max(...widths) - Math.min(...widths);
  assert.ok(spread < 0.02,
    `横向不应随挤压强度变化（说明挤压污染了宽度），实际跨度 ${spread.toFixed(4)}`);
});

test('轴转模式下横向就是 cos θ（数值对齐）', () => {
  for (const deg of [30, 60, 120, 150]) {
    const t = fakeTarget();
    const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 100, strength: 1.5 });
    fx.state.spin = (deg * Math.PI) / 180;
    fx.update(1 / 600);
    const expected = Math.cos((deg * Math.PI) / 180);
    assert.ok(Math.abs(t.scale.x - expected) < 0.03,
      `${deg}° 横向应约为 ${expected.toFixed(3)}，实际 ${t.scale.x.toFixed(3)}`);
  }
});

test('挤压在轴转模式下仍然作用于纵向（功能没丢）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'vertical', spinPeriod: 100, strength: 1.5 });
  const before = t.scale.y;
  fx.state.spin = Math.PI / 3;
  for (let i = 0; i < 20; i++) fx.update(1 / 60);
  assert.notEqual(t.scale.y, before, '纵向应有挤压');
});

test('★ 平面内模式仍保留体积守恒（横向补偿还在，那是另一种效果）', () => {
  const t = fakeTarget();
  const fx = createUnitEffect(t, { spinAxis: 'screen', spinPeriod: 100, strength: 1.5 });
  fx.state.spin = 0;
  for (let i = 0; i < 20; i++) fx.update(1 / 60);
  // 压扁时横向应 > 1（体积守恒）
  if (t.scale.y < 0.999) assert.ok(t.scale.x > 1.0, '平面内模式下压扁应伴随横向变宽');
});

// ---- 整齐：全场转速一致 ----------------------------------------------------------

test('★ movingSpeedScale 默认为 1（全场转速一致）', () => {
  assert.equal(EFFECT_DEFAULTS.movingSpeedScale, 1,
    '默认必须一致；曾经的硬编码 1.15 让"走着的比站着的快"，转起来参差');
});

// ---- 全场同步弹跳 ----------------------------------------------------------------
// 玩家反馈"弹跳并不整齐"。根因：每个 effect 的 `st.time` 是**从该单位被创建那一刻**
// 起算的（再加上"每帧最多新接 3 个"的预算），所以各单位的相位互不相同、整场散开。
// 修法：调用方维护一个共享时基，所有单位读它。
//
// 这一组的关键断言是**同相**：两个在不同时刻创建、被喂入不同 dt 序列的 effect，
// 只要共享相位相同，压扁程度就必须完全一致。

const mkTarget = () => ({
  scale: { x: 1, y: 1 },
  rotation: 0,
  pivot: { x: 0, y: 0, set() {} },
  position: { x: 0, y: 0, set() {} },
});

test('★ 共享相位相同 ⇒ 压扁程度完全相同（同步弹跳的核心性质）', () => {
  const a = mkTarget();
  const b = mkTarget();
  const fa = createUnitEffect(a, { spinAxis: 'vertical', syncBounce: true, strength: 1.15 });
  const fb = createUnitEffect(b, { spinAxis: 'vertical', syncBounce: true, strength: 1.15 });

  // 故意让两者"历史"完全不同：先各跑一段不同长度的时间
  for (let i = 0; i < 7; i++) fa.update(1 / 60, 1, 0.5);
  for (let i = 0; i < 40; i++) fb.update(1 / 60, 1, 1.9);

  // 现在给同一个共享相位，各推几帧
  //
  // 注意断言的口径：**不是"一帧内完全相等"**。弹簧跟随器本身有滞后，各单位进入
  // 同步时的滞后状态不同，所以严格的性质是"喂入相同相位后**迅速收敛**"。
  // 起初跟随速度只有 22（一帧收敛约 37%，要十几帧才齐），实测会带着残差晃；
  // 同步模式下改用 syncFollow=60，约 2~3 帧收敛 —— 这才算"整场同步"。
  const phase = 3.14159;
  for (let i = 0; i < 5; i++) {
    fa.update(1 / 60, 1, phase);
    fb.update(1 / 60, 1, phase);
  }

  assert.ok(Math.abs(a.scale.y - b.scale.y) < 1e-3,
    `同一共享相位下纵向应迅速收敛到一致，实际 ${a.scale.y} vs ${b.scale.y}`);
  assert.ok(Math.abs(a.scale.x - b.scale.x) < 1e-3,
    `同一共享相位下横向也应一致，实际 ${a.scale.x} vs ${b.scale.x}`);
});

test('★ 共享相位下的收敛足够快（3 帧内进入同一状态）', () => {
  const a = mkTarget();
  const b = mkTarget();
  const fa = createUnitEffect(a, { spinAxis: 'vertical', syncBounce: true, strength: 1.15 });
  const fb = createUnitEffect(b, { spinAxis: 'vertical', syncBounce: true, strength: 1.15 });
  for (let i = 0; i < 11; i++) fa.update(1 / 60, 1, 0.4);
  for (let i = 0; i < 47; i++) fb.update(1 / 60, 1, 2.9);

  for (let i = 0; i < 3; i++) {           // 只推 3 帧
    fa.update(1 / 60, 1, 1.234);
    fb.update(1 / 60, 1, 1.234);
  }
  assert.ok(Math.abs(a.scale.y - b.scale.y) < 1e-2,
    `3 帧内应收敛，实际差值 ${Math.abs(a.scale.y - b.scale.y).toFixed(5)}`);
});

test('关闭 syncBounce 时各单位各走各的（保留原来的自由相位）', () => {
  const a = mkTarget();
  const b = mkTarget();
  const fa = createUnitEffect(a, { spinAxis: 'vertical', syncBounce: false, strength: 1.15 });
  const fb = createUnitEffect(b, { spinAxis: 'vertical', syncBounce: false, strength: 1.15 });
  for (let i = 0; i < 30; i++) fa.update(1 / 60, 1, 0);
  for (let i = 0; i < 5; i++) fb.update(1 / 60, 1, 0);
  fa.update(1 / 60, 1, 0);
  fb.update(1 / 60, 1, 0);
  assert.ok(Math.abs(a.scale.y - b.scale.y) > 1e-6,
    '关闭同步时应各自计时（不应完全一致）');
});

test('共享相位也作用于跳跃（不只是压扁）', () => {
  const a = mkTarget();
  const b = mkTarget();
  const fa = createUnitEffect(a, { spinAxis: 'vertical', syncBounce: true });
  const fb = createUnitEffect(b, { spinAxis: 'vertical', syncBounce: true });
  for (let i = 0; i < 9; i++) fa.update(1 / 60, 1, 0.3);
  for (let i = 0; i < 33; i++) fb.update(1 / 60, 1, 2.2);
  a.position.y = 0; b.position.y = 0;
  const phase = 2.5;   // 取一个跳跃不为 0 的相位
  fa.update(1 / 60, 1, phase);
  fb.update(1 / 60, 1, phase);
  assert.ok(Math.abs(a.position.y - b.position.y) < 1e-9,
    `跳跃也应同相，实际 ${a.position.y} vs ${b.position.y}`);
});

test('没给共享相位时退回各自的 st.time（向后兼容）', () => {
  const a = mkTarget();
  const fa = createUnitEffect(a, { spinAxis: 'vertical', syncBounce: true });
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) fa.update(1 / 60); });
  assert.ok(Number.isFinite(a.scale.y), '没有共享相位也应正常推进');
});

test('共享相位为 NaN / undefined 时安静退回各自计时（不产生 NaN）', () => {
  for (const bad of [NaN, undefined, null, 'x']) {
    const t = mkTarget();
    const fx = createUnitEffect(t, { spinAxis: 'vertical', syncBounce: true });
    for (let i = 0; i < 20; i++) fx.update(1 / 60, 1, bad);
    assert.ok(Number.isFinite(t.scale.y), `坏相位 ${String(bad)} 不应产生 NaN，实际 ${t.scale.y}`);
    assert.ok(Number.isFinite(t.scale.x), `坏相位 ${String(bad)} 不应产生 NaN（横向）`);
  }
});
