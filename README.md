# QQ Agent（纯内核版）

一个**零插件、零数据、零凭据**的 QQ 智能体机器人起始包。

包里只有内核：能收发消息、能存历史、能调模型，**不具备任何附加能力**
（不会联网、不会看图、不会发语音、没有游戏）。需要什么自己装。

---

## 三步启动

```bash
npm install
npm run server          # 控制台 http://127.0.0.1:3210
```

打开控制台 → **设置 → 模型 API** → 填 Base URL 与 API Key → 保存
→ **聊天白名单** 加上要让它参与的群或好友。

到这里机器人就能聊天了。

## 这个包里有什么

| 目录 | 内容 |
|:--|:--|
| `src/` | 内核程序（连接 / 存档 / 模型 / HTTP 面板） |
| `src/core/` | 插件内核（宿主 / 契约 / 配置 / 数据 / 管理接口） |
| `src/tools.js` | 内核的 10 个基础工具 |
| `src/personas-*.js` | 17 个内置人设（16 人格 + 小鲸鱼） |
| `plugins/` | **空目录**，等你放插件 |
| `ui/` | 控制台前端 |

内核的 10 个工具：`send_message` `send_sticker` `send_image` `receive_file`
`send_file` `send_poke` `get_recent_messages` `get_active_members`
`get_message_detail` `finish`

## 装插件

插件不在这个包里，需要单独获取（`.tar.gz` 插件包）。

**方式一（面板导入，推荐）**
控制台 → 插件页 → 导入插件包 → 选 `xxx.tar.gz` → 导入后在列表打开开关。

**方式二（解压）**
```bash
tar xzf grail.tar.gz -C plugins/
# 解压后应是 plugins/grail/manifest.json 的结构
```

导入后重启服务或点「重载」生效。

## 插件机制

每个插件 = `plugins/<id>/manifest.json` + `index.js`（导出 `activate(ctx)`）。

- 声明式：能力、钩子、工具、面板页签都在 manifest 里声明
- 故障隔离：插件崩了只标记 `failed`，内核照常跑
- 装卸即生效：卸载后它注册的路由/工具/页签一并摘除
- 数据分离：代码在 `plugins/<id>/`，运行数据在 `data/plugins/<id>/`

详见 `PLUGIN-ARCH.md`。

## 必须自己配的

| 配置 | 位置 | 说明 |
|:--|:--|:--|
| 模型 API Key | 设置 → 模型 API | 必填 |
| OneBot 连接 | 设置 → OneBot | WS/HTTP 地址与 token |
| 聊天白名单 | 设置 → 聊天白名单 | 不加机器人不说话 |
| 主人 QQ | `data/config.json` 的 `persona.masterQQ` | 决定谁能用主人专属工具 |

`data/` 目录运行时自动创建，不进版本库。

## 许可与来源

基础框架参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，
插件机制、圣杯战争、学习系统等为自研。

使用前请自行确认所在地区关于自动化账号的相关规定。
