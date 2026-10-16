// tests/settings.test.js — 设置项的默认值完整性。
//
// 这一组守一个**静默失效**的坑：`mergeSettings` 只接受"默认值里已有的键"，
// 所以任何**没写进默认值**的设置项，读回时都会被悄悄丢掉 ——
// 表现是"面板上拉高、刷新页面就回到默认"，而且没有任何报错。
//
// 曾经真实发生过：`EFFECT_DEFAULTS`（core）加了 `spinWritesPerSec` / `spinSmooth`，
// 而 `DEFAULT_SETTINGS.effect`（client）是另一份各自维护的副本、没跟上，
// 于是"自转顺滑度"这个滑杆调了不生效。
//
// 现在 client 直接复用 `EFFECT_DEFAULTS`，从根上消除了重复。这里守住两件事：
//   ① 两个必须真的**同步**（防止将来又拆成两份）；
//   ② 会被玩家通过面板改动的项都必须存在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { EFFECT_DEFAULTS } from '../src/core/unit-effect.js';

const CLIENT_SRC = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

/** 面板上可调、因而**必须**能被持久化的设置项。 */
const PERSISTED = [
  'enabled',
  'strength',
  'spinPeriod',
  'spinAxis',
  'spinWritesPerSec',
  'spinSmooth',
  'movingSpeedScale',
  'deadBounce',
  'deadSpinScale',
  'hopAmplitude',
  'pulsesPerSecond',
];

test('★ client 必须复用 core 的 EFFECT_DEFAULTS（不能各自维护副本）', () => {
  // 源码级断言：这是"唯一来源"这个性质的直接检验
  assert.match(CLIENT_SRC, /effect:\s*EFFECT_DEFAULTS/,
    'DEFAULT_SETTINGS.effect 应当直接引用 EFFECT_DEFAULTS；'
    + '若又抄成副本，两份默认值会再次漂移，缺的键会被 mergeSettings 静默丢弃');
});

test('会被面板改动的项都在默认值里（否则存了也会被丢）', () => {
  const missing = PERSISTED.filter((k) => !(k in EFFECT_DEFAULTS));
  assert.deepEqual(missing, [],
    `这些设置项不在默认值里 ⇒ 读回时会被静默丢弃：${missing.join(', ')}`);
});

test('数值型设置项的默认值是有限数字（挡住 NaN / undefined 这类坏默认值）', () => {
  const numeric = ['strength', 'spinPeriod', 'spinWritesPerSec', 'movingSpeedScale',
    'hopAmplitude', 'pulsesPerSecond', 'squashDepth', 'flipDead'];
  for (const k of numeric) {
    assert.equal(typeof EFFECT_DEFAULTS[k], 'number', `${k} 应是数字`);
    assert.ok(Number.isFinite(EFFECT_DEFAULTS[k]), `${k} 应是有限数字`);
    assert.ok(EFFECT_DEFAULTS[k] > 0 || k === 'deadSpinScale', `${k} 应为正数`);
  }
});

test('spinAxis 只能取已知的两个值（面板下拉依赖它）', () => {
  assert.ok(['vertical', 'screen'].includes(EFFECT_DEFAULTS.spinAxis),
    `spinAxis 默认值应合法，实际 ${EFFECT_DEFAULTS.spinAxis}`);
});

test('★ 默认转速倍数为 1（全场转速一致 = "整齐"）', () => {
  assert.equal(EFFECT_DEFAULTS.movingSpeedScale, 1);
});

test('默认是绕竖轴（梗图效果本身）', () => {
  assert.equal(EFFECT_DEFAULTS.spinAxis, 'vertical');
});

test('默认不做支点补偿（两次浮空事故的修复不能被改回去）', () => {
  assert.equal(EFFECT_DEFAULTS.spinPivot, false,
    '默认必须是 false —— 打开会移动 pivot/position，实测两次都把单位搞浮空');
});
