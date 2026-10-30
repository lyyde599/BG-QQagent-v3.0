---
name: 阿里云部署 DSH 与鲸界Bridge
summary: 从零在阿里云免费服务器上跑通 DeepSeek Harness 和鲸界Bridge 的完整步骤与踩坑
when: 群友问怎么部署/安装鲸界Bridge、怎么买阿里云服务器跑机器人、DSH 怎么装、NapCat 怎么配、机器人不回话怎么查、内存 OOM 怎么办、端口要不要开放时
author: 白光
version: 1.0.0
license: MIT
---

# 阿里云部署 DSH 与鲸界Bridge

来源：B 站视频 `BV1W1n862EjW`（阿里云 300 代金券 + CDT 设置）
与 `BV1Amn86LEvz`（DSH + 鲸界Bridge 部署），UP 主「爱听音乐的白熊」。
第三～六章的端口、路径、命令与报错均来自实机验证，不是文档复述。

## 整条链路的四个阶段

```
①领券 → ②买机器（勾公网IP + 按流量计费） → ③SSH 进机器
                                            ↓
        ⑥用 DSH 部署 鲸界Bridge ← ⑤装 DSH ← ④装 Node 环境
              ↓
        ⑦扫码登录 → ⑧配置模型与白名单 → ⑨交给 systemd 长期托管
```

| 阶段 | 交付结果 | 耗时 |
|:--|:--|:--|
| 一、拿到服务器 | 有公网 IP、能 SSH 登录的 Linux，实付 0 元 | 15 分钟 |
| 二、拿到工作台 | 服务器上有 Node 20+ | 10 分钟 |
| 三、装 DSH | `dsh --version` 有输出、`dsh web` 浏览器能开 | 10 分钟 |
| 四、装 鲸界Bridge | QQ 账号在线、控制台 :3210 能开、群里能回话 | 30 分钟 |

**最容易翻车的地方不在安装，在第二阶段**——公网 IP 与计费模式没选对、安全组没放行 22。

## 前置准备

| 项目 | 要求 |
|:--|:--|
| 阿里云账号 | 已注册 + **已完成实名认证**（未实名买不了 ECS） |
| 支付方式 | 绑定支付宝/微信（0 元订单也要绑） |
| SSH 客户端 | 系统自带（Win10+ 的 PowerShell 就有） |
| QQ 号 | **建议专号专用**，机器人会和手机端互踢 |

领券：登录阿里云 → 搜「免费试用」/「代金券」/ 学生认证。
券一般限「新用户 + 指定规格 + 指定地域」，下单前确认结算页显示 **优惠后应付 ¥0.00**。
额度随活动变化，只给方法，不承诺额度。

## 二、购买服务器：核心是「公网 IP + 按流量计费」

**一句话结论**：勾「公网 IP」+ 带宽选「按使用流量」→ 自动分配固定公网 IPv4，不额外收 IP 费；
带宽峰值只是上限，不按峰值收费，只按实际出方向流量计费。

### 逐项怎么选

| 购买页选项 | 选什么 | 理由 |
|:--|:--|:--|
| 付费模式 | **包年包月** | 只有包年包月能用代金券；按量付费不吃券 |
| 地域 | 离你近的（华东1/华南1） | 延迟低，内地流量便宜 |
| 实例规格 | **2 核 2G**（经济型 e / 共享型 s6） | 跑一个 鲸界Bridge 足够 |
| 镜像 | Ubuntu 22.04/24.04 或 Alibaba Cloud Linux 3 | 前者资料多，后者依赖少 |
| 系统盘 | 40G 高效云盘 | LinuxQQ+NapCat 约 300MB，Node 依赖约 400MB |
| **公网 IP** | ✅ **勾选「分配公网 IPv4 地址」** | 不勾 = 没公网 IP = 连不上 |
| **带宽计费模式** | ✅ **按使用流量** | 见下 |
| 带宽峰值 | 100 Mbps 或默认 | 只是上限，不按峰值收费 |
| IPv6 | 需要就勾 | 免费分配，但公网访问要另开网关带宽 |
| **安全组** | ✅ **先放行 22** | 不放行 22，机器开好了你也进不去 |
| 登录凭证 | 密钥对（推荐）或自定义密码 | 密码需 8 位以上含大小写与数字 |

### 为什么选「按使用流量」而不是「按固定带宽」

| 对比项 | 按固定带宽 | 按使用流量（推荐） |
|:--|:--|:--|
| 收费口径 | 按峰值 × 时长，24 小时都在扣 | 按实际出方向流量，不跑就不花钱 |
| 跑 QQ 机器人 | 1Mbps 约 20+ 元/月，多数时间闲置 | 纯文本收发，月流量常见几百 MB |
| 突发能力 | 卡在峰值，下载会打满丢包 | 峰值可设 100Mbps，突发自动承载 |

价格参考（内地 BGP）：**0.8 元/GB**；开通 CDT 后每月免费额度
**内地 20 GB、非内地 200 GB**。只跑 QQ 机器人通常落在免费额度内，长期成本≈0。

### IPv4 与 IPv6

- **IPv4**：勾「分配公网 IPv4」+「按使用流量」→ 自动分配固定公网 IPv4，这就是 SSH 连的地址。**主线，务必拿到。**
- **IPv6**：ECS 可同时持有，但阿里云 IPv6 默认只有内网可达。要公网可达需：① VPC/交换机创建时勾 IPv6 网段；
  ② 在 IPv6 网关控制台购买公网带宽（也支持按流量）。
- **建议**：新手只走 IPv4，IPv6 留作后期优化（不少家用网络 IPv6 出口不稳，反而增加排障变量）。

### 安全组：该放行哪些端口

安全组在**阿里云控制台**，不在服务器操作系统里（`firewalld`/`ufw` 是第二层，两处都要通）。

| 端口 | 用途 | 建议 |
|:--|:--|:--|
| 22 | SSH 登录 | ✅ **必须**（否则进不去） |
| 3210 | 鲸界Bridge 控制台 | 建议改用 SSH 隧道 |
| 3080 | DSH Web UI | 建议隧道或域名反代 |
| 6099 | NapCat WebUI | ⚠️ **不要公网放行**——几乎无认证，暴露=把机器人交出去 |

**端口不是开得越多越好。** 控制台、DSH、NapCat 面板都带「能操控机器人发言 + 看全部聊天记录」的能力。
推荐姿势：**安全组只放 22，其余端口一律走 SSH 隧道**。

### CDT 升级（省钱第二步）

按流量实例默认按 ECS 自己的价格出账；手动升级到 **CDT（云数据传输）** 后才享受统一阶梯价 + 每月免费额度。

1. 控制台搜「云数据传输 CDT」→ 找「按流量计费实例升级」
2. 勾选你的 ECS 实例 → 确认升级
3. ⚠️ **升级不可回退**

验收：CDT 控制台能看到实例 ID，用量统计开始有数。
固定包月带宽的实例**不参与** CDT 阶梯与免费额度。

## 三、SSH 登录

```bash
# 密码登录
ssh root@<公网IPv4>
```

连不上时的三板斧：
1. 控制台「远程连接（VNC）」能进吗？能进 = 机器没问题，是网络/安全组
2. 安全组 22 端口对 0.0.0.0/0 放行了吗？
3. 镜像用密钥对却用密码登？→ 控制台「重置实例密码」

### 密钥登录（推荐）

```bash
# 本地生成（已有可跳过）
ssh-keygen -t ed25519 -C "aliyun-ecs" -f ~/.ssh/id_ed25519_aliyun

# 服务器上执行一次（密码登录状态下）
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<粘贴 id_ed25519_aliyun.pub 的内容>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

本地 `~/.ssh/config` 写别名，之后 `ssh ali` 一条命令进机器：

```
Host ali
    HostName <公网IPv4>
    User root
    IdentityFile ~/.ssh/id_ed25519_aliyun
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ControlMaster auto
    ControlPersist 10m
```

`ControlMaster` 是效率关键：首次握手后复用同一条 TCP，后续 `scp`/`rsync`/多次 `ssh` 免二次握手。

### SSH 隧道（把不该暴露的端口变成本地端口）

```bash
ssh -N -L 3210:127.0.0.1:3210 ali     # 鲸界Bridge 控制台
```

然后浏览器打开 `http://127.0.0.1:3210/` —— 走加密隧道，公网看不到这个端口。
同理可映射 3080（DSH）、6099（NapCat）。**隧道开着才有、关了就断。**

## 四、把服务器变成工作台

### 基础环境

```bash
# Ubuntu / Debian
apt update && apt -y upgrade
apt -y install curl git vim unzip htop tmux

# Node.js 20 LTS（DSH 与 鲸界Bridge 都要 >=20）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs

# 验收
node -v   # 期望 v20.x 或更高
```

Alibaba Cloud Linux / CentOS 系把 `apt` 换成 `dnf`。

### 两个必调的设置（不调后面一定踩）

```bash
# ① 时区统一到北京时间
timedatectl set-timezone Asia/Shanghai && date

# ② 小内存机器加 swap（2G 内存装依赖容易被 OOM 打死）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab && free -h
```

**2G 内存是硬约束**：`npm install` 峰值可能吃到 1.5G+。加 swap 之后仍要守住一条铁律——
**任何常驻服务都要在 systemd 单元里设 `MemoryMax`**，否则一次内存失控会连带把 SSH 一起打死，你连机器都进不去。

## 五、安装 DSH

```bash
npm install -g @deepseek-ai/dsh
dsh --version          # 期望形如 0.1.5-rc.1
which dsh              # 应为 /usr/bin/dsh 或 /usr/local/bin/dsh
```

⚠️ `npm install -g` 报权限错误时**别用 `sudo npm` 硬来**（会把文件属主搞乱）。
正确做法：把 npm 全局目录改到家目录，或该机器本来就是 root 则直接装。

### 启起来：三种姿势

```bash
# ① 只给本机看（最安全，配合 SSH 隧道）
dsh web --no-open --port 3080

# ② 允许指定域名/公网访问（要显式声明可信 Host，否则 API 会 403）
dsh web --no-open --port=3080 --trusted-host=<你的域名或IP>

# ③ 显式指定监听地址（谨慎：暴露面变大）
dsh web --host 0.0.0.0 --port=3080 --trusted-host=<IP>:3080
```

**两条硬规则（实测踩出）**：

1. **不要用 `npm exec dsh web --port X`** —— `npm exec` 会把 `--port` 的值甩成位置参数，
   直接报 `too many arguments`。要用全局命令 `dsh` 或 `node_modules/.bin/dsh`。
2. **`--trusted-host` 是可变参数（variadic）**：用等号形式 `--trusted-host=IP:3080` 最稳，
   空格形式容易把后面的参数一起吞掉。

### 已知限制

- 远程（非 127.0.0.1）打开时，设置/模型页可能报 `settings are unavailable in this browser`。
  **这不是故障**，是 DSH 的设计：判断页面来源是否为回环地址，非回环则把设置作用域降级为内存态。
  解决：① 用 SSH 隧道从 `http://127.0.0.1:3080` 访问（最省事）；② 装 `dsh-loopback-boot` 类补丁。
- **若前面挂了 nginx 反代**：必须 `proxy_set_header Host $http_host;`（保留端口）。
  用 `$host`（丢端口）会让浏览器 Origin 与 Host 对不上，**API 一律 403**；
  还要补 `Upgrade`/`Connection` 头与长超时，否则前端 WebSocket 一直「自动重连中」。

### 常驻（systemd）

```ini
# /etc/systemd/system/dsh.service
[Unit]
Description=DSH Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root
Environment=DSH_HOME=/root/.dsh
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/dsh web --no-open --port=3080 --trusted-host=<你的IP或域名>
Restart=always
RestartSec=10
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now dsh
```

`MemoryMax` 不是装饰：2G 机器上不给上限，DSH + NapCat + 鲸界Bridge 抢内存时，内核会挑最大的那个杀——
往往就是你正在用的那个。

## 六、用 DSH 部署 鲸界Bridge

**核心思路**：DSH 是操作台，鲸界Bridge 是被部署的业务。

### 架构：三个必须同时活着的东西

```
NapCat（协议端插件） → 驱动 → LinuxQQ（真正的 QQ 客户端）
        ↕ OneBot WS 3001 / HTTP 3000
鲸界Bridge（Node 服务） → 调 → OpenAI 兼容接口（DeepSeek / 中转站）
        ↕
控制台 :3210（看会话、改人设、勾群白名单）
```

**Xvfb（虚拟显示）→ QQ 客户端（含 NapCat）→ 鲸界Bridge 服务**，任何一环挂了，
就会出现「进程都在跑但机器人不说话」。

### 拿到代码

```bash
mkdir -p /root/qqbot && cd /root/qqbot
git clone <你的仓库地址> qq-agent-v2
cd qq-agent-v2 && npm install
```

### 装 NapCat + LinuxQQ

思路：LinuxQQ 是官方客户端，NapCat 通过修改入口 JS 注入进去，从而对外提供 OneBot 接口。

```bash
# 1) 装 LinuxQQ
wget <LinuxQQ 官方 deb 链接> -O linuxqq.deb
dpkg -i linuxqq.deb || apt -y -f install

# 2) 下载 NapCat.Shell 解压进 QQ 插件目录
#    路径形如 /opt/QQ/resources/app/app_launcher/napcat/

# 3) 写加载器 /opt/QQ/resources/app/loadNapCat.js
#    内容为 import('<绝对路径>/napcat.mjs')
#    备份并把 /opt/QQ/resources/app/package.json 的 "main" 改成 ./loadNapCat.js

# 4) OneBot 配置 .../napcat/config/onebot11.json
#    HTTP 3000 / WS 3001，token 留空（仅本机回环访问）

# 5) 无头机器必须有虚拟显示
apt -y install xvfb
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# 6) 启动（首次要扫码）
qq --no-sandbox -q <你的机器人QQ号>
```

**三个真实坑**：

| 坑 | 现象 | 正解 |
|:--|:--|:--|
| 参数顺序 | 加了 `-q` 仍在刷二维码 | `-q` 必须紧跟 `qq` 之后、`--no-sandbox` 之前：`qq --no-sandbox -q <号>`；systemd 里 `${VAR}` 不会拆成多参数，用 `$VAR` 或写死 |
| 无 `-q` 就回退扫码 | 有登录态仍要扫码 | 登录成功后 NapCat 日志会打印「可用于快速登录」的号，填进去 |
| 手工 `nohup` 会被带走 | 过一会儿全没了 | 用 `setsid` 脱会话，最终交给 systemd |

**二维码怎么看**：NapCat 缓存目录里有 `qrcode.png`（约 2 分钟刷新一次）。
服务器没桌面，最省事的是起临时小 HTTP 服务只对内网/隧道暴露，或把图片 `scp` 下来扫。

### 配 鲸界Bridge

编辑 `data/config.json`（唯一配置文件，改完重启生效）：

```json
{
  "api": {
    "baseUrl": "https://<你的模型服务>/v1",
    "apiKey": "sk-<你的key>",
    "model": "deepseek-v4.1-flash",
    "temperature": 0.8,
    "maxRounds": 12,
    "timeoutMs": 180000
  },
  "snowluma": {
    "dir": "/opt/QQ/resources/app/app_launcher/napcat",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": ""
  },
  "server": { "port": 3210, "token": "", "autoStart": true },
  "allow": { "groups": [] },
  "deny": { "groups": [] }
}
```

🔴 **`server.token` 必须留空**：内置前端调接口时不带任何鉴权头，填了 token 会让整个面板 401。
需要认证就套一层 nginx Basic Auth + 只开隧道，而不是往这里塞 token。

```bash
node src/server.js

# 验收
curl -s http://127.0.0.1:3210/api/status | head -c 300
# 关注两个字段：onebot.connected = true、account.online = true
```

### 登录与开聊

1. 浏览器开 `http://127.0.0.1:3210`（或隧道过来的本地端口）
2. NapCat / SnowLuma 页签 → 扫码登录机器人 QQ
3. 控制台 →「选择群」→ 勾选允许它说话的群（**默认空，不勾就永远不回话**）
4. 私聊机器人发一句话，看是否有回复

🔴 **别用桌面版 QQ 登同一个号**：会互踢，掉线后只能重新扫码。
🔴 **「进程活着」≠「服务可用」**：NapCat 的 WS 端口在账号离线时照样在监听，只看端口会得到
「一切正常」的假象。判断标准是 `/api/status` 里的 `account.online`。

### 交给 systemd 长期托管

手工 `nohup` 起的进程会被 shell 会话连带杀掉，长期跑必须三件套：

```ini
# /etc/systemd/system/xvfb-qq.service
[Unit]
Description=Xvfb for QQ
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24
Restart=always
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/napcat-qq.service
[Unit]
Description=LinuxQQ + NapCat
After=xvfb-qq.service
Requires=xvfb-qq.service
[Service]
Environment=DISPLAY=:99
ExecStart=/opt/QQ/qq --no-sandbox -q <机器人QQ号>
Restart=always
RestartSec=10
MemoryMax=800M
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/qq-agent-v2.service
[Unit]
Description=鲸界Bridge
After=napcat-qq.service
[Service]
WorkingDirectory=/root/qqbot/qq-agent-v2
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
Environment=TZ=Asia/Shanghai
MemoryMax=700M
[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now xvfb-qq napcat-qq qq-agent-v2
journalctl -u napcat-qq -n 50 --no-pager   # 排障先看它
```

🔴 **内存上限预算**：各单元 `MemoryMax` 之和必须小于机器物理内存。
上例 1500+800+700=3000M，在 **2G 机器上已超编** → 实际要压低（如 DSH 不常驻），或升到 2 核 4G。
**设了超编的上限等于没设**——上限永远不会触发，最后仍是被内核整体干掉。

## 七、总验收清单

按顺序打勾，任何一项不过就回去看对应章节：

| # | 检查项 | 命令 | 通过标准 |
|:--|:--|:--|:--|
| 1 | SSH 免密 | `ssh ali 'hostname'` | 直接返回主机名 |
| 2 | Node 版本 | `node -v` | ≥ v20 |
| 3 | 时区 | `date` | CST +0800 |
| 4 | DSH 可用 | `dsh --version` + `curl -I 127.0.0.1:3080` | 版本号 + 200 |
| 5 | 协议端在线 | `ss -ltn \| grep 3001` | 有监听 |
| 6 | 账号在线 | `curl -s 127.0.0.1:3210/api/status` | `account.online: true` |
| 7 | 白名单 | 控制台「选择群」 | 至少勾 1 个群 |
| 8 | 实聊 | 群里 @ 机器人 | 有回复 |
| 9 | 开机自启 | `systemctl is-enabled xvfb-qq napcat-qq qq-agent-v2` | 三个 enabled |
| 10 | 内存安全 | `free -h` + 各单元 MemoryMax | 上限之和 < 物理内存 |

## 八、故障速查（症状 → 方向）

| 症状 | 最可能原因 | 处置 |
|:--|:--|:--|
| ssh 连不上，控制台 VNC 能进 | 安全组没放行 22 | 控制台 → 安全组 → 入方向加 22 |
| ssh 连不上且 VNC 也进不去 | 无公网 IP / 关机 / 内存被打死 | 查实例状态与公网 IP 是否为空 |
| 控制台页面能开但一直转圈 | 前端 WebSocket 被反代挡住 | nginx 补 Upgrade/Connection 头 + 长超时 |
| DSH 页面开、API 全 403 | 反代把 Host 的端口丢了 | `proxy_set_header Host $http_host;` |
| DSH 全程 401 | 两层认证打架（反代 Basic Auth + DSH token） | 认证只留一层，别叠 |
| 设置页报 settings are unavailable | 从非回环地址打开 | 走 SSH 隧道用 127.0.0.1 访问 |
| 机器人进程全 active 但不回话 | 账号离线（NapCat 端口仍在听） | 查 `account.online`，重新扫码 |
| 重启后必须扫码 | 未配置 `-q` 快速登录 | ExecStart 加 `-q <号>`，注意参数顺序 |
| 群里 @ 它不理 | 群白名单为空 | 控制台勾选群 |
| `npm install` 被杀 | 2G 内存不够 | 加 swap；或本地装好再传 node_modules |
| 升级 DSH 后站点突然 401 | 升级覆盖了鉴权补丁 | 重打补丁，或改用隧道方案（推荐） |

## 九、费用与安全

**费用**
- 券抵扣的是实例费；**流量费与云盘费另算**。境外流量尤其贵，别在这台机器上跑下载/推流。
- 「按使用流量」+ CDT 免费额度（内地 20GB/月、非内地 200GB/月）→ 日常用量通常在额度内。
- **关机 ≠ 不收费**：包年包月照常计费；按量实例关机后仍可能收云盘/公网 IP 保留费。
- 券到期前把不用的机器释放，别让它自动续费。

**安全三条底线**
1. **公网只开 22**，其余端口走 SSH 隧道；
2. **密钥优先于密码**，密码不要出现在命令行参数里（会进 history）；
3. **面板等于控制权**——能开机器人的面板 = 能用你的号发言 + 看全部聊天记录，公开前先加认证层。

## 十、端口总表

| 端口 | 归属 | 建议暴露方式 |
|:--|:--|:--|
| 22 | sshd | 安全组放行（可限源 IP） |
| 3000 | NapCat OneBot HTTP | 仅 127.0.0.1 |
| 3001 | NapCat OneBot WS | 仅 127.0.0.1 |
| 3080 | DSH Web | 隧道 或 域名 + 认证 |
| 3210 | 鲸界Bridge 控制台 | 隧道 或 域名 + Basic Auth |
| 6099 | NapCat WebUI | 仅 127.0.0.1 |

## 附：一页命令速查

```bash
# 服务器
ssh ali                                          # 登录
ssh -N -L 3210:127.0.0.1:3210 ali                # 隧道
systemctl status dsh napcat-qq qq-agent-v2       # 状态
journalctl -u qq-agent-v2 -f                     # 日志
curl -s http://127.0.0.1:3210/api/status         # 业务健康
free -h; ss -ltnp                                # 内存 / 端口

# 本地
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_aliyun
scp 文件 ali:/root/                              # 传文件
```

## 排障顺序

**先看症状表；仍不通时按「安全组 → 端口监听 → 业务状态接口 → 日志」四级往下查，不要一上来就重装。**
