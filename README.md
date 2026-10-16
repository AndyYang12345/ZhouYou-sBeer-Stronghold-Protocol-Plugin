# stronghold-spin-bounce

> 「粥友的酒」风格的**弹跳 + 自转**特效，为《[卫戍协议：盟约](https://github.com/sganggs/Stronghold-Protocol)》网页版制作。
> 所有我方与敌方单位都在自己的格子里一下一下地被压扁再回弹，同时持续自转；敌方单位边行进边弹。

核心是一个**欠阻尼弹簧**：压下去之后会过冲成拉伸再回弹，这才是"Q弹"而不是"匀速伸缩"。

本项目同时可以作为**独立的 2D 形变库**使用 —— `src/` 不依赖任何渲染库，只要求目标对象有
`scale` / `rotation` / `pivot` 三个可写属性。

```
src/physics.js        弹簧、体积守恒缩放、离地弹跳（纯函数，可单测）
src/unit-effect.js    把三者组合成"单位特效"（不依赖渲染库）
integrations/         与具体游戏的接线（知道游戏内部结构的那一层）
tests/                27 项性质测试
docs/                 上游提案等
```

## 效果参数

默认值沿用参考实现（已在真机验证过手感）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `strength` | 1.15 | Q弹强度，越大压得越扁 |
| `spinPeriod` | 2.7 秒 | 自转一圈的时长；敌方单位默认 ×0.85（行进中更欢快） |
| `pulsesPerSecond` | 2 | 每秒挤压几次 |
| `hopAmplitude` | 0.115 | 离地弹跳幅度（以模型高度为单位） |
| `spinAxis` | `vertical` | `vertical` 竖轴自转（梗图效果）／`screen` 屏幕平面内转 |
| `deadBounce` | `false` | 死亡后是否继续弹跳 |
| `deadSpinScale` | 1 | 死亡后自转速度倍数（**死亡继续旋转**） |

弹簧常数在 `src/physics.js` 的 `SPRING_DEFAULTS`：刚度 170、阻尼 8.5。

## 为什么是"贴纸翻转"而不是真 3D 自转

参考实现是**真 3D**（GLB 有几何体，`rotation.y` 转的是真模型）。但游戏里的单位是 **2D Spine 贴图**：

- 2D 容器的 `rotation` 只能绕 **Z 轴**（屏幕平面内转，等于"躺倒"）；
- Spine 的 `skew` 能模拟 Y 轴旋转，但贴图会**斜切撕裂**，不是真 3D。

所以竖轴自转用**「水平镜像 × 侧倾」**近似：镜像让正反面交替出现，侧倾给一点透视暗示，
合起来有"转过来"的读感。这也是本项目的取舍 —— 保留了梗图的荒诞感，放弃了真 3D 的立体感。

> 如果上游将来愿意在单位渲染里支持逐单位 Y 轴变换，`spinAxis` 可以再加一个 `'real3d'` 分支。

## 安装

### 方式一：作为补丁打进游戏（当前可用）

```bash
./tools/game-patch.sh check     # 只看状态、不改任何东西
./tools/game-patch.sh apply     # 打补丁
./tools/game-patch.sh revert    # 回滚
```

补丁是**幂等**的（重复执行不会叠加），并且会在 `index.html` 里留下明确的标记块，
上游更新覆盖后重跑一次即可。

### 方式二：作为库使用

```js
import { createUnitEffect } from 'stronghold-spin-bounce';

const fx = createUnitEffect(someContainer, { spinPeriod: 2.7, strength: 1.15 });
fx.setModelHeight(64);        // 旋转支点 = 身体中部
fx.setAlive(true);

function frame(dt) {
  fx.update(dt);              // 每帧调用
}
fx.setAlive(false);           // 死亡：停弹跳，继续自转
```

## 音乐

**这是一个独立开关**，默认关闭（浏览器会拦自动播放，也没理由一进页面就吵）。
开启「弹跳自转」后，设置面板里才会出现音乐开关。

### 为什么音乐不能走插件系统

0.3.0 的插件沙箱对音频是彻底封闭的，三重约束叠加：

| 约束 | 后果 |
| --- | --- |
| `UI_FRAME_CSP` **没有 `media-src`**，而 `default-src 'none'` 兜底 | `<audio>` / `<video>` 一律被拦 |
| `connect-src 'none'` | `fetch` / XHR / WebSocket 全断，取不回自己的文件 |
| `sandbox="allow-scripts"` 且**无 `allow-same-origin`** | 不透明来源，同源路径也只是跨源 |

`script` / `trusted` 类虽是 `.js`（能在主页面跑），但默认关闭、需服主 pin + 每个玩家同意，
公网反代还要 `trusted-force` —— 用它来放一首歌，负担与收益不成比例。

### 三条可行的路

| | 方案 | 状态 |
| --- | --- | --- |
| **A** | 让游戏自己的音频系统接管（BGM 是数据驱动的：`resolveBgm(manifest, key)` 查 `manifest.audio.bgm`） | **推荐**，已写成上游提案：[docs/upstream-audio-proposal.md](docs/upstream-audio-proposal.md) |
| **B** | 插件作为素材提供者：`cosmetic` 插件可带 `.mp3`，通过 `/p/<id>/<hash8>/…` 下发，**那条路由不带 CSP** | **机制上已可行**，只差主页面知道那个 URL |
| **C** | 本插件自包含：补丁往 `index.html` 注入 `<audio id="sp-spin-music">`，音源写在 `<html data-sp-spin-music="…">` | **当前采用**，零依赖但独立于游戏音量系统 |

**方案 A 的好处**是被采纳后音乐自动继承游戏的音量滑杆、静音、后台暂停、淡入淡出 ——
比自建 `<audio>` 好得多。所以我们向上游提的就是 A。

> 音乐文件**不随本仓库分发**。请自备，或用 `data-sp-spin-music` 指向你自己的路径。

## 测试

```bash
npm test
```

27 项性质测试，覆盖守恒（体积守恒 `x²y ≡ 1`）、收敛（必然回到静止）、有界（限幅 + NaN 防护）、
稳定性（固定步长与调用频率无关、巨大 dt 不发散）、以及控制器行为（自转、死亡处理、支点、开关）。

> 这些测试在开发中确实抓到了两个真 bug：`hopVelocityFor` 的导数多乘了一个因子 2（照抄参考实现时
> 把错误一起抄了过来，已用数值微分校验修正），以及 `spinning` 判断写成了 `st.spinPeriod`
> 而正确路径是 `cfg.spinPeriod` —— 后者会让自转**完全失效**。

## 许可

代码：**GPL-3.0-or-later**（与上游《卫戍协议：盟约》一致）。

音乐、模型、贴图等第三方素材**不在本仓库内**，各自遵循原作者的授权。
本项目不包含任何官方游戏素材 —— 它只做渲染变换，用的是游戏自己已经加载好的资源。
