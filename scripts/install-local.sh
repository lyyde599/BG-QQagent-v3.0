#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  鲸界Bridge · 本地（非 Docker）一键部署
#
#  两种部署形态，这个脚本管「直接装在宿主机上」那种：
#    · 原生部署（本脚本）：Node 直接跑，systemd 管进程
#    · Docker 部署：见 部署说明.md 的 Docker 章节
#
#  用法：
#    bash scripts/install-local.sh                     # 装到 /opt/whalebridge
#    bash scripts/install-local.sh --dir ~/whalebridge # 自定义目录
#    bash scripts/install-local.sh --port 3210         # 自定义端口
#    bash scripts/install-local.sh --no-service        # 只装不注册 systemd
#    bash scripts/install-local.sh --upgrade           # 升级已有安装（自动备份+回滚）
#    bash scripts/install-local.sh --uninstall         # 卸载（保留 data/）
# ══════════════════════════════════════════════════════════════
set -euo pipefail

TARGET_DIR="/opt/whalebridge"
PORT=3210
UNIT_NAME="whalebridge"
DO_SERVICE=1
DO_UNINSTALL=0
DO_UPGRADE=0
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %s⚠%s %s\n' "$YEL" "$RST" "$*"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

# ── 参数 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        TARGET_DIR="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --unit)       UNIT_NAME="$2"; shift 2 ;;
    --no-service) DO_SERVICE=0; shift ;;
    --upgrade)    DO_UPGRADE=1; shift ;;
    --uninstall)  DO_UNINSTALL=1; shift ;;
    -h|--help)    sed -n '2,14p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

# ── 卸载 ──
if [[ "$DO_UNINSTALL" == "1" ]]; then
  info "卸载 $UNIT_NAME …"
  sudo systemctl stop  "$UNIT_NAME" 2>/dev/null || true
  sudo systemctl disable "$UNIT_NAME" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$UNIT_NAME.service"
  sudo systemctl daemon-reload
  ok "已停止并移除服务单元"
  warn "代码目录 $TARGET_DIR 保留（data/ 里有你的配置和会话，不自动删）"
  info "确要连代码一起删：sudo rm -rf $TARGET_DIR"
  exit 0
fi

printf '\n%s鲸界Bridge · 本地部署%s\n\n' "$GRN" "$RST"

# ── 1. 环境检查 ──
info "① 检查环境"

if ! command -v node >/dev/null 2>&1; then
  die "没装 Node.js。Ubuntu/Debian: sudo apt install nodejs ｜ 或 https://nodejs.org"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node 版本太低（当前 $(node -v)），需要 >= 20"
fi
ok "Node $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  die "没装 npm（通常跟 node 一起装，检查 PATH）"
fi
ok "npm $(npm -v)"

# ── 自动识别升级场景 ──
# 目标目录已有 package.json 就是已有安装 —— 自动切到升级模式，
# 不用用户记得加 --upgrade（但加了会更明确地做备份）
if [[ -f "$TARGET_DIR/package.json" && "$SRC_DIR" != "$TARGET_DIR" ]]; then
  if [[ "$DO_UPGRADE" != "1" ]]; then
    DO_UPGRADE=1
    info "检测到已有安装在 $TARGET_DIR，自动进入升级模式"
  fi
fi

if [[ "$DO_UPGRADE" == "1" && ! -f "$TARGET_DIR/package.json" ]]; then
  die "指定了 --upgrade 但 $TARGET_DIR 不是已有安装（没有 package.json）。首次安装去掉 --upgrade"
fi

# 端口占用检查（只提示，不阻断 —— 用户可能就是想换端口）
# 升级模式下服务本来就占着端口，这是正常的，不提示
if [[ "$DO_UPGRADE" != "1" ]] && command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  warn "端口 $PORT 已被占用，稍后启动可能失败（用 --port 换一个）"
fi

# ── 升级：备份 ──
BACKUP_DIR=""
if [[ "$DO_UPGRADE" == "1" ]]; then
  info "升级模式：先备份现有安装"
  OLD_VER="$(node -p "try{require('$TARGET_DIR/package.json').version}catch(e){'?'}" 2>/dev/null || echo '?')"
  NEW_VER="$(node -p "try{require('$SRC_DIR/package.json').version}catch(e){'?'}" 2>/dev/null || echo '?')"
  info "  $OLD_VER → $NEW_VER"

  BACKUP_DIR="$(dirname "$TARGET_DIR")/$(basename "$TARGET_DIR").bak-$(date +%Y%m%d-%H%M%S)"
  # 只备份代码，不备份 data/（那是用户数据，本来就不会被覆盖）
  if sudo mkdir -p "$BACKUP_DIR" && \
     sudo tar czf "$BACKUP_DIR/code.tar.gz" -C "$TARGET_DIR" \
       --exclude=./data --exclude=./node_modules --exclude=./.git . 2>/dev/null; then
    ok "代码已备份 → $BACKUP_DIR/code.tar.gz"
  else
    warn "备份失败！继续升级有风险，建议 Ctrl+C 中止"
    printf '  %s继续？（y/N）%s ' "$YEL" "$RST"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]] || die "已取消"
  fi
fi

# ── 2. 复制代码 ──
if [[ "$DO_UPGRADE" == "1" ]]; then
  info "② 替换代码（升级）"

  # 先停服务，避免替换到一半进程读到半新半旧的文件
  if [[ "$DO_SERVICE" == "1" ]] && systemctl list-unit-files 2>/dev/null | grep -q "^$UNIT_NAME.service"; then
    sudo systemctl stop "$UNIT_NAME" 2>/dev/null || true
    ok "服务已停止"
  fi

  # 🔴 升级要「先清旧代码再拷」而不是直接覆盖 ——
  #    直接 cp 不会删除已废弃的文件，旧模块留在磁盘上可能被误加载。
  #    但 data/ plugins/ node_modules/ 必须保留：
  #      data/        用户配置与会话（绝对不能动）
  #      plugins/     用户自己装的插件（发布包只带两个内置的）
  #      node_modules 复用，省一次安装
  for sub in src ui electron skills scripts test assets docs; do
    [[ -d "$TARGET_DIR/$sub" ]] && sudo rm -rf "$TARGET_DIR/$sub"
  done
  # 顶层文档也一并换掉（旧的发布说明不该留着）
  for f in README.md PLUGIN-ARCH.md VOICE-RESEARCH.md 插件与Skill制作及使用规范.md 内核发布说明.md 安装说明.md .gitignore LICENSE; do
    [[ -f "$TARGET_DIR/$f" ]] && sudo rm -f "$TARGET_DIR/$f"
  done
  ok "旧代码已清理（data/ plugins/ node_modules/ 保留）"

  sudo cp -r "$SRC_DIR"/. "$TARGET_DIR"/ 2>/dev/null || true
  # 发布包里的 plugins/ 只含内置插件 —— 合并进去，不覆盖用户自己装的
  if [[ -d "$SRC_DIR/plugins" ]]; then
    for pd in "$SRC_DIR"/plugins/*/; do
      [[ -d "$pd" ]] || continue
      pname="$(basename "$pd")"
      if [[ -d "$TARGET_DIR/plugins/$pname" ]]; then
        # 内置插件（market / file-recv）要更新；其他保留用户的
        case "$pname" in
          plugin-market|file-recv) sudo rm -rf "$TARGET_DIR/plugins/$pname"; sudo cp -r "$pd" "$TARGET_DIR/plugins/" ;;
          *) ok "保留用户插件：$pname" ;;
        esac
      else
        sudo cp -r "$pd" "$TARGET_DIR/plugins/" 2>/dev/null || true
      fi
    done
  fi
  ok "新代码已就位"
else
  info "② 部署到 $TARGET_DIR"
  if [[ "$SRC_DIR" != "$TARGET_DIR" ]]; then
    sudo mkdir -p "$TARGET_DIR"
    if [[ -d "$TARGET_DIR/data" ]]; then
      warn "检测到已有 data/，将保留（不覆盖配置与会话）"
    fi
    sudo cp -r "$SRC_DIR"/. "$TARGET_DIR"/ 2>/dev/null || true
    ok "代码已复制"
  else
    ok "源目录就是目标目录，跳过复制"
  fi
fi

# 所有权：服务以 $SUDO_USER 或当前用户跑，代码得归他
RUN_USER="${SUDO_USER:-$(id -un)}"
sudo chown -R "$RUN_USER":"$RUN_USER" "$TARGET_DIR" 2>/dev/null || true
ok "归属 $RUN_USER"

# ── 3. 装依赖 ──
info "③ 安装依赖（4 个包，约十几秒）"
cd "$TARGET_DIR"
if [[ ! -d node_modules ]]; then
  if ! npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3; then
    die "npm install 失败。国内网络可先设镜像：npm config set registry https://registry.npmmirror.com"
  fi
  ok "依赖已安装"
else
  ok "node_modules 已存在，跳过"
fi

# ── 4. 初始化配置 ──
info "④ 初始化配置"
if [[ ! -f data/config.json ]]; then
  mkdir -p data
  ok "data/config.json 将在首次启动时自动生成"
else
  ok "沿用已有 data/config.json"
fi

# ── 5. 语法自检 ──
info "⑤ 语法自检"
BAD=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { warn "语法错误：$f"; BAD=1; }
done < <(find src ui plugins -name '*.js' -not -path '*/node_modules/*' 2>/dev/null)
[[ "$BAD" == "0" ]] && ok "全部通过" || die "有文件语法错误，中止"

# ── 6. systemd ──
if [[ "$DO_SERVICE" == "1" ]]; then
  info "⑥ 注册 systemd 服务"
  NODE_BIN="$(command -v node)"
  sudo tee "/etc/systemd/system/$UNIT_NAME.service" >/dev/null <<UNIT
[Unit]
Description=鲸界Bridge QQ bot (console on :$PORT)
After=network.target

[Service]
Environment=TZ=Asia/Shanghai
Environment=WB_SERVICE=$UNIT_NAME
Environment=HOME=$(eval echo "~$RUN_USER")
Type=simple
User=$RUN_USER
WorkingDirectory=$TARGET_DIR
ExecStart=$NODE_BIN src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
  ok "单元 /etc/systemd/system/$UNIT_NAME.service"

  info "⑦ 启动"
  sudo systemctl restart "$UNIT_NAME"
  sleep 6
  if systemctl is-active --quiet "$UNIT_NAME"; then
    ok "服务已启动"
  else
    warn "服务没起来，看日志：journalctl -u $UNIT_NAME -n 50 --no-pager"
  fi
else
  warn "跳过了 systemd 注册（--no-service）。手动启动：cd $TARGET_DIR && node src/server.js"
fi

# ── 8. 健康探测 ──
info "⑧ 健康探测"
ALIVE=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/api/kernel/version" >/dev/null 2>&1; then
    ALIVE=1; break
  fi
  sleep 1
done
if [[ "$ALIVE" == "1" ]]; then
  VER="$(curl -s -m 2 "http://127.0.0.1:$PORT/api/kernel/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  ok "控制台已响应（版本 $VER）"
else
  printf '\n'
  warn "升级后控制台没响应"
  if [[ "$DO_UPGRADE" == "1" && -n "$BACKUP_DIR" && -f "$BACKUP_DIR/code.tar.gz" ]]; then
    printf '  %s自动回滚到升级前的版本？(Y/n)%s ' "$YEL" "$RST"
    read -r ans
    if [[ ! "$ans" =~ ^[Nn]$ ]]; then
      info "回滚中…"
      sudo systemctl stop "$UNIT_NAME" 2>/dev/null || true
      # 清掉新代码（同样保留 data/ plugins/ node_modules/）
      for sub in src ui electron skills scripts test assets docs; do
        [[ -d "$TARGET_DIR/$sub" ]] && sudo rm -rf "$TARGET_DIR/$sub"
      done
      sudo tar xzf "$BACKUP_DIR/code.tar.gz" -C "$TARGET_DIR" 2>/dev/null || warn "解包失败"
      sudo chown -R "$RUN_USER":"$RUN_USER" "$TARGET_DIR" 2>/dev/null || true
      sudo systemctl start "$UNIT_NAME" 2>/dev/null || true
      sleep 6
      if systemctl is-active --quiet "$UNIT_NAME"; then
        ok "已回滚，服务恢复运行"
        info "备份仍在：$BACKUP_DIR"
      else
        die "回滚后仍起不来。手动排查：journalctl -u $UNIT_NAME -n 80 --no-pager"
      fi
      exit 1
    fi
  fi
  warn "请检查：journalctl -u $UNIT_NAME -n 50 --no-pager"
fi

# ── 完成 ──
printf '\n%s部署完成%s\n\n' "$GRN" "$RST"
cat <<TIP
  控制台    http://127.0.0.1:$PORT
  目录      $TARGET_DIR
  数据      $TARGET_DIR/data（升级不会动它）

  ${DIM}接下来：${RST}
  1. 打开控制台 → 设置 → 模型 API，填 Base URL 和 Key
  2. 「登录」页签配 OneBot（NapCat/SnowLuma 的 ws 与 http 地址）
  3. 设置 → 聊天设置 → 聊天白名单，加上要跑的群/人

  ${DIM}常用命令：${RST}
  sudo systemctl status  $UNIT_NAME
  sudo systemctl restart $UNIT_NAME
  journalctl -u $UNIT_NAME -f

  ${DIM}卸载（保留数据）：${RST} bash $TARGET_DIR/scripts/install-local.sh --uninstall

TIP

if [[ "$DO_UPGRADE" == "1" && -n "$BACKUP_DIR" ]]; then
  printf '  %s升级前备份：%s%s\n' "$DIM" "$BACKUP_DIR/code.tar.gz" "$RST"
  printf '  %s回滚：sudo systemctl stop %s && sudo tar xzf %s/code.tar.gz -C %s && sudo systemctl start %s%s\n\n' \
    "$DIM" "$UNIT_NAME" "$BACKUP_DIR" "$TARGET_DIR" "$UNIT_NAME" "$RST"
fi
