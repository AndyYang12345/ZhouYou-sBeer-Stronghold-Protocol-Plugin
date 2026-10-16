#!/usr/bin/env bash
# tools/deploy.sh — 安全地把插件部署到游戏服务器。
#
# ★ 这个脚本存在的**唯一理由**是：不要在有玩家在线时重启服务。
#   我自己犯过这个错 —— 明明先查了 `humans=3`，看了一眼还是重启了，打断了别人的对局。
#   所以把判断写成**硬规则**，而不是每次靠临场判断。
#
# 用法：
#   HOST=ubuntu@1.2.3.4 GAME_DIR=/opt/stronghold-protocol ./tools/deploy.sh
#
#   HOST=... GAME_DIR=... ./tools/deploy.sh --status       # 只看有没有人，不做任何事
#   HOST=... GAME_DIR=... ./tools/deploy.sh --stage-only   # 只放文件+pin，**不重启**（有人时用这个）
#   HOST=... GAME_DIR=... ./tools/deploy.sh --force        # 明知有人也要重启（会打断对局）
set -euo pipefail

HOST="${HOST:?请设置 HOST，例如 ubuntu@1.2.3.4}"
GAME_DIR="${GAME_DIR:?请设置 GAME_DIR，例如 /opt/stronghold-protocol}"
PLUGIN_ID="${PLUGIN_ID:-spin-bounce}"
SERVICE="${SERVICE:-stronghold}"
# 服务器上的 node 路径：默认自动探测（游戏常用自带 Node，不一定是 PATH 里的 node）
NODE_BIN="${NODE_BIN:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

mode="deploy"
case "${1:-}" in
  --status)     mode="status" ;;
  --stage-only) mode="stage" ;;
  --force)      mode="force" ;;
  "") ;;
  *) echo "未知参数：$1"; exit 2 ;;
esac

# ---- 服务器占用情况（唯一的判断依据）----------------------------------------
read_health() {
  ssh "$HOST" "curl -s http://127.0.0.1:3000/healthz" 2>/dev/null \
    | python3 -c '
import sys, json
try:
    h = json.load(sys.stdin)
except Exception:
    print("0 0 0"); raise SystemExit
print(h.get("matches", 0), h.get("humans", 0), h.get("rooms", 0))
'
}

read -r MATCHES HUMANS ROOMS <<<"$(read_health)"
echo "服务器状态：对局 $MATCHES · 真人 $HUMANS · 房间 $ROOMS"

if [ "$mode" = "status" ]; then
  [ "$HUMANS" -eq 0 ] && echo "→ 空闲，可以部署" || echo "→ ★ 有真人在线，不要重启"
  exit 0
fi

# ★ 硬规则：只要有一个真人，就不重启。
#   `--stage-only` 例外 —— 它**不重启**，只把文件放上去并 pin，对正在进行的对局无影响。
if [ "$HUMANS" -gt 0 ] && [ "$mode" = "deploy" ]; then
  echo
  echo "★ 拒绝重启：有 $HUMANS 个真人在线。"
  echo
  echo "  两个选择："
  echo "    · 只放文件、不重启（对局不受影响，新对局生效）：$0 --stage-only"
  echo "    · 等没人的时候再跑一次：$0"
  echo "    · 确认无妨、要立刻重启（会打断对局）：$0 --force"
  exit 1
fi

# ---- 服务器上的 node（自动探测；不写死路径）-----------------------------------
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ssh "$HOST" '
    if command -v node >/dev/null 2>&1; then command -v node; exit 0; fi
    for c in /opt/stronghold-node/*/bin/node /usr/local/bin/node /usr/bin/node; do
      [ -x "$c" ] && { echo "$c"; exit 0; }
    done
    ls -1d /opt/*node*/bin/node 2>/dev/null | head -1
  ' | head -1)"
  if [ -z "$NODE_BIN" ]; then
    echo "★ 找不到服务器上的 node。请显式指定：NODE_BIN=/path/to/node $0"
    exit 1
  fi
  echo "服务器 node：$NODE_BIN"
fi

# ---- 打包（本地）--------------------------------------------------------------
echo "→ 构建单文件产物"
node "$HERE/tools/build-plugin.mjs"
node "$HERE/tools/build-plugin.mjs" --check >/dev/null

# ---- 上传 ---------------------------------------------------------------------
echo "→ 上传到 $HOST:$GAME_DIR/plugins/$PLUGIN_ID"
ssh "$HOST" "mkdir -p /tmp/sb-deploy"
rsync -a --delete "$HERE/plugin/$PLUGIN_ID/" "$HOST:/tmp/sb-deploy/$PLUGIN_ID/"

# ---- 就位 + 打包 + pin --------------------------------------------------------
echo "→ 就位、打包、写入锁哈希"
ssh "$HOST" "set -e
cd '$GAME_DIR'
sudo rm -rf 'plugins/$PLUGIN_ID'
sudo cp -r '/tmp/sb-deploy/$PLUGIN_ID' 'plugins/'
# 权限：目录 755 / 文件 644 —— 否则插件会以 PLUGIN_UNREADABLE 被跳过
sudo find 'plugins/$PLUGIN_ID' -type d -exec chmod 755 {} \\;
sudo find 'plugins/$PLUGIN_ID' -type f -exec chmod 644 {} \\;
sudo '$NODE_BIN' tools/plugin.mjs pack '$PLUGIN_ID'
sudo '$NODE_BIN' tools/plugin.mjs check '$PLUGIN_ID'
NEW=\$(sudo python3 -c \"import hashlib;print(hashlib.sha256(open('plugins/$PLUGIN_ID/plugin.lock.json','rb').read()).hexdigest())\")
sudo python3 - <<PY
import json
p = 'plugins/$PLUGIN_ID/../config.json'
d = json.load(open(p))
d.setdefault('trusted', {})['$PLUGIN_ID'] = '\$NEW'
json.dump(d, open(p, 'w'), indent=2)
print('  pinned', '$PLUGIN_ID', '\$NEW'[:16] + '…')
PY
"

# ---- 重启 + 验证 --------------------------------------------------------------
if [ "$mode" = "stage" ]; then
  echo
  echo "✓ 文件已就位并 pin，**未重启服务**。"
  echo "  正在进行的对局不受影响；服务下次重启后新版本生效。"
  echo "  想立刻生效：等没人的时候跑 $0"
  exit 0
fi

if [ "$mode" = "force" ] && [ "$HUMANS" -gt 0 ]; then
  echo "→ --force：重启中（★ 这会打断 $HUMANS 个真人的对局）"
fi
echo "→ 重启服务"
ssh "$HOST" "sudo systemctl restart '$SERVICE' && sleep 7"
echo "→ 验证"
ssh "$HOST" "cd '$GAME_DIR'
sudo journalctl -u '$SERVICE' --since '-1 min' --no-pager 2>/dev/null | grep -iE '$PLUGIN_ID' | tail -3
curl -s http://127.0.0.1:3000/plugins/index.json | python3 -c \"
import sys, json
for p in json.load(sys.stdin)['plugins']:
    if p['id'] == '$PLUGIN_ID':
        print('  状态:', p['status'], '| 名称:', p.get('name'))
\""
echo "✓ 完成"
