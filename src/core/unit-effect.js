// Copyright (C) 2026 Harekasa
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 本文件以 GPL-3.0-or-later 发布（全文见仓库根的 LICENSE）。
//
// src/unit-effect.js — 把弹簧形变 + 自转 + 离地弹跳组合成一个"单位特效"。
//
// 设计要点
//   1. **不依赖具体渲染库**：只要求目标对象有 `scale` / `rotation` / `pivot` 三个可写属性
//      （PIXI Container 就是这样）。所以本文件可以直接单测，也能移植到别的 2D 引擎。
//   2. **支点在身体中部**：自转若以脚为轴，单位会像钟摆一样甩出去。所以旋转支点取
//      模型高度的中点，并且把模型向下平移同样的距离，让视觉位置保持不变。
//   3. **挤压与自转解耦**：压扁是"活着"的感觉，自转是梗图的荒诞感。两者各自独立开关，
//      也各自独立计相，互不干扰 —— 死亡时只停弹跳、继续旋转（见 `setAlive`）。
//   4. **固定步长积分**：与帧率解耦。掉帧时多跑几步，而不是让弹簧变慢。

import { createDeformState, kick, stepFixed, scaleFor, hopFor, hopVelocityFor, FIXED_STEP } from './physics.js';

/**
 * 自转的**每秒写入次数**（顺滑度与性能的唯一权衡点）。
 *
 * 为什么不是"每圈固定台阶数"：每秒写入次数 = 台阶数 ÷ 周期，若固定台阶数，
 * 周期一变顺滑度就跟着变（调快自转 → 台阶变粗）。固定**每秒写入次数**才能让
 * 任意周期下的观感一致。
 *
 * 默认 30：1.1 秒/圈约 33 台阶（10.9°/台阶，看不出）；2.7 秒/圈约 81 台阶。
 * 早期版本只有 8.9 次/秒 —— 1.1 秒/圈仅 10 台阶（36°/台阶），那是一眼可见的卡顿。
 */
export const SPIN_WRITES_PER_SEC = 30;

/** 默认参数。手感来自参考实现，自转周期也沿用它的 2.7 秒。 */
export const EFFECT_DEFAULTS = Object.freeze({
  enabled: true,
  // ★ 走**参考实现移植版**（core/dj.js）还是既有实现（弹簧+量化）。
  //   移植版是纯时间函数、无状态 ⇒ 更省、天然同场同步、没有台阶问题。
  //   保留开关是为了能干净回退（设 false 即回到既有实现）。
  djMode: true,
  djSpinMode: 'axis',      // 'axis' 绕竖直轴 | 'squash' 仅压缩 | 'flat' 平面内
  djSpinPeriod: 67,        // 帧（参考实现默认 67 帧 ≈ 1.12 秒）
  djSquashPeriod: 38,      // 帧（参考实现默认 38 帧 ≈ 0.63 秒）
  djSquashMinPct: 60,      // 高度压到 60%
  djWidthMaxPct: 110,      // 宽度撑到 110%
  strength: 1.15,          // Q弹强度倍数（参考实现默认 1.15）
  spinPeriod: 2.7,         // 自转一圈的秒数（参考实现默认 2.7）
  spinAxis: 'vertical',    // 'vertical' 竖轴（梗图效果）| 'screen' 屏幕平面内转
  spinWritesPerSec: SPIN_WRITES_PER_SEC, // 自转顺滑度：每秒写入次数（性能与观感的唯一权衡点）
  // 挤压的驱动方式：
  //   true（默认）—— **连续正弦驱动**：形变按平滑波形推，帧与帧之间没有台阶
  //   false        —— 冲量式：每 1/pulsesPerSecond 秒踢一脚，靠欠阻尼弹簧回弹
  // 冲量式的起跳很陡，快速脉冲下会看出"一顿一顿"；连续式明显更顺，手感略软。
  spinSmooth: true,
  // 正反面切换的死区（迟滞）。见 spinFacing 的说明 —— 等价于过零前后各一个小门限。
  flipDead: 0.04,
  // 行进中单位的转速倍数。**默认 1 = 全场转速完全一致**（需求"让旋转更整齐"的关键之一）。
  // 曾硬编码 1.15，导致场上"走着的比站着的快"，转起来参差。
  movingSpeedScale: 1,
  // **全场同步弹跳**：所有单位读同一个时基，因而压扁/回弹/跳跃完全同相。
  //
  // 为什么需要这个开关：默认每个单位的相位是**各自从自己被创建那一刻**起算的
  // （`st.time` 是 effect 自己的计时器），再加上"每帧最多新接 3 个"的预算，
  // 各单位开始的时刻都不同 ⇒ 整场是散开的。
  // 打开后改用调用方给的共享相位，全场严格同相。
  syncBounce: true,
  // 同步模式下的"跟随目标"速度。比自由模式（smoothFollow=22）快得多，因为
  // **光共享相位不够**：弹簧跟随器自身有滞后，各单位进入同步时滞后状态不同，
  // 若跟随太慢就会带着各自的残差晃几秒（实测 22 时一帧只收敛约 37%，要十几帧才齐）。
  // 60 时约 2~3 帧收敛 —— 人眼察觉不到，而"整场同步"变成一个近乎严格的性质。
  syncFollow: 60,
  // **全场同步自转**：自转角度也由共享相位推导，而不是各单位各自累加。
  //
  // 为什么连自转也要同步：`st.spin += d·ω` 是**各自的累加器**，各单位创建时刻不同
  // （还有"每帧最多新接 3 个"的预算），于是旋转角度全部错开 —— 即使弹跳同相，
  // 横向 `cos(spin)` 依旧各不相同，整场看起来还是散的。
  syncSpin: true,
  squashDepth: 0.14,   // 连续模式的压扁深度基准（实际深度 = squashDepth × strength）
  smoothFollow: 22,    // 连续模式下"跟随目标"的速度（越大越贴近波形、越小越软）
  manualImpulse: 0.02, // 连续模式下把手动冲量（kick）换算成额外位移的比例
  spinPivot: false,        // 是否把旋转支点移到身体中部（默认否，见 applyPivot 的两次踩坑记录）
  pulsesPerSecond: 2,      // 每秒挤压几次（参考实现是 2）
  hopAmplitude: 0.115,     // 离地弹跳幅度（模型高度归一化单位，1 ≈ 一个单位高）
  tiltFactor: 0.06,        // 压扁时的轻微侧倾，让它不那么"硬"
  deadSpinScale: 1,        // 死亡后自转速度倍数（1 = 不变）
  deadBounce: false,       // 死亡后是否继续弹跳
  fixedStep: FIXED_STEP,
});

const fxNum = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);

/**
 * 创建一个作用在单个显示对象上的特效驱动。
 *
 * @param {{ scale: {x:number,y:number}, rotation: number, pivot?: {x:number,y:number} }} target
 *        被驱动的显示对象（如 PIXI Container）
 * @param {object} [options] 见 EFFECT_DEFAULTS
 */
export function createUnitEffect(target, options = {}) {
  const cfg = { ...EFFECT_DEFAULTS };
  for (const k of Object.keys(EFFECT_DEFAULTS)) {
    if (options[k] !== undefined) cfg[k] = options[k];
  }
  cfg.strength = fxNum(cfg.strength, EFFECT_DEFAULTS.strength);
  cfg.spinPeriod = Math.max(0.05, fxNum(cfg.spinPeriod, EFFECT_DEFAULTS.spinPeriod));
  cfg.hopAmplitude = fxNum(cfg.hopAmplitude, EFFECT_DEFAULTS.hopAmplitude);
  cfg.tiltFactor = fxNum(cfg.tiltFactor, EFFECT_DEFAULTS.tiltFactor);
  cfg.pulsesPerSecond = Math.max(0.1, fxNum(cfg.pulsesPerSecond, EFFECT_DEFAULTS.pulsesPerSecond));

  const deform = createDeformState(options.spring || {});

  const st = {
    cfg,
    target,
    deform,
    time: 0,          // 特效自己的时钟（秒）
    pulse: -1,        // 上一次触发脉冲的序号，用于"每 1/pulsesPerSecond 秒踢一脚"
    spin: 0,          // 自转角度（弧度）
    alive: true,      // 死亡后停弹跳、继续自转
    pivotOffset: 0,   // 旋转支点相对脚底的向上偏移量（像素/世界单位）
    pivotReady: false,
    spinOrigin: 0,          // 同步自转的起始角（保持各单位一致）
    facingBack: false,      // 当前是否已换成背面（带迟滞，避免在过零处抖动）
    flipCount: 0,           // 换面次数（诊断用）
    baseRotation: 0,  // 目标对象原本的 rotation，自转叠加在它之上
    _baseCaptured: false,
  };

  st.setAlive = (alive) => { st.alive = alive === true; };
  st.setEnabled = (on) => { cfg.enabled = on === true; };

  /** 重新计算旋转支点：传入模型高度（脚底到头顶）。只做一次平移，之后位置保持不变。 */
  st.setModelHeight = (height) => {
    const h = fxNum(height, 0);
    if (!(h > 0)) return;
    // 支点取身体中部偏上一点：视觉上"腰"的位置比几何中点更像在原地转
    st.pivotOffset = h * 0.5;
    applyPivot(st);
  };

  st.setSpinPeriod = (sec) => { cfg.spinPeriod = Math.max(0.05, fxNum(sec, cfg.spinPeriod)); };

  /** 手动踢一脚（点击、落地、碰撞时用）。 */
  st.kick = (impact = 1) => { kick(deform, cfg.strength, impact); };

  /** 立刻回到静止姿态（切换开关、单位回收时用）。 */
  st.reset = () => {
    deform.squash = 0; deform.sv = 0;
    st.spin = st.spinOrigin;
    st.facingBack = false;
    apply(st);
  };

  /**
   * 每帧推进。
   * @param {number} dt 距上一帧的秒数
   * @param {number} [aliveScale] 存活时的速度倍数（可用于"行进中更欢快"之类）
   */
  st.update = (dt, aliveScale = 1, sharedPhase = null) => {
    if (!cfg.enabled) { st.reset(); return; }
    const d = Math.max(0, Math.min(fxNum(dt, 0), 0.25)); // 后台切回来时的巨大 dt 会炸弹簧
    if (d <= 0) return;

    st.time += d;

    // 弹跳相位：同步模式下用调用方给的**共享时基**（全场同相），否则用各自的 st.time。
    // 注意共享时基也要参与"每帧只推进一步"，所以它是**外部算好的相位值**，不在这里累加。
    const phase = (cfg.syncBounce && typeof sharedPhase === 'number' && Number.isFinite(sharedPhase))
      ? sharedPhase : st.time;

    const spinPhase = (cfg.syncSpin && typeof sharedPhase === 'number' && Number.isFinite(sharedPhase))
      ? sharedPhase : null;

    const spinning = cfg.spinPeriod > 0;
    if (spinning) {
      const scale = st.alive ? 1 : cfg.deadSpinScale;
      if (spinPhase !== null) {
        // 同步自转：角度由**共享相位**推导，而不是各自累加。
        // 死亡后仍继续转（`scale` 只改速率），但我们不再允许"死亡时刻不同导致相位跳变"——
        // 所以死亡时改用等比缩放而不是重新起算：旋转仍与全场同相。
        st.spin = st.spinOrigin
          + spinPhase * (2 * Math.PI / cfg.spinPeriod) * fxNum(aliveScale, 1) * scale;
      } else {
        // 自由自转（syncSpin 关闭）：各自累加。
        // 不把角度取模归一化：sin/cos 本来就不受大角度影响，而保留累加值能让
        // 调用方读到"一共转了多少"（调试、测试、以及将来接附属物摆动都用得上）。
        st.spin += d * (2 * Math.PI / cfg.spinPeriod) * fxNum(aliveScale, 1) * scale;
      }
    }

    const bouncing = st.alive || cfg.deadBounce;
    if (bouncing) {
      if (cfg.spinSmooth) {
        // **连续正弦驱动**：不再"踢一脚再等弹簧回弹"，而是让目标形变按平滑波形走。
        // 好处是帧与帧之间没有陡跳，快速脉冲下也不会看起来一顿一顿。
        //
        // 手动冲量（点击 / 落地 / 碰撞调用 kick()）在这里**要单独处理**：
        // 早期版本直接 `deform.sv = 0`，等于把手动冲量抹掉 —— 那些交互就失效了。
        // 现在把剩余速度叠加到目标上，让它自然衰减，手动冲量仍然看得见。
        const omega = 2 * Math.PI * cfg.pulsesPerSecond;
        // 深度乘上 strength，"Q弹强度"滑杆在连续模式下才有效（否则它形同虚设）
        const wave = -cfg.squashDepth * cfg.strength * (1 - Math.cos(phase * omega)) / 2;
        const manual = deform.sv * cfg.manualImpulse;   // 把残余速度换算成一点额外位移
        const target = wave + manual;
        // 同步模式下用更快的跟随：把各单位的滞后状态尽快拉到同一个值
        const follow = cfg.syncBounce && typeof sharedPhase === 'number' && Number.isFinite(sharedPhase)
          ? cfg.syncFollow : cfg.smoothFollow;
        deform.squash += (target - deform.squash) * Math.min(1, d * follow);
        // 手动冲量按弹簧自身的阻尼衰减（★ 阻尼在 `deform.opts` 里，不在 `cfg` 上 ——
        // 早先写成 `cfg.damping` 得到 undefined，一步就把 sv 变成 NaN，整支 effect 全废）
        deform.sv -= deform.opts.damping * deform.sv * d;
        if (Math.abs(deform.sv) < 1e-4) deform.sv = 0;
      } else {
        // 冲量式：每 1/pulsesPerSecond 秒踢一脚，靠欠阻尼弹簧过冲回弹（原实现）
        const idx = Math.floor(phase * cfg.pulsesPerSecond);
        if (idx !== st.pulse) {
          st.pulse = idx;
          kick(deform, cfg.strength);
        }
        stepFixed(deform, d, cfg.strength, cfg.fixedStep);
      }
    } else {
      // 死亡后让它自然收敛回静止，而不是"啪"地弹回去
      stepFixed(deform, d, cfg.strength, cfg.fixedStep);
      if (Math.abs(deform.squash) < 1e-3 && Math.abs(deform.sv) < 1e-3) {
        deform.squash = 0; deform.sv = 0;
      }
    }

    apply(st);
  };

  /** 当前离地高度（供宿主决定要不要同步影子等）。 */
  st.hop = () => (cfg.enabled && (st.alive || cfg.deadBounce)
    ? hopFor(phase, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);
  st.hopVelocity = () => (cfg.enabled && (st.alive || cfg.deadBounce)
    ? hopVelocityFor(phase, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);

  /**
   * 当前应当使用哪一面 —— 由 `cos θ` 的**符号**决定（这正是"宽度过零"的数学形式：
   * `width ∝ cos θ`），并带一个小死区做迟滞。
   *
   * 为什么需要迟滞：`cos θ` 在过零附近会反复变号，若每帧都按符号切换，就会在 90° 处
   * **疯狂来回换模型**（每次换面都是重建骨架）。参考实现取 0.04 —— 小于一帧的 |Δcos|
   * （默认周期下约 0.094），所以换面永远发生在过零后的第一帧，不会额外延后。
   *
   * @returns {'front'|'back'} 应当显示的一面
   */
  st.facingFor = () => {
    if (!cfg.enabled || cfg.spinAxis !== 'vertical') return 'front';
    const c = Math.cos(st.spin);
    const dead = cfg.flipDead;
    // 带迟滞：已经在背面时要 c > +dead 才回正面；在正面时要 c < -dead 才去背面
    if (st.facingBack) { if (c > dead) st.facingBack = false; }
    else if (c < -dead) { st.facingBack = true; }
    return st.facingBack ? 'back' : 'front';
  };

  /** 供宿主调用：记录已经完成了一次换面（统计与调试）。 */
  st.noteFlipped = () => { st.flipCount++; };

  st.state = st; // 便于调试与测试读取内部量
  return st;
}

// ---- 内部：把状态写到显示对象上 ------------------------------------------------------------

/**
 * 写回阈值：数值变化小于它就**不写**。
 *
 * ★★ 这是性能的关键，不是可选优化。PIXI 的变换有"脏"标记：一旦写入 scale / rotation，
 * 该容器**及其整棵子树**（一个单位是 Spine 骨架，子节点上百）的 world transform 就会在
 * 本次渲染里重算。无条件每帧写入 = 每帧重算所有单位的整棵子树 —— 单位一多就把主线程拖死，
 * 实测会让游戏判定"插件卡死，由服务器接管本局"。
 *
 * 阈值定在**可见精度**而不是浮点噪声：实测弹簧收敛后的残余形变约 5e-4 量级，
 * 而 0.1% 的缩放变化在任何分辨率下都看不出来 —— 所以阈值必须 ≥1e-3，
 * 否则那点残余会让每帧照写不误（这正是第一次取 1e-4 时踩的坑）。
 */
export const WRITE_EPSILON = 1e-3;

/** 差异是否小到不值得写回。形状是 `max(epsilon, epsilon·|当前值|)`。 */
function near(a, b) {
  const d = Math.abs(a - b);
  return d < WRITE_EPSILON || d < WRITE_EPSILON * Math.abs(a);
}

/** 只在真的变了才写，避免无谓地让 PIXI 标脏。 */
function writeTransform(t, sx, sy, rot) {
  if (!near(t.scale.x, sx)) t.scale.x = sx;
  if (!near(t.scale.y, sy)) t.scale.y = sy;
  if (!near(t.rotation, rot)) t.rotation = rot;
}


/**
 * 旋转支点：**默认完全不动** `pivot` / `position`。
 *
 * ============================ 两次踩坑换来的结论 ============================
 *
 * 我曾两次试图"把支点移到身体中部，让它绕腰转"，两次都把单位搞浮空了：
 *   第一次：pivot.y = +h/2 且 position.y = −h/2   → 浮空
 *   第二次：只写 pivot.y = +h/2                    → 仍然浮空
 * 两次都是我在纸面上推 PIXI 的变换语义，两次都推错。
 *
 * 而参考实现（CyanFish 的 CyanModPack，`dj-all/client/engine-pixi.js`）的逐字段表写得很清楚：
 *
 *     op / enemy / token   UnitView.body   scale free · rot free
 *     device               box.mesh / gfx  …绕 v.screen 锚点     ← 只有它设 pivot
 *
 * 也就是说：**它压根不碰单位 body 的 pivot**。只有"几何已经画在屏幕绝对坐标里"的
 * Graphics / Mesh（装置箱体、血条）才需要 `pivot` + `position` 那套补偿，而且它的写法是
 * **两者设成同一个值**（`o.pivot.set(ax,ay); o.position.set(ax,ay)`），不是一正一负。
 *
 * 所以正确做法是：**只写 `body.scale` 与 `body.rotation`，什么都不动位置。**
 * 旋转自然绕 body 自身的原点（脚底）—— 这正是它验证过的行为。
 *
 * 保留本函数是为了两件事：① 记录这个结论，避免第三次去改 pivot；
 * ② 提供 `spinPivot` 选项给确实需要绕中点转的场合（默认关闭）。
 */
function applyPivot(st) {
  const t = st.target;
  if (!t || !st.cfg.spinPivot) { st.pivotReady = true; return; }
  const y = st.pivotOffset;
  if (t.pivot && t.position) {
    // 只在显式开启时使用，且按参考实现的写法：pivot 与 position 设成同一个值。
    t.pivot.set(0, y);
    t.position.set(0, y);
  }
  st.pivotReady = true;
}

function apply(st) {
  const t = st.target;
  if (!t) return;
  if (!st._baseCaptured) { st.baseRotation = fxNum(t.rotation, 0); st._baseCaptured = true; }

  if (!st.cfg.enabled) {
    writeTransform(t, 1, 1, st.baseRotation);
    return;
  }

  const { x: sx, y: sy } = scaleFor(st.deform.squash);

  // 自转量化：把连续角度吸附到台阶上，写入次数因此从"每帧"降到"每台阶一次"。
  //
  // 推导：每秒写入次数 = steps / spinPeriod，要它等于 SPIN_WRITES_PER_SEC，
  // 于是 **steps = SPIN_WRITES_PER_SEC × spinPeriod**。
  // 周期越长，一圈可以分更多步而不增加每秒写入；下限 8 步保证慢速也别看出台阶。
  // 台阶数取 **4 的倍数**：这样 0° / 90° / 180° / 270° 必然落在网格点上，
  // 宽度能真正归零（侧对的那一帧）与真正取到 ±1（正对 / 背面）。
  // 否则 90° 会落在两格之间，宽度只压到 0.05 左右就反弹 —— 看起来"没转到位"。
  const want = Math.max(8, Math.min(st.cfg.spinStepsMax ?? 240,
    Math.round((st.cfg.spinWritesPerSec ?? SPIN_WRITES_PER_SEC) * st.cfg.spinPeriod)));
  const steps = Math.max(8, Math.round(want / 4) * 4);

  if (st.cfg.spinAxis === 'screen') {
    // 屏幕平面内转：直接写角度。台阶作用在**角度**上。
    const q = Math.round(st.spin / (2 * Math.PI) * steps) / steps * 2 * Math.PI;
    writeTransform(t, sx, sy, st.baseRotation + q);
    return;
  }

  // ============================ 绕竖轴（梗图效果）============================
  // 2D 贴图无法真的绕 Y 轴转，唯一可行的表达是**横向压扁**：
  //
  //     横向 = 原宽 × cos θ
  //
  // θ = 0 → 完整正面；θ = 90° → 宽度 0（侧对着你）；θ = 180° → cos θ = −1，
  // 宽度取负 ⇒ **自然镜像**，于是露出背面。
  //
  // ★★ 这里曾写错成 `sx * (cos θ >= 0 ? 1 : -1)` —— 只取**符号**，横向只剩 ±1 两种宽度，
  //    结果变成"瞬间左右翻"，完全没有收缩过程（玩家反馈"绕竖轴旋转没成功"）。
  //    参考实现（CyanFish CyanModPack, engine-pixi.js:429-431）是从原始 scale 出发：
  //        const x = s.sx * ctx.xK * axisK;      // axisK = 带符号的 cos θ
  //    而 frontback.js 抬头逐字写明：**横向永远用带符号的 cos θ，不做 |cos θ| 修正**。
  //
  // ★ 同一份参考还写明：**绕竖直轴不写 rotation**（只有平面内才写）。写 rotation 会让
  //   整张贴图在屏幕里倾斜，那是另一种效果，会把"轴转"的读感破坏掉。
  //
  // 台阶量化在 **角度**上、再取 cos（不是直接量化 cos 值）。
  //
  // 为什么：均匀的角度台阶给出的 cos 分布是"两端密、中间疏"——取 cos 值量化反而会在
  // 过零附近把台阶跨过头（曾出现 90° 处写成 −0.037 而不是 0，宽度没有真正归零）。
  // 量化角度则天然保证 90° 落在台阶上，宽度能真正到 0。
  const a = Math.round(st.spin / (2 * Math.PI) * steps) / steps * 2 * Math.PI;
  //
  // ★ 横向**只由 cos θ 决定**，不再乘挤压的 `sx`。
  //   曾经写成 `sx * cos θ`：而 `sx = 1/√y`，等于把挤压的横向补偿又乘了一次
  //   （横向实际变成 cos θ · 1.18），压缩被放大、且挤压的抖动直接叠在宽度上 ——
  //   转起来就"不整齐"。轴转的横向应当只有一个来源：角度。
  //   挤压在轴转模式下只作用于纵向（它本来就是"纵向压缩"，见"绕中轴旋转"的需求）。
  writeTransform(t, Math.cos(a), sy, st.baseRotation);
}
