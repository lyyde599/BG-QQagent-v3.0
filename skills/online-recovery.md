---
name: 鲸界Bridge 防掉线与自动恢复
summary: 机器人掉线、二维码过期、容器挂了怎么自动恢复和排查；靠内核自愈加进程守护，不是单个插件
when: 机器人不回话、QQ 显示离线、二维码过期、NapCat 容器挂了、想知道掉线后怎么自己起来、要配掉线邮件告警时
author: Victoria
version: 1.2.0
license: MIT
---

# 鲸界Bridge 防掉线与自动恢复

> 先说结论：**没有"防掉线插件"这种东西**。稳定运行靠的是三层叠加，
> 装一个插件解决不了掉线——掉线时插件自己也不在了。

## 一、三层结构

| 层 | 谁负责 | 作用 |
|---|---|---|
| ① 内核自愈 | `src/onebot-health.js`、`src/qr-refresh-guard.js`（2.9.x 自带） | 定时探测 OneBot 在线状态；发现掉线 → 记录/恢复；二维码过期 → 自动刷新重生成 |
| ② 进程守护 | systemd `Restart=always`（qq-agent 服务）+ docker `--restart unless-stopped`（NapCat 容器） | 进程崩了自动拉起；服务器重启后容器自己起来 |
| ③ 告警 | `napcat-alert` 插件（市场里有，作者 Dex） | 连续多次探测失败 → 邮件通知主人，附二维码；恢复后也发一封 |

**关键认知**：第 ③ 层只是"告诉你"，真正让机器人回来的是 ① 和 ②。
所以别把希望全押在告警插件上。

## 二、怎么确认它在工作（三条命令）

```bash
# 1. 内核自愈有没有在跑（应该看到周期性的健康检查日志）
journalctl -u qq-agent-v2 --since "-1 hour" | grep -E "\[health\]|qr-guard"
# ⚠️ 你的服务名可能是 qq-agent 或 qq-agent-v2，先确认：
#    systemctl list-units | grep qq-agent

# 2. 进程守护生效没
systemctl show qq-agent-v2 -p Restart -p RestartSec -p NRestarts --value
docker inspect napcat --format '{{.State.Status}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}'

# 3. 告警通道通不通（发一封测试信）
#    配置位置：控制台 → 插件 → 掉线告警 → SMTP
#    必填：host=smtp.qq.com port=465 tls=ssl user=你的QQ邮箱 pass=授权码 to=收件邮箱
```

## 三、掉线后的排查顺序（按这个来，别一上来就重启）

1. **先看是不是"人不在"而不是"机器坏了"**
   `journalctl -u qq-agent-v2 --since "-10 min" | grep -E "\[health\]|离线|恢复"`
   如果只是二维码过期，内核会自己刷新，等 1~2 分钟往往就好了。

2. **再确认 NapCat 活着**
   - systemd 部署：`systemctl is-active napcat-qq`
   - docker 部署：`docker ps | grep napcat`
   
   进程/容器在但 QQ 离线 = 登录态失效，重启没用，**必须扫码**。

3. **然后才是重启**
   ```bash
   # 先重启协议端
   sudo systemctl restart napcat-qq     # systemd 部署
   # docker restart napcat              # docker 部署
   
   # 再重启主服务
   sudo systemctl restart qq-agent-v2
   ```

4. **最后看端口/网络**
   `ss -lntp | grep -E "3000|3001"` —— 3000/3001 没监听说明 NapCat 没起来。

## 四、常见故障对照

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| 发消息不回，但容器 running | QQ 登录态掉了 | 扫码重登（控制台首页二维码 / 邮件里的二维码） |
| 二维码扫了没反应 | 二维码过期（约 2 分钟） | 等内核自动刷新，或重启容器重新生成 |
| 容器一直 restarting | 配置错/端口占用 | `docker logs --tail 100 napcat` 看原因 |
| 服务在跑但连不上 OneBot | 3001 端口没开 / token 不对 | 查 `onebot11_<QQ>.json` 里的 ws 地址与 token |
| 告警邮件收不到 | SMTP 没配/授权码过期 | 重配 SMTP，用测试信验证 |
| 日志里反复 `探测失败` 但 QQ 正常 | 健康检查频率太高 | 调大 intervalSec，别缩短 |

## 五、配置要点（照抄）

**systemd（qq-agent-v2.service）**
```ini
Restart=always
RestartSec=5      # 5~10 秒都行，别设 0（会疯狂重启触发风控）
```

**NapCat 有两种部署方式，按你用哪种看对应那段：**

*方式 A：systemd 原生部署*（Linux 直装，本文作者用的是这种）
```ini
# /etc/systemd/system/napcat-qq.service
[Service]
ExecStart=/path/to/qq --no-sandbox
Restart=always
RestartSec=10
Environment=DISPLAY=:99
```
```bash
systemctl status napcat-qq
journalctl -u napcat-qq --since "-10 min"
```

*方式 B：docker 部署*
```bash
docker run -d --name napcat --restart unless-stopped \
  -p 3000:3000 -p 3001:3001 -p 6099:6099 \
  -v /your/path/qq:/app/.config/QQ \
  -v /your/path/config:/app/napcat/config \
  -v /your/path/logs:/app/napcat/logs \
  mlikiowa/napcat-docker:latest
```
```bash
docker ps | grep napcat
docker inspect napcat --format '{{.State.Status}} restarts={{.RestartCount}}'
docker logs --tail 100 napcat
```

> ⚠️ 别照抄 `/root/napcat` 这个路径 —— 换成你自己的实际路径。
> 确认你用的是哪种：`systemctl is-active napcat-qq` 有输出就是方式 A；
> `docker ps | grep napcat` 有输出就是方式 B。

**掉线告警（napcat-alert）**
```
enabled: true
intervalSec: 120
failThreshold: 2
attachQr: true
notifyRecovery: true
smtp: { host: smtp.qq.com, port: 465, tls: ssl, user: 你的邮箱, pass: 授权码, to: 接收邮箱 }
```

## 六、别做的事

- **别频繁重启**：QQ 对短时间反复登录会风控，可能触发验证码
- **别删 `data/` 里的登录/session 目录**：删了就要重新扫码
- **别把 NapCat 的 3000/3001/6099 暴露到公网**：等于把机器人控制权交出去
- **别只依赖告警插件**：它挂了/没配 SMTP 就完全静默（这个坑我们踩过）

## 七、一句话总结

稳定运行 = 内核自愈（有）+ 进程守护（有）+ 告警（配好）+ 别乱动。
前两个是内核和进程管理器给的，**不需要也不应该用插件去重复实现**。

---

## 附：修订记录

**v1.2.0（2026-10-28）** —— 实机核对后修正三处事实偏差：

1. **服务名**：`qq-agent` → `qq-agent-v2`（并提示用户先确认自己的服务名，
   因为不同部署可能是 `qq-agent` 或 `qq-agent-v2`）
2. **RestartSec**：`10` → `5`（实测值；并注明 5~10 秒都合理，但别设 0）
3. **NapCat 部署方式**：原文只写了 docker，实际还有 systemd 原生部署
   （本文验证机就是 systemd）。现两种都写，并给出「怎么判断自己是哪种」的命令。

另外把 `/root/napcat` 这种硬编码路径改成「换成你自己的实际路径」，
避免读者照抄到错误位置。

**已验证正确的部分**（无需改动）：
- `src/onebot-health.js`、`src/qr-refresh-guard.js` 确实存在
- 健康检查默认 60 秒间隔属实
- `napcat-alert` 插件在市场里（v1.0.3）
- systemd `Restart=always` 有效
- 核心观点「没有防掉线插件，靠内核自愈+进程守护+告警三层」完全正确
