# audio/ — 音乐放这里（不入库）

本目录**不分发任何音频**。请自备音乐文件，理由：

- 音乐有各自的版权与授权，不应随代码仓库分发；
- 仓库保持轻量，便于别人 clone。

## 部署方式：放进游戏目录，插件会自动找到

`public/` 是游戏的静态目录，放进去就能通过 HTTP 取到。插件会**按顺序探测**以下路径，
用第一个能解码的：

```
/sp-music/spin-bounce.m4a
/sp-music/spin-bounce.mp3
/sp-music/spin-bounce.ogg
/sp-music/music.m4a
/sp-music/music.mp3
```

所以部署只要两步：

```bash
sudo mkdir -p <游戏目录>/public/sp-music
sudo cp 你的音乐.m4a <游戏目录>/public/sp-music/spin-bounce.m4a
```

**换歌**：替换文件（或改名成上面任一路径）即可，不必改代码、不必改 HTML。

**想用别的路径**：在 `<html>` 上写 `data-sp-spin-music="/你的/路径.mp3"`，
它的优先级高于上面的候选列表。

## 为什么不做成"随插件分发的音频"

`trusted` 插件只下发 `entry.client` 一个文件（见 `docs/bundling-constraint.md`），
所以插件目录里的音频**取不到** —— 这也是为什么音乐走游戏静态目录。

## 参考实现的参数（供对照）

原始参考用的是一首 187 秒的曲子，AAC 96 kbps（约 2.2 MiB），带 0.35 秒淡入与 2 秒淡出。
本项目不依赖任何具体曲子 —— 换成你自己的即可。
