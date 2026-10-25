# QQAgent 插件协议标准 v2

> **版本**：2.0.0 ｜ **最后更新**：2026-10-25 ｜ **适用内核**：apiVersion 1

本文是**插件设计的唯一权威标准**。写新插件、改旧插件、发布到创造营，都按这份来。

---

## 一、为什么要有这份标准

在设计「创造营（插件市场）」时暴露了三个真问题：

1. **`permissions` 只声明不校验** —— 20 个插件都写了权限，内核一个都不检查。等于门牌号，不是门锁。
2. **插件能碰一切** —— 和内核同进程，能读 `data/config.json`、能 `child_process.exec`、能发任意网络请求。
3. **用户不知道装的是什么** —— 安装时不显示"这插件要做什么"，出事只能事后追。

所以这份标准的核心是：**权限要能被看见，也要能被拦住。**

---

## 二、manifest 规范

### 2.1 必填字段

```json
{
  "id": "sticker",
  "name": "表情包",
  "version": "1.3.2",
  "apiVersion": 1,
  "entry": "index.js",
  "author": "白光"
}
```

| 字段 | 约束 | 说明 |
|:--|:--|:--|
| `id` | `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` | 必须与目录名一致，全局唯一 |
| `name` | 2-20 字 | 显示名，中文可以 |
| `version` | 语义化版本 | `MAJOR.MINOR.PATCH` |
| `apiVersion` | 必须是 `1` | 内核不兼容时会拒绝加载 |
| `entry` | 默认 `index.js` | 必须有 `export async function activate(ctx)` |
| `author` | 非空 | 出事时要能找到人 |

### 2.2 展示字段

```json
{
  "description": "一句话说清这插件做什么（30-200 字）",
  "summary": "更短的一句（10 字内）",
  "category": "运营 | 能力 | 娱乐 | 主人 | 工具",
  "ui": "ui.js",
  "uiTab": { "id": "sticker", "label": "表情包", "inline": true }
}
```

### 2.3 发布元信息（创造营用）

```json
{
  "homepage": "https://github.com/xxx",
  "repository": "https://github.com/xxx/qqagent-sticker",
  "license": "MIT",
  "contact": { "qq": "1970037984" }
}
```

**`license` 强烈建议填** —— 没有 license 的代码，别人不敢用也不敢改。

### 2.4 核心插件标记

```json
{
  "core": true,
  "coreReason": "禁用后无法从云端安装插件"
}
```

`core: true` 的插件**不可停用、不可卸载**。只给基础设施类插件用（目前只有创造营）。

---

## 三、权限系统（本标准的重点）

### 3.1 设计原则

**三道关，缺一不可：**

```
① 声明  —— 作者在 manifest 里写明要什么
② 授权  —— 用户安装时逐一同意，可随时撤销
③ 强制  —— 内核在运行时真的拦住越权调用
```

现状只有 ①，本文补齐 ② 和 ③。

### 3.2 权限清单

权限分五组，按风险从低到高：

#### A 组：只读（低风险）

| 权限 | 能做什么 | 典型插件 |
|:--|:--|:--|
| `read-media` | 读消息里的图片/文件 URL | 表情包、识图 |
| `read-memory` | 读机器人的记忆条目 | 记忆 |
| `read-schedule` | 读定时任务列表 | 定时 |
| `read-knowledge` | 读知识库 | 学习 |
| `read-blacklist` | 读黑名单 | 黑名单 |

#### B 组：发消息（中风险）

| 权限 | 能做什么 | 典型插件 |
|:--|:--|:--|
| `send` | 发消息/表情到会话 | 几乎所有 |
| `send-proactive` | **主动**发消息（不等被 @） | 群日报、提醒 |

**`send-proactive` 单独列出**，因为主动打扰和被动回复的风险差很多。

#### C 组：管理动作（高风险）

| 权限 | 能做什么 | 典型插件 |
|:--|:--|:--|
| `mute` | 禁言群友 | 广告禁言 |
| `kick` | 踢人 | 群管理 |
| `approve-request` | 同意加群/好友申请 | 群管理 |

#### D 组：数据与模型（中高风险）

| 权限 | 能做什么 |
|:--|:--|
| `write-memory` | 写机器人记忆 |
| `llm` | 调模型（花钱） |
| `network` | 访问外部网络 |

**`network` 必须配合 `networkHosts` 使用**（见 3.3）。

#### E 组：系统级（最高风险，需显式二次确认）

| 权限 | 能做什么 |
|:--|:--|
| `exec` | 执行系统命令 |
| `fs-write` | 写插件数据目录之外的文件 |
| `persona` | 修改机器人人设 |

装这类插件时，**安装确认框要用红色警示**，并要求输入插件名确认。

### 3.3 网络白名单（可选但推荐）

```json
{
  "permissions": ["network"],
  "networkHosts": ["api.example.com", "*.baidu.com"]
}
```

**声明了 `networkHosts` 就只允许访问这些域名**；不声明则视为任意域名（此时安装提示会标注「可访问任意网站」）。

### 3.4 授权流程

```
用户点「安装」
  ↓
弹出授权确认框：
  ┌──────────────────────────────────────┐
  │ 要安装「表情包」v1.3.2                │
  │ 作者：白光                            │
  │                                      │
  │ 这个插件申请了：                      │
  │  ● 读取消息里的图片（read-media）      │
  │  ● 发送消息（send）                   │
  │                                      │
  │ 关于权限：插件能执行任意代码，        │
  │ 只安装你信任的作者的作品。            │
  │                                      │
  │      [取消]  [同意并安装]             │
  └──────────────────────────────────────┘
  ↓
用户点「同意并安装」
  ↓
权限写入 data/plugin-grants.json：
  {
    "sticker": {
      "granted": ["send", "read-media"],
      "grantedAt": "2026-10-25T...",
      "version": "1.3.2",
      "by": "user"
    }
  }
  ↓
安装
```

### 3.5 授权变更处理

| 情况 | 行为 |
|:--|:--|
| 首次安装 | 必须显式同意 |
| 版本升级，权限不变 | 静默通过，不重复打扰 |
| **版本升级，权限增加** | **重新弹出确认框**，只列新增的权限 |
| 版本升级，权限减少 | 静默通过，自动收缩授权 |
| 用户手动撤销 | 插件立即失去该能力，运行时报错 |

### 3.6 运行时强制

内核在 `ctx` 构建时按授权裁剪能力：

```js
// 未授权 send → ctx.sender 不存在
// 未授权 network → fetch 被包装成抛错
// 未授权 exec → child_process 被禁用
```

**越权调用的正确行为是抛错并记日志**，不是静默忽略——静默会让作者难以调试。

---

## 四、插件代码规范

### 4.1 目录结构

```
plugins/<id>/
├── manifest.json     必需
├── index.js          必需（activate）
├── ui.js             可选（面板）
├── README.md         推荐
├── assets/           可选（小素材）
└── data/             ❌ 运行时生成，禁止打包
```

### 4.2 activate 契约

```js
export async function activate(ctx) {
  // ctx 提供的能力见第五节
  return {
    dispose() { /* 清理定时器、监听器等 */ }
  };
}
```

**必须返回 `dispose`**（可以是空函数）。内核重载插件时会调用它，没清理干净会内存泄漏。

### 4.3 数据处理

```js
// ✅ 正确：用 ctx.data，内核管理路径
const file = ctx.data.file('cache.json');
ctx.data.adopt('cache.json');   // 声明此文件随插件迁移

// ❌ 错误：自己拼路径
fs.writeFileSync('/home/lyy/QQbot/qq-agent-v2/data/xxx.json')
```

### 4.4 出错处理

```js
// ✅ 单点失败不影响整体
try { await doSomething(); } catch (e) { ctx.log('失败:', e.message); }

// ❌ 让异常冒泡到内核
await doSomething();   // 可能导致整个插件崩溃
```

### 4.5 命名

| 项 | 规范 | 例 |
|:--|:--|:--|
| 插件 id | 小写 + 连字符 | `group-pond` |
| 工具名 | 小写下划线 | `collect_sticker` |
| 私有变量 | `_` 前缀 | `_cache` |
| UI class | 插件 id 缩写前缀 | `cy-card`（创造营） |

---

## 五、ctx 能力清单

### 5.1 永远可用

| 能力 | 说明 |
|:--|:--|
| `ctx.id` / `ctx.version` / `ctx.manifest` | 插件元信息 |
| `ctx.log(...)` | 日志（自动加 `[plugin:<id>]` 前缀） |
| `ctx.config.get()` / `.set()` | 自己的配置 |
| `ctx.data` | 自己的数据目录 |
| `ctx.hooks.on(name, fn)` | 事件钩子 |
| `ctx.scheduler.every(ms, fn)` | 定时器 |

### 5.2 需权限

| 能力 | 所需权限 |
|:--|:--|
| `ctx.sender.*` | `send` |
| `ctx.onebot.*` | `send` 或对应管理权限 |
| `ctx.chatCompletion` | `llm` |
| `ctx.memory.*` | `read-memory` / `write-memory` |
| `ctx.stickers.*` | `read-media` |
| `ctx.http.route` | 无（但只能注册 `/api/<插件id>/*`） |

### 5.3 内核基础设施（插件只能调用，不能自带）

有些能力**属于基础设施，不该随插件分发**。插件包是公开的，把实现打进去
等于把整套机制送出去。

| 能力 | 内核实现 | 插件怎么用 |
|:--|:--|:--|
| 邮件发信 | `src/core/mailer.js` + `src/core/mail/send_mail.py` | `ctx.mail.send(to, subject, body)` |
| OneBot 通信 | `src/onebot.js` | `ctx.onebot.*`（需 `send` 权限） |
| 数据存储 | `src/store.js` / `src/memory.js` | `ctx.store` / `ctx.memory` |

**判定标准**：这个能力是否涉及凭据、是否所有插件都可能用到、
是否会因为分发而暴露风险。三者有其一放内核。

**反例（教训）**：`plugin-market` 第一版把 `send_mail.py` 放在
`plugins/plugin-market/vendor/` 下，结果打包时跟着走 ——
别人一装就拿到了完整的发信实现。

### 5.4 明确不提供

| 能力 | 原因 |
|:--|:--|
| 直接读 `data/config.json` | 里面有所有密钥 |
| `child_process` | 除非声明 `exec` |
| 写 `src/` 或 `ui/` | 内核文件，插件不许碰 |
| 读其他插件的数据目录 | 隔离 |

---

## 六、发布规范

### 6.1 打包前自检

- [ ] `manifest.json` 通过 schema 校验
- [ ] 权限声明与实际调用一致（不多报也不漏报）
- [ ] 没有硬编码的密钥、QQ 号、群号
- [ ] 没有 `data/`、`node_modules`、`.venv`
- [ ] `README.md` 说明了用法
- [ ] `license` 已声明

### 6.2 包大小

| 大小 | 处理 |
|:--|:--|
| < 5 MB | ✅ 正常 |
| 5-20 MB | ⚠️ 提示把素材拆出去 |
| > 20 MB | ❌ 拒绝发布 |

**素材（图片/音视频）应该单独托管**，插件包只带代码 + 素材清单。

### 6.3 审核分级

| 级别 | 含义 | 默认可见 |
|:--|:--|:--|
| 🟢 `official` | 内核作者自己写的 | ✅ |
| 🔵 `verified` | 有人审过代码 | ✅ |
| 🟡 `unverified` | 未审核，作者自测 | ❌ 需手动开启 |
| 🔴 `blocked` | 有安全问题，已下架 | ❌ 不可装 |

---

## 七、版本兼容

### 7.1 apiVersion 演进

| 变化 | apiVersion |
|:--|:--|
| 加可选字段 | 不变 |
| 加必填字段 | +1 |
| 改字段语义 | +1 |
| 删字段 | +1 |

**内核拒绝加载 apiVersion 不匹配的插件**，不尝试兼容。

### 7.2 插件自身版本

- 修 bug → PATCH
- 加功能 → MINOR
- 破坏性变更（配置结构改了、权限增加了）→ MAJOR

---

## 八、迁移指南（现有 20 个插件）

### 8.1 必须做

1. 补 `license`（建议 MIT）
2. 检查权限声明是否与实际行为一致

### 8.2 检查清单

| 插件 | 当前声明 | 实际需要 | 差异 |
|:--|:--|:--|:--|
| `file-recv` | `read-media, exec` | 需确认 exec 是否真用 | ⚠️ |
| `master-tools` | `exec, network` | 需确认 | ⚠️ |
| `teacher` | `persona` | 改人设，高风险 | ⚠️ 需二次确认 |
| `study` | `read-knowledge, llm` | 合理 | ✅ |
| `anti-ad` | `mute` | 合理 | ✅ |

**`exec` 权限的两个插件要重点审** —— 它们能执行任意系统命令。

---

## 九、这份标准怎么落地

| 阶段 | 做什么 | 状态 |
|:--|:--|:--|
| 第 1 步 | 本文档 + manifest 规范 | ✅ 完成 |
| 第 2 步 | 授权系统（授权文件 `data/plugin-grants.json`） | ✅ 完成 |
| 第 3 步 | 运行时强制（按授权裁剪 ctx） | ✅ 完成 |
| 第 4 步 | 现有插件补齐 manifest 字段 | ✅ 22/28 |
| 第 5 步 | 安装确认框（按风险分级展示） | ✅ 完成 |
| 第 6 步 | 下架功能 | ✅ 完成 |

### 各步实现位置

| 能力 | 文件 | 接口 |
|:--|:--|:--|
| 权限定义与分组 | `src/core/plugin-grants.js` | — |
| 授权校验 | `plugin-host.js` `permit()` | — |
| 查/授/撤授权 | `src/core/plugin-admin.js` | `/api/plugins/grants` `grant` `revoke` |
| 权限预览 | 同上 | `/api/plugins/permissions/preview` |
| 下架 | `plugins/plugin-market/index.js` | `/api/market/myplugins/unpublish` |

### 运行时强制的实际行为

未授权时，`ctx` 上对应的能力**不挂载**（是 `undefined`，不是假对象）：

```js
// 没授权 send
ctx.sender    // → undefined
ctx.onebot    // → undefined
// 没授权 llm
ctx.chatCompletion  // → undefined
```

**为什么不 throw**：插件可能只是在探测能力（`if (ctx.sender) ...`），
抛错会让它整个起不来。返回 `undefined` 让插件自己退让。

### 兼容策略（重要）

**本机已存在的老插件，没有授权记录时默认放行全部声明权限。**
它们已经跑了很久，突然全部失效是灾难。只对新安装走确认流程。

这条写在 `plugin-grants.js` 文件头的 ② 里，改动前务必先读。

---

*本标准的每一次修订都要更新顶部的「最后更新」和版本号。*
