// ⚠️ 本文件由 tools/build-plugin.mjs 生成 —— 不要直接编辑。
// 源码在仓库的 src/ 下（多文件、可单测）；这里打包成单文件是游戏的硬性要求：
// trusted 插件只下发 entry.client 一个文件，相对 import 的路径一律 404。
// 改源码后运行：node tools/build-plugin.mjs


// ======== src/core/physics.js ========
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
const SPRING_DEFAULTS = Object.freeze({
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
const FIXED_STEP = 1 / 120;

const physNum = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * 一个可被弹簧驱动的形变体。
 *
 * `squash` 是形变量：**正值 = 横向变胖（被压扁）**，负值 = 被拉伸。
 * `sv` 是它的速度。两者都由调用方持有，本模块不保存状态 —— 便于测试与复用。
 */
function createDeformState(overrides = {}) {
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
function squashLimitOf(state, strength = 1) {
  const { squashLimit, limitBias, maxLimit } = state.opts;
  return Math.min(maxLimit, squashLimit * strength + limitBias);
}

/**
 * 推进一个固定步长。
 * @param {{squash:number, sv:number, opts:object}} body
 * @param {number} dt 秒（应已切成固定步长）
 * @param {number} [strength] Q弹强度倍数
 */
function springStep(body, dt, strength = 1) {
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
function kick(body, strength = 1, impact = 1) {
  const { kickScale, kickMax } = body.opts;
  body.sv -= Math.min(kickMax, kickScale * strength * impact);
}

/**
 * 把一个 dt 切成固定步长并推进。渲染循环里直接调这个，不要自己写循环。
 * @returns {number} 实际执行的步数
 */
function stepFixed(body, dt, strength = 1, fixedStep = FIXED_STEP) {
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
function scaleFor(squash) {
  const y = 1 + squash;
  // 极端值保护：y 趋近 0 时 1/sqrt(y) 会发散
  const safe = Math.max(0.35, y);
  return { x: 1 / Math.sqrt(safe), y };
}

/**
 * 离地弹跳：与脉冲同周期，起跳时正好被压扁 —— 参考实现里这个相位是调过的。
 * @param {number} phase 秒
 * @param {number} [amplitude]
 * @param {number} [perSecond] 每秒脉冲次数
 */
function hopFor(phase, amplitude = 0.115, perSecond = 2) {
  return amplitude * (1 - Math.cos(phase * 2 * Math.PI * perSecond)) / 2;
}

/**
 * hopFor 对时间的导数（用于驱动"附属物"的滞后摆动，如耳朵、衣摆）。
 *
 * 注意：`hop(t) = A(1 - cos(ωt)) / 2`，其中 `ω = 2π · perSecond`，
 * 所以导数是 `A · ω/2 · sin(ωt)` —— **不是** `A · ω · sin(ωt)`。
 * （参考实现里写的是后者，多了一个因子 2；这里按正确的导数实现。）
 */
function hopVelocityFor(phase, amplitude = 0.115, perSecond = 2) {
  const omega = 2 * Math.PI * perSecond;
  return amplitude * omega / 2 * Math.sin(phase * omega);
}

// ======== src/core/unit-effect.js ========
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
const SPIN_WRITES_PER_SEC = 30;

/** 默认参数。手感来自参考实现，自转周期也沿用它的 2.7 秒。 */
const EFFECT_DEFAULTS = Object.freeze({
  enabled: true,
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
function createUnitEffect(target, options = {}) {
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
    st.spin = 0;
    st.facingBack = false;
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
      if (cfg.spinSmooth) {
        // **连续正弦驱动**：不再"踢一脚再等弹簧回弹"，而是让目标形变按平滑波形走。
        // 好处是帧与帧之间没有陡跳，快速脉冲下也不会看起来一顿一顿。
        //
        // 手动冲量（点击 / 落地 / 碰撞调用 kick()）在这里**要单独处理**：
        // 早期版本直接 `deform.sv = 0`，等于把手动冲量抹掉 —— 那些交互就失效了。
        // 现在把剩余速度叠加到目标上，让它自然衰减，手动冲量仍然看得见。
        const omega = 2 * Math.PI * cfg.pulsesPerSecond;
        // 深度乘上 strength，"Q弹强度"滑杆在连续模式下才有效（否则它形同虚设）
        const wave = -cfg.squashDepth * cfg.strength * (1 - Math.cos(st.time * omega)) / 2;
        const manual = deform.sv * cfg.manualImpulse;   // 把残余速度换算成一点额外位移
        const target = wave + manual;
        deform.squash += (target - deform.squash) * Math.min(1, d * cfg.smoothFollow);
        // 手动冲量按弹簧自身的阻尼衰减（★ 阻尼在 `deform.opts` 里，不在 `cfg` 上 ——
        // 早先写成 `cfg.damping` 得到 undefined，一步就把 sv 变成 NaN，整支 effect 全废）
        deform.sv -= deform.opts.damping * deform.sv * d;
        if (Math.abs(deform.sv) < 1e-4) deform.sv = 0;
      } else {
        // 冲量式：每 1/pulsesPerSecond 秒踢一脚，靠欠阻尼弹簧过冲回弹（原实现）
        const idx = Math.floor(st.time * cfg.pulsesPerSecond);
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
    ? hopFor(st.time, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);
  st.hopVelocity = () => (cfg.enabled && (st.alive || cfg.deadBounce)
    ? hopVelocityFor(st.time, cfg.hopAmplitude, cfg.pulsesPerSecond) : 0);

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
const WRITE_EPSILON = 1e-3;

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

// ======== src/integrations/units.js ========
// plugin/spin-bounce/integrations/units.js — 把特效适配到游戏的 UnitView 上。
//
// 这一层是**唯一知道游戏内部结构**的地方：core/ 里的东西只认 `scale` / `rotation` / `pivot`，
// 所以核心库可以独立复用与单测；游戏改版时也只需要动这一个文件。
//
// UnitView 的结构（0.3.0 实测，public/js/render/units.js）
//   view.root ── 定位 / 可见性 / 深度排序            ← 不动
//   view.body ── 装 fallback 肖像与 actor.spine       ← 驱动它
//   view.hud  ── 血量条，挂在独立的 bars 层            ← 天然不受形变影响
// `body.scale` / `body.rotation` 在上游代码里**从未被赋值**（只有 addChild），是我们的干净挂载点。

/**
 * 判断一个 PIXI 显示对象是否是一个单位视图（UnitView）。
 *
 * ⚠️ **时序陷阱** —— 本插件最容易写错的一处。`UnitView` 的构造顺序是：
 *
 * ```
 * root = new Container();  layers.units.addChild(root);   ← 发现钩子在这里触发
 * body = new Container();  root.addChild(body);
 * …
 * hud  = new Container();  layers.bars.addChild(hud);     ← hud 比 root 入层更晚
 * ```
 *
 * 所以在「root 入层」那一刻若要求 `body && root && hud` 三者俱全，会**太早**而全部漏掉
 * （实测表现：面板状态一直是"已挂钩，等待单位"，而单位明明在场）。
 *
 * 因此判定只要 `body`（那时已存在）：`body.scale` 可写是 UnitView 独有的特征 ——
 * 同一个 units 层里的道具没有 `body`。
 */
function looksLikeUnitView(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const body = obj.body;
  if (!body) return false;
  // 不要求 body.children 是数组，也不要求 hud 存在：
  // 这两个字段的创建时机都比"body 被挂上"更晚，要求它们会把单位漏掉。
  return !!body.scale && typeof body.scale === 'object';
}

/** 敌方单位转得略快一点，呼应"边行进边弹跳自转"。 */
const ENEMY_SPIN_FACTOR = 0.85;

/** 从设置里取出适用于这个单位的特效参数。 */
function optionsFor(view, effectSettings) {
  return {
    ...effectSettings,
    spinPeriod: effectSettings.spinPeriod * (view?.isEnemy ? ENEMY_SPIN_FACTOR : 1),
  };
}

/**
 * 为一个单位建特效实例。
 * @param {object} view UnitView
 * @param {object} effectSettings `settings.effect`
 */
function attachEffect(view, effectSettings) {
  if (!view?.body) return null;
  return createUnitEffect(view.body, optionsFor(view, effectSettings));
}

/**
 * 量出模型高度，用来把旋转支点放到身体中部。
 *
 * 为什么不设支点会难看：`body` 的原点在脚底，直接 `rotation` 会让单位像钟摆一样
 * 以脚为轴甩出去，而不是"在原地转"。
 *
 * @returns {number} 量到的高度；量不到返回 0（调用方据此保持原布局不动）
 */
function measureModelHeight(view) {
  let h = 0;
  const spine = view?.actor?.spine;
  if (spine) {
    if (typeof spine.height === 'number' && spine.height > 0) h = spine.height;
    else if (typeof spine.skeleton?.data?.height === 'number') h = spine.skeleton.data.height;
  }
  if (!(h > 0) && typeof view?.fallback?.height === 'number') h = view.fallback.height;
  return h > 0 ? h : 0;
}

/**
 * 每帧驱动一个单位。
 *
 * @param {object} view
 * @param {object} fx 特效实例
 * @param {number} dt 秒
 */
/**
 * 支点测量的重试预算。
 *
 * 为什么要设上限：`measureModelHeight` 要读 Spine 的内部尺寸，而模型是**异步加载**的，
 * 在它就绪前每一帧都测一次是纯浪费；如果模型永远量不到（尺寸异常、结构不同），
 * 那就是**每帧一次的无用功**，会把主线程拖慢。
 */
const PIVOT_TRIES_MAX = 20;

function driveUnit(view, fx, dt) {
  // 模型可能刚加载完（之前量不到高度），重试若干次即可，不做无上限的每帧测量
  if (!fx.state.pivotReady) {
    fx.state.pivotTries = (fx.state.pivotTries || 0) + 1;
    if (fx.state.pivotTries <= PIVOT_TRIES_MAX) {
      const h = measureModelHeight(view);
      if (h > 0) fx.setModelHeight(h);
    }
  }

  // 死亡：停弹跳、继续自转（本插件的明确行为）
  const dying = view.dying === true || view.dead === true;
  fx.setAlive(!dying);

  // 行进中单位是否转得更快 —— **默认倍数 1（全场转速一致）**。
  // 曾硬编码 1.15，导致场上"走着的比站着的快"，转起来参差、不整齐。
  // 想要那种"行进更欢快"的效果可以把 movingSpeedScale 调大。
  const mul = typeof fx.state.cfg.movingSpeedScale === 'number' ? fx.state.cfg.movingSpeedScale : 1;
  const moving = mul !== 1 && typeof view.speed === 'number' && view.speed > 0 ? mul : 1;
  fx.update(dt, moving);

  // 转身换面：横向压缩只是"看起来翻过来"，换成**真正的背面资产**才像在绕竖轴转。
  //
  // 死亡时**主动退回正面**：135 个背面骨架里只有 4 个自带 Die 剪辑，其余必须用正面播死亡，
  // 否则会卡在背面没有死亡动画（宿主随后自己也会按 `_wantsBack()` 退回，但那时已经晚了一帧）。
  if (dying) restoreFacing(view);
  else applyFacing(view, fx);
}

// ---- 转身换面（正 / 背）--------------------------------------------------------
//
// 光靠"横向镜像"只能做出"翻过来"的观感；**换成真正的背面资产**才像在绕竖轴转。
// 宿主提供了 `view.setDir(dir)`：原地换骨架（`_syncModel → _loadSpine → _acquireSpine`），
// 中间不闪占位钻石（`public/js/render/units.js:1269`）。
//
// 这一节的判据与禁区照搬 CyanFish 的 CyanModPack（`dj-all/client/frontback.js`）——
// 那是服主逐轮实测调过的定稿，它踩过的坑我不必再踩一遍。

/** `shared/constants.js` —— 宿主 `_baseFromAnim()` 用的同一组常量。 */
const ANIM_STUN = 5;
/** UF.STUNNED | UF.FROZEN | UF.SLEEP —— 宿主把这三位等同成一个 'stun' 静息态。 */
const UF_CONTROL = 2 | 4 | 256;

/**
 * 视图此刻处于**晕眩 / 冻结 / 沉睡**吗（逐字复刻宿主 `_baseFromAnim()` 的判据）。
 *
 * 为什么这三位要单独挡：宿主把它们等同成一个 `'stun'` 静息态，而那是**动画模式**
 * （还可能冻住姿态）。此刻换模型 = 替宿主在强控中途 `_dropActor()` + 异步重建 SpineActor
 * ⇒ 渲染丢失 / 只渲染一半。参考实现的服主实测过，所以**期间一个字节都不碰**。
 */
function isControlView(v) {
  if (!v || typeof v !== 'object') return false;
  if ((typeof v.anim === 'number' ? v.anim : 0) === ANIM_STUN) return true;
  return ((typeof v.flags === 'number' ? v.flags : 0) & UF_CONTROL) !== 0;
}

/**
 * 这个视图现在**能不能**换面（不能就一个字节都不写）。
 *
 * 禁区逐条：
 *   · 已销毁 / 模型还没就绪 / 精灵还在加载中
 *   · 倒地、死亡、淡出：135 个 Back 骨架里只有 4 个自带 Die 剪辑，其余必须退回 Front 播死亡
 *     ⇒ 决定权完全留给宿主（它下一帧会自己按 `_wantsBack()` 退回正面）
 *   · 强控（晕眩 / 冻结 / 沉睡）：见 isControlView
 *   · 备战盘与预览栏（`view.prep`）：那里 `dir` 是玩家正在编辑的部署方向，宿主每次同步会重设
 *   · 替身 / 形态（`view.form`）：形态切换有自己的模型逻辑
 *   · 没有背面资产：用**宿主自己的判据** `ctx.assets.hasBack(id)`，绝不猜路径
 *   · 敌人：`setDir` 对敌人本就是 no-op（宿主第一行就 return），这里也一并挡掉
 */
function canFlip(v) {
  if (!v || v.destroyed || !v.actor || !v.spineReady) return false;
  if (v.isEnemy || v.prep || v.form) return false;
  if (v.dying === true || v.dead === true || v.alive === false) return false;
  if (isControlView(v)) return false;
  if (v._spineBusy) return false;              // 正在换骨架，别叠第二次
  const assets = v.ctx && v.ctx.assets;
  const id = v.info && (v.info.spine || v.info.defId);
  if (!assets || typeof assets.hasBack !== 'function' || !id || !assets.hasBack(id)) return false;
  return true;
}

/**
 * 按特效的判定换到正面或背面。
 *
 * ★ `setDir()` 会顺手写 `dir` / `facing` / `visFacing` / `hasDir` —— 后三个是**朝向指示**
 * （地面那个橙色 ›、阻挡标记画在哪侧），不是模型。所以调完要**逐值还原**，
 * 否则玩家的朝向指示会被我们改掉。
 *
 * @returns {boolean} 是否真的换了
 */
function applyFacing(view, fx) {
  if (!fx || typeof fx.facingFor !== 'function') return false;
  const want = fx.facingFor();                 // 'front' | 'back'，带迟滞
  const wantBack = want === 'back';
  if (wantBack === (view._sbFacingBack === true)) return false;   // 已经是这一面
  if (!canFlip(view)) return false;

  // 记下会被 setDir 改写的朝向指示
  const prev = { facing: view.facing, visFacing: view.visFacing, hasDir: view.hasDir };
  try {
    view.setDir(wantBack ? 'UP' : 'RIGHT');
  } catch (err) {
    console.warn('[spin-bounce] 换面失败（不影响游戏）', err);
    return false;
  }
  // 逐值还原朝向指示：我们只换模型，不动朝向
  if (prev.facing !== undefined) view.facing = prev.facing;
  if (prev.visFacing !== undefined) view.visFacing = prev.visFacing;
  if (prev.hasDir !== undefined) view.hasDir = prev.hasDir;

  view._sbFacingBack = wantBack;
  fx.noteFlipped();
  return true;
}

/** 还原到正面（停用特效 / 离开对局时用）。 */
function restoreFacing(view) {
  if (!view || view.destroyed || view.isEnemy || !view.actor) return;
  if (view._sbFacingBack !== true) return;
  const prev = { facing: view.facing, visFacing: view.visFacing, hasDir: view.hasDir };
  try { view.setDir('RIGHT'); } catch { /* ignore */ }
  if (prev.facing !== undefined) view.facing = prev.facing;
  if (prev.visFacing !== undefined) view.visFacing = prev.visFacing;
  if (prev.hasDir !== undefined) view.hasDir = prev.hasDir;
  view._sbFacingBack = false;
}

// ======== src/integrations/host.js ========
// src/integrations/host.js — 通过**宿主自己暴露的调试抓手**访问渲染层。
//
// ============================ 为什么不用挂钩原型 ============================
//
// 我最初的实现是包装 `PIXI.Container.prototype.addChild`，从场景图里"猜"出哪个容器是单位。
// 那条路连踩三个坑：
//   1. UnitView 构造时 `layers.units.addChild(this.root)` 发生在 `this.body` 赋值**之前**，
//      在那一刻判断 `view.body` 永远为 undefined；
//   2. `view.root` **就是 view 自己**（视图对象本身继承 Container），把它当成"装载 root 的容器"
//      会把 root 误认成单位；
//   3. 即便认对了，"单位"其实来自**三处**：战斗 `views`、预览栏 `penViews`、首领 `leader.view` ——
//      遍历单个容器天然覆盖不全。
//
// 而宿主**本来就给了正式抓手**（dev/E2E 用，只读）：
//
//   public/js/ui/fieldHost.js:287   globalThis.__SP_VIEW__ = view;        // guardView 包过的壳
//   public/js/render/app.js:2191    debug: { app, views, penViews, get leader(), tiles, fx, ctx, … }
//
// `__SP_VIEW__.raw` 就是那个含 `debug` 的真视图。这是**官方接缝**，可靠性远高于猜场景图。
//
// 这一节的做法参考了 CyanFish 的 Stronghold-Protocol-CyanModPack（`dj-all/client/engine-pixi.js`
// 的 resolveHost / eachView / collectUnits）—— 它做的是同类效果（压扁 + 旋转），
// 并且给出了逐字段的宿主覆写矩阵（见下）。

/** 找抓手的轮询间隔（ms）。视图随对局生命周期来去匆匆 ⇒ 必须有独立心跳重新解析。 */
const DISCOVER_MS = 200;

/**
 * 解析宿主抓手。任何一步拿不到就返回 null（调用方静默降级，绝不抛）。
 *
 * @param {object} [g] globalThis 替身，便于单测
 */
function resolveHost(g = globalThis) {
  try {
    const safe = g ? g.__SP_VIEW__ : null;
    if (!safe) { hostCache.key = null; hostCache.val = null; return null; }
    const raw = safe.raw && typeof safe.raw === 'object' ? safe.raw : safe;
    const dbg = raw.debug;
    const views = dbg && dbg.views;
    if (!views || typeof views.values !== 'function') { hostCache.key = null; hostCache.val = null; return null; }

    // 复用上一次的结果：这个函数**每帧**都会被调用，而它的产物在一次对局里是稳定的。
    // 用 `views` 的**实例同一性**判断缓存是否还有效 —— 换对局时游戏会换一个 Map。
    if (hostCache.key === views && hostCache.val) return hostCache.val;

    const app = dbg.app;
    const ticker = app && app.ticker
      && typeof app.ticker.add === 'function' && typeof app.ticker.remove === 'function'
      ? app.ticker : null;
    const host = {
      raw,
      views,
      penViews: dbg.penViews && typeof dbg.penViews.values === 'function' ? dbg.penViews : null,
      get leader() { try { return dbg.leader; } catch { return null; } },   // getter：首领随时换人，必须现读
      fx: dbg.fx || null,
      ticker,
    };
    hostCache.key = views;
    hostCache.val = host;
    return host;
  } catch {
    hostCache.key = null;
    hostCache.val = null;
    return null;
  }
}

/** resolveHost 的缓存槽（避免每帧重建对象）。 */
const hostCache = { key: null, val: null };

/**
 * 遍历"所有可能出现单位视图的地方"。
 *
 * 三处缺一不可：战斗/备战 `views`、整备区预览栏 `penViews`、首领 `leader.view`。
 * 只遍历 views 会漏掉预览栏里的干员和首领。
 */
function eachView(host, fn) {
  if (!host) return;
  try {
    if (host.views) for (const v of host.views.values()) fn(v);
    if (host.penViews) for (const v of host.penViews.values()) fn(v);
    const lv = host.leader;
    if (lv && lv.view) fn(lv.view);
  } catch (err) {
    console.warn('[spin-bounce] 遍历视图出错（不影响游戏）', err);
  }
}

/** 视图是否还能安全操作（未被销毁、身体与缩放都在）。 */
function hasBody(v) {
  return !!(v && !v.destroyed && v.body && v.body.scale);
}

/**
 * "模型加载完"的门：没加载完的视图只算 pending，不动它。
 *
 * 为什么必须等：`body` 里先是占位肖像，Spine 模型是异步换上去的。在模型就绪前改 transform，
 * 量到的尺寸与真实模型不符（支点会错），而且换模型的瞬间会被覆盖一次。
 */
function modelReady(v) {
  return !!(v && v.actor && v.spineReady && v.actor.spine);
}

/** 单位视图的 kind（渲染层就能拿到）。 */
function kindOf(v) {
  return v && v.info && typeof v.info.kind === 'string' ? v.info.kind : '';
}

/**
 * 收集当前所有可操作的单位视图。
 * @returns {Array<object>}
 */
function collectUnits(host) {
  const out = [];
  eachView(host, (v) => {
    if (!hasBody(v) || !modelReady(v)) return;
    if (!looksLikeUnitView(v)) return;
    out.push(v);
  });
  return out;
}

// ======== src/integrations/audio.js ========
// integrations/game-audio.js — 自定义音乐的播放控制。
//
// ============================ 为什么音乐不能走插件 ============================
//
// 0.3.0 的插件沙箱对音频是**彻底封闭**的，这不是配置问题，是三重设计约束叠加：
//
//   1. UI 插件 iframe 的响应头是
//        default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
//        img-src 'self' data: blob:; connect-src 'none'; sandbox allow-scripts; ...
//      注意：**没有 `media-src`**。CSP 里 media-src 缺失时会回落到 `default-src 'none'`，
//      所以 `<audio>` / `<video>` 一律被拦。
//   2. `connect-src 'none'` 断掉了 `fetch` / XHR / WebSocket，插件连自己的音频文件都取不回来。
//   3. iframe 是 `sandbox="allow-scripts"` **且没有 `allow-same-origin`** → 不透明来源，
//      即使 CSP 放开，同源相对路径也只是另一个跨源请求。
//
// 顺带也说清了为什么 `script`/`trusted` 类也救不了场：trusted 段是 `.js`（能在主页面跑），
// 但它默认关闭、需要服主 pin + 每个玩家逐个同意，公网反代还要 `trusted-force`；
// 拿它来放一首歌，负担与收益完全不成比例。
//
// ============================ 可行的三条路 ============================
//
// A. **游戏自己的音频系统**（最正确，需要上游配合）：BGM 是数据驱动的 ——
//      `bgmKeyFor(route, pub, track)` 决定 key，`resolveBgm(manifest, key)` 从
//      `manifest.audio.bgm[key]` 取出 `{intro, loop}`，再由 `AudioManager.playBgm()` 播放。
//    所以只要让 `manifest.audio` 能指向插件带的音频，就**自动继承音量滑杆、静音、
//    后台暂停、淡入淡出**这些既有能力 —— 比自建 `<audio>` 好得多。
//    数据来源是 `data/assets.json`，而它是 `skip_render` 之外的普通静态文件。
//
// B. **插件作为"素材提供者"**（已经能用，无需上游改动）：`cosmetic` 类插件可以带
//    `.mp3` / `.ogg`（见 shared/plugins/manifest.js 的 PERMISSIONS / 文件类型表），
//    并且是通过 `/p/<id>/<hash8>/<path>` 这个**普通静态路由**下发的 —— 那个路由
//    **不带** UI_FRAME_CSP。所以主页面可以直接 `<audio src="/p/<id>/<hash8>/music.mp3">`。
//    这条路的限制是：主页面得知道那个 URL，也就是仍要一处极小改动去接线。
//
// C. **本插件自包含**（当前采用）：trusted 插件运行在**主页面**里，没有那条 iframe CSP，
//    所以可以直接建 <audio> 播放。音源按优先级取：
//      1. 插件自带的音频（随插件由服务器下发）
//      2. `<html data-sp-spin-music="...">` 指定的路径（便于换用自己的歌）
//    好处是零依赖、离线可用、不动游戏任何文件；代价是它独立于游戏音频系统，
//    **音量要与游戏 BGM 手动协调**（详见 README「音乐」一节）。
//
// 我们向上游提的 issue/PR 就是请官方采纳 A（见 docs/upstream-audio-proposal.md）。

/** 音乐元素的默认 id（由补丁注入到 index.html）。 */
const MUSIC_ELEMENT_ID = 'sp-spin-music';
/** 音源路径写在 <html> 的这个属性上，便于换歌不用改代码。 */
const MUSIC_SOURCE_ATTR = 'data-sp-spin-music';

/**
 * 约定的部署路径（按顺序探测，第一个能用的胜出）。
 *
 * 音乐文件**不在仓库里**：它有自己的版权，体积也大。部署者把它放进游戏目录即可 ——
 * 放在这任一个位置就能被自动找到，不必改任何代码或属性。
 *
 * 注意这些路径由游戏的静态服务直接下发（`public/` 是静态目录），与插件沙箱无关 ——
 * trusted 插件运行在主页面，没有那条 iframe CSP。
 */
const MUSIC_CANDIDATES = Object.freeze([
  '/sp-music/spin-bounce.m4a',
  '/sp-music/spin-bounce.mp3',
  '/sp-music/spin-bounce.ogg',
  '/sp-music/music.m4a',
  '/sp-music/music.mp3',
]);

const AUDIO_DEFAULTS = Object.freeze({
  enabled: false,     // **默认关闭**：自动播放会被浏览器拦，且没理由一进页面就吵
  volume: 0.55,       // 独立音量；与游戏 BGM 各管各的
  loop: true,
  fadeMs: 600,        // 开/关时淡入淡出，避免"啪"地一声
});

const audNum = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);

/**
 * 创建音乐控制器。
 *
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {string} [opts.elementId]
 * @param {string} [opts.src] 显式音源；省略时读 `<html data-sp-spin-music>`
 */
function createMusicController(opts = {}) {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const cfg = { ...AUDIO_DEFAULTS, ...(opts.settings ?? {}) };
  const state = {
    cfg,
    el: null,
    src: opts.src ?? null,
    ready: false,
    blocked: false,     // 被自动播放策略拦下
    playing: false,
    fadeTimer: 0,
  };

  /**
   * 音源候选路径，按优先级：
   *   1. 显式传入的 `opts.src`
   *   2. `<html data-sp-spin-music="...">`（便于换歌不改代码）
   *   3. 约定的部署路径（见 MUSIC_CANDIDATES）
   *
   * 为什么是**候选列表**而不是单个路径：音乐文件不在本仓库里（版权与体积），
   * 由部署者放进游戏目录。探测几个约定位置比要求改 HTML 属性省事得多 ——
   * 放好文件就能用，换歌也只是换个文件名。
   */
  state.sources = () => {
    const out = [];
    if (state.src) out.push(state.src);
    try {
      const attr = doc?.documentElement?.getAttribute(MUSIC_SOURCE_ATTR);
      if (attr) out.push(attr);
    } catch { /* ignore */ }
    for (const c of MUSIC_CANDIDATES) if (!out.includes(c)) out.push(c);
    return out;
  };

  /** 上一次解析的结果（面板显示用）。 */
  state.resolved = null;

  /**
   * 依次探测候选路径，返回第一个真正能解码播放的。
   *
   * 用 `canplay` 事件而不是 fetch：同源静态文件的 HEAD 未必被支持，
   * 而 `<audio>` 自身的加载事件就是最真实的可用性判断。
   */
  state.probe = () => new Promise((resolve) => {
    if (!doc) return resolve(null);
    const list = state.sources();
    if (!list.length) return resolve(null);
    let i = 0;
    const tryNext = () => {
      if (i >= list.length) return resolve(null);
      const src = list[i++];
      const probe = doc.createElement('audio');
      probe.preload = 'metadata';
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeAttribute('src');
        try { probe.load(); } catch { /* ignore */ }
        if (ok) { state.resolved = src; resolve(src); } else tryNext();
      };
      // 6 秒够一次本地静态请求；超时按不可用处理，继续试下一个
      const timer = setTimeout(() => done(false), 6000);
      probe.addEventListener('canplaythrough', () => done(true), { once: true });
      probe.addEventListener('loadedmetadata', () => done(true), { once: true });
      probe.addEventListener('error', () => done(false), { once: true });
      probe.src = src;
    };
    tryNext();
  });

  state.ensureElement = () => {
    if (state.el) return state.el;
    if (!doc) return null;
    let el = opts.elementId ? doc.getElementById(opts.elementId) : null;
    if (!el) el = doc.getElementById(MUSIC_ELEMENT_ID);
    if (!el) {
      const src = state.resolved || state.resolveSrc();
      if (!src) return null;
      el = doc.createElement('audio');
      el.id = MUSIC_ELEMENT_ID;
      el.loop = cfg.loop !== false;
      el.preload = 'none';        // 默认关闭 → 不该预加载，省玩家流量
      el.src = src;
      doc.body?.appendChild(el);
    }
    el.loop = cfg.loop !== false;
    el.volume = audNum(cfg.volume, AUDIO_DEFAULTS.volume);
    state.el = el;
    state.ready = true;
    return el;
  };

  /** 单一路径的直读（保留给已注入 <audio> 的场景）。 */
  state.resolveSrc = () => {
    if (state.src) return state.src;
    if (!doc?.documentElement) return null;
    return doc.documentElement.getAttribute(MUSIC_SOURCE_ATTR) || null;
  };

  /** 淡入到目标音量。 */
  const fadeTo = (target, ms) => {
    const el = state.el;
    if (!el) return;
    const from = el.volume;
    const dur = Math.max(0, audNum(ms, cfg.fadeMs));
    if (dur === 0 || typeof requestAnimationFrame !== 'function') { el.volume = target; return; }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      const k = Math.min(1, ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / dur);
      el.volume = from + (target - from) * k;
      if (k < 1) state.fadeTimer = requestAnimationFrame(step);
    };
    state.fadeTimer = requestAnimationFrame(step);
  };

  /**
   * 尝试开始播放。
   *
   * **必须在用户手势里调用**（点击、按键）。浏览器会拒绝非手势触发的音频播放；
   * 被拒时本函数不抛异常，而是把 `blocked` 置真，调用方可以据此提示玩家再点一次。
   */
  state.play = async () => {
    if (cfg.enabled !== true) return false;
    // 还没解析出音源就先探测（按候选路径逐个试），避免"开关打开了却没声音"
    if (!state.resolved && !state.el) {
      await state.probe();
    }
    const el = state.ensureElement();
    if (!el) return false;
    try {
      fadeTo(0, 0);
      await el.play();
      state.playing = true;
      state.blocked = false;
      fadeTo(audNum(cfg.volume, AUDIO_DEFAULTS.volume), cfg.fadeMs);
      return true;
    } catch (err) {
      state.playing = false;
      // NotAllowedError = 自动播放策略；其他错误（格式、404）也一并静默
      state.blocked = err?.name === 'NotAllowedError';
      return false;
    }
  };

  state.pause = () => {
    const el = state.el;
    if (!el) return;
    if (state.fadeTimer && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.fadeTimer);
    state.fadeTimer = 0;
    try { el.pause(); } catch { /* 忽略 */ }
    state.playing = false;
  };

  state.setEnabled = (on) => {
    cfg.enabled = on === true;
    if (!cfg.enabled) state.pause();
  };

  state.setVolume = (v) => {
    cfg.volume = Math.max(0, Math.min(1, audNum(v, cfg.volume)));
    if (state.el && state.playing) state.el.volume = cfg.volume;
  };

  /** 首次用户手势时调用一次：若设置里已开启，则开始播放。 */
  state.armAutoStart = () => {
    if (!doc) return;
    const once = () => {
      doc.removeEventListener('pointerdown', once, true);
      doc.removeEventListener('keydown', once, true);
      if (cfg.enabled) state.play();
    };
    doc.addEventListener('pointerdown', once, true);
    doc.addEventListener('keydown', once, true);
  };

  state.state = state;
  return state;
}

// ======== src/integrations/panel.js ========
// plugin/spin-bounce/integrations/panel.js — 插件自己的设置面板。
//
// 为什么不去改游戏的设置弹窗：那是 Preact 渲染的（`public/js/ui/settings.js` 的 `Modal`），
// 往里注入 DOM 会和框架的 diff 打架（重渲染时被抹掉）。独立悬浮面板既不动随包文件，
// 也不会与任何渲染框架冲突 —— 而且卸载时删得干净。
//
// 样式全部加 `sbp-` 前缀并使用内联样式表，避免与游戏 CSS 撞名。

const PANEL_ID = 'sbp-panel';
const BUTTON_ID = 'sbp-button';
const STYLE_ID = 'sbp-style';

const CSS = `
#${BUTTON_ID}{position:fixed;right:.42rem;bottom:.42rem;z-index:9998;height:.42rem;min-width:.42rem;
  padding:0 .14rem;border-radius:99px;border:1px solid rgba(78,216,175,.55);background:rgba(16,20,18,.88);
  color:#4ed8af;font:600 12px/1 "Noto Sans SC",system-ui,sans-serif;cursor:pointer;
  display:flex;align-items:center;gap:.06rem;backdrop-filter:blur(4px);
  box-shadow:0 .04rem .16rem rgba(0,0,0,.45)}
#${BUTTON_ID}::before{content:"弹";font-size:14px}
#${BUTTON_ID} i{font-style:normal;opacity:.75;font-size:10px}
#${BUTTON_ID}:hover{border-color:#4ed8af;background:rgba(16,20,18,.95)}
#${PANEL_ID}{position:fixed;right:.5rem;bottom:1.15rem;z-index:9999;width:3.4rem;padding:.22rem .26rem;
  background:rgba(12,16,14,.96);border:1px solid #2f3a35;border-radius:.12rem;color:#c3cbc7;
  font:12px/1.5 "Noto Sans SC",system-ui,sans-serif;backdrop-filter:blur(6px);
  box-shadow:0 .08rem .3rem rgba(0,0,0,.5)}
#${PANEL_ID}[hidden]{display:none}
#${PANEL_ID} h3{margin:0 0 .14rem;font-size:13px;color:#f2f2f2;letter-spacing:.04em;font-weight:600}
#${PANEL_ID} .sbp-row{display:flex;align-items:center;justify-content:space-between;gap:.12rem;margin:.1rem 0}
#${PANEL_ID} label{flex:1;min-width:0}
#${PANEL_ID} small{display:block;color:#8a948f;font-size:10px;line-height:1.35}
#${PANEL_ID} input[type=range]{width:1.5rem;flex:none}
#${PANEL_ID} output{flex:none;width:.62rem;text-align:right;font-variant-numeric:tabular-nums;color:#4ed8af}
#${PANEL_ID} .sbp-sw{flex:none;width:.42rem;height:.2rem;border-radius:99px;border:1px solid #3e4b45;
  background:#1e2421;position:relative;cursor:pointer;padding:0;transition:background .18s}
#${PANEL_ID} .sbp-sw::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#5d6863;transition:transform .18s,background .18s}
#${PANEL_ID} .sbp-sw[aria-checked=true]{background:rgba(78,216,175,.25);border-color:#4ed8af}
#${PANEL_ID} .sbp-sw[aria-checked=true]::after{transform:translateX(16px);background:#4ed8af}
#${PANEL_ID} .sbp-sub{margin:.12rem 0 0;padding:.1rem 0 0;border-top:1px solid #2f3a35}
#${PANEL_ID} .sbp-sub[hidden]{display:none}
#${PANEL_ID} .sbp-note{margin:.1rem 0 0;color:#8a948f;font-size:10px;line-height:1.4}
#${PANEL_ID} select{background:#1e2421;color:#c3cbc7;border:1px solid #3e4b45;border-radius:.06rem;
  font:inherit;padding:2px 4px;flex:none}
`;

const ensureStyle = (doc) => {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head?.appendChild(s);
};

const el = (doc, tag, props = {}) => Object.assign(doc.createElement(tag), props);

function row(doc, labelText, hintText) {
  const r = el(doc, 'div', { className: 'sbp-row' });
  const l = el(doc, 'label', { textContent: labelText });
  if (hintText) l.appendChild(el(doc, 'small', { textContent: hintText }));
  r.appendChild(l);
  return r;
}

function toggle(doc, checked, onToggle) {
  const b = el(doc, 'button', { className: 'sbp-sw', type: 'button' });
  b.setAttribute('role', 'switch');
  const sync = (v) => {
    b.setAttribute('aria-checked', String(!!v));
    b.setAttribute('aria-label', v ? '已开启' : '已关闭');
  };
  sync(checked);
  b.addEventListener('click', () => { const v = b.getAttribute('aria-checked') !== 'true'; sync(v); onToggle(v); });
  return { node: b, sync };
}

function slider(doc, { min, max, step, value, format }, onInput) {
  const wrap = el(doc, 'div', { className: 'sbp-row' });
  const input = el(doc, 'input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el(doc, 'output', { textContent: format(value) });
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = format(v); onInput(v); });
  wrap.appendChild(input);
  wrap.appendChild(out);
  return { node: wrap, input, out };
}

/**
 * 挂载插件设置面板。
 *
 * @param {object} o
 * @param {Document} o.doc
 * @param {object} o.settings 当前设置（会被读取；改动通过 onChange 回传）
 * @param {object} [o.music] 音乐控制器（用于开关时立即播放/暂停）
 * @param {(next:object)=>void} o.onChange
 */
function attachSettingsPanel(o) {
  const doc = o.doc ?? document;
  const settings = o.settings;
  if (!doc?.body) return null;
  ensureStyle(doc);

  // --- 入口按钮
  let button = doc.getElementById(BUTTON_ID);
  if (!button) {
    button = el(doc, 'button', { id: BUTTON_ID, type: 'button', title: '弹跳自转设置（点击展开）' });
    button.appendChild(el(doc, 'i', { textContent: '设置' }));
    doc.body.appendChild(button);
  }

  // --- 面板
  let panel = doc.getElementById(PANEL_ID);
  if (panel) panel.remove();          // 重建，避免旧闭包引用过期设置
  panel = el(doc, 'div', { id: PANEL_ID });
  panel.hidden = true;

  panel.appendChild(el(doc, 'h3', { textContent: '弹跳自转' }));

  // 状态行：让玩家一眼看出插件有没有在工作（而不是靠猜）
  const statusLine = el(doc, 'p', { className: 'sbp-note', textContent: '状态：读取中…' });
  const refreshStatus = () => {
    if (typeof o.status !== 'function') { statusLine.textContent = ''; return; }
    try {
      const st = o.status() || {};
      statusLine.textContent = st.degraded
        ? '状态：已自动关闭（每帧耗时过高）'
        : !st.hooked ? '状态：等待进入对局（渲染器未加载）'
          : !st.layer ? '状态：已挂钩，等待单位'
            : `状态：运行中 · ${st.units} 个单位`;
    } catch { statusLine.textContent = ''; }
  };
  refreshStatus();
  const statusTimer = setInterval(refreshStatus, 1000);
  panel.appendChild(statusLine);

  const eff = toggle(doc, settings.effect.enabled, (v) => {
    settings.effect.enabled = v;
    music?.setEnabled?.(v && settings.music.enabled);
    sub.hidden = !v;
    musicRow.hidden = !v;
    o.onChange?.(settings);
  });
  const effRow = row(doc, '弹跳自转', '单位在格子里压扁回弹并自转');
  effRow.appendChild(eff.node);
  panel.appendChild(effRow);

  // 音乐开关：**只在特效开启时展示**（用户要求）
  const mus = toggle(doc, settings.music.enabled, async (v) => {
    settings.music.enabled = v;
    music?.setEnabled?.(v);
    if (v) {
      // 必须在用户手势里调用 —— 这个点击就是手势
      const ok = await music?.play?.();
      if (ok === false && music?.state?.blocked) {
        note.textContent = '浏览器拦截了自动播放，请再点一次音乐开关。';
      } else {
        note.textContent = '';
      }
    } else {
      music?.pause?.();
      note.textContent = '';
    }
    o.onChange?.(settings);
  });
  const musicRow = row(doc, '自定义音乐', '独立于游戏 BGM；需自备音频文件');
  musicRow.appendChild(mus.node);
  panel.appendChild(musicRow);

  // --- 细节（折叠在特效开关之下）
  const sub = el(doc, 'div', { className: 'sbp-sub' });
  sub.hidden = !settings.effect.enabled;

  const strength = slider(doc, {
    min: 0.3, max: 1.8, step: 0.05, value: settings.effect.strength,
    format: (v) => `${v.toFixed(2)}×`,
  }, (v) => { settings.effect.strength = v; o.onChange?.(settings); });
  const strengthRow = row(doc, 'Q弹强度', '越大压得越扁');
  strengthRow.appendChild(strength.node);
  sub.appendChild(strengthRow);

  const period = slider(doc, {
    min: 0.8, max: 12, step: 0.1, value: settings.effect.spinPeriod,
    format: (v) => `${v.toFixed(1)}s`,
  }, (v) => { settings.effect.spinPeriod = v; o.onChange?.(settings); });
  const periodRow = row(doc, '自转周期', '转一圈的秒数');
  periodRow.appendChild(period.node);
  sub.appendChild(periodRow);

  const smooth = slider(doc, {
    min: 8, max: 90, step: 1, value: settings.effect.spinWritesPerSec,
    format: (v) => `${v}/s`,
  }, (v) => { settings.effect.spinWritesPerSec = v; o.onChange?.(settings); });
  const smoothRow = row(doc, '自转顺滑度', '每秒刷新次数；调高更顺、更耗性能');
  smoothRow.appendChild(smooth.node);
  sub.appendChild(smoothRow);

  const continuous = toggle(doc, settings.effect.spinSmooth, (v) => {
    settings.effect.spinSmooth = v; o.onChange?.(settings);
  });
  const contRow = row(doc, '挤压用连续波形', '关闭则改成"踢一脚+回弹"（更弹但更顿）');
  contRow.appendChild(continuous.node);
  sub.appendChild(contRow);

  const axisRow = row(doc, '自转方式', '竖轴=梗图效果；平面=躺倒打转');
  const axis = el(doc, 'select');
  for (const [v, label] of [['vertical', '竖轴'], ['screen', '平面']]) {
    const opt = el(doc, 'option', { value: v, textContent: label });
    if (settings.effect.spinAxis === v) opt.selected = true;
    axis.appendChild(opt);
  }
  axis.addEventListener('change', () => { settings.effect.spinAxis = axis.value; o.onChange?.(settings); });
  axisRow.appendChild(axis);
  sub.appendChild(axisRow);

  const dead = toggle(doc, settings.effect.deadBounce, (v) => { settings.effect.deadBounce = v; o.onChange?.(settings); });
  const deadRow = row(doc, '死亡后继续弹跳', '默认关闭；自转不受影响，始终继续');
  deadRow.appendChild(dead.node);
  sub.appendChild(deadRow);

  panel.appendChild(sub);

  const note = el(doc, 'p', { className: 'sbp-note', textContent: '' });
  panel.appendChild(note);

  doc.body.appendChild(panel);

  const open = (v) => { panel.hidden = !v; button.setAttribute('aria-expanded', String(v)); };
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => { e.stopPropagation(); open(panel.hidden); });

  // 点击面板外或按 Esc 收起
  const onDocClick = (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== button) open(false); };
  const onKey = (e) => { if (e.key === 'Escape' && !panel.hidden) open(false); };
  doc.addEventListener('pointerdown', onDocClick, true);
  doc.addEventListener('keydown', onKey, true);

  return {
    open,
    destroy() {
      clearInterval(statusTimer);
      doc.removeEventListener('pointerdown', onDocClick, true);
      doc.removeEventListener('keydown', onKey, true);
      panel.remove();
      button.remove();
      doc.getElementById(STYLE_ID)?.remove();
    },
  };
}

// ======== src/client.js ========
// src/client.js — 《卫戍协议：盟约》trusted 插件入口（「弹跳自转」）。
//
// ===================== 为什么这是 trusted 而不是 ui 插件 =====================
//
// 本插件要改变**单位容器的变换矩阵**，也就是要拿到每一帧的渲染对象。插件系统里只有
// `trusted` 类做得到：
//
//   * public/js/content.js:546 —— `await import(scriptUrl(cs, p.id, m.entry.client))`
//     也就是说 trusted 的 `entry.client` 会被动态 import 成**主页面里的原生 ES 模块**
//     （不是沙箱 iframe）。于是相对 import 可用，宿主全局对象也可用。
//   * `ui` 类的 iframe 带 UI_FRAME_CSP（`default-src 'none'`、`connect-src 'none'`、
//     且没有 `media-src`、无 allow-same-origin），看得到但碰不到 —— 做不了渲染，也放不了音乐。
//
// ===================== 怎么拿到渲染层 =====================
//
// 用宿主**自己暴露的调试抓手**（`globalThis.__SP_VIEW__.raw.debug`），不挂钩原型、不改任何文件。
// 详见 integrations/host.js 抬头 —— 那里记录了"挂钩原型自己猜"那条路连踩的三个坑。

/** 插件 id，同时用作所有 DOM / localStorage 键的前缀，避免与游戏或其他插件撞名。 */
const PLUGIN_ID = 'spin-bounce';
const PLUGIN_VERSION = '0.3.0';
const LOG = `[${PLUGIN_ID}]`;

const SETTINGS_KEY = 'sp.plugin.spinBounce.settings';

/**
 * 默认设置。
 *
 * ★ `effect` 这一组**直接复用 core 的 `EFFECT_DEFAULTS`**，不再各自维护一份副本。
 *
 * 为什么必须这样：这里曾经是一份独立抄写的副本，后来与 core 漂移了 —— 本对象缺少
 * `spinWritesPerSec` / `spinSmooth` 等项，而 `mergeSettings` 只接受
 * "默认值里已有的键" ⇒ 缺的那些**每次读回时都被静默丢弃**：
 * 面板上把"自转顺滑度"拉高、刷新页面就回到默认，玩家会以为设置没生效。
 * 两份默认值必须只有一个来源。
 */
const DEFAULT_SETTINGS = Object.freeze({
  effect: EFFECT_DEFAULTS,
  music: {
    enabled: false,   // 浏览器会拦自动播放，也不该一进页面就吵
    volume: 0.55,
  },
});

// ---- 设置持久化（仅本浏览器，绝不上报）--------------------------------------

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 深合并，但只接受与默认值**同类型**的字段（挡住旧版本残留的坏值）。 */
function mergeSettings(base, patch) {
  const out = clone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const [group, val] of Object.entries(patch)) {
    if (!out[group] || typeof out[group] !== 'object' || !val || typeof val !== 'object') continue;
    for (const [k, v] of Object.entries(val)) {
      if (!(k in out[group])) continue;
      if (typeof out[group][k] !== typeof DEFAULT_SETTINGS[group][k]) continue;
      out[group][k] = v;
    }
  }
  return out;
}

function readSettings(storage = globalThis.localStorage) {
  let out;
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    out = raw ? mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw)) : clone(DEFAULT_SETTINGS);
  } catch {
    out = clone(DEFAULT_SETTINGS);
  }
  out.effect.enabled = applySafetySwitches(out.effect.enabled, storage);
  return out;
}

/**
 * 安全阀（按优先级）：
 *   1. URL 带 `?sbn=0` → 强制关闭并**持久化**（出问题时刷新一下就能救回来，不必进设置面板）
 *   2. 系统「减少动态效果」→ 默认关闭（可用 `?sbn=1` 显式覆盖）
 *
 * 之所以要做第 1 条：这个特效每帧改写所有单位的变换，一旦性能出问题，玩家最需要的是
 * **一个不用点进任何界面就能关掉它的开关**。
 */
function applySafetySwitches(current, storage = globalThis.localStorage, loc = globalThis.location) {
  try {
    const q = new URLSearchParams(loc?.search || '').get('sbn');
    if (q === '0' || q === 'off') {
      try { storage?.setItem(SETTINGS_KEY + '.killed', '1'); } catch { /* ignore */ }
      return false;
    }
    if (q === '1' || q === 'on') {
      try { storage?.removeItem(SETTINGS_KEY + '.killed'); } catch { /* ignore */ }
      return true;
    }
    if (storage?.getItem(SETTINGS_KEY + '.killed') === '1') return false;
  } catch { /* ignore */ }
  try {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
  } catch { /* ignore */ }
  return current;
}

function writeSettings(s, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 无痕模式等 */ }
}

/** 性能诊断开关（`sp.plugin.spinBounce.settings.debug` = '1'）。 */
function debugOn(storage = globalThis.localStorage) {
  try { return storage?.getItem(SETTINGS_KEY + '.debug') === '1'; } catch { return false; }
}

// ---- 逐帧驱动 ----------------------------------------------------------------

/**
 * 单位 → 特效实例。用 WeakMap 而不是给 view 挂属性：
 * 不污染游戏对象、单位被回收时自动释放、也不会与其他插件抢同一个属性名。
 */
const effects = new WeakMap();

/** 当前帧的 dt（秒），由帧循环写入。 */
let frameDt = 1 / 60;

const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0, attached: 0 };
const getStats = () => ({ ...stats });

/**
 * 每帧推进。
 *
 * 每帧**重新收集**单位，而不是维护长期注册表：单位随对局生命周期来去匆匆
 * （`views` 是 Map，随时增删），重新收集最稳，开销也不高 —— 一次 Map 遍历加几个字段检查。
 */
/**
 * 每帧推进。
 *
 * ============================ 两个刻意的设计 ============================
 *
 * ① **每帧重新收集单位**（而不是维护长期注册表）：单位随对局生命周期来去匆匆
 *    （`views` 是 Map，随时增删），重新收集最稳，成本也只是一次 Map 遍历。
 *
 * ② **新建特效有每帧预算**（ATTACH_BUDGET_PER_FRAME）。这一条是为"进入战斗那一下的卡顿"加的：
 *    战斗开始时游戏会一次建好全部单位视图，若在同一帧里给每个单位都 attachEffect
 *    （量模型高度、建弹簧状态、建 DOM 样式），30 个单位就是**同一帧里 30 次初始化** —— 一个尖峰。
 *    改成每帧最多新接几个，初始化就被摊到十几帧里，人眼察觉不到，而那一下的卡顿消失。
 *    已在驱动的单位不受预算限制（它们的每帧成本很小）。
 */
const ATTACH_BUDGET_PER_FRAME = 3;

function tickEffects(storage, host) {
  if (!storage.settings.effect.enabled) return 0;
  const h = host || resolveHost();
  if (!h) return 0;
  const t0 = storage.debug ? performance.now() : 0;
  const list = collectUnits(h);
  let attached = 0;
  let driven = 0;
  for (let i = 0; i < list.length; i++) {
    const view = list[i];
    let fx = effects.get(view);
    if (!fx) {
      // 新单位：受每帧预算限制（见上），本帧超了就留到下一帧
      if (attached >= ATTACH_BUDGET_PER_FRAME) continue;
      fx = attachEffect(view, storage.settings.effect);
      if (!fx) continue;
      effects.set(view, fx);
      attached++;
    }
    driveUnit(view, fx, frameDt);
    driven++;
  }
  if (storage.debug) {
    const ms = performance.now() - t0;
    stats.ticks++; stats.units += driven; stats.ms += ms; stats.attached += attached;
    if (ms > stats.maxMs) stats.maxMs = ms;
    const now = performance.now();
    if (!stats.at) stats.at = now;
    if (now - stats.at >= 2000) {
      console.info(`${LOG} 诊断：${stats.ticks} 帧 / ${(now - stats.at).toFixed(0)}ms，`
        + `平均 ${(stats.ms / Math.max(1, stats.ticks)).toFixed(2)}ms/帧，最慢 ${stats.maxMs.toFixed(2)}ms，`
        + `已接管 ${driven} 个，新接入 ${stats.attached}`);
      stats.ticks = 0; stats.units = 0; stats.ms = 0; stats.maxMs = 0; stats.attached = 0; stats.at = now;
    }
  }
  return driven;
}

// ---- 帧循环 ------------------------------------------------------------------

/** 自适应降级：连续多帧超预算就自动关掉，绝不允许把整局拖到"服务器接管"。 */
const BUDGET_MS = 4;
const BUDGET_STRIKES = 90;

/**
 * 帧循环。优先挂到**宿主自己的 ticker**（`debug.app.ticker`）：不多开一条 rAF，
 * 且写入顺序可控（宿主渲染在 LOW(-25)，我们在它之前写）。拿不到 ticker 时退回自建 rAF。
 */
function startFrameLoop(storage, getHost, env = {}) {
  let stopped = false;
  let strikes = 0;
  let degraded = false;
  let attached = null;

  const step = (dtSeconds) => {
    if (stopped) return;
    frameDt = Math.max(0, Math.min(dtSeconds, 0.25));
    const t0 = performance.now();
    try { tickEffects(storage, getHost()); } catch (err) { console.warn(`${LOG} 帧驱动出错`, err); }
    const cost = performance.now() - t0;
    if (degraded) return;
    strikes = cost > BUDGET_MS ? strikes + 1 : 0;
    if (strikes >= BUDGET_STRIKES) {
      degraded = true;
      storage.degraded = true;
      storage.settings.effect.enabled = false;
      try { writeSettings(storage.settings); } catch { /* ignore */ }
      console.warn(`${LOG} 特效每帧耗时持续超过 ${BUDGET_MS}ms，已**自动关闭**以免拖慢对局。`
        + `可在设置面板重新开启，或用 ?sbn=0 永久关闭。`);
      try { globalThis.dispatchEvent?.(new CustomEvent('spin-bounce-degraded')); } catch { /* ignore */ }
    }
  };

  const detachFromHost = () => {
    if (!attached) return;
    try { attached.ticker.remove(attached.onTick); } catch { /* ignore */ }
    attached = null;
  };
  const attachToHost = () => {
    const h = getHost();
    const ticker = h && h.ticker;
    if (!ticker || attached === ticker) return;
    detachFromHost();
    const onTick = () => {
      const d = ticker.deltaMS != null ? ticker.deltaMS / 1000 : (ticker.deltaTime || 1) / 60;
      step(d);
    };
    ticker.add(onTick);
    attached = { ticker, onTick };
    console.info(`${LOG} 已接管宿主 ticker 的帧回调`);
  };

  const raf = env.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  let last = 0;
  const loop = (now) => {
    if (stopped) return;
    if (!attached) {
      attachToHost();                       // ticker 随对局视图来去匆匆，要反复尝试接管
      if (!attached) {
        const dt = last ? (now - last) / 1000 : 1 / 60;
        step(dt);
      }
    }
    last = now;
    if (raf) raf(loop);
  };
  if (raf) raf(loop);

  return () => { stopped = true; detachFromHost(); };
}

// ---- 离开对局时复位 ----------------------------------------------------------

/**
 * 盯 `html.sp-in-match`（游戏自己维护，见 `screens/game.js` 的 `useDocClass`）。
 * 离开对局时把在场景里的单位复位，避免它们保持压扁姿态被复用。
 */
function watchMatchState(storage, getHost, doc = globalThis.document) {
  if (!doc?.documentElement) return () => {};
  const reset = () => {
    if (doc.documentElement.classList.contains('sp-in-match')) return;
    const h = getHost();
    if (!h) return;
    for (const view of collectUnits(h)) effects.get(view)?.reset();
  };
  const mo = new MutationObserver(reset);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  reset();
  return () => mo.disconnect();
}

// ---- 设置改动即时生效（不必重载页面）----------------------------------------

/**
 * 打开开关时**立刻**给在场单位补上特效，否则玩家会以为开关没反应
 * （要等下一个单位出现才看到效果）。
 */
function applyLiveSettings(storage, host) {
  const h = host !== undefined ? host : resolveHost();
  const e = storage.settings.effect;
  const list = h ? collectUnits(h) : [];
  for (const view of list) {
    let fx = effects.get(view);
    if (!e.enabled) { fx?.setEnabled(false); fx?.reset(); continue; }
    if (!fx) {
      fx = attachEffect(view, e);
      if (fx) effects.set(view, fx);
      continue;
    }
    fx.setEnabled(true);
    fx.setSpinPeriod(optionsFor(view, e).spinPeriod);
    Object.assign(fx.state.cfg, {
      strength: e.strength,
      spinAxis: e.spinAxis,
      spinWritesPerSec: e.spinWritesPerSec,
      spinSmooth: e.spinSmooth,
      hopAmplitude: e.hopAmplitude,
      pulsesPerSecond: e.pulsesPerSecond,
      deadSpinScale: e.deadSpinScale,
      deadBounce: e.deadBounce,
    });
  }
}

// ---- 状态 --------------------------------------------------------------------

/** 面板上显示的状态行（让玩家一眼看出插件到底有没有在工作）。 */
function statusOf(host) {
  const h = host !== undefined ? host : resolveHost();
  if (!h) return { host: false, units: 0, views: 0, penViews: 0, ticker: false };
  return {
    host: true,
    ticker: !!h.ticker,
    views: h.views.size,
    penViews: h.penViews ? h.penViews.size : 0,
    units: collectUnits(h).length,
  };
}

// ---- 启动 --------------------------------------------------------------------

let started = null;

/**
 * 启动插件。trusted 插件在模块顶层调用它（导入即生效）。
 * @param {object} [env] 可注入的宿主环境，便于测试
 */
function start(env = {}) {
  if (started) return started;

  const doc = env.document ?? globalThis.document;
  const g = env.global ?? globalThis;
  const settings = env.settings ?? readSettings(env.storage ?? g.localStorage);
  const storage = { settings, debug: env.debug ?? debugOn(env.storage ?? g.localStorage), degraded: false };

  // ============================ 初始化顺序很重要 ============================
  // 面板与音乐**必须先挂**，且绝不依赖渲染层。
  // 之前把面板放在"渲染层就绪"分支之后，而渲染层要等进入对局才可用 —— 一旦那条路
  // 出问题，玩家就**看不到任何开关**，连关掉它的入口都没有。
  // 教训：安全开关必须比被它保护的功能更早、更可靠地存在。

  const music = createMusicController({
    settings: storage.settings.music,
    doc,
    elementId: env.musicElementId ?? 'sp-spin-music',
    src: env.musicSrc,
    storage: env.storage,
  });
  music.setEnabled(storage.settings.music.enabled);
  music.armAutoStart();

  const getHost = () => resolveHost(g);

  const panel = attachSettingsPanel({
    doc,
    settings: storage.settings,
    music,
    storage: env.storage ?? g.localStorage,
    status: () => statusOf(getHost()),
    onChange: (next) => {
      storage.settings = next;
      writeSettings(next, env.storage ?? g.localStorage);
      applyLiveSettings(storage, getHost());
    },
  });
  console.info(`${LOG} 设置面板已挂载（右下角「弹 设置」按钮）`);

  // 对外的逃生舱：玩家/作者可在控制台直接开关，不必依赖界面
  const api = {
    version: PLUGIN_VERSION,
    get settings() { return storage.settings; },
    on() { storage.settings.effect.enabled = true; writeSettings(storage.settings); applyLiveSettings(storage, getHost()); return 'effect on'; },
    off() { storage.settings.effect.enabled = false; writeSettings(storage.settings); applyLiveSettings(storage, getHost()); return 'effect off'; },
    musicOn() { storage.settings.music.enabled = true; writeSettings(storage.settings); music.setEnabled(true); return music.play(); },
    musicOff() { storage.settings.music.enabled = false; writeSettings(storage.settings); music.setEnabled(false); music.pause(); return 'music off'; },
    stats: getStats,
    status: () => statusOf(getHost()),
  };
  g.__SP_SPIN_BOUNCE__ = api;

  const stopLoop = startFrameLoop(storage, getHost, env);
  const stopWatch = watchMatchState(storage, getHost, doc);

  // 渲染层还没出现时只记一条日志：帧循环与状态行会持续重试，不需要额外分支。
  if (!getHost()) console.info(`${LOG} 等待渲染层（进入对局后才会出现）…；设置面板已可用`);

  console.info(`${LOG} v${PLUGIN_VERSION} 已启动（弹跳自转${storage.settings.effect.enabled ? '开启' : '关闭'}，`
    + `音乐${storage.settings.music.enabled ? '开启' : '关闭'}）`);

  started = {
    ok: true,
    get settings() { return storage.settings; },
    api, music, panel, getHost,
    stop() {
      stopLoop(); stopWatch(); panel?.destroy?.();
      started = null;
    },
  };
  return started;
}

// trusted 插件：导入即生效。
start();

// ======== 打包尾部：确保启动 ========
if (typeof start === 'function') { try { start(); } catch (err) { console.warn('[spin-bounce] start() 失败', err); } }
