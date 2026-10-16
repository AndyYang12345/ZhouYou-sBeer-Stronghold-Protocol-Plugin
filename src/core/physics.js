// Copyright (C) 2026 Harekasa
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 本文件以 GPL-3.0-or-later 发布（全文见仓库根的 LICENSE）。
//
// src/physics.js — 欠阻尼弹簧：挤压 / 拉伸的手感来源。
//
// 从参考实现（博客的坐姿普瑞赛斯手办）移植并参数化：它已经在真机上验证过手感，
// 所以默认值直接沿用（刚度 170、阻尼 8.5），只是把硬编码的常量提成可配置项。
//
// 为什么用弹簧而不是正弦：正弦是「压下去再匀速回来」，看起来是机械的伸缩；
// 欠阻尼弹簧压下去之后会**过冲成拉伸再回弹**，这才是「Q弹」的来源。
//
// 本文件不依赖任何渲染库或 DOM，可在 Node 里直接单测。

/** 挤压量 squash 的默认限幅系数：limit = min(maxLimit, squashLimit * strength + limitBias)。 */
export const SPRING_DEFAULTS = Object.freeze({
  stiffness: 170,     // 弹簧刚度：越大越"硬"，回弹越快
  damping: 8.5,       // 阻尼：越小过冲越明显（欠阻尼）
  squashLimit: 0.21,  // 限幅随强度增长
  limitBias: 0.06,
  maxLimit: 0.32,     // 限幅上限：再调也不会压得更扁，避免模型糊成一团
  kickScale: 2.6,     // 每次脉冲注入的冲量 = kickScale * strength * impact
  kickMax: 4.5,       // 单次冲量上限
  bounce: -0.25,      // 撞到限幅后的速度反弹系数
});

/** 固定步长的默认值（秒）。参考实现用 1/120，与帧率解耦，保证手感一致。 */
export const FIXED_STEP = 1 / 120;

const physNum = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * 一个可被弹簧驱动的形变体。
 *
 * `squash` 是形变量：**正值 = 横向变胖（被压扁）**，负值 = 被拉伸。
 * `sv` 是它的速度。两者都由调用方持有，本模块不保存状态 —— 便于测试与复用。
 */
export function createDeformState(overrides = {}) {
  const o = { ...SPRING_DEFAULTS, ...overrides };
  return {
    squash: 0,
    sv: 0,
    opts: {
      stiffness: physNum(o.stiffness, SPRING_DEFAULTS.stiffness),
      damping: physNum(o.damping, SPRING_DEFAULTS.damping),
      squashLimit: physNum(o.squashLimit, SPRING_DEFAULTS.squashLimit),
      limitBias: physNum(o.limitBias, SPRING_DEFAULTS.limitBias),
      maxLimit: physNum(o.maxLimit, SPRING_DEFAULTS.maxLimit),
      kickScale: physNum(o.kickScale, SPRING_DEFAULTS.kickScale),
      kickMax: physNum(o.kickMax, SPRING_DEFAULTS.kickMax),
      bounce: physNum(o.bounce, SPRING_DEFAULTS.bounce),
    },
  };
}

/** 当前强度下的挤压限幅。 */
export function squashLimitOf(state, strength = 1) {
  const { squashLimit, limitBias, maxLimit } = state.opts;
  return Math.min(maxLimit, squashLimit * strength + limitBias);
}

/**
 * 推进一个固定步长。
 * @param {{squash:number, sv:number, opts:object}} body
 * @param {number} dt 秒（应已切成固定步长）
 * @param {number} [strength] Q弹强度倍数
 */
export function springStep(body, dt, strength = 1) {
  const { stiffness, damping, bounce } = body.opts;
  body.sv += (-stiffness * body.squash - damping * body.sv) * dt;
  body.squash += body.sv * dt;
  const limit = squashLimitOf(body, strength);
  if (body.squash < -limit || body.squash > limit) {
    body.squash = Math.max(-limit, Math.min(limit, body.squash));
    body.sv *= bounce;
  }
}

/**
 * 打一个冲量（每次脉冲、每次落地、每次碰撞调用一次）。
 * @param {object} body
 * @param {number} [strength] Q弹强度
 * @param {number} [impact] 冲击系数，1 为基准；碰撞时可用碰前相对速度换算
 */
export function kick(body, strength = 1, impact = 1) {
  const { kickScale, kickMax } = body.opts;
  body.sv -= Math.min(kickMax, kickScale * strength * impact);
}

/**
 * 把一个 dt 切成固定步长并推进。渲染循环里直接调这个，不要自己写循环。
 * @returns {number} 实际执行的步数
 */
export function stepFixed(body, dt, strength = 1, fixedStep = FIXED_STEP) {
  const steps = Math.max(1, Math.ceil(dt / fixedStep));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) springStep(body, h, strength);
  return steps;
}

/**
 * 形变量 → 实际缩放（**体积守恒**：压扁时横向变胖，所以看起来是软体而不是缩水）。
 * @param {number} squash
 * @returns {{x:number, y:number}} 建议施加到渲染对象上的缩放
 */
/**
 * 由形变量求缩放。**复用同一个对象**，不每帧分配。
 *
 * 为什么：这是每帧每单位调用一次的热路径。返回新对象看似无害，
 * 但在 200Hz × 20 个单位下就是每秒 4000 个短命对象，直接推高 GC 压力
 * （实测追踪里 GC 占了约 180ms）。调用方**必须立即读取 x/y**，不可保存引用。
 */
const SCALE_OUT = { x: 1, y: 1 };
export function scaleFor(squash) {
  const y = 1 + squash;
  // 极端值保护：y 趋近 0 时 1/sqrt(y) 会发散
  SCALE_OUT.y = y;
  SCALE_OUT.x = 1 / Math.sqrt(Math.max(0.35, y));
  return SCALE_OUT;
}

/**
 * 离地弹跳：与脉冲同周期，起跳时正好被压扁 —— 参考实现里这个相位是调过的。
 * @param {number} phase 秒
 * @param {number} [amplitude]
 * @param {number} [perSecond] 每秒脉冲次数
 */
export function hopFor(phase, amplitude = 0.115, perSecond = 2) {
  return amplitude * (1 - Math.cos(phase * 2 * Math.PI * perSecond)) / 2;
}

/**
 * hopFor 对时间的导数（用于驱动"附属物"的滞后摆动，如耳朵、衣摆）。
 *
 * 注意：`hop(t) = A(1 - cos(ωt)) / 2`，其中 `ω = 2π · perSecond`，
 * 所以导数是 `A · ω/2 · sin(ωt)` —— **不是** `A · ω · sin(ωt)`。
 * （参考实现里写的是后者，多了一个因子 2；这里按正确的导数实现。）
 */
export function hopVelocityFor(phase, amplitude = 0.115, perSecond = 2) {
  const omega = 2 * Math.PI * perSecond;
  return amplitude * omega / 2 * Math.sin(phase * omega);
}
