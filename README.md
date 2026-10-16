# stronghold-spin-bounce

> 「粥友的酒」风格的**压扁—回弹 + 绕竖直轴自转**特效，为《[卫戍协议：盟约](https://github.com/sganggs/Stronghold-Protocol)》网页版制作的
> **合法 `trusted` 插件**（不改游戏任何文件）。
> 所有我方与敌方单位都在自己的格子里同步起伏，同时绕竖直轴转；转向背面时会换成**真正的背面立绘**。

---

## ★ 本项目建立在 CyanFish 的工作之上

**本项目的核心实现是从 [CyanF1sh / Stronghold-Protocol-CyanModPack](https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack)
移植而来的。没有他的工作，这个插件不可能做成。**

具体移植了什么，逐项列清楚：

| 本仓库 | 来源（CyanModPack） | 内容 |
| --- | --- | --- |
| `src/core/dj.js` | `mods/cyanfish.dj-all/client/config.js`<br>`mods/cyanfish.dj-all/client/engine-pixi.js` | **压缩/旋转的逐帧数学**：`squashProfile` 三角波（40% 压 + 40% 弹 + 20% 停）、`frameFactors` 的 `yK/xK/axisK`、`DEFAULT_GLOBAL` 的全部默认值 |
| `src/integrations/host.js` | 同上，`resolveHost` / `eachView` / `collectUnits` | **怎么在宿主里找到渲染层**：用 `globalThis.__SP_VIEW__.raw.debug` 的 `views / penViews / leader` 作为抓手 |
| `src/client.js` 的帧驱动 | 同上，`TICK_PRIORITY` / `BUDGET` / `bind()` | **帧驱动方式**：ticker 优先级 −20、挂上后停掉自建 rAF、每帧写入预算 |
| `src/integrations/units.js` 的换面 | `mods/cyanfish.dj-all/client/frontback.js` | **转身换面**的判据与禁区（强控/死亡/备战不碰、`hasBack` 决定能不能换、`setDir` 后逐值还原朝向指示） |
| `docs/performance-notes.md` | 同上，逐字段表与注释 | 宿主每帧覆写哪些 transform 字段（`scale free · rot free` 等） |

**他解决了我卡住的两个根本问题：**

1. **怎么可靠地拿到单位** —— 我原来包装 `PIXI.Container.prototype.addChild` 从场景图里"猜"，
   连踩三个时序坑（详见 `src/integrations/host.js` 抬头）。而宿主**本来就给了正式抓手**
   （`public/js/ui/fieldHost.js` 的 `__SP_VIEW__`），是他指出来的。
   而且单位来自**三处**（战斗 `views` / 预览栏 `penViews` / 首领 `leader.view`），
   遍历单个容器必然漏 —— 这一点我完全没想到。

2. **动画该写成纯时间函数** —— 我原来用欠阻尼弹簧积分，于是不得不叠上共享时基、死区、
   收敛调参、写回阈值、量化台阶一大堆机制来收拾它带来的漂移与不同步。
   他的写法是**给定时刻直接算姿态**：无状态 ⇒ 不漂移、天然同场同步、连"要不要省写入"这个问题都不存在。
   移植后我的代码删掉了整类复杂度。

另外，**他踩过并记录下来的坑我直接省掉了**：`setDir()` 会顺手改写朝向指示（地面那枚橙色 `›`）
必须逐值还原；135 个背面骨架里只有 4 个自带 `Die` 剪辑所以死亡时必须退回正面；
伤害数字在轴转模式下会因横向压扁产生**撕裂毛边**（`24px` 位图字体压到零点几倍宽时
抗锯齿采样率不足 1 采样/像素）……这些都是他实测得出并写在源码注释里的。

**移植原则**：凡是照抄的地方，注释里都写明来源文件与行号；`tests/dj.test.js` 的 16 项测试
**逐值对照来源的公式**，让"照抄"这件事变成可验证的，而不是"我理解的它"。

---

## 与 CyanModPack 的区别

它是**平台补丁 + 14 个 Mod**：需要先改 `public/**` 的平台接缝，且对齐上游 **0.2.6**。
本项目走的是**另一条路**：

| | CyanModPack | 本项目 |
| --- | --- | --- |
| 接入方式 | 平台覆盖层（改 `public/**`） | **`trusted` 插件**，不改任何游戏文件 |
| 上游版本 | 0.2.6 | 0.3.0（可用插件系统） |
| 游戏内功能范围 | 14 个 Mod（界面/聊天/音乐/整活…） | 只做这一个特效 |
| 上游更新后 | 需重跑覆盖层 | 插件机制不受影响 |

两条路各有取舍：它的覆盖面广得多；本项目的优势是**零侵入**、跟着上游更新不失效。
**本项目不是它的替代品**，只是在它的成果上做了一个不同接入方式的实现。

> 如果你想要的是完整的一整套体验（而不只是这一个特效），**建议直接用 CyanModPack**。

---

## 效果参数

默认值**逐字沿用参考实现**：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `spinMode` | `axis` | `axis` 绕竖直轴（梗图效果）／`squash` 仅压缩／`flat` 平面内转 |
| `spinPeriod` | 67 帧 ≈ 1.12 秒 | 自转一圈 |
| `squashPeriod` | 38 帧 ≈ 0.63 秒 | 一次压扁—回弹 |
| `squashMinPct` | 60% | 高度压到多少 |
| `widthMaxPct` | 110% | 宽度撑到多少（压扁时的体积补偿，这就是"Q弹"的来源） |

还有两个"整齐"开关：`syncBounce`（全场同步起伏）、`syncSpin`（全场角度一致），默认都开。

### 绕竖直轴是怎么表达的

2D 贴图无法真的绕 Y 轴转，唯一可行的表达是**横向压扁**：

```
横向 = 原宽 × cos θ
θ = 0    → +1     完整正面
θ = 90°  →  0     侧对着你（宽度归零）
θ = 180° → −1     镜像 ⇒ 露出背面
```

`cos θ` **允许为负**，宽度过零时自然镜像 —— 这就是"翻转"。
同时宽度在压扁段还会乘上体积补偿（到 110%），所以横向有两个来源相乘。

**光靠镜像只做到"看起来翻过来"**，所以另外接上了宿主的 `view.setDir()` 换成**真正的背面立绘**
（`public/js/render/units.js:1269`，原地换骨架、不闪占位钻石）。

> 注意：竖直轴模式下**不写 `rotation`** —— 写它会让整张贴图在屏幕里倾斜，破坏轴转的读感。
> 只有平面内模式才写。这是参考实现的口径。

---

## 安装

```bash
# 1) 拷进游戏目录
scp -r plugin/spin-bounce/ <服务器>:<游戏目录>/plugins/

# 2) 权限（否则插件会以 PLUGIN_UNREADABLE 被跳过）
sudo find plugins/spin-bounce -type d -exec chmod 755 {} \;
sudo find plugins/spin-bounce -type f -exec chmod 644 {} \;

# 3) 打包 + 校验
sudo node tools/plugin.mjs pack spin-bounce
sudo node tools/plugin.mjs check spin-bounce      # 期望 0 problem / 0 warning

# 4) 把锁文件哈希 pin 进 plugins/config.json 的 trusted
#    （trusted 插件必须 pin，否则服务端拒绝加载）

# 5) 重启游戏服务
sudo systemctl restart stronghold
```

服务端还需要 `SP_PLUGIN_SCRIPTS=trusted`。若游戏只绑定 `127.0.0.1`，
**不需要 `trusted-force`** —— 那道闸门检查的是内核绑定的地址，不是 HTTP 对端。

然后**在房间里启用它并同意**（每个内容集同意一次，存在 `localStorage` 里）。

### 构建

源码保持多文件（可单测、可复用），**发布产物是单文件**：

```bash
node tools/build-plugin.mjs          # src/ → plugin/spin-bounce/client.js
node tools/build-plugin.mjs --check  # 提交前确认产物是最新的
npm test                             # 122 项测试
```

> ⚠️ **为什么必须打包**：内容集只下发 `entry.client` **一个文件**，本地相对 `import` 没有解析途径
> （实测依赖路径全部 404）。详见 [docs/bundling-constraint.md](docs/bundling-constraint.md)。

### 作为库使用

`src/core/dj.js` 与 `src/core/physics.js` 不依赖任何渲染库，
只要求目标对象有 `scale` / `rotation` 可写属性：

```js
import { djFactors, djApply } from './src/core/dj.js';

const st = {};                              // 每目标一份：记下基准 scale/rotation
function frame(target, t) {
  djApply(target, st, djFactors(DEFAULT, t));   // t = 时刻（秒）
}
```

---

## 音乐

**独立开关**，默认关闭。音源**不随本仓库分发**（版权 + 体积）—— 把文件放进游戏的静态目录即可，
插件会按候选路径自动找到：`/sp-music/spin-bounce.{m4a,mp3,ogg}`。

详见 [audio/README.md](audio/README.md)。

> 为什么音频不能随插件分发：`trusted` 插件只下发 `entry.client` 一个文件，
> 插件目录里的音频取不到（同 `docs/bundling-constraint.md`）。

---

## 性能

这个插件是**每帧改写所有单位的变换**，属于最容易拖慢游戏的那一类。
排查过程中得到的结论都写在 [docs/performance-notes.md](docs/performance-notes.md)，要点：

- **不碰被裁切的单位** —— 宿主的 `_cull()` 对屏幕外单位既不画也不动画，写了纯属浪费，
  还会占掉每帧预算
- **加载期让路** —— 用宿主自己的负载判据（`stats().lod`），它 ≥2 说明游戏已认为设备吃紧
- **帧驱动照抄参考实现** —— ticker 优先级 −20、单一驱动、每帧写入预算
- **热路径零分配** —— 每帧每单位返回新对象会直接推高 GC

> ★ 一条反直觉但重要的教训：**只看性能追踪里自己的耗时占比会得出错误结论**。
> 实测本插件在 4 次长任务里只占 0.02~0.07ms，却确实拖慢了整个过程 ——
> 因为**持续性的每帧开销不会出现在长任务里**。
> 定论靠的是 **A/B 对照**：装一个空插件（`client.js` 只有一行 `console.log`）对比。
> 这个办法已固化成工具：[tools/control-plugin/](tools/control-plugin/)。

---

## 已知的、属于游戏自身的问题

进战斗及每回合开始时有一次性卡顿（实测 `Decode Image` 累计约 250ms + GC 173ms，
4 次长任务 105/267/363/267ms，全部集中在单位/敌人**首次出现**的时刻）。
**这与本插件无关** —— 用空插件对照同样出现。详见 `docs/performance-notes.md`。

---

## 测试

```bash
npm test        # 122 项
```

覆盖：移植数学的**逐值对照**（`tests/dj.test.js`）、渲染层抓手的解析与降级（`host.test.js`）、
换面的判据与禁区（`facing.test.js`）、面板交互（`panel.test.js`）、
弹簧性质（`physics.test.js`）、控制器行为（`unit-effect.test.js`）、设置项完整性（`settings.test.js`）。

> 这些测试确实抓到了真 bug。几个值得记的：
>
> - **`WRITE_EPSILON` 取太小**（1e-4）：弹簧收敛后的残余形变约 5e-4，导致每帧照写不误，
>   性能修复形同虚设 —— 阈值必须按**可见精度**取（≥1e-3），不是按浮点噪声。
> - **测试断言了错误行为**：有一条测试写着"设置旋转支点会同时平移对象，视觉位置不变"，
>   而那个行为正是导致**单位全部浮空**的原因。测试替身/断言写错比没有测试更危险。
> - **`hopVelocityFor` 的导数多乘了一个因子 2** —— 照抄参考实现时把错误一起抄了过来，
>   已用数值微分校验修正（参考实现本身这一点是错的，值得反馈）。
> - **移植数学时浮点不可严格比较**：`squashProfile(0.6)` 是 `0.5000000000000001`，
>   断言要用容差。

---

## 许可

**GPL-3.0-or-later** —— 全文见 [LICENSE](LICENSE)。

**为什么是 GPL 而不是 MIT**：本项目的核心实现**移植自另一个 GPL 项目**
（[CyanF1sh / Stronghold-Protocol-CyanModPack](https://github.com/CyanF1sh/Stronghold-Protocol-CyanModPack)，
Copyright (C) 2026 CyanFish），且与上游游戏同许可 ⇒ 没有选宽松许可证的余地。

每个源文件头部都有 `SPDX-License-Identifier` 与版权行；**移植来的文件额外标明来源文件与改动范围**
（GPL-3.0 第 5 条的要求）。

### 版权与来源汇总

完整的逐项移植清单、来源文件对应关系、以及参考实现实测得出的结论，
见 **[NOTICE.md](NOTICE.md)**。要点：

| | |
| --- | --- |
| 本项目代码 | Copyright (C) 2026 Harekasa |
| 移植部分 | Copyright (C) 2026 CyanFish（CyanModPack） |
| 游戏本体 | [sganggs / Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) |
| 游戏素材 | 归各权利人所有，**不在本仓库内** |

**禁止盈利**（收费开服、付费房间、广告、打赏、打包进收费产品）—— 仅供学习、研究和个人非商业娱乐。
