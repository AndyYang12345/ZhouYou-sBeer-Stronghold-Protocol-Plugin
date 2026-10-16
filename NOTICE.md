# 版权与使用声明（NOTICE）

**本项目** = 《卫戍协议：盟约》网页版的 **`trusted` 插件「弹跳自转」**
（压扁—回弹 + 绕竖直轴自转的单位特效）。

与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关联**，
也未获得其授权或认可。

---

## 1. 本项目的许可证：GPL-3.0-or-later

Copyright (C) 2026 Harekasa

本仓库自己编写的源代码与文档，以 **GNU 通用公共许可证第 3 版或（由你选择）任何更新版本**
（**GPL-3.0-or-later**）发布，全文见 [LICENSE](LICENSE)。你可以按该许可证的条件使用、修改和再分发。

**为什么是 GPL 而不是 MIT**：本项目的核心实现**移植自另一个 GPL 项目**（见下一节），
且与上游游戏同许可 ⇒ 没有选宽松许可证的余地。整仓统一 GPL-3.0-or-later。

每个源文件头部都有 `SPDX-License-Identifier: GPL-3.0-or-later` 与版权行；
**移植来的文件额外标明来源文件与改动范围**（GPL-3.0 第 5 条的要求）。

---

## 2. 主要来源：CyanFish / Stronghold-Protocol-CyanModPack

**★ 本项目的核心实现移植自 [CyanF1sh / Stronghold-Protocol-CyanModPack](https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack)
（Copyright (C) 2026 CyanFish，GPL-3.0-or-later）。没有他的工作，这个插件不可能做成。**

同许可 ⇒ 可以合法移植；移植后本项目同样以 GPL-3.0-or-later 发布，并在此致谢。

### 移植清单（逐项对应到本仓库的文件）

| 本仓库 | 来源文件（CyanModPack） | 移植内容 | 改动 |
| --- | --- | --- | --- |
| `src/core/dj.js` | `mods/cyanfish.dj-all/client/config.js`<br>`mods/cyanfish.dj-all/client/engine-pixi.js` | 压缩/旋转的**逐帧数学**：`SQUASH_IN`/`SQUASH_OUT`、`squashProfile`（三角波）、`frameFactors` 的 `yK`/`xK`/`axisK`、`DEFAULT_GLOBAL` 默认值、`MODE_FREE` 写入语义 | 只把 API 适配到本插件结构（入参改为秒 + 相位，输出对象可复用）。**数学未改动**，并由 `tests/dj.test.js` 的 16 项测试逐值对照来源公式 |
| `src/integrations/host.js` | `mods/cyanfish.dj-all/client/engine-pixi.js` | `resolveHost` / `eachView` / `collectUnits` / `hasBody` / `modelReady` / `kindOf` —— **怎么用宿主自己暴露的调试抓手**（`globalThis.__SP_VIEW__.raw.debug`）找到渲染层 | 去掉了本项目用不到的分组（item/device/hud/num/fx），只保留单位 |
| `src/client.js`（帧驱动部分） | `mods/cyanfish.dj-all/client/engine-pixi.js` | **帧驱动方式**：`TICK_PRIORITY = -20` 的挂载优先级、每帧写入预算（`BUDGET`）、挂上 ticker 后停掉自建 rAF | 预算值按本项目规模调整；其余照搬 |
| `src/integrations/units.js`（换面部分） | `mods/cyanfish.dj-all/client/frontback.js` | **转身换面的判据与禁区**：由 `cos θ` 符号决定换不换、用宿主自己的 `ctx.assets.hasBack(id)` 决定能不能换、强控/死亡/备战/替身期间绝不碰、`setDir()` 之后**逐值还原**朝向指示 | 保留同一套判据与禁区，接入本项目的特效实例 |
| `docs/performance-notes.md` | 同上各文件的注释（逐字段表） | 宿主每帧覆写哪些 transform 字段（`scale free · rot free` / `div` 等）的实测结论 | 整理成文档 |

### 他解决的问题

1. **怎么可靠地拿到单位**：宿主本来就为 dev/E2E 暴露了 `__SP_VIEW__`
   （`public/js/ui/fieldHost.js`），而单位来自**三处** —— 战斗 `views`、预览栏 `penViews`、
   首领 `leader.view`。本项目原先包装 `PIXI.Container.prototype.addChild` 从场景图里猜，
   连踩三个时序坑且必然漏掉后两处。
2. **动画该写成纯时间函数**：给定时刻直接算姿态 ⇒ 无状态、不漂移、天然同场同步，
   连带消掉了"要不要省写入"这一整类问题。

### 他实测得出、本项目直接沿用的坑

- `setDir()` 会顺手改写 `facing` / `visFacing` / `hasDir`（那是**朝向指示**，不是模型）⇒ 必须逐值还原；
- 135 个背面骨架里只有 4 个自带 `Die` 剪辑 ⇒ 死亡时必须退回正面；
- 伤害数字在轴转模式下会因横向压扁产生**撕裂毛边**（24px 位图字体压到零点几倍宽时
  抗锯齿采样率不足 1 采样/像素）⇒ 那一组恒为平面内旋转；
- `cos θ` **不做 `|cos θ|` 修正** —— 背面资产是**对称**的，而非"转过 180° 的那张图"
  （他 2026-10-14 真机实测推翻了自己早先的推断）。

以上均由他写在源码注释里，本项目在对应位置保留了同样的说明。

---

## 3. 上游游戏

- **Stronghold Protocol（`sganggs/Stronghold-Protocol`）** —— 本插件运行的游戏本体。
  本项目**不含**它的任何代码或素材；只通过它公开的运行时抓手（`__SP_VIEW__`）读取渲染对象。
  上游自身以 GPL-3.0-or-later 发布。
- **《明日方舟》/ 卫戍协议：盟约** —— 上海鹰角网络科技有限公司的作品。
  本项目是**非官方同人**，与鹰角网络无关联、未获授权或认可。

---

## 4. 第三方素材：不在本仓库内

本仓库**不包含**任何游戏素材（美术、模型、语音、音乐、字体）。

- `audio/` 目录只有说明文档；音乐文件由部署者自备并放在游戏自己的静态目录里
  （见 [audio/README.md](audio/README.md)）。
- 插件只对游戏**已经加载好的**渲染对象做变换，不加载也不分发任何素材。

各素材的授权归其各自权利人所有。

---

## 5. 使用限制

沿用上游与 CyanModPack 共同的口径：**禁止任何形式的盈利**
（收费开服、付费房间、广告、打赏、打包进收费产品）。
本项目仅供**学习、研究和个人非商业娱乐**。

若你是权利人并认为本仓库有不妥内容，请提 Issue，我们会尽快删除或下架。

---

## 6. 反馈

- 移植中的偏差或对来源的误解：欢迎提 Issue，**尤其是与 CyanModPack 行为不一致的地方** ——
  那是本项目的移植缺陷，我们应当修正。
- 关于参考实现本身的建议：请提到
  [CyanF1sh/Stronghold-Protocol-CyanModPack](https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack)。
