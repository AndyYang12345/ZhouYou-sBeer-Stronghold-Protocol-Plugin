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

/** 默认参数。手感来自参考实现，自转周期也沿用它的 2.7 秒。 */
export const EFFECT_DEFAULTS = Object.freeze({
  enabled: true,
  strength: 1.15,          // Q弹强度倍数（参考实现默认 1.15）
  spinPeriod: 2.7,         // 自转一圈的秒数（参考实现默认 2.7）
  spinAxis: 'vertical',    // 'vertical' 竖轴（梗图效果）| 'screen' 屏幕平面内转
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
    st.spin = 0;
    apply(st);
  };

  /**
   * 每帧推进。
   * @param {number} dt 距上一帧的秒数
   * @param {number} [aliveScale] 存活时的速度倍数（可用于"行进中更欢快"之类）
   */
  st.update = (dt, aliveScale = 1) => {
    if (!cfg.enabled) { st.reset(); return; }
    const d = Math.max(0, Math.min(fxNum(dt, 0), 0.25)); // 后台切回来时的巨大 dt 会炸弹簧
    if (d <= 0) return;

    st.time += d;

    const spinning = cfg.spinPeriod > 0;
    if (spinning) {
      const scale = st.alive ? 1 : cfg.deadSpinScale;
      // 不把角度取模归一化：sin/cos 本来就不受大角度影响，而保留累加值能让
      // 调用方读到"一共转了多少"（调试、测试、以及将来接附属物摆动都用得上）。
      st.spin += d * (2 * Math.PI / cfg.spinPeriod) * fxNum(aliveScale, 1) * scale;
    }

    const bouncing = st.alive || cfg.deadBounce;
    if (bouncing) {
      // 脉冲与自转共用时钟，所以"压扁"会跟着自转一起走，频率上是和谐的
      const idx = Math.floor(st.time * cfg.pulsesPerSecond);
      if (idx !== st.pulse) {
        st.pulse = idx;
        kick(deform, cfg.strength);
      }
      stepFixed(deform, d, cfg.strength, cfg.fixedStep);
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
    ? hopFor(st.time, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);
  st.hopVelocity = () => (cfg.enabled && (st.alive || cfg.deadBounce)
    ? hopVelocityFor(st.time, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);

  st.state = st; // 便于调试与测试读取内部量
  return st;
}

// ---- 内部：把状态写到显示对象上 ------------------------------------------------------------

function applyPivot(st) {
  const t = st.target;
  if (!t) return;
  // 旋转支点上移 pivotOffset，同时把对象下移同样的距离 —— 视觉位置不变，但绕新的支点转
  if (t.pivot) { t.pivot.x = 0; t.pivot.y = st.pivotOffset; }
  if (t.position) t.position.y = -st.pivotOffset;
  st.pivotReady = true;
}

function apply(st) {
  const t = st.target;
  if (!t) return;
  if (!st._baseCaptured) { st.baseRotation = fxNum(t.rotation, 0); st._baseCaptured = true; }

  if (!st.cfg.enabled) {
    t.scale.x = 1; t.scale.y = 1;
    t.rotation = st.baseRotation;
    return;
  }

  const { x: sx, y: sy } = scaleFor(st.deform.squash);
  t.scale.x = sx;
  t.scale.y = sy;

  if (st.cfg.spinAxis === 'screen') {
    // 屏幕平面内转：连挤压一起转，看起来像"躺倒着打转"
    t.rotation = st.baseRotation + st.spin;
  } else {
    // 竖轴自转：2D 贴图无法真正绕 Y 轴转，这里用"水平镜像 × 侧倾"近似 ——
    // 镜像让正反面交替出现，侧倾给一点透视暗示，合起来有"转过来"的读感。
    const c = Math.cos(st.spin);
    t.scale.x = sx * (c >= 0 ? 1 : -1);
    t.rotation = st.baseRotation + st.deform.squash * st.cfg.tiltFactor + Math.sin(st.spin) * 0.12;
  }
}
