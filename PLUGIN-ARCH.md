# 插件架构设计（v2 内核化改造）

> 目标：**基础功能常驻，附加功能全部插件化**——可安装、可卸载、可导出导入，装卸不影响基础功能。

## 一、分层

### 内核（core，不可卸载）

只保留"聊天本身能跑"的地基：

| 模块 | 职责 |
|:--|:--|
| `onebot.js` / `sender.js` | OneBot 连接、发送队列、限频重连 |
| `store.js` | 消息入库、存档、未读 |
| `sessions.js` / `orchestrator.js` | 会话生命周期、LLM 调度骨架 |
| `llm.js` / `providers.js` | 模型调用与提供商 |
| `config.js` | 配置读写（含插件配置命名空间） |
| `personas.js` + `personas-legacy/new` | 18 人设卡本体（不含切换逻辑） |
| `stickers.js` / `sticker-manager.js` / `vision-scan.js` / `web-search.js` | 表情包、识图、联网（按用户决策留内核） |
| `app.js` | HTTP/SSE 外壳、白名单、账号与协议端管理 |
| `core/*` | 插件宿主（本文档描述的框架） |

### 插件（plugins，可装卸）

| 插件 id | 原文件 | 挂载点 |
|:--|:--|:--|
| `anti-ad` | `anti-ad.js` | 消息链（异步旁路） |
| `ad-inject` | `ad-inject.js` | 消息链（同步预判 + 条件接管） |
| `welfare` | `welfare.js` | 消息链（私聊接管） |
| `grail` | `grail/` | 消息链（接管）+ API + UI tab |
| `group-manager` | `group-manager.js` + `mute_member` 工具 | 事件钩子 + 工具 |
| `schedule` | `scheduled-tasks.js` / `schedule-notify.js` / `schedule-query.js` | 调度器 + 工具 |
| `study` | `study-plan.js` / `knowledge.js` | 工具 + 提示词块 + 身份模式 |

## 二、插件目录结构

```
plugins/<id>/
  manifest.json      # 元信息与声明（唯一必需文件）
  index.js           # 入口：export async function activate(ctx)
  ui.js              # 可选：面板渲染（ES module，导出 render(el, ctx)）
  README.md          # 可选：说明
```

### manifest.json 契约

```jsonc
{
  "id": "anti-ad",                    // 唯一，字母数字与连字符
  "name": "广告自动禁言",
  "version": "1.0.0",
  "apiVersion": 1,                    // 内核插件 API 版本，不兼容则拒绝装载
  "description": "检测群友发广告并按规则禁言",
  "author": "lyy",

  "entry": "index.js",
  "ui": "ui.js",                      // 可选

  "priority": 20,                     // 消息链顺序，小的先跑
  "defaultEnabled": false,            // 装完默认是否启用

  "hooks": ["message"],               // message / poke / notice / tick
  "tools": true,                      // 是否注册函数工具
  "promptSections": ["welfare"],      // 需要插入系统提示词的段
  "uiTab": { "id": "ad", "label": "广告注入" },   // 可选面板 tab

  "config": {                         // 默认配置（写入 config.plugins.<id>）
    "enabled": false,
    "dryRun": false
  },

  "permissions": ["send", "mute"],    // 声明式（仅记录，供审阅）
  "scopes": ["all"]                   // 默认作用域；见第四节
}
```

## 三、运行时契约

### ctx 对象

`activate(ctx)` 收到内核注入的能力，返回 `{ dispose() }`：

```js
{
  id, version, manifest,
  log(...args),                       // 带 [plugin:id] 前缀
  config,                             // get() / set(patch) / on(handler)，命名空间隔离
  store,                              // 只读消息库（recent/activeMembers/...）
  sender,                             // sendText(chatKey, text, opts) 等
  onebot,                             // 只读：selfId / call()
  master,                             // masterQQ 判定辅助
  isEnabled(chatKey),                 // 全局默认 + 按会话覆盖（第四节）
  state,                              // 私有落盘：get(key)/set(key,val)，存 data/plugins/<id>/
  http,                               // route(method, path, handler) → 注册到 /api/plugins/<id>/*
  tools,                              // register(def) → 挂到模型工具集
  promptSections,                     // register(name, fn(ctxInfo) => string)
  hooks,                              // on('message'|'poke'|'notice'|'tick', fn)
  ui,                                 // register({ id, label, render, api })
  scheduler,                          // every(ms, fn) / cron(expr, fn)
}
```

### 消息链（关键）

入站消息经内核入库后，按 `manifest.priority` 升序跑插件的 `message` 钩子：

```js
// 钩子签名
async function onMessage(msg, ctx) {
  // msg = { chatKey, kind, chatId, userId, senderName, text, media, messageId }
  // 返回值语义：
  return { handled: true }            // 已处理 → 终止链，不进 LLM
  return { defer: true }              // 异步跑，不阻塞后续与 LLM
  return { flag: 'ad-inject-hit' }    // 设置共享标志位，供后续插件读取
  return undefined                    // 继续下一个插件
}
```

共享标志位：`ctx.chain.flags`（本轮消息共享），用于重现现有"ad-inject 命中则 anti-ad 豁免"的门闸语义——anti-ad 检查 `flags.has('ad-inject-hit')` 自行决定。

单个插件抛错：记日志、标记该插件本轮失败、**继续下一个插件**。内核永不被插件拖垮。

## 四、作用域（全局默认 + 按会话覆盖）

`config.plugins.<id>.enabled` 是全局默认；`config.plugins.<id>.scopes` 是覆盖表：

```jsonc
{
  "enabled": true,                          // 全局默认开
  "scopes": {
    "group:1127063335": false,              // 这个群关掉
    "private:123456": true              // 主人私聊单独开
  }
}
```

`ctx.isEnabled(chatKey)` 的判定顺序：`scopes[chatKey]` → `enabled` → `manifest.defaultEnabled`。
内核通过 `isEnabled` 决定是否调用该插件；插件无需自己判断（但可再调一次做细粒度控制）。

## 五、导出 / 导入

**导出**：`GET /api/plugins/<id>/export` → zip，含
`manifest.json` + `index.js` + `ui.js` + `README.md` + `config.json`（当前配置）+ `state/`（可选，默认不含隐私数据）
+ `_export.json`（内核 API 版本、导出时间、校验和）。

**导入**：`POST /api/plugins/import`（上传 zip）→ 校验 `apiVersion` 与 `id` 冲突 → 落盘到 `plugins/<id>/` →
**不自动启用**，等用户在面板点开。

用途：本机 ↔ 阿里云双向迁移、单插件备份、分享给别的实例。

## 六、失败隔离

| 场景 | 行为 |
|:--|:--|
| `activate` 抛错 | 插件标记 `failed`，记 `lastError`，内核照常启动 |
| 钩子抛错 | 本轮跳过该插件，日志记录，继续后续插件与 LLM |
| `dispose` 抛错 | 记录后忽略，状态仍标记为 `disabled` |
| manifest 不合法 | 装载阶段跳过，面板显示"损坏" |
| apiVersion 不匹配 | 拒绝装载，面板提示需要内核升级 |

## 七、面板

新增「插件」tab：

- 列表：id / 名称 / 版本 / 状态（enabled/disabled/failed）/ 作用域数
- 每项操作：启用、停用、配置、导出、卸载
- 顶部：导入（上传 zip）、全部启用、全部停用
- 插件自带面板：`uiTab` 声明了就在主导航出现（如圣杯战争、广告注入）

## 八、迁移策略

插件化不是一次性大爆炸。按"一次一个、每步可验"推进：

1. 先建内核框架，`app.js` 消息链改为调用宿主（原有四个硬编码块暂以"内建插件"形式挂载）
2. 逐个把内建块抽成 `plugins/<id>/`，每抽一个跑一次回归
3. 全部抽完后，`app.js` 只剩内核逻辑，插件全部走宿主

每一步都提交 git，任何一步失败可 `git reset --hard HEAD~1` 回滚。
