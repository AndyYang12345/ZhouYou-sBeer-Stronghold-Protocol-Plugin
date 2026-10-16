// tests/discovery.test.js — 渲染层抓手的解析与单位收集。
//
// 这一组守的是**插件与游戏之间最脆弱的那条缝**：宿主私有成员的形状。
// 我先后走过两条路，都留下了教训：
//
//   路线 A（已废弃）：包装 `PIXI.Container.prototype.addChild`，从场景图猜单位。
//     连踩三个坑 ——
//       1. `layers.units.addChild(this.root)` 发生在 `this.body` 赋值**之前**，
//          那一刻判断 `view.body` 永远是 undefined；
//       2. `view.root` **就是 view 自己**，把它当"装载 root 的容器"会把 root 误认成单位；
//       3. 单位其实来自**三处**（战斗 views / 预览栏 penViews / 首领 leader.view），
//          遍历单个容器天然覆盖不全。
//
//   路线 B（当前）：用宿主自己暴露的调试抓手
//     `globalThis.__SP_VIEW__.raw.debug = { app, views, penViews, get leader(), … }`
//     （public/js/ui/fieldHost.js:287 与 public/js/render/app.js:2191）
//     这是官方接缝，也是 CyanFish 的 CyanModPack（dj-all/client/engine-pixi.js）走的同一条路。
//
// 本文件因此测的是：抓不到时是否**安静降级**、抓到时是否**三处都遍历到**、
// 以及"模型没加载完的单位"是否被正确跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHost, eachView, collectUnits, hasBody, modelReady, kindOf } from '../src/integrations/host.js';

// ---- 最小宿主替身 --------------------------------------------------------------

/** 一个"模型已就绪"的单位视图替身。 */
function unitView(over = {}) {
  return {
    info: { kind: 'op' },
    destroyed: false,
    body: { scale: { x: 1, y: 1 }, pivot: { x: 0, y: 0 }, position: { x: 0, y: 0 }, rotation: 0 },
    root: {},
    hud: {},
    actor: { spine: {} },
    spineReady: true,
    ...over,
  };
}

/** 造一个含 `__SP_VIEW__` 的假 global。 */
function fakeGlobal({ views = [], penViews = [], leader = null, ticker = null } = {}) {
  return {
    __SP_VIEW__: {
      raw: {
        debug: {
          app: { ticker: ticker || { add() {}, remove() {}, deltaMS: 16.7 } },
          views: new Map(views.map((v, i) => [`v${i}`, v])),
          penViews: new Map(penViews.map((v, i) => [`p${i}`, v])),
          get leader() { return leader; },
          fx: {},
        },
      },
    },
  };
}

// ---- resolveHost ---------------------------------------------------------------

test('抓不到 __SP_VIEW__ 时安静返回 null（不抛）', () => {
  assert.equal(resolveHost({}), null);
  assert.equal(resolveHost(null), null);
  assert.equal(resolveHost(undefined), null);
});

test('__SP_VIEW__ 存在但没有 debug.views 时返回 null', () => {
  assert.equal(resolveHost({ __SP_VIEW__: { raw: { debug: {} } } }), null);
  assert.equal(resolveHost({ __SP_VIEW__: { raw: { debug: { views: {} } } } }), null, 'views 必须有 values()');
});

test('能解析出 views / penViews / ticker', () => {
  const g = fakeGlobal({ views: [unitView()], penViews: [unitView()] });
  const h = resolveHost(g);
  assert.ok(h, '应解析成功');
  assert.equal(h.views.size, 1);
  assert.equal(h.penViews.size, 1);
  assert.ok(h.ticker, '应拿到 ticker');
});

test('没有 raw 包装时退回直接用 __SP_VIEW__（两种形状都兼容）', () => {
  const g = { __SP_VIEW__: { debug: { app: { ticker: { add() {}, remove() {} } }, views: new Map() } } };
  const h = resolveHost(g);
  assert.ok(h, '没有 .raw 时也应能解析');
});

test('没有 app.ticker 时 ticker 为 null（调用方据此退回自建 rAF）', () => {
  const g = fakeGlobal({ views: [unitView()] });
  g.__SP_VIEW__.raw.debug.app = {};
  const h = resolveHost(g);
  assert.ok(h);
  assert.equal(h.ticker, null);
});

test('leader 是 getter：每帧现读，能反映换人', () => {
  let cur = null;
  const g = fakeGlobal({ views: [unitView()] });
  Object.defineProperty(g.__SP_VIEW__.raw.debug, 'leader', { get: () => cur, configurable: true });
  const h = resolveHost(g);
  assert.equal(h.leader, null);
  cur = unitView();
  assert.ok(h.leader, '首领换人后应能读到新值（不能缓存）');
});

// ---- eachView ------------------------------------------------------------------

test('eachView 必须遍历三处：views / penViews / leader.view', () => {
  const leaderView = unitView();
  const g = fakeGlobal({ views: [unitView()], penViews: [unitView()], leader: { view: leaderView } });
  const h = resolveHost(g);
  const seen = [];
  eachView(h, (v) => seen.push(v));
  assert.equal(seen.length, 3, `应遍历到 3 个视图（战斗/预览栏/首领），实际 ${seen.length}`);
  assert.ok(seen.includes(leaderView), '首领视图不能漏');
});

test('leader 为 null 时不报错', () => {
  const g = fakeGlobal({ views: [unitView()], leader: null });
  const h = resolveHost(g);
  const seen = [];
  eachView(h, (v) => seen.push(v));
  assert.equal(seen.length, 1);
});

// ---- collectUnits --------------------------------------------------------------

test('只收集"有身体且模型已就绪"的单位', () => {
  const ready = unitView();
  const noModel = unitView({ spineReady: false });          // 模型还没换上去
  const destroyed = unitView({ destroyed: true });           // 已回收
  const noBody = unitView({ body: null });
  const g = fakeGlobal({ views: [ready, noModel, destroyed, noBody] });
  const got = collectUnits(resolveHost(g));
  assert.equal(got.length, 1, `应只收集到 1 个，实际 ${got.length}`);
  assert.equal(got[0], ready);
});

test('刚创建、模型未就绪的单位会被跳过（否则量到的尺寸是占位肖像的）', () => {
  const pending = unitView({ spineReady: false, actor: null });
  assert.equal(hasBody(pending), true, '身体是有的');
  assert.equal(modelReady(pending), false, '但模型没就绪 ⇒ 必须跳过');
  const g = fakeGlobal({ views: [pending] });
  assert.equal(collectUnits(resolveHost(g)).length, 0);
});

test('收集到的是视图本身，不是它的 body（否则支点与换面都会错）', () => {
  const v = unitView();
  const g = fakeGlobal({ views: [v] });
  const got = collectUnits(resolveHost(g));
  assert.equal(got[0], v);
  assert.notEqual(got[0], v.body);
});

test('host 为 null 时 collectUnits 返回空数组（安静降级）', () => {
  assert.deepEqual(collectUnits(null), []);
});

test('宿主对象形状异常时不抛异常', () => {
  const broken = { views: { values: () => { throw new Error('boom'); } }, penViews: null, leader: null };
  assert.doesNotThrow(() => eachView(broken, () => {}));
  assert.doesNotThrow(() => collectUnits(broken));
});

// ---- 辅助判定 ------------------------------------------------------------------

test('kindOf 读 info.kind，缺失时返回空串', () => {
  assert.equal(kindOf(unitView()), 'op');
  assert.equal(kindOf({ info: {} }), '');
  assert.equal(kindOf(null), '');
});

// ---- 缓存（性能：resolveHost 每帧都被调用）-------------------------------------

test('同一个对局内复用同一个 host 对象（避免每帧重建）', () => {
  const g = fakeGlobal({ views: [unitView()] });
  const a = resolveHost(g);
  const b = resolveHost(g);
  assert.equal(a, b, '★ 同一 views 实例应复用，否则每帧都在分配对象');
});

test('换了对局（views 换成新 Map）必须重建，不能拿旧视图', () => {
  const g = fakeGlobal({ views: [unitView()] });
  const a = resolveHost(g);
  const fresh = [unitView()];
  g.__SP_VIEW__.raw.debug.views = new Map(fresh.map((v, i) => [`n${i}`, v]));
  const b = resolveHost(g);
  assert.notEqual(b, a, '换了对局必须重建');
  assert.equal(b.views.size, 1);
  assert.equal(collectUnits(b)[0], fresh[0], '拿到的必须是新对局的单位');
});

test('缓存不影响 leader 的现读（首领换人仍然即时反映）', () => {
  let cur = null;
  const g = fakeGlobal({ views: [unitView()] });
  Object.defineProperty(g.__SP_VIEW__.raw.debug, 'leader', { get: () => cur, configurable: true });
  const h = resolveHost(g);
  assert.equal(h.leader, null);
  cur = unitView();
  assert.ok(h.leader, '★ 缓存了 host 也不能把 leader 一起缓存住');
});

test('宿主消失后缓存立即失效（不返回过期 host）', () => {
  const g = fakeGlobal({ views: [unitView()] });
  assert.ok(resolveHost(g));
  g.__SP_VIEW__ = null;
  assert.equal(resolveHost(g), null, '★ 宿主没了就必须返回 null');
});
