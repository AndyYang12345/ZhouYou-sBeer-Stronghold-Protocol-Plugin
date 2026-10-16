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
// C. **本插件的自包含方案**（当前采用）：补丁往 index.html 注入一个 `<audio id="sp-spin-music">`，
//    音源路径写在 `<html data-sp-spin-music="...">` 上，由这里读取。
//    好处是零外部依赖、离线可用；代价是它独立于游戏音频系统，所以**音量要和游戏 BGM 手动协调**。
//
// 我们向上游提的 issue/PR 就是请官方采纳 A（见 docs/upstream-audio-proposal.md）。

/** 音乐元素的默认 id（由补丁注入到 index.html）。 */
export const MUSIC_ELEMENT_ID = 'sp-spin-music';
/** 音源路径写在 <html> 的这个属性上，便于换歌不用改代码。 */
export const MUSIC_SOURCE_ATTR = 'data-sp-spin-music';

export const AUDIO_DEFAULTS = Object.freeze({
  enabled: false,     // **默认关闭**：自动播放会被浏览器拦，且没理由一进页面就吵
  volume: 0.55,       // 独立音量；与游戏 BGM 各管各的
  loop: true,
  fadeMs: 600,        // 开/关时淡入淡出，避免"啪"地一声
});

const num = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);

/**
 * 创建音乐控制器。
 *
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {string} [opts.elementId]
 * @param {string} [opts.src] 显式音源；省略时读 `<html data-sp-spin-music>`
 */
export function createMusicController(opts = {}) {
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
    el.volume = num(cfg.volume, AUDIO_DEFAULTS.volume);
    state.el = el;
    state.ready = true;
    return el;
  };

  /** 淡入到目标音量。 */
  const fadeTo = (target, ms) => {
    const el = state.el;
    if (!el) return;
    const from = el.volume;
    const dur = Math.max(0, num(ms, cfg.fadeMs));
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
      fadeTo(num(cfg.volume, AUDIO_DEFAULTS.volume), cfg.fadeMs);
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
    cfg.volume = Math.max(0, Math.min(1, num(v, cfg.volume)));
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
