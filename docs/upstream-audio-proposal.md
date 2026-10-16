# 上游提案：让插件能提供自定义音乐

> 用途：向 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 提 issue 或 PR 时的正文。
> 结论写在最前面，证据在后面，改动方案在最后。**欢迎直接抄用。**

---

## 结论

0.3.0 的插件系统目前**无法提供任何音频**，三重约束叠加导致（不是配置问题）：

1. UI 插件的响应头 `UI_FRAME_CSP`（`shared/plugins/ui.js`）**没有 `media-src`**，而 `default-src 'none'` 会兜底 —— `<audio>` 一律被拦；
2. 同一个 CSP 的 `connect-src 'none'` 断掉 `fetch` / XHR / WebSocket，插件连自己的文件都取不回；
3. iframe 是 `sandbox="allow-scripts"` **且无 `allow-same-origin`** → 不透明来源，同源相对路径也只是跨源请求。

而 `script` / `trusted` 类虽是 `.js`（能在主页面跑），但默认关闭、需服主 pin + 每个玩家同意，公网反代还需 `trusted-force` —— 用它来放一首 BGM，负担与收益不成比例。

**但值得注意的是：游戏自己的 BGM 通道本来就是数据驱动的，接上它几乎不需要新机制。**

---

## 证据

### BGM 已经是"查表播放"

```js
// public/js/audio.js
export function bgmKeyFor(route, pub, combatTrack = null) { … }        // 路由/阶段 → key
export function resolveBgm(manifest, key) {                            // key → {intro, loop}
  const a = manifest?.audio;
  if (!a || !key) return null;
  let t = null;
  if (key.startsWith('boss:')) t = a.bossBgm?.[key.slice(5)] || a.bgm?.boss;
  else if (key.startsWith('combat:')) t = a.bgm?.combatAlts?.[…] || a.bgm?.combat;
  else if (key === 'unite') t = a.bgm?.unite || a.bgm?.combat;
  else t = a.bgm?.[key];
  if (!t || typeof t.loop !== 'string') return null;
  return { intro: typeof t.intro === 'string' ? t.intro : null, loop: t.loop };
}
```

也就是说：**`manifest.audio.bgm` 就是音乐注册表**，`AudioManager.playBgm()` 消费它。任何能进入这张表的音频，都自动获得音量滑杆、静音、后台暂停、淡入淡出——不需要新的播放器代码。

### 素材清单是普通静态文件

`data/assets.json` 由静态服务直接下发，不属于 `skip_render` 的特殊路径。也就是说"往清单里加一条"在机制上不存在障碍，缺的只是**约定**：插件声明自己的音频，服务器把它并进清单（或让客户端在解析时叠加）。

### 插件的素材已经走普通静态路由

`cosmetic` 类插件可以带 `.mp3` / `.ogg`（`shared/plugins/manifest.js` 的文件类型表与 `PERMISSIONS`），并且通过 `/p/<id>/<hash8>/<path>` 下发 —— **那条路由不带 `UI_FRAME_CSP`**（只有 `f.frame` 的文件才带）。所以插件的音频文件本身是可取的，问题只在"主页面怎么知道它、以及怎么把它交给音频系统"。

---

## 建议的改动（最小、向后兼容）

### 1. 清单新增一个音频字段

`plugin.json`（`content` / `cosmetic` 类，或新增 `audio` 角色）允许声明：

```json
{
  "class": "cosmetic",
  "permissions": ["assets.add"],
  "audio": {
    "bgm": { "combat": { "loop": "audio/battle.mp3" },
             "lobby":  { "loop": "audio/lobby.mp3" } }
  }
}
```

沿用既有的"路径在文件夹内"校验（`isPackPath`）与类型白名单（`.mp3` / `.ogg`），无需新校验器。

### 2. `resolveBgm` 之前叠加一层

不必改 `resolveBgm` 本身 —— 在**美术清单组装的地方**（`public/js/content.js` 已经在对 `manifest.audio` 做叠加的那条路径上）把插件声明的 `audio.bgm` 合并进去即可。这样：

- 原版行为完全不变（没有插件时清单不动）；
- 插件音乐自动继承音量/静音/后台暂停；
- 房间范围的插件由房主的 `vs` 集合决定，天然与现有的"房主开启、全员校验"一致；
- **不需要给 UI 插件放开 CSP** —— 沙箱边界一条都不用动。

### 3. （可选）UI 插件的只读音量信息

如果希望界面插件能显示"正在播放"或提供音量控件，可以给 `hostState` 的公开子集加一个只读字段（如 `audio: { playing, key }`），仍然不给网络能力。

---

## 为什么这个方案值得做

- **改动面小**：一个清单字段 + 一处清单组装时的叠加，不碰 CSP、不碰沙箱、不碰 `AudioManager`；
- **风险低**：默认无插件时行为逐字节不变，golden 结果不受影响；
- **收益明确**：外部音乐本来就是社区长尾需求（梗曲、服务器主题曲、活动 BGM），现在只能靠改游戏文件，一改就与更新机制冲突（`MANIFEST.json` 校验会让更新包拒绝启动）；
- **与既有设计一致**：语言包、外观、数值都已经"插件声明 + 服务器校验 + 客户端叠加"，音频只是同一模式的第 N 个实例。

## 相关的现状补充（供维护者参考）

- 直接修改 `public/` 下的随包文件会导致下一次更新包**拒绝启动**（`server/update.js` 的 `affectsRuntime`），所以外部音乐目前只能靠玩家自建脚本，无法作为可分发的插件；
- `public/` 是静态目录，任何**新增**文件都不受清单校验影响，也不在 `UPDATE.json` 的 `removed` 列表里 —— 这一点已经足以让"素材型插件"存在，缺的只是清单接线。
