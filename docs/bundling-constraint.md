# 硬性约束：trusted 插件的 `entry.client` 必须是自包含单文件

**这是本插件为什么要打包的直接原因，也是所有想写 trusted 插件的人都会踩的坑。**

## 现象

把代码拆成多个文件（`client.js` 相对 import `core/x.js`、`integrations/y.js`），
插件在服务端 `loaded` 正常，房间也能开启，但玩家侧会看到：

> **房间的插件内容未能通过校验，请刷新页面重试**

## 根因

内容集（content set）**只下发入口那一个文件**。实测：

```
/cs/<cs>/scripts/spin-bounce/client.js              → 200
/cs/<cs>/scripts/spin-bounce/core/physics.js        → 404
/cs/<cs>/scripts/spin-bounce/integrations/audio.js  → 404
```

内容集描述符里 `sources` 的键就是**入口声明的那一个**：

```python
p.sources 的键: ['client.js']
manifestSource 哈希 == 清单 pin ✓     # 描述符本身没问题
```

`shared/plugins/scriptLoad.js` 的 `linkScript` **刻意不改写 `entry.client` 的字节**
（只对 `entry.sim` / `entry.meta` 链接 `sp:sdk@1`），所以本地相对 import 没有任何解析途径。

这是确定性校验的必然结果：描述符必须能覆盖脚本的**每一个字节**，所以不能有描述符之外的依赖。
官方模板（`plugins/_template/script/`）因此也是单一入口、只用 `sp:sdk@1`。

## 处置

源码保持多文件（可单测、可复用），**发布产物是单文件**：

```bash
node tools/build-plugin.mjs          # src/ → plugin/spin-bounce/client.js
node tools/build-plugin.mjs --check  # 提交前确认产物是最新的
```

打包器会**检测顶层声明重名**并明确报错——平铺两个同名 `const` 会直接 SyntaxError，
与其产出坏包不如当场失败（本项目就因此抓到 `physics.js` / `unit-effect.js` / `audio.js`
三处都声明了 `num`，已改名为 `physNum` / `fxNum` / `audNum`）。

## 值得向上游提的一点

如果上游希望 trusted 插件支持多文件，最小改动是：**允许清单声明额外的运行时依赖文件**，
由服务端把它们一并收进内容集描述符（`sources` / `browserSources` 已经是一张 rel→文本 的表，
机制上是现成的）。这样作者就能像普通 ES 模块那样组织代码，而不必人人自己写打包器。
