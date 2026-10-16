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
 * 自转的量化台阶（每圈多少步）。
 *
 * **和写回阈值同等重要。** 自转是**连续量**：即使阈值挡住了微小的缩放抖动，`rotation`
 * 每帧都在变，于是每帧仍要写一次 → PIXI 每帧重算该单位的整棵子树。量化成台阶后，
 * 写入频率降为 `steps / spinPeriod` 次/秒（默认 24 步 / 2.7 秒 ≈ 8.9 次/秒，
 * 而 60fps 是 60 次/秒 —— 降了约 7 倍）。
 *
 * 为什么敢量化：2D 贴图的自转本来就不是真正的立体旋转，而是"镜像 + 侧倾"的近似，
 * 观感上本来就带台阶感；24 步/圈在人眼里仍是连续转动。
 * 想要更顺滑可以调大（代价是写入更频繁），想要更省可以调小。
 */
export const SPIN_STEPS_PER_TURN = 24;

/** 默认参数。手感来自参考实现，自转周期也沿用它的 2.7 秒。 */
export const EFFECT_DEFAULTS = Object.freeze({
  enabled: true,
  strength: 1.15,          // Q弹强度倍数（参考实现默认 1.15）
  spinPeriod: 2.7,         // 自转一圈的秒数（参考实现默认 2.7）
  spinAxis: 'vertical',    // 'vertical' 竖轴（梗图效果）| 'screen' 屏幕平面内转
  spinSteps: SPIN_STEPS_PER_TURN, // 自转量化台阶（见 SPIN_STEPS_PER_TURN 的说明）
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

/**
 * 设定旋转支点。
 *
 * ★★ 这里踩过一个很显眼的坑：曾同时写 `pivot.y = +offset` 与 `position.y = -offset`，
 * 以为"两者抵消、视觉位置不变"。**错**，结果是**所有单位整体上浮半个身高**。
 *
 * 原因：PIXI 的语义是
 * ```
 * 屏幕位置 = position − pivot        （渲染时再叠加子树自己的局部坐标）
 * ```
 * `pivot` 把容器的原点**移到体内**，而 `position` 决定**那个新原点落在哪**。
 * 单位的 `body` 原本 `position = 0`、模型原点在脚底，也就是"脚底落在父坐标系原点"。
 * 要"绕身体中部转、但脚底不动"，唯一正确的做法是：
 *
 * ```
 * pivot.y = 半个身高      （原点从脚底移到中部）
 * position.y = 0         （中部依然落在父坐标系原点 —— 不动！）
 * ```
 *
 * 那时模型的脚底会落到 −half 处，由"中部在原点"等价换算出"脚底仍在原处"。
 * 再去动 `position` 就是把整体平移，必然浮空。
 */
function applyPivot(st) {
  const t = st.target;
  if (!t) return;
  if (t.pivot) { t.pivot.x = 0; t.pivot.y = st.pivotOffset; }
  // ★ 绝不碰 position：body 原本就是 0，保持它才是"位置不变"。
  st.pivotReady = true;
}

/**
 * 写回显示对象的阈值：小于这个变化就不写。
 *
 * **这是性能的关键，不是可选的优化。** PIXI 的变换有"脏"标记：一旦写入 scale / rotation，
 * 该容器（及其子树，一个单位是 spine 骨架，子节点上百）的 world transform 就会在本次渲染
 * 里重算。而单位的形变在静止段几乎是常量 —— 无条件每帧写入等于**每帧强制重算所有单位的
 * 整棵子树**，单位一多就把主线程拖死（实测会让游戏判定"插件卡死，由服务器接管本局"）。
 *
 * 加了阈值后，脉冲之间的绝大多数帧里数值没有可见变化，于是一个变换都不写，
 * PIXI 的缓存自然生效。
 */
export const WRITE_EPSILON = 1e-3;

/**
 * 是否差异小到不值得写回。
 *
 * 用**相对 + 绝对下限**而不是单一绝对值：形状是 `max(epsilon, epsilon·|当前值|)`。
 * 定这个阈值的依据是**可见精度**而不是浮点噪声 —— 0.1% 的缩放变化在任何分辨率下都看不出来，
 * 但它每帧写一次就足以让 PIXI 每帧重算整棵子树。实测弹簧收敛后的残余形变约 5e-4 量级，
 * 正好落在阈值以下（这就是这个阈值必须 ≥1e-3 的原因）。
 */
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
  // 步数**按周期缩放**，目标是"每秒写入次数大致恒定"（≈ SPIN_WRITES_PER_SEC），
  // 而不是"每圈固定步数"。
  //
  // 推导：每秒写入次数 = steps / spinPeriod，要它等于 SPIN_WRITES_PER_SEC，
  // 于是 **steps = SPIN_WRITES_PER_SEC × spinPeriod**。
  // 周期越长，一圈可以分更多步而不增加每秒写入 —— 慢速自转更顺滑，快速自转也不会失控。
  // 下限 8 步（慢速也别看出台阶）、上限 60 步（不超过 60fps，超过就没意义了）。
  const rateTarget = (st.cfg.spinSteps ?? SPIN_STEPS_PER_TURN) / 2.7; // 默认 24 步 / 2.7 秒
  const steps = Math.max(8, Math.min(60, Math.round(rateTarget * st.cfg.spinPeriod)));
  const q = Math.round(st.spin / (2 * Math.PI) * steps) / steps * 2 * Math.PI;

  if (st.cfg.spinAxis === 'screen') {
    // 屏幕平面内转：连挤压一起转，看起来像"躺倒着打转"
    writeTransform(t, sx, sy, st.baseRotation + q);
  } else {
    // 竖轴自转：2D 贴图无法真正绕 Y 轴转，这里用"水平镜像 × 侧倾"近似 ——
    // 镜像让正反面交替出现，侧倾给一点透视暗示，合起来有"转过来"的读感。
    const c = Math.cos(q);
    writeTransform(t, sx * (c >= 0 ? 1 : -1), sy,
      st.baseRotation + st.deform.squash * st.cfg.tiltFactor + Math.sin(q) * 0.12);
  }
}
