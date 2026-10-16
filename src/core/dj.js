// Copyright (C) 2026 Harekasa（本项目作者）
// Copyright (C) 2026 CyanFish（本文件的数学移植自 Stronghold-Protocol-CyanModPack）
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ============================ 来源与许可 ============================
// 本文件的数学**逐行移植**自 CyanFish 的 Stronghold-Protocol-CyanModPack：
//     mods/cyanfish.dj-all/client/config.js        （SQUASH_IN/OUT、squashProfile、DEFAULT_GLOBAL）
//     mods/cyanfish.dj-all/client/engine-pixi.js   （frameFactors、MODE_FREE 写入语义）
//     原始实现见 https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack
// CyanModPack 以 GPL-3.0-or-later 发布（Copyright (C) 2026 CyanFish），与本项目同许可，
// 因此可以合法移植；移植后同样以 GPL-3.0-or-later 发布。
// 按 GPL-3.0 第 5 条，本文件已标明来源；**改动**只有：把 API 适配到本插件的结构
// （入参改为秒 + 相位、输出对象可复用），数学本身未改动，并由 tests/dj.test.js 逐值对照。
// 完整许可见仓库根的 LICENSE；第三方来源汇总见 NOTICE.md。
//
// src/core/dj.js — 压缩/旋转的**逐帧数学**，逐行移植自参考实现。
//
// 来源：CyanFish / Stronghold-Protocol-CyanModPack（GPL-3.0-or-later，与本项目同许可）
//   · mods/cyanfish.dj-all/client/config.js   → SQUASH_IN / SQUASH_OUT / squashProfile / DEFAULT_GLOBAL
//   · mods/cyanfish.dj-all/client/engine-pixi.js → frameFactors / 写入模式 / 帧预算
//
// ===================== 为什么整段照搬而不是"参考思路" =====================
//
// 我原先自己写了一套：欠阻尼弹簧 + 冲量踢 + 连续正弦跟随 + 写回阈值 + 自转量化台阶。
// 那套东西有三个先天的麻烦：
//   1. **有状态**：弹簧状态会漂移、会因为接入时刻不同而不同步、会被跳帧影响；
//   2. **每帧都要算**：即使观感上没变化也在推进积分；
//   3. 为了省写入又叠了量化/阈值，逻辑越来越绕。
//
// 参考实现是**纯时间函数**：给定时刻 t，直接算出这一帧该是什么姿态。于是
//   · 无状态 ⇒ 不漂移、天然同步（所有单位读同一个 t）、掉帧也不累积误差；
//   · 简单 ⇒ 没有弹簧参数、没有阈值、没有台阶，"整不整齐"这个问题根本不存在；
//   · 快 ⇒ 每帧只是几次乘加。
//
// 所以这次不再"借鉴思路"，而是**逐行移植数学**，只把 API 适配到本插件的结构。

/** 参考实现里一切周期以**帧**为单位（FPS=60）。 */
export const FPS = 60;

/** 压缩脉冲的相位划分：前 40% 压下去，接着 40% 弹回来，最后 20% 保持原状。 */
export const SQUASH_IN = 0.4;
export const SQUASH_OUT = 0.4;

/**
 * 压缩曲线（三角波）。逐行照搬 `config.js` 的 squashProfile。
 *
 * `u` 的小数部分决定相位：
 *   [0, 0.4)        → 0 → 1     （压下去）
 *   [0.4, 0.8)      → 1 → 0     （弹回来）
 *   [0.8, 1)        → 0         （静止，让"压扁"有明确的节拍感而不是连续晃动）
 *
 * @param {number} u 相位（可为任意实数，内部取小数部分）
 * @returns {number} 0..1 的压缩量
 */
export function squashProfile(u) {
  let x = Number(u) || 0;
  x -= Math.floor(x);                       // 折回 [0,1)
  if (x < SQUASH_IN) return x / SQUASH_IN;
  if (x < SQUASH_IN + SQUASH_OUT) return 1 - (x - SQUASH_IN) / SQUASH_OUT;
  return 0;
}

/** 参考实现的默认参数（逐字照搬 DEFAULT_GLOBAL）。 */
export const DJ_DEFAULTS = Object.freeze({
  spinMode: 'axis',      // 'axis' 绕竖直轴 | 'squash' 仅压缩 | 'flat' 平面内
  spinPeriod: 67,        // 帧
  squashPeriod: 38,      // 帧
  squashMinPct: 60,      // 高度压到 60%
  widthMaxPct: 110,      // 宽度撑到 110%
});

/** 「仅压缩」模式不乘 cos θ（照搬 NO_SPIN_MODES）。 */
export const NO_SPIN_MODES = Object.freeze(['squash']);

const TAU = Math.PI * 2;
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num0 = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * 由时刻 `t`（秒）算出这一帧的各个系数。
 * **逐行移植** `engine-pixi.js` 的 frameFactors，只把入参名换成秒 + 一个相位偏移。
 *
 * @param {object} c 参数（见 DJ_DEFAULTS，周期单位是帧）
 * @param {number} t 该单位自己的时间（秒）
 * @param {number} [phase] 额外相位偏移（0..1）。同步模式全传 0 ⇒ 全场严格同相
 * @param {object} [out] 复用的输出对象（这是每帧热路径，不该分配）
 */
export function djFactors(c, t, phase = 0, out = {}) {
  const M = clampNum(num0(c && c.squashMinPct, 60) / 100, 0.05, 1);
  const W = clampNum(num0(c && c.widthMaxPct, 110) / 100, 1, 2);
  const Tq = Math.max(1, num0(c && c.squashPeriod, 38)) / FPS;
  const Ts = Math.max(1, num0(c && c.spinPeriod, 67)) / FPS;
  const mode = (c && c.spinMode) || 'axis';
  const phi = num0(phase, 0);
  const tt = Number(t) || 0;

  const s = squashProfile(tt / Tq + phi);
  const theta = TAU * (tt / Ts + phi);
  const axis = mode === 'axis';

  out.s = s;
  out.theta = theta;
  out.axis = axis;
  out.flat = mode === 'flat';
  out.noSpin = NO_SPIN_MODES.indexOf(mode) >= 0;
  out.yK = 1 - (1 - M) * s;
  out.xK = 1 + (W - 1) * s;
  // axis 模式：宽度额外乘 cos θ（**允许为负** ⇒ 自然镜像 = 转到了背面）
  out.axisK = axis ? Math.cos(theta) : 1;
  return out;
}

/**
 * 把系数写进一个 PIXI 容器，按参考实现的"写入模式"语义。
 *
 * 逐行对应 `applyTarget` 里的两段：
 * ```
 * if (tgt.scale === MODE_FREE && o.scale) {
 *   if (typeof s.sx !== 'number') { s.sx = o.scale.x; s.sy = o.scale.y; }   // 记基准一次
 *   const x = s.sx * ctx.xK * axisK, y = s.sy * ctx.yK;
 *   o.scale.set(x, y); s.wx = x; s.wy = y;
 * }
 * if (tgt.rot === MODE_FREE && typeof o.rotation === 'number') {
 *   if (typeof s.rot !== 'number') s.rot = o.rotation;
 *   if (ctx.flat) o.rotation = s.rot + ctx.theta;      // ★ 只有平面内才写 rotation
 * }
 * ```
 *
 * ★ `MODE_FREE` = "宿主从不写这个字段" ⇒ 第一次碰到时记下原值当基准，之后写 `基准 × 系数`。
 *   单位 `body` 的 scale / rotation 正是这种（参考实现的逐字段表标为 `scale free · rot free`）。
 *   因为基准只记一次，**不需要写回阈值也不需要量化** —— 系数就是当帧的真实值，
 *   没有"累积漂移"这回事。
 *
 * @param {object} o PIXI 容器
 * @param {object} st 该容器的持久状态（{sx, sy, rot} 基准值）
 * @param {object} f djFactors 的输出
 */
export function djApply(o, st, f) {
  if (!o) return;
  if (o.scale) {
    if (typeof st.sx !== 'number') { st.sx = o.scale.x; st.sy = o.scale.y; }
    o.scale.x = st.sx * f.xK * f.axisK;
    o.scale.y = st.sy * f.yK;
  }
  // ★ 只有「平面内」才写 rotation（照搬参考实现：绕竖直轴/仅压缩都不写）
  if (f.flat && typeof o.rotation === 'number') {
    if (typeof st.rot !== 'number') st.rot = o.rotation;
    o.rotation = st.rot + f.theta;
  }
}

/** 还原到基准姿态（关掉特效 / 离开对局时用）。 */
export function djRestore(o, st) {
  if (!o) return;
  try {
    if (o.scale && typeof st.sx === 'number') o.scale.set(st.sx, st.sy);
    if (typeof st.rot === 'number' && typeof o.rotation === 'number') o.rotation = st.rot;
  } catch { /* ignore */ }
}
