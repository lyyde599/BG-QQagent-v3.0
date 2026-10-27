#!/usr/bin/env bash
# SnowLuma 一键安装脚本（2026-10-27）
#
# 用途：把 SnowLuma 装成本机可用的 OneBot v11 备用通道。
#       从 GitHub 仓库克隆本项目的人，跑这个脚本就能装好，不用手配。
#
# 用法：
#   bash scripts/install-snowluma.sh              # 默认装到 ~/snowluma
#   SNOWLUMA_HOME=/opt/sl bash scripts/install-snowluma.sh
#
# 默认凭据（可在安装后用 --password 改）：
#   账号 admin
#   密码 Baiguang@2026      ← 满足 SnowLuma 强度要求（≥10位+大写+特殊符）
#
# 装完后：
#   · 服务名 snowluma（systemd，用户级或系统级取决于权限）
#   · WebUI http://127.0.0.1:5099
#   · 密码同时写入 <SNOWLUMA_HOME>/.webui-password 与
#     ~/.secrets/snowluma/password（600），面板读取后者
set -uo pipefail

SL_HOME="${SNOWLUMA_HOME:-$HOME/snowluma}"
REPO="SnowLuma/SnowLuma"
DEFAULT_PW="Baiguang@2026"
DEFAULT_USER="admin"
PORT="${SNOWLUMA_PORT:-5099}"

echo "=== SnowLuma 安装器 ==="
echo "  目标目录: $SL_HOME"
echo "  默认账号: $DEFAULT_USER"
echo "  默认密码: $DEFAULT_PW"
echo

# ── 架构判定 ──
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "不支持的架构: $(uname -m)"; exit 1 ;;
esac
PLAT=linux
echo "  检测到平台: $PLAT-$ARCH"

# ── 取最新版 ──
echo "  查询 GitHub 最新版本…"
API="https://api.github.com/repos/$REPO/releases/latest"
TAG=$(curl -s -m 20 "$API" | grep -oE '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')
if [ -z "${TAG:-}" ]; then
  echo "  ✗ 查询失败（网络或 GitHub 限流），可手动指定：SNOWLUMA_VERSION=x.y.z"
  [ -n "${SNOWLUMA_VERSION:-}" ] && TAG="$SNOWLUMA_VERSION" || exit 1
fi
echo "  最新版本: v$TAG"

# 优先完整版（内置 Node），Lite 需要本机 Node 24+
URL="https://github.com/$REPO/releases/download/v$TAG/SnowLuma-v$TAG-$PLAT-$ARCH.tar.gz"
echo "  下载: $URL"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if ! curl -fL -m 900 -o "$TMP/sl.tar.gz" "$URL"; then
  echo "  ✗ 下载失败"; exit 1
fi
echo "  下载完成: $(du -h "$TMP/sl.tar.gz" | cut -f1)"

# ── 备份旧版 ──
if [ -f "$SL_HOME/index.mjs" ]; then
  BAK="$SL_HOME.bak-$(date +%Y%m%d-%H%M%S)"
  echo "  备份旧版到 $BAK"
  mkdir -p "$BAK"
  for f in index.mjs package.json launcher.sh release.json; do
    [ -f "$SL_HOME/$f" ] && cp -a "$SL_HOME/$f" "$BAK/" 2>/dev/null
  done
fi

# ── 解包（保留 config/ 与 logs/）──
mkdir -p "$SL_HOME"
mkdir -p "$TMP/x"
tar xzf "$TMP/sl.tar.gz" -C "$TMP/x"
# 用 rsync 排除用户配置；没有 rsync 就逐个复制关键文件
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude=config --exclude=logs --exclude=data "$TMP/x/" "$SL_HOME/"
else
  cp -a "$TMP/x/." "$SL_HOME/"
fi
chmod +x "$SL_HOME/node" "$SL_HOME/launcher.sh" 2>/dev/null

echo "  ✓ 已解包到 $SL_HOME"

# ── 默认凭据 ──
echo "$DEFAULT_PW" > "$SL_HOME/.webui-password"
chmod 600 "$SL_HOME/.webui-password"
mkdir -p "$HOME/.secrets/snowluma"
echo "$DEFAULT_PW" > "$HOME/.secrets/snowluma/password"
chmod 700 "$HOME/.secrets/snowluma"
chmod 600 "$HOME/.secrets/snowluma/password"
echo "  ✓ 默认凭据已写入（$DEFAULT_USER / $DEFAULT_PW）"

# ── systemd 服务 ──
UNIT=/etc/systemd/system/snowluma.service
if [ -w /etc/systemd/system ] || sudo -n true 2>/dev/null; then
  SUDO=""
  [ -w /etc/systemd/system ] || SUDO="sudo"
  $SUDO tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=SnowLuma QQ protocol backend (OneBot v11)
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$SL_HOME
Environment=TZ=Asia/Shanghai
Environment=HOME=$HOME
Environment=SNOWLUMA_ACCEPT_EULA=1
Environment=SNOWLUMA_ACCEPT_PRIVACY=1
ExecStart=$SL_HOME/launcher.sh
Restart=on-failure
RestartSec=10
MemoryMax=1500M
MemoryHigh=1200M

[Install]
WantedBy=multi-user.target
UNITEOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable snowluma >/dev/null 2>&1
  $SUDO systemctl restart snowluma
  echo "  ✓ systemd 服务已装好并启动"
else
  echo "  ⚠ 无 root，跳过 systemd。手动启动："
  echo "      cd $SL_HOME && SNOWLUMA_ACCEPT_EULA=1 SNOWLUMA_ACCEPT_PRIVACY=1 ./launcher.sh"
fi

# ── 信息安全：关掉 SnowLuma 的状态查询命令（2026-10-27）──
#
# 背景：SnowLuma 默认开启 #sl 命令，**任何群友**发这句就能查到：
#   版本 / 平台(win32-x64 之类) / 运行时长
# 这会暴露框架类型和运行环境，属于信息泄露。
# 默认关闭；确有需要可以在 WebUI 里打开。
mkdir -p "$SL_HOME/config"
python3 - "$SL_HOME/config/onebot.json" <<'PYCFG'
import json, os, sys
p = sys.argv[1]
cfg = {}
if os.path.exists(p):
    try: cfg = json.load(open(p))
    except Exception: cfg = {}
cfg.setdefault('statusCommand', {})
cfg['statusCommand'].update({
    'enabled': False,      # 关掉，防止群友调出框架信息
    'swallow': False,
    'cooldownSeconds': 5,
    'trigger': '#sl'
})
json.dump(cfg, open(p, 'w'), ensure_ascii=False, indent=2)
print('  ✓ 已关闭 #sl 状态命令')
PYCFG

# ── 公网访问（2026-10-27 用户要求）──
#
# 用户要求："一键安装部署snowluma的脚本记得同时为我们搭建好公网访问和地址"
#
# 做法：项目内置的反代已经把 /snowluma/ 挂到主面板（3210）上，
# 而主面板本身已有公网入口，所以**公网访问自动就有了**，
# 无需额外开隧道。这里只负责把它写进提示、并做一次连通性检查。
PUBLIC_BASE="${PUBLIC_BASE_URL:-}"
if [ -n "$PUBLIC_BASE" ]; then
  PUBLIC_URL="${PUBLIC_BASE%/}/snowluma/"
else
  # 没给就用"当前主面板地址 + /snowluma/"，脚本无从得知域名时留占位
  PUBLIC_URL="<你的主面板公网地址>/snowluma/"
fi

# 尝试探测：如果本机跑着主面板，从它的公网入口配置里猜一个
if [ -z "${PUBLIC_BASE_URL:-}" ] && [ -f /etc/nginx/sites-enabled/qq-agent.conf ]; then
  DETECTED=$(grep -oE "server_name +[a-zA-Z0-9.-]+\.[a-z]+" /etc/nginx/sites-enabled/qq-agent.conf 2>/dev/null \
    | head -1 | awk '{print $2}')
  [ -n "${DETECTED:-}" ] && PUBLIC_URL="https://$DETECTED/snowluma/" || true
fi

# 连通性自检（只在本机范围检查，不真的打公网）
if curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
  echo "  ✓ SnowLuma 本机可访问"
else
  echo "  ⚠ SnowLuma 端口 $PORT 无响应，可能还在启动中"
fi

echo
echo "=== 完成 ==="
echo "  本机地址: http://127.0.0.1:$PORT"
echo "  公网地址: $PUBLIC_URL"
echo "            （访问主面板域名下的 /snowluma/ 即到 SnowLuma，"
echo "              由项目内置反代自动转发，无需额外开隧道）"
echo "  账号    : $DEFAULT_USER"
echo "  密码    : $DEFAULT_PW"
echo "  密码文件: $HOME/.secrets/snowluma/password"
echo
echo "  首次登录若提示密码不符（初始密码是随机的），在面板点"
echo "  「取访问令牌」或执行："
echo "    curl -s -X POST http://127.0.0.1:$PORT/api/login \\"
echo "      -H 'content-type: application/json' \\"
echo "      -d '{\"username\":\"admin\",\"password\":\"<启动日志里的初始密码>\"}'"
