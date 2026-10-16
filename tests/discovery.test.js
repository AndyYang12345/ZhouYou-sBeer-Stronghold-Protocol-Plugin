// tests/discovery.test.js — 单位发现链路的回归测试。
//
// 这一组守的是**我连续踩了两次的时序陷阱**。UnitView 的真实构造顺序是
// （public/js/render/units.js）：
//
//   719  ctx.layers.shadow.addChild(this.shadow)   ← this.body 还不存在
//   723  ctx.layers.units.addChild(this.root)      ← 此刻 view.body 仍是 undefined
//   734  this.body = new P.Container()
//   735  this.root.addChild(this.body)             ← 只有这里，child.parent.parent 才是 view
//   752  ctx.layers.bars.addChild(this.hud)
//
// 所以任何"在 root 入层那一刻判断 view.body"的实现都会漏掉全部单位。
// 本测试用最小替身严格按这个顺序搭场景图，确保发现逻辑不再依赖创建顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 最小 PIXI Container 替身：只要 parent / children / addChild。 */
function makeContainer() {
  const c = {
    children: [],
    parent: null,
    addChild(...kids) {
      for (const k of kids) {
        if (k.parent) k.parent.children.splice(k.parent.children.indexOf(k), 1);
        k.parent = c;
        c.children.push(k);
      }
      return kids[0];
    },
  };
  return c;
}

/**
 * 造一个"真 PIXI 环境"：让 installUnitDiscovery 能挂上原型。
 * 关键：addChild 必须定义在 **prototype** 上，因为插件挂钩的就是原型。
 */
function makePIXI() {
  class Container {
    constructor() {
      this.children = [];
      this.parent = null;
      // PIXI 的真实 Container 一定有这些变换属性，而插件正是靠 body.scale
      // 判断"这是个单位身体"。替身必须带上，否则测的是个不存在的形状。
      this.scale = { x: 1, y: 1 };
      this.pivot = { x: 0, y: 0 };
      this.position = { x: 0, y: 0 };
      this.rotation = 0;
    }
    addChild(...kids) {
      for (const k of kids) {
        if (k.parent) {
          const i = k.parent.children.indexOf(k);
          if (i >= 0) k.parent.children.splice(i, 1);
        }
        k.parent = this;
        this.children.push(k);
      }
      return kids[0];
    }
  }
  return { Container };
}

/**
 * 按游戏真实顺序构造一个 UnitView 替身。
 *
 * ⚠️ **最容易搞错的一点：`view.root` 就是 `view` 自己。**
 * 真实的 UnitView 挂载时执行 `ctx.layers.units.addChild(this.root)`，而 `this.root`
 * 是一个**继承自 Container 的视图对象**，`body` / `hud` / `shadow` 都是它自己的属性。
 * 所以 `body.parent === view.root === view`。
 *
 * 我第一版替身把 view 与 view.root 建成了两个不同对象，于是测试一直在测一个
 * 不存在的形状（表现为"发现了但拿到的是 root"）—— 这是本文件踩过的最大一个坑。
 */
function buildUnitLikeGame(PIXI, layers, { golden = false } = {}) {
  const C = () => new PIXI.Container();

  // view 自己就是那个被加进 layers.units 的容器
  const view = new PIXI.Container();

  // 719
  view.shadow = C();
  layers.shadow.addChild(view.shadow);

  // 723 —— 此刻 view.body 还不存在
  layers.units.addChild(view);

  // 727-733：可选光环
  if (golden) {
    view.aura = C();
    view.addChild(view.aura);
  }

  // 734-735
  view.body = C();
  view.addChild(view.body);

  // 738
  view.fallback = C();
  view.body.addChild(view.fallback);

  // 752
  view.hud = C();
  layers.bars.addChild(view.hud);

  return view;
}

test('按游戏真实顺序构造单位时能被发现（root 入层时 body 尚不存在）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const layers = { units: new PIXI.Container(), bars: new PIXI.Container(), shadow: new PIXI.Container() };

  const found = [];
  const disc = installUnitDiscovery(PIXI);
  disc.onUnit = (v) => found.push(v);

  const view = buildUnitLikeGame(PIXI, layers);

  assert.equal(found.length, 1, `应恰好发现 1 个单位，实际 ${found.length}`);
  assert.equal(found[0], view, '发现的对象应是 UnitView 本身，而不是它的内部零件');
});

test('发现的对象不是内部零件（body / fallback 不能算作单位）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const layers = { units: new PIXI.Container(), bars: new PIXI.Container(), shadow: new PIXI.Container() };
  const found = [];
  const disc = installUnitDiscovery(PIXI);
  disc.onUnit = (v) => found.push(v);

  const view = buildUnitLikeGame(PIXI, layers);

  assert.ok(!found.includes(view.body), 'body 自身不能被当成单位');
  assert.ok(!found.includes(view.fallback), 'fallback 不能被当成单位');
  assert.ok(found.includes(view), '必须是 view 自己');
});

test('多个单位都被发现（含带光环的）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const layers = { units: new PIXI.Container(), bars: new PIXI.Container(), shadow: new PIXI.Container() };
  const found = new Set();
  const disc = installUnitDiscovery(PIXI);
  disc.onUnit = (v) => found.add(v);

  const a = buildUnitLikeGame(PIXI, layers);
  const b = buildUnitLikeGame(PIXI, layers, { golden: true });
  const c = buildUnitLikeGame(PIXI, layers);

  assert.equal(found.size, 3, `应发现 3 个单位，实际 ${found.size}`);
  for (const v of [a, b, c]) assert.ok(found.has(v));
});

test('非单位对象不会被误判（道具没有 body）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const layers = { units: new PIXI.Container(), bars: new PIXI.Container(), shadow: new PIXI.Container() };
  const found = [];
  const disc = installUnitDiscovery(PIXI);
  disc.onUnit = (v) => found.push(v);

  // 同一个 units 层里还有道具：只是个普通容器
  const prop = new PIXI.Container();
  layers.units.addChild(prop);

  assert.equal(found.length, 0, `道具不应被发现，实际 ${found.length}`);
});

test('单位部件陆续加入时，上报的始终是同一个 view（去重交给 Set）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const layers = { units: new PIXI.Container(), bars: new PIXI.Container(), shadow: new PIXI.Container() };
  const found = [];
  const disc = installUnitDiscovery(PIXI);
  disc.onUnit = (v) => found.push(v);

  const view = buildUnitLikeGame(PIXI, layers);
  // 游戏后续还会往 body 里加东西（spine 模型、特效、小零件）
  view.body.addChild(new PIXI.Container());
  view.body.addChild(new PIXI.Container());
  view.addChild(new PIXI.Container());

  // onUnit 可能被触发多次（单位构造期间会多次往 root/body 里加东西），
  // 但**每一次上报的都必须是同一个 view**；真正的去重在 trackUnit 的 Set 里。
  assert.ok(found.length >= 1, `至少要发现一次，实际 ${found.length}`);
  assert.ok(found.every((v) => v === view), '上报的都应指向同一个 view，不能混入 root');
});

test('原型只包装一次（重复安装共享同一份状态）', async () => {
  const { installUnitDiscovery } = await import('../src/client.js');
  const PIXI = makePIXI();
  const a = installUnitDiscovery(PIXI);
  const b = installUnitDiscovery(PIXI);
  assert.equal(a, b, '重复安装应返回同一份状态');
});
