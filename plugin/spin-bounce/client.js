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
const SPIN_STEPS_PER_TURN = 24;

/** 默认参数。手感来自参考实现，自转周期也沿用它的 2.7 秒。 */
const EFFECT_DEFAULTS = Object.freeze({
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
const WRITE_EPSILON = 1e-3;

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

  // 行进中的单位转得略快
  const moving = typeof view.speed === 'number' && view.speed > 0 ? 1.15 : 1;
  fx.update(dt, moving);
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
    if (!safe) return null;
    const raw = safe.raw && typeof safe.raw === 'object' ? safe.raw : safe;
    const dbg = raw.debug;
    const views = dbg && dbg.views;
    if (!views || typeof views.values !== 'function') return null;
    const app = dbg.app;
    const ticker = app && app.ticker
      && typeof app.ticker.add === 'function' && typeof app.ticker.remove === 'function'
      ? app.ticker : null;
    return {
      raw,
      views,
      penViews: dbg.penViews && typeof dbg.penViews.values === 'function' ? dbg.penViews : null,
      get leader() { try { return dbg.leader; } catch { return null; } },   // getter：首领随时换人，必须现读
      fx: dbg.fx || null,
      ticker,
    };
  } catch {
    return null;
  }
}

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

  state.resolveSrc = () => {
    if (state.src) return state.src;
    if (!doc?.documentElement) return null;
    return doc.documentElement.getAttribute(MUSIC_SOURCE_ATTR) || null;
  };

  state.ensureElement = () => {
    if (state.el) return state.el;
    if (!doc) return null;
    let el = opts.elementId ? doc.getElementById(opts.elementId) : null;
    if (!el) el = doc.getElementById(MUSIC_ELEMENT_ID);
    if (!el) {
      const src = state.resolveSrc();
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

/** 默认设置：特效**开启**、音乐**关闭**（浏览器会拦自动播放，也不该一进页面就吵）。 */
const DEFAULT_SETTINGS = Object.freeze({
  effect: {
    enabled: true,
    strength: 1.15,
    spinPeriod: 2.7,
    pulsesPerSecond: 2,
    hopAmplitude: 0.115,
    spinAxis: 'vertical',   // 'vertical' 竖轴自转（梗图效果）| 'screen' 屏幕平面内转
    deadSpinScale: 1,
    deadBounce: false,
  },
  music: {
    enabled: false,
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

const stats = { ticks: 0, units: 0, ms: 0, at: 0, maxMs: 0 };
const getStats = () => ({ ...stats });

/**
 * 每帧推进。
 *
 * 每帧**重新收集**单位，而不是维护长期注册表：单位随对局生命周期来去匆匆
 * （`views` 是 Map，随时增删），重新收集最稳，开销也不高 —— 一次 Map 遍历加几个字段检查。
 */
function tickEffects(storage, host) {
  if (!storage.settings.effect.enabled) return 0;
  const h = host || resolveHost();
  if (!h) return 0;
  const t0 = storage.debug ? performance.now() : 0;
  const list = collectUnits(h);
  for (let i = 0; i < list.length; i++) {
    const view = list[i];
    let fx = effects.get(view);
    if (!fx) {
      fx = attachEffect(view, storage.settings.effect);
      if (!fx) continue;
      effects.set(view, fx);
    }
    driveUnit(view, fx, frameDt);
  }
  if (storage.debug) {
    const ms = performance.now() - t0;
    stats.ticks++; stats.units += list.length; stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    const now = performance.now();
    if (!stats.at) stats.at = now;
    if (now - stats.at >= 2000) {
      console.info(`${LOG} 诊断：${stats.ticks} 帧 / ${(now - stats.at).toFixed(0)}ms，`
        + `平均 ${(stats.ms / Math.max(1, stats.ticks)).toFixed(2)}ms/帧，最慢 ${stats.maxMs.toFixed(2)}ms，`
        + `单位数 ${list.length}`);
      stats.ticks = 0; stats.units = 0; stats.ms = 0; stats.maxMs = 0; stats.at = now;
    }
  }
  return list.length;
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
      spinSteps: e.spinSteps,
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
