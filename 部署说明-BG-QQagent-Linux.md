# BG-QQagent-Linux 部署说明

> 版本 3.0.0 ｜ 2026-10-28
> 目录名与服务名统一为 **BG-QQagent-Linux**（原 qq-agent-v2）

---

## 一、装之前先跑环境检查

**每个人的 Linux 机子都不一样** —— 发行版、架构、包管理器、Node 版本、
有没有图形环境，任何一项不对都会导致"装完报错"。

所以第一步不是装，是**探**：

```bash
node -e "import('./src/env-probe.js').then(m=>console.log(m.renderProbe(m.probe())))"
```

或者装好后访问控制台：`GET /api/env/probe`

它会告诉你：
- 你的发行版叫什么、用哪个包管理器
- Node 版本够不够，不够的话**针对你的系统**给升级命令
- 内存够不够，不够的话给加 swap 的命令
- 缺不缺 Xvfb（NapCat 要图形环境）
- QQ 运行库齐不齐（缺了会白屏）

**输出里的「适配步骤」是可以直接复制的**，不用自己想去哪找包。

---

## 二、环境要求

| 项 | 最低 | 建议 |
|:---|:---|:---|
| 系统 | Linux（systemd） | Ubuntu 22.04 / 24.04 |
| 架构 | x86_64 / arm64 | x86_64（包更全） |
| 内存 | 1G + swap | **2G 以上** |
| 磁盘 | 3G | 5G |
| Node | 20 | 20 / 22 |

⚠️ **arm64 用户注意**：QQ 和 NapCat 的 arm64 包比 x64 少，
可选的版本更受限。装之前一定先跑环境检查。

---

## 三、安装

**核心包 `BG-QQagent-Linux-3.0.0-core.tar.gz`（554KB）只含内核本体**：

```
src/        内核代码
ui/         内置控制台
scripts/    安装/维护脚本
skills/     内置技能文档
package.json + lock
```

**不含**：插件、缓存、数据、`node_modules`、`.venv`、备份目录。
插件从市场装，数据自己生成 —— 这样包才小、才干净。

```bash
tar -xzf BG-QQagent-Linux-3.0.0-core.tar.gz
cd BG-QQagent-Linux
npm install --production      # 只需 4 个依赖：js-yaml / qrcode / undici / ws
```

装完直接能跑 —— **不装任何插件也能启动**（日志会显示「没有 plugins/ 目录，跳过」）。
插件按需从市场装。

⚠️ 别把 `data/` 从别处拷进来就用：配置里可能有别人的路径。
全新装的话让它自己生成。

---

## 四、服务配置

```bash
sudo tee /etc/systemd/system/BG-QQagent-Linux.service > /dev/null <<'EOF'
[Unit]
Description=BG-QQagent-Linux (QQ bot, console on :3210)
After=network.target napcat-qq.service
Wants=napcat-qq.service

[Service]
Environment=TZ=Asia/Shanghai
Environment=QQ_AGENT_SERVICE=BG-QQagent-Linux
Type=simple
User=<你的用户名>
WorkingDirectory=<你的安装路径>/BG-QQagent-Linux
Environment=HOME=<你的 home>
ExecStart=/usr/local/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now BG-QQagent-Linux
```

**把 `<你的用户名>` 和路径换成实际的**，别照抄。

---

## 五、版本兼容（最容易踩的坑）

**NapCat 和 QQ 不能各自追最新** —— NapCat 是注入到 QQ 里的，
两边版本必须配套。控制台的「登录」页会显示：

```
✓ 当前组合已验证可用
已验证组合：NapCat 4.18.41 + QQ 3.2.33-52892
```

**看到这个是绿色就说明能跑，不要动它。**

已验证组合表在 `src/napcat-compat.js`，有新的实测结果往里加。

---

## 六、从旧版本迁移（qq-agent-v2 → BG-QQagent-Linux）

```bash
# 1. 停旧服务
sudo systemctl stop qq-agent-v2

# 2. 改目录名
mv /path/to/qq-agent-v2 /path/to/BG-QQagent-Linux

# 3. 换服务文件（见第四节，注意改路径）
sudo systemctl disable qq-agent-v2
sudo rm /etc/systemd/system/qq-agent-v2.service
sudo systemctl daemon-reload
sudo systemctl enable --now BG-QQagent-Linux
```

**`data/` 目录不用动** —— 配置、插件数据、会话记录都在里面，跟着目录走。

代码里的路径是动态推导的（`path.resolve(__dirname, '..')`），
**改目录名不需要改代码**。只有服务名要跟着换。

---

## 七、时区

面向用户的时间（战报、日报、接口返回）**统一北京时间**。
服务文件里已设 `Environment=TZ=Asia/Shanghai`，别删。

系统本身是 UTC 没关系，进程内锁了就行。

---

## 八、出问题了怎么查

```bash
# 服务状态
systemctl status BG-QQagent-Linux

# 最近日志
journalctl -u BG-QQagent-Linux -n 100 --no-pager

# 环境再检查一遍
curl -s localhost:3210/api/env/probe
```

常见情况：

| 现象 | 先查什么 |
|:---|:---|
| 起来就退出 | `journalctl` 看 Node 版本是否够 |
| 控制台打不开 | 端口 3210 被占？`ss -lntp \| grep 3210` |
| 机器人不回话 | OneBot 连上了吗？看登录页状态 |
| 扫码没反应 | NapCat 需要 Xvfb，先跑环境检查 |
