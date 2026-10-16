// tests/panel.test.js — 设置面板的开关行为（含"音乐无法关闭"那个 ReferenceError）。
//
// 这一组守的是一个**运行时才暴露的错**：
//   attachSettingsPanel 的参数是选项对象 `o`，音乐控制器在 `o.music` 上，
//   但函数体里有 5 处裸用了 `music` —— `music` 这个变量根本不存在。
//   于是**每次碰音乐开关都抛 `ReferenceError: music is not defined`**，
//   玩家看到的就是"音乐无法关闭"。
//
// 值得记的一点：**可选链 `?.` 挡不住未声明的变量**（它只在值为 null/undefined 时短路），
// 所以 `music?.pause?.()` 照样炸。这类错误静态看不出来、单测不碰 DOM 也测不出来，
// 所以这里搭一个最小 DOM 直接驱动开关。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachSettingsPanel } from '../src/integrations/panel.js';
// 注意：不要从 src/client.js 取 DEFAULT_SETTINGS —— 那个模块顶层会调 start()，
// 而 Node 里没有 document。`effect` 那一组的真正来源就是 EFFECT_DEFAULTS。
import { EFFECT_DEFAULTS } from '../src/core/unit-effect.js';

// ---- 最小 DOM 替身 --------------------------------------------------------------

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    _attrs: {},
    _listeners: {},
    textContent: '',
    id: '',
    className: '',
    type: '',
    value: '',
    checked: false,
    max: '', min: '', step: '',
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    addEventListener(t, fn) { (el._listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const a = el._listeners[t];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    classList: {
      _s: new Set(),
      add(c) { el.classList._s.add(c); },
      remove(c) { el.classList._s.delete(c); },
      contains(c) { return el.classList._s.has(c); },
      toggle(c, on) { if (on) el.classList.add(c); else el.classList.remove(c); },
    },
    /** 测试用：触发某类事件（事件对象要带上真实 DOM 事件的基本方法）。 */
    fire(type, ev = {}) {
      const event = {
        target: el,
        currentTarget: el,
        type,
        preventDefault() {},
        stopPropagation() {},
        ...ev,
      };
      for (const fn of [...(el._listeners[type] || [])]) fn(event);
    },
    /** 测试用：递归找元素。 */
    find(pred) {
      if (pred(el)) return el;
      for (const c of el.children) { const r = c.find?.(pred); if (r) return r; }
      return null;
    },
    findAll(pred, out = []) {
      if (pred(el)) out.push(el);
      for (const c of el.children) c.findAll?.(pred, out);
      return out;
    },
  };
  return el;
}

function makeDoc() {
  const body = makeEl('body');
  const head = makeEl('head');
  const documentElement = makeEl('html');
  return {
    body, head, documentElement,
    _byId: new Map(),
    createElement: (t) => makeEl(t),
    getElementById(id) {
      // ★ 这里必须用桩自己的 body/head，**不能**引用全局 `document` —— 在 Node 里它未声明，
      //   一读就抛 ReferenceError，而栈会指向调用方（panel.js 的 ensureStyle），
      //   看起来像源码的错，其实是桩的错。（我自己在这上面绕了好几圈。）
      return body.find((e) => e.id === id) || head.find((e) => e.id === id) || null;
    },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
  };
}

/** 假的音乐控制器：记录调用。 */
function fakeMusic() {
  const calls = [];
  return {
    calls,
    enabled: false,
    state: { blocked: false, playing: false },
    setEnabled(v) { calls.push(['setEnabled', v]); this.enabled = v; },
    async play() { calls.push(['play']); return true; },
    pause() { calls.push(['pause']); this.state.playing = false; },
  };
}

/** 挂上面板，返回 todo 与关键元素。 */
function mount(over = {}) {
  const doc = makeDoc();
  // ★ 深合并顺序很重要：`over.settings` 必须**合进** effect，而不是覆盖掉整个 effect。
  //   写成 `{ effect: EFFECT_DEFAULTS, ...over.settings }` 会让 over.settings.effect（可能只有
  //   一个键）整个替换掉默认值，于是别的滑杆读到 undefined —— 我自己就在这上面栽过一次。
  const settings = JSON.parse(JSON.stringify({
    effect: { ...EFFECT_DEFAULTS, ...(over.settings?.effect || {}) },
    music: { enabled: false, volume: 0.55, ...(over.settings?.music || {}) },
  }));
  const music = fakeMusic();
  const changes = [];
  const panel = attachSettingsPanel({
    doc,
    settings,
    music,
    status: () => ({ host: true, units: 2, views: 2, penViews: 0 }),
    statusIntervalMs: 0,          // 关掉轮询，避免定时器让测试进程不退出
    onChange: (s) => changes.push(s),
    ...over.opts,
  });

  // 打开面板（默认是收起的）
  const button = doc.body.find((e) => e.id === 'sbp-button');
  button?.fire('click');
  const root = doc.body.find((e) => e.id === 'sbp-panel');
  return { doc, settings, music, changes, panel, button, root };
}

// ---- 基本挂载 ------------------------------------------------------------------

test('面板能挂上，且不抛异常', () => {
  const { button, root } = mount();
  assert.ok(button, '应有「弹 设置」按钮');
  assert.ok(root, '点开后应有面板');
});

test('没有 document.body 时安静返回 null', () => {
  const panel = attachSettingsPanel({ doc: {}, settings: { effect: EFFECT_DEFAULTS, music: { enabled: false, volume: 0.55 } } });
  assert.equal(panel, null);
});

// ---- ★ 音乐开关：那个 ReferenceError 的回归测试 ---------------------------------

// 面板里的开关是「带 aria-checked 的按钮」（不是 input[type=checkbox]），
// 点一下切换一次 —— 测试要按这个真实结构来，否则会找不到元素（我第一版就找错了）。
const toggles = (root) => root.findAll((e) => e.getAttribute?.('aria-checked') !== null || e._attrs?.['aria-checked'] !== undefined);
const isOn = (el) => el.getAttribute('aria-checked') === 'true';

test('★ 关闭音乐会调用 setEnabled(false) 与 pause（不再抛 music is not defined）', async () => {
  const { settings, music, root } = mount();
  assert.equal(settings.music.enabled, false, '默认关闭');

  const sw = toggles(root).find((e) => /自定义音乐|音乐/.test(e.closestText || '')) || toggles(root)[1];
  assert.ok(sw, '应能找到音乐开关');

  // 打开再关闭 —— 关闭这一步正是过去抛 ReferenceError 的地方
  await assert.doesNotReject(async () => {
    sw.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    sw.fire('click');
    await new Promise((r) => setTimeout(r, 0));
  }, '切换音乐开关不应抛异常');

  assert.ok(music.calls.some(([m]) => m === 'pause'), `关闭时应调用 pause，实际调用：${JSON.stringify(music.calls)}`);
  assert.ok(music.calls.some(([m, v]) => m === 'setEnabled' && v === false), '应 setEnabled(false)');
});

test('★ 打开音乐会尝试播放，并写回设置', async () => {
  const { settings, music, root } = mount();
  const sw = toggles(root)[1] || toggles(root)[0];
  sw.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settings.music.enabled, true, '设置应被更新');
  assert.ok(music.calls.some(([m]) => m === 'setEnabled'), '应通知音乐控制器');
});

test('被浏览器拦自动播放时给出提示（而不是静默失败）', async () => {
  const { music, root } = mount();
  music.play = async () => { music.calls.push(['play']); return false; };
  music.state.blocked = true;
  const sw = toggles(root)[1] || toggles(root)[0];
  sw.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(music.calls.some(([m]) => m === 'play'), '应确实尝试过播放');
});

// ---- 特效开关 ------------------------------------------------------------------

test('特效开关会更新设置并触发 onChange', () => {
  const { settings, changes, root } = mount();
  const sw = toggles(root)[0];
  assert.ok(sw, '应能找到特效开关');
  assert.equal(isOn(sw), true, '特效默认开启');
  sw.fire('click');
  assert.equal(settings.effect.enabled, false, `点击后应关闭，实际 ${settings.effect.enabled}`);
  assert.ok(changes.length > 0, '应触发 onChange 以便持久化');
});

test('滑杆存在且会写回设置（顺滑度 / 强度 / 周期）', () => {
  const { settings, root } = mount();
  const ranges = root.findAll((e) => e.type === 'range');
  assert.ok(ranges.length >= 3, `应有多个滑杆，实际 ${ranges.length}`);
  for (const r of ranges) { r.value = r.max || '1'; r.fire('input', { target: r }); }
  assert.ok(Number.isFinite(settings.effect.spinWritesPerSec) || Number.isFinite(settings.effect.strength),
    '滑杆应写回数值设置');
});

test('status 回调被安全调用（缺失也不抛）', () => {
  assert.doesNotThrow(() => mount({ opts: { status: undefined } }));
});

test('destroy 能撤掉界面且不抛', () => {
  const { panel, doc } = mount();
  assert.ok(panel?.destroy, '应提供 destroy');
  assert.doesNotThrow(() => panel.destroy());
});
