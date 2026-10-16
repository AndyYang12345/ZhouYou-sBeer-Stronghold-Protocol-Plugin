// tools/diagnose-in-browser.js — 在游戏页面的控制台里跑，一次定位整条链路。
//
// 用法：进对局后，F12 → Console → 粘贴本文件全部内容 → 回车。
// 它只读、不改任何东西，输出一段报告。把报告发我即可。
//
// 为什么需要它：单位发现的链路有好几个环节（PIXI 是否就绪、原型是否挂钩、
// 钩子是否被触发、判定是否命中），任何一环断了都表现为"等待单位"。
// 逐个猜测代价太高，这里一次把每一环的实测值打出来。
(() => {
  const out = [];
  const say = (k, v) => out.push(`${k}: ${v}`);

  say('页面', location.href.slice(0, 80));
  say('插件 API 存在', !!globalThis.__SP_SPIN_BOUNCE__);
  say('插件设置', JSON.stringify(globalThis.__SP_SPIN_BOUNCE__?.settings ?? null));

  const PIXI = globalThis.PIXI;
  say('globalThis.PIXI', !!PIXI);
  if (!PIXI) { console.log(out.join('\n')); return; }

  const proto = PIXI.Container?.prototype;
  say('Container.prototype', !!proto);
  say('原型已挂钩(__sbPatched)', !!proto?.__sbPatched);
  say('钩子状态(__sbState)', JSON.stringify(
    proto?.__sbState ? { hasOnUnit: typeof proto.__sbState.onUnit === 'function' } : null));

  // 从 stage 整棵遍历（不依赖游戏内部的 views 注册表）
  const stage = PIXI.Application?._lastApp?.stage
    || (() => { // 退路：从 canvas 找不到 stage 时，顺着任一 Container 往上爬
      return null;
    })();
  say('stage 可达', !!stage);

  let containers = 0, withBody = 0, withBodyAndChildren = 0, withBodyScale = 0;
  const samples = [];
  const seen = new Set();
  const roots = [];
  if (stage) roots.push(stage);
  // 即使拿不到 stage，也把 proto.__sbState 记录的父容器当作起点
  const layer = proto?.__sbState?.unitsLayer;
  say('记录的 unitsLayer', !!layer);
  if (layer) roots.push(layer);

  const walk = (node, depth) => {
    if (!node || seen.has(node) || depth > 12) return;
    seen.add(node);
    if (node instanceof PIXI.Container) {
      containers++;
      const hasBody = !!node.body;
      if (hasBody) {
        withBody++;
        if (Array.isArray(node.body.children)) withBodyAndChildren++;
        if (node.body.scale && typeof node.body.scale === 'object') withBodyScale++;
        if (samples.length < 5) {
          samples.push({
            keys: Object.keys(node).slice(0, 12),
            bodyKeys: node.body ? Object.keys(node.body).slice(0, 6) : null,
            bodyChildren: Array.isArray(node.body?.children) ? node.body.children.length : 'not-array',
            bodyScaleType: typeof node.body?.scale,
            rootParent: !!node.root?.parent,
            hudParent: !!node.hud?.parent,
            destroyed: node.destroyed,
          });
        }
      }
      for (const c of node.children || []) walk(c, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);

  say('遍历到的 Container 总数', containers);
  say('其中带 body 的', withBody);
  say('  且 body.children 是数组', withBodyAndChildren);
  say('  且 body.scale 是对象', withBodyScale);
  console.log(out.join('\n'));
  if (samples.length) console.log('样例（前 5 个带 body 的对象）:', samples);
  console.log('→ 把以上全部内容发我');
})();
