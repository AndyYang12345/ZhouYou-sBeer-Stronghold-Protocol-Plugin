# 空白对照插件（诊断工具）

怀疑"卡顿/变慢是不是插件的锅"时，**这个空白插件是几分钟内就能定论的办法**。

## 怎么用

```bash
# 1) 把空白插件拷到游戏目录并装好
ssh <服务器> 'cd <游戏目录>
  sudo cp -r /path/to/tools/control-plugin/empty/ plugins/empty-control
  sudo find plugins/empty-control -type d -exec chmod 755 {} \;
  sudo find plugins/empty-control -type f -exec chmod 644 {} \;
  sudo node tools/plugin.mjs pack empty-control
  # 2) 把锁文件哈希 pin 进 plugins/config.json 的 trusted
  sudo node -e "
    const fs=require(\"fs\"),c=require(\"crypto\");
    const h=c.createHash(\"sha256\").update(fs.readFileSync(\"plugins/empty-control/plugin.lock.json\")).digest(\"hex\");
    const p=\"plugins/config.json\", d=JSON.parse(fs.readFileSync(p));
    d.trusted[\"empty-control\"]=h; fs.writeFileSync(p, JSON.stringify(d,null,2));
  "
  sudo systemctl restart stronghold'

# 3) 建一个启用它的房间，和启用真插件的房间各打一局，比较
```

## 怎么读结果

| 观察 | 结论 |
|---|---|
| 空白插件**也**慢/卡 | 问题在插件系统或游戏本身，不在你的插件代码 |
| 空白插件**快**，真插件慢 | 确定是你的插件代码 —— 去查每帧开销 |

## 为什么这个办法有效

它把"插件系统引入的固定成本"和"你的插件代码引入的变动成本"**分离开了**。
这一步能在几分钟内排除掉一半可能性 —— 比读代码、比看 profile 都直接。

> ★ 本项目就是靠它定位的：空白插件 1 秒内进战斗，真插件明显更慢
> ⇒ 确定是插件代码的问题。而**只看 trace 里自己的耗时占比会得出错误结论**
> （实测插件在 4 次长任务里只占 0.02~0.07ms，却确实拖慢了整个过程）——
> 因为**持续性的每帧开销不会出现在长任务里**。
>
> 详见 `docs/performance-notes.md`。

## 注意

- `empty/` 里**没有** `client.js`：`trusted` 类的 `entry` 是可选的。若要测"空入口"这一档，
  再加一个只有一行 `console.log` 的 `client.js` 并写 `"entry": { "client": "client.js" }`。
- 用完记得删掉插件目录，并从 `plugins/config.json` 的 `trusted` 里移除它的哈希。
