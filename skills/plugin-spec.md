---
name: 插件开发规范
summary: manifest 字段、权限分组、ctx 能力、打包发布与常见坑
when: 主人要求新增/修改插件，或问"插件怎么写"时
author: 白光
version: 1.0.0
license: MIT
---
# 插件与 Skill 制作及使用规范

> **适用**：为 鲸界Bridge（`qq-agent-v2`）编写插件与 Skill
> **内核 API 版本**：`1`（见 `src/core/manifest.js` 的 `PLUGIN_API_VERSION`）
> **权威源**：本规范依据实际代码，不是设计稿。字段与行为以 `src/core/` 为准。

## 两部分，各取所需

| 你想做什么 | 看哪里 |
|:--|:--|
| 给机器人加功能（发消息、调接口、定时任务） | **第一部分：插件**（第一~七、十四~十六节） |
| 给机器人加知识（规范、套路、领域资料） | **第二部分：Skill**（第八·五节） |
| 纯使用者，想加自己的知识 | 直接跳到 **8.5.5「用户怎么加技能」** |
| 想用面板管理技能，不写代码 | 看 **8.5.6「面板管理」** |

**一句话区分**：插件**做事**（注册工具、钩子、面板），Skill**让模型知道怎么做**（纯文本知识，按需加载）。

---

## 一、一句话说清插件是什么

**一个插件 = 一个目录 + 一份 manifest + 一个 `activate(ctx)` 函数。**

它向内核「借」能力（发消息、存数据、注册工具、开 HTTP 路由），
在 `dispose()` 时还回去。内核不关心插件做什么，只负责：

- 按 `priority` 排序后依次调用钩子
- 任何插件抛错只记日志、不扩散（**插件崩了内核照跑**）
- 卸载时按清单精确摘除它注册的一切

---

## 一·五、铁律：插件改动不许动内核

> **2026-10-21 用户明确要求**：所有插件内容与功能升级，
> **一律通过改插件实现，不许修改内核代码。**

这不是风格建议，是**架构约束**。判断标准很简单：

```
plugins/<id>/...   → 可以随便改，改坏了只影响这一个插件
src/  ui/          → 改了就是改内核，影响所有插件，需要单独发布
```

### 反例（真实踩过）

圣杯战争的面板 UI 曾经写在内核 `ui/app.js` 里，共 482 行。
后果：

- 改一次圣杯界面 → 动了内核文件 → 内核版本号变化
- 想单独更新圣杯插件 → 做不到，界面代码在内核里
- 插件卸载了 → 内核里那堆函数还在（死代码）

现在这些代码在 `plugins/grail/ui.js`，改它不影响任何人。

### 插件前端怎么放

```
plugins/<id>/
  manifest.json    ← 加 "ui": "ui.js"
  ui.js            ← 前端代码，导出 mount(root, ctx)
  ui.css           ← 可选，插件自己的样式
```

内核通过 `mount(root, ctx)` 调用，`ctx` 提供公共能力：

| 能力 | 说明 |
|:--|:--|
| `ctx.api(path, opts)` | HTTP 请求（自动 JSON 序列化） |
| `ctx.toast(msg)` | 轻提示 |
| `ctx.esc(str)` | HTML 转义（**必须用**，别直接插值） |
| `ctx.state` | 前端共享状态 |
| `ctx.$` / `ctx.$$` | querySelector 简写 |
| `ctx.fmtTime(ts)` | 北京时间格式化 |
| `ctx.panelShell(...)` | 插件页面板外壳（统一标题+收起按钮） |
| `ctx.bindPanelClose(box)` | 绑定收起 |
| `ctx.savePluginConfig(id, patch)` | 保存插件配置 |

**插件不需要 `import` 任何内核模块** —— 全靠 `ctx` 传入。

### 页签 vs 配置面板

两种形态，都写在同一个 `ui.js` 里：

```js
// ① 顶栏页签（大功能，如圣杯）
export async function mount(root, ctx) {
  root.innerHTML = '<div id="my-page"></div>';
  // 渲染你的界面
}

// ② 插件页里的配置面板（小功能，如黑名单）
export async function mountPanel(box, ctx) {
  box.innerHTML = ctx.panelShell('my-plugin', '标题', '...');
  ctx.bindPanelClose(box);
}

export default { mount, mountPanel };
```

`manifest.uiTab.inline` 决定它出现在哪里：

- `inline: false` / 不写 → 顶栏页签，走 `mount`
- `inline: true` → 塞进「插件」页，走 `mountPanel`

### 🔴 两个必须知道的缓存坑（2026-10-21 实测）

插件前端是运行时 `import()` 加载的，有两个缓存陷阱会让**"改了插件但界面没变"**：

| 坑 | 现象 | 根因 | 修法 |
|:--|:--|:--|:--|
| **失败结果被缓存** | 插件文件明明有 `export function mount`，页面却一直报「没有导出 mount()」 | 加载器失败时缓存了 `null`，之后永远返回 null，不再重试 | 失败**不写缓存**，下次调用自动重试 |
| **ES module 缓存** | 插件 `ui.js` 更新后，浏览器仍加载旧内容 | 浏览器对 `import()` 的缓存很激进 | URL 带 `?v=<mtime>`，缓存 key 用 `<id>@<stamp>` |

内核侧已处理（`plugin-admin.js` 的 `tabs` 返回 `fileStamp` = ui.js 的 mtime），
**插件作者不用管**，但排查问题时要知道有这回事。

> 判断顺序：界面上看不到你的改动时 ——
> ① 硬刷新页面（Ctrl+Shift+R）→ ② 检查 manifest.ui 是否写了 → ③ 看
> `/plugin-ui/<id>/ui.js?v=<stamp>` 是否能直接取到。

### 顶栏页签 vs 插件页面板的选择

| | 顶栏页签（`mount`） | 插件页面板（`mountPanel`） |
|:--|:--|:--|
| 适合 | 大功能、需要长期停留（圣杯战争） | 设置类、看一眼就走（黑名单） |
| 占位 | 顶栏多一个页签，**页签多了会挤** | 塞进插件页，不占顶栏 |
| 内核调用 | `dispatchTabLoad` 找不到页签容器时 | 插件页点「配置」按钮 |

**建议默认用 `mountPanel`** —— 15 个插件如果都开顶栏页签，导航会爆。
目前只保留 `grail` 和 `ad-inject` 两个顶栏页签。

但 `openPluginPanel()` 有回退：插件只有 `mount` 没有 `mountPanel` 时，
也会在插件页里用 `mount` 渲染一遍，所以**只写一个也能两处都用**。

### 检查有没有违规

```bash
# 内核里不该出现插件专属函数
grep -nE "^(async )?function (render|load)(Grail|Ad|Welfare)" ui/app.js
# 应该没有输出
```

---

## 二、目录结构

```
plugins/<id>/
  manifest.json      ← 必需，唯一必需文件
  index.js           ← 必需，入口（默认名，可被 manifest.entry 改）
  README.md          ← 强烈建议（讲清依赖与用法）
  kb/  data/  cards/ ← 可选：插件的**静态资产**（题库、卡池、模板）
  ui.js              ← 可选：面板前端（目前由内核统一渲染，暂未启用独立 UI）
```

**`<id>` 的硬规则**：

- 只能 `a-z` `0-9` `-`，长度 3~40，首尾不能是 `-`
- **必须与 `manifest.id` 完全一致** —— 导入时会校验，不一致直接拒绝装载：
  ```
  [plugins] 圣杯战争 装载失败：目录名 圣杯战争 与 id grail 不一致
  ```
- 中文只用在**插件包文件名**上（给人看），目录名永远用英文 id（给程序认）

---

## 三、manifest.json 完整字段

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,

  "description": "一句话讲清这个插件做什么（会显示在面板上）",
  "author": "your-name",
  "category": "能力",
  "summary": "短标签",

  "entry": "index.js",
  "priority": 100,
  "defaultEnabled": false,

  "hooks": ["message"],
  "tools": true,
  "promptSections": [],
  "uiTab": { "id": "mytab", "label": "我的页签" },

  "config": {
    "enabled": false,
    "scopes": {}
  },

  "deps": {
    "pip": [],
    "system": [],
    "npm": []
  },
  "setup": "可选的安装说明（多行文本）",

  "permissions": ["send"],
  "scopes": ["all"]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|:--|:--:|:--|
| `id` | ✅ | 唯一标识，规则见上 |
| `name` | | 中文显示名（面板用） |
| `version` | | 语义化版本 |
| `apiVersion` | ✅ | 必须是 `1`，不匹配内核直接拒绝 |
| `description` | | 面板上的一行说明 |
| `category` | | **五选一**：`运营` / `能力` / `娱乐` / `工具` / `主人` —— 面板按此分组，见下 |
| `summary` | | 更短的标签 |
| `entry` | | 入口文件名，默认 `index.js` |
| `priority` | | **消息链顺序，小的先跑**（默认 100） |
| `defaultEnabled` | | 全新安装时是否自动启用，**建议 `false`** |
| `hooks` | | 要监听的钩子，见第五节 |
| `tools` | | 是否给模型注册工具 |
| `promptSections` | | 是否往系统提示词里插段（声明用，实际注册在代码里） |
| `uiTab` | | 面板页签 `{id, label}`，`id` 只能是 `a-z0-9-` |
| `config` | | 默认配置，会写进 `config.plugins.<id>` |
| `deps` | | 依赖声明，**只用于提示，内核不自动装** |
| `scopes` | | 默认作用域 |

---

## 三·五、分类（category）只有 5 个，别自己造

历史遗留问题：曾经同时存在 `群运营` / `内容能力` / `娱乐互动` / `系统工具` /
`扩展` / `插件` / `界面` / `运维` 等十几种写法，面板分组乱成一锅粥。

现在统一为**五选一**，发布时可以在发布页下拉里选：

| 分类 | 放什么 | 例子 |
|:--|:--|:--|
| `运营` | 群里日常运转相关 | 群管理、群日报、广告禁言、黑名单、题库、回复控制 |
| `能力` | 让机器人会做事 | 生图、识图、语音、搜索、记忆、表情包、定时任务、学习 |
| `娱乐` | 玩的东西 | 圣杯战争、好感度 |
| `工具` | 系统/管理类 | 创造营、插件中心、MCP 客户端、AstrBot 兼容层 |
| `主人` | 只有主人能用 | 主人专属工具 |

**不要写别的值。** 写了会被归一化到最接近的一类（认不出来的归 `工具`）。

发布页有下拉可选，不选就沿用 manifest 里现有的。

## 四、ctx 对象：插件能用的全部能力

```js
export async function activate(ctx) {
  // ... 注册你的东西
  return { dispose() { /* 可选：清理 */ } };
}
```

### 4.0 给「管理类插件」的四个新能力（2026-10-24）

如果你写的是**插件市场 / 插件管理器**这类要装卸别人的插件，别再去摸内核内部结构了，
用下面这四个（都有稳定性契约）：

```js
// ① 插件宿主 API —— 装卸查
ctx.pluginHost.list()                        // [{ id, version, status, dir, lastError }]
await ctx.pluginHost.enableFromDir(dir)      // 内核自己读 manifest/归一化/校验
await ctx.pluginHost.disable(id)
await ctx.pluginHost.reload(id)
const off = ctx.pluginHost.onChange(evt => { /* { type:'add'|'remove'|'change', id } */ })

// ② 路径 —— 别再 path.resolve(HERE, '../..')
ctx.paths.root          // 内核根
ctx.paths.plugins       // plugins/ 目录
ctx.paths.data          // data/ 目录
ctx.paths.pluginData    // data/plugins/<本插件id>
ctx.paths.store('x.json')  // 等价 ctx.data.file

// ③ manifest 归一化 —— 别再 import '../../src/core/manifest.js'
const r = ctx.normalizeManifest(rawJson, { dirName: 'my-plugin' });
// → { ok: true, manifest } 或 { ok: false, error }

// ④ 能力探测 —— 别再读源码文本找关键字
ctx.capabilities = {
  apiVersion, inlinePanel, hotLoad, pluginHostApi,
  pathsApi, normalizeApi, kernelUpgrade, onChange, hooks: [...]
}
```

**为什么不能用老办法**

| 老做法 | 后果 |
|:--|:--|
| `host.records` 直接摸 Map | 内核重构（改名/换存储）就崩 |
| `import '../../src/core/manifest.js'` | 插件装到别的布局 → `ERR_MODULE_NOT_FOUND` |
| `path.resolve(HERE, '../..')` | 同上，数据可能写到不该写的地方 |
| 读源码字符串猜能力（`kernelHas('xxx')`） | 内核改个注释就误判 |

**降级约定**：这些能力可能存在也可能不存在（老内核），调用前先探测：

```js
if (ctx.capabilities?.pluginHostApi) { /* 用新 API */ }
else { /* 退回自己读目录 + enable() */ }
```

| 成员 | 用途 |
|:--|:--|
| `ctx.id` / `ctx.version` / `ctx.manifest` / `ctx.dir` | 自身信息与插件目录绝对路径 |
| `ctx.log(...)` | 打印日志（自动加 `[plugin:<id>]` 前缀） |
| `ctx.config.get()` | 读配置（默认值 + 用户设置合并后） |
| `ctx.config.set(patch)` | 写配置，`null` 表示**删除该键** |
| `ctx.config.reset()` | 清空该插件的用户配置，回到 manifest 默认值 |
| `ctx.isEnabled(chatKey)` | 全局默认 + 按会话覆盖的判定结果 |
| `ctx.state.get/set/all/clear()` | 极简 KV 落盘（`data/plugins/<id>/state.json`） |
| `ctx.data.dir` | 插件私有数据目录 |
| `ctx.data.file('name.json')` | 拼一个私有数据文件路径 |
| `ctx.data.ensure()` | 确保目录存在 |
| `ctx.data.adopt('旧文件名')` | **接管历史遗留数据**（复制语义，原件保留） |
| `ctx.store` | 只读消息库：`recent()` / `activeMembers()` / `findByMid()` |
| `ctx.sender` | 发送队列：`sendTextBatch(chatKey, [文本...])` |
| `ctx.onebot` | OneBot 客户端：`call(action, params)` / `sendSegments()` / `selfId` |
| `ctx.stickers` | 表情库（list / find / note / collect） |
| `ctx.memory` | 轻量记忆（append / query / remove / formatForPrompt） |
| `ctx.chatCompletion(...)` | 直接调一次模型（做分类、润色等） |
| `ctx.root` / `ctx.dataDir` | 项目根 / data 根 |
| `ctx.hooks.on(name, fn)` | 注册钩子，返回取消函数 |
| `ctx.http.route(method, path, handler, opts)` | 注册 HTTP 路由 |
| `ctx.tools.register(def)` | 给模型注册工具 |
| `ctx.promptSections.register(name, fn)` | 往系统提示词插一段 |
| `ctx.declareKbTools([...])` | 声明"这些是教学工具"，非学习身份时对模型隐藏 |
| `ctx.skill.register({id,name,summary,when,body})` | **注册技能**（按需加载的知识块，见第九节） |
| `ctx.scheduler.every(ms, fn)` | 定时回调（dispose 时自动清理） |
| `ctx.emit(type, payload)` | 往面板推送 SSE 事件 |

### ctx.http.route 的两种注册方式

```js
// ① 挂在 /api/plugins/<id> 下（默认，推荐）
ctx.http.route('GET', '/snapshot', () => ({ ok: true, data: 123 }));
//    → GET /api/plugins/my-plugin/snapshot

// ② 用绝对路径（历史兼容，避免前端改动）
ctx.http.route('GET', '/api/my-plugin', () => ({ ok: true }), { absolute: true });
//    → GET /api/my-plugin
```

返回值**直接 return 对象**即可，内核自动 JSON 序列化。
要自己控制响应（下载文件等），返回 `{ __raw: true, buffer, contentType, filename }`。

---

## 五、钩子：插件介入运行的方式

`manifest.hooks` 声明 + `ctx.hooks.on()` 注册，两者必须都有。

| 钩子 | 触发时机 | 能做什么 |
|:--|:--|:--|
| `prefilter` | **消息入库之前** | 返回 `{drop:true}` 丢弃消息（黑名单用） |
| `message` | 消息入库之后、调模型之前 | 返回 `{handled:true}` 终止链、不进模型 |
| `notice` | 群成员增减 / 好友申请 | 迎新、审批 |
| `poke` | 拍一拍 | 回应戳一戳 |
| `tick` | 定时心跳 | 周期性任务 |

### 返回值语义（这是插件设计的核心）

```js
// ① 不管，交给下一个插件和模型
return;

// ② 已处理，终止链（不再触发模型）
return { handled: true };

// ③ 给后续插件传信号
return { flags: ['ad-inject-hit'] };
//   后续插件用 api.chain.has('ad-inject-hit') 读到

// ④ 丢弃消息（仅 prefilter）
return { drop: true, reason: '黑名单命中' };
```

### priority 决定顺序

`ad-inject(10) → anti-ad(20) → welfare(30) → grail(40) → group-manager(50)
→ websearch(60) → sticker(70) → vision(80) → teacher(85) → study(90)
→ schedule(100) → memory(110) → master-tools(120)`

**改 priority 前先想清楚**：顺序变了可能让原本靠"先跑"实现的逻辑失效。

### 🔴 prefilter 与 message 的关键区别

| | message | prefilter |
|:--|:--|:--|
| 消息是否已入库 | ✅ 已入库 | ❌ 还没 |
| 能不能阻止记录 | 不能 | **能**（`drop`） |
| 适合 | 处理、回复、拦截模型 | 黑名单、敏感词过滤 |

**踩过的坑**：驱逐级黑名单要在 `prefilter` 里踢人，
因为消息被 `drop` 之后，`message` 钩子根本收不到它。

---

## 六、注册工具（给模型用）

```js
ctx.tools.register({
  name: 'my_tool',
  description: '模型据此决定什么时候调你。写清楚"什么时候用、什么时候别用"。',
  masterOnly: false,        // true = 只有主人触发时才挂载
  available: () => true,    // 可选：运行时二次判定，false 则不挂载
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '参数说明' }
    },
    required: ['text']
  },
  async execute(toolCtx, args) {
    // toolCtx 与 activate 的 ctx 不同：这是"本次运行"的上下文
    // 含 chatKey / kind / chatId / selfId / session / store ...
    return { content: '返回给模型的文本' };
    // 或失败：return { content: '错误：xxx', isError: true };
  }
});
```

**工具命名**：小写字母 + 下划线，全局唯一（重名会被后注册的覆盖）。

**返回值格式**：必须 `{ content: string, isError?: boolean }`，
或多模态用 `{ content: [{type:'text'},{type:'image_url'}] }`。

**`toolCtx` 与 `ctx` 的区别**：

- `activate(ctx)` 的 ctx = **插件生命周期上下文**（配置、钩子、注册）
- `execute(toolCtx, args)` 的 toolCtx = **单次运行上下文**（聊天、会话、记忆）

两者不是同一个东西，别混用。

### 安全提醒

工具描述会进模型上下文。**不要把密钥、内网地址写进 description**。

---

## 七、配置：命名空间与作用域

### 配置隔离

插件配置存 `config.plugins.<id>`，只能写自己那一段：

```js
ctx.config.set({ enabled: true });        // 只改 plugins.<id>.enabled
ctx.config.set({ scopes: null });         // 删除 scopes 键（回落到默认）
```

**不会影响** `api` / `allow` / `persona` 等核心配置。

### 按会话覆盖

```json
{
  "enabled": true,
  "scopes": {
    "group:123456": false,
    "private:78901": true
  }
}
```

判定顺序：`scopes[chatKey]` → `enabled` → `manifest.defaultEnabled`

⚠️ 内核在**调用钩子前**已经做过这个判定，插件一般不用自己再判一次。

### 🔴 配置写入的一个已知约束

`ctx.config.set()` 用的是**浅层键值替换**（每个键整体覆盖），
不是深度合并 —— 这是刻意的，因为深合并**删不掉键**（踩过三轮）。
需要合并对象时自己 merge 后整体写入。

---

## 八、数据：资产 vs 运行数据（最容易搞混的地方）

| 类别 | 放哪 | 导出插件包时 | 举例 |
|:--|:--|:--|:--|
| **代码** | `plugins/<id>/` | ✅ 带走 | index.js |
| **资产** | `plugins/<id>/kb/`、`cards/` | ✅ 带走 | 题库、从者卡池 |
| **运行数据** | `data/plugins/<id>/` | 仅 `full` 模式 | 对局、进度、名单 |
| **用户隐私** | `data/config.json` | ❌ 永不 | API Key、QQ 号 |
| **依赖** | `.venv/`、`node_modules/` | ❌ 强制排除 | — |

**判断标准**：这东西是"随代码版本管理的静态内容"还是"用起来才产生的记录"？

前者放 `plugins/<id>/`，后者放 `data/plugins/<id>/`。

**反例（真实踩过）**：把 63 骑从者卡放进了 `data/grail/cards/`，
结果「清空数据」把卡池删了 —— 卡池是资产，不是运行数据。

### 接管历史数据

```js
ctx.data.adopt('old-filename.json');   // 复制语义，原件保留作回滚
```
用于插件化改造时把原本写在内核 `data/` 下的旧文件搬进来。

---

## 八·五、Skill：让插件带知识，但不吃 token

### 为什么要有这个

有些知识很长——插件开发规范、圣杯规则、教学法、专业资料。
传统做法是塞进 `promptSections`，**每轮都拼进提示词**，代价是：

- 一个 5000 字的规范 = 每轮白烧 ~1500 token
- 装 10 个这样的插件，提示词就爆了
- 而模型 95% 的时间根本用不到这些知识

**Skill 的思路**：提示词里只留**一行索引**（id + 一句话），
模型真需要时再调 `load_skill` 取正文。

### 三种来源

| 来源 | 放哪 | 谁维护 | 卸载时 |
|:--|:--|:--|:--|
| **内核内置** | `src/skill.js` 的 `BUILTIN_SKILLS` | 内核 | — |
| **插件注册** | `ctx.skill.register()` | 插件作者 | **自动摘除** |
| **用户自定义** | 项目根 `skills/*.md` | 主人自己 | 删文件即消失 |

合并时按 id 去重，优先级：**插件 > 用户 > 内置**（后者可被覆盖）。

### 插件怎么注册

```js
export async function activate(ctx) {
  ctx.skill.register({
    id: 'grail-rules',                 // 全局唯一，建议加插件前缀
    name: '圣杯战争规则',
    summary: '七职阶克制、灵脉、夜结算流程',   // 一句话，进索引
    when: '主人问圣杯怎么玩、或要开局时',      // 何时该读，进索引
    body: `# 圣杯规则
七职阶互相克制：Saber 克 Lancer ...
`                                  // 正文，只在 load_skill 时读取
  });
}
```

也可以用 `file` 指向仓库里的文件，避免同一份内容维护两处：

```js
ctx.skill.register({
  id: 'plugin-dev',
  name: '插件开发规范',
  summary: '怎么写插件',
  when: '主人要求做插件时',
  file: '插件与Skill制作及使用规范.md'   // 相对项目根
});
```

### 提示词里长什么样

只占一行一个 skill：

```
【技能库】你有一批可按需加载的知识，**不要凭印象猜**，需要时先 load_skill 取正文：
- grail-rules（圣杯战争规则）：七职阶克制、灵脉、夜结算流程 ｜ 何时用：主人问圣杯怎么玩时
调用方式：load_skill(id)。同一轮里可以只读需要的那一个，不要全读（浪费上下文）。
```

3 个 skill 的索引约 200 字符，而它们的正文可能是几万字。

### 什么时候用 skill，什么时候用 promptSection

| | promptSection | skill |
|:--|:--|:--|
| 何时进上下文 | **每轮**都拼 | 模型主动 `load_skill` 时才读 |
| 适合 | 短、且**每轮都必须遵守**的规则（说话方式、禁止事项） | 长、且**偶尔才用**的知识（规范、领域资料、套路） |
| 判据 | 不遵守会立刻出错 | 不知道也能正常聊天，只是做特定任务时不够专业 |

**简单判断**：如果你的内容超过 500 字，或者不是每次对话都用得上 → 用 skill。

### 8.5.5 用户自己加技能

主人不需要写代码，往 `skills/` 目录丢一个 `.md` 就行：

```markdown
---
name: 代码风格
summary: 本项目写代码的约定
when: 主人让你改代码时
---

- 注释用中文，只写"为什么"
- 改前先读文件，不要凭印象改
```

**改完不用重启**，下一轮运行即生效（`README.md` 会被自动跳过，不当技能）。

### 8.5.6 面板管理（不写代码也能管）

控制台顶部有「**技能**」页签，三种来源统一列出：

| 来源 | 能不能改 |
|:--|:--|
| 内核内置 | 🔒 只读 |
| 插件提供 | 🔒 只读 |
| **自定义** | ✏️ 可编辑 / 可删除 |

内置与插件提供的为什么只读：它们**随代码走**，改了下次更新就被覆盖。
想定制就新建一个同用途的自定义技能 —— 合并时 **自定义优先于内置**，
模型会读到你那份。

面板能做的事：

- **新建**：填 id / 名称 / 一句话说明 / 何时用 / 正文
- **编辑**：改上面任意字段（id 不可改，它是文件名）
- **查看**：内置技能也能看正文，方便照着写
- **删除**：仅自定义技能

保存后直接写进 `skills/<id>.md`，**下一轮运行即生效，不用重启**。

对应的 HTTP 接口（脚本化时用）：

| 方法 | 路径 | 作用 |
|:--|:--|:--|
| GET | `/api/skills` | 列出全部（不含正文） |
| GET | `/api/skills/one?id=` | 读单个正文 |
| POST | `/api/skills/save` | 新建/覆盖（仅自定义） |
| POST | `/api/skills/delete` | 删除（仅自定义） |

### 8.5.7 完整例子：给插件配一个技能

场景：黑名单插件想告诉模型"三级语义怎么选"，但这段说明有 800 字，
塞进 `promptSections` 会每轮都占 token。

```js
// plugins/blacklist/index.js
export async function activate(ctx) {
  ctx.skill.register({
    id: 'blacklist-levels',
    name: '黑名单三级语义',
    summary: '静默/屏蔽/驱逐的区别，以及什么时候该用哪一级',
    when: '主人要拉黑某人、或问"为什么他还出现在群里"时',
    body: `# 三级黑名单

## 静默（silent）
消息照常入库，但机器人**绝不回复**。适合：说话烦人但没违规。

## 屏蔽（block）
消息在入库前就被丢弃，存档里完全看不到。适合：刷屏、发广告。

## 驱逐（evict）
屏蔽 + 自动踢出群聊，再入群立即再踢。适合：恶意骚扰。

## 怎么选
默认用静默。只有明确违规才升级，驱逐需要确认。
`
  });
}
```

效果：提示词里只多一行（约 60 字），模型在主人提到拉黑时才读那 800 字。

### 注意

- `id` 要全局唯一，建议 `<插件id>-<用途>`
- `summary` 和 `when` 是模型决定"要不要读"的唯一依据，**认真写**
- 正文超过 20000 字会被截断（防止一次灌爆上下文）
- 插件卸载时 skill 自动摘除，不会留下孤儿

---

## 九、依赖声明

导出插件包时 `.venv` / `node_modules` / `.so` / `.pyc` **一律排除**
（否则包里会塞进 32MB 的架构绑定二进制，到别人机器上直接坏掉）。

所以依赖必须在 manifest 里声明：

```json
"deps": {
  "pip": ["edge-tts", "faster-whisper", "av<13"],
  "system": ["ffmpeg"],
  "npm": []
},
"setup": "pip install edge-tts faster-whisper \"av<13\"\n系统还需要 ffmpeg"
```

**内核不会自动安装依赖**（自动装是安全与可复现性的雷区）。
`deps` 只用于面板提示和 README 展示，安装由使用者自己做。

**写 README 时把版本约束讲清楚**，比如 `av<13` 是因为
`faster-whisper` 调 `av.open(metadata_errors=...)` 在 av≥13 已移除。

---

## 十、失败隔离：插件崩了会怎样

| 场景 | 内核行为 |
|:--|:--|
| `activate` 抛错 | 标记 `failed`、记 `lastError`、**内核照常启动** |
| 钩子抛错 | 本轮跳过该插件，**继续下一个插件与模型** |
| `prefilter` 抛错 | 视为不拦截（**宁可放过，不可误杀**） |
| `dispose` 抛错 | 记录后忽略，状态仍标记 `disabled` |
| manifest 不合法 | 装载阶段跳过，面板显示失败原因 |
| `apiVersion` 不匹配 | 拒绝装载 |

**所以：插件里不需要写防御性的 try/catch 去"保护内核"**，
但**应该**写在你这步失败时"降级怎么做"的逻辑
（例如语音转写失败 → 放行原消息而不是吞掉）。

---

## 十一、完整示例：一个最小可用插件

```json
// plugins/hello/manifest.json
{
  "id": "hello",
  "name": "打招呼",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "群友说「你好」时回一句欢迎",
  "category": "能力",
  "priority": 200,
  "defaultEnabled": false,
  "hooks": ["message"],
  "tools": false,
  "config": { "enabled": false, "reply": "欢迎欢迎～", "scopes": {} }
}
```

```js
// plugins/hello/index.js
export async function activate(ctx) {
  ctx.hooks.on('message', async (msg) => {
    if (msg.kind !== 'group' || !msg.text) return;
    if (!msg.text.includes('你好')) return;

    // 用 sender 发，而不是自己调 onebot —— 它会自动落盘+限频
    await ctx.sender.sendTextBatch(msg.chatKey, [ctx.config.get().reply]);

    // 不返回 handled：让消息继续走，模型也能看到
    return;
  });

  return { dispose() {} };
}
```

**这个插件做对的几件事**：
- id 与目录名一致
- `defaultEnabled: false`（装完不擅自开口）
- 用 `ctx.sender` 而非裸调 onebot
- 不返回 `handled` —— 打招呼不该阻断后续处理
- priority 放在末尾，不抢占核心插件的顺序

---

## 十二、自检清单（提交前逐条过）

**元信息**
- [ ] `id` 与目录名一致，符合 `a-z0-9-` 规则
- [ ] `apiVersion: 1`
- [ ] `defaultEnabled: false`（除非确有理由默认开）
- [ ] `category` 填了（五选一：运营/能力/娱乐/工具/主人）
- [ ] `author` 填了（插件页会展示）

**代码**
- [ ] 导出了 `activate` 函数（`export async function activate`）
- [ ] `ctx.hooks.on()` 注册的钩子都在 `manifest.hooks` 里声明过
- [ ] 工具返回 `{content, isError}` 格式
- [ ] 没有硬编码路径、QQ 号、密钥
- [ ] 长任务有超时，重任务有并发保护
- [ ] 超过 500 字的知识用 `ctx.skill.register()`，不要塞进 `promptSections`

**数据**
- [ ] 资产放 `plugins/<id>/`，运行数据放 `data/plugins/<id>/`
- [ ] 用 `ctx.state` 或 `ctx.data` 而不是自己拼 `data/` 路径

**依赖**
- [ ] `deps` 里写清 pip/system/npm
- [ ] README 有完整安装命令
- [ ] 版本约束写明（如 `av<13`）

**分发**
- [ ] 导出 `clean` 模式验证：包里不含 `.venv`/`.so`/密钥
- [ ] 在干净目录解压 → 导入 → 启用 → 跑通

---

## 十三、常见坑（都是真踩过的）

| 坑 | 症状 | 正解 |
|:--|:--|:--|
| 目录名 ≠ manifest.id | 装载失败 | 目录名用 id，中文只放包文件名 |
| 钩子没在 manifest 声明 | 注册了但不触发 | `hooks: ["message"]` 必须有 |
| `prefilter` 里做踢人之外的耗时操作 | 消息延迟入库 | prefilter 要快，慢活放 message |
| 消息被 drop 后还指望 message 钩子 | 逻辑永不执行 | 该做的事在 prefilter 里做 |
| 用深合并写配置 | 删不掉键 | `null` 表示删除，或整体替换 |
| 资产放进 data/ | 清空数据时资产没了 | 资产放 plugins/ |
| `.venv` 打进插件包 | 包 32MB，对方机器跑不了 | 内核已强制排除，但别指望带依赖 |
| 工具描述写太长 | 每轮都占 token | 写"何时用/何时不用"，别写实现细节 |
| 循环里 await 慢操作 | 消息链卡住 | 用 `ctx.scheduler.every` 或异步不阻塞 |
| 长知识塞 promptSections | 每轮白烧几千 token | 改用 `ctx.skill.register()`，按需加载 |
| skill 的 summary 随便写 | 模型不知道该何时读 | `summary`/`when` 是唯一判断依据，要写准 |
| skill id 与别的插件重名 | 被覆盖或互相干扰 | 用 `<插件id>-<用途>` 前缀 |

---

## 十四、导出与分发

### 三种导出模式

| 模式 | 内容 | 用途 |
|:--|:--|:--|
| `clean` | 代码 + 资产，**配置回默认、无数据** | **开源/分发用这个** |
| `config` | 代码 + 资产 + 当前配置 | 保留设置的迁移 |
| `full` | 代码 + 资产 + 配置 + 运行数据 | 整体备份 |

### 命令

```bash
# 面板：插件页 → 导出 → 选模式
# 或直接调接口
curl -o my-plugin.tar.gz \
  "http://127.0.0.1:3210/api/plugins/export?id=my-plugin&mode=clean"
```

### 导入

```bash
# 面板：插件页 → 导入插件包 → 选 .tar.gz
# 已存在同名插件会拒绝，需显式 replace
```

---

## 十五、参考实现

**按复杂度递增**，建议照这个顺序读源码：

| 插件 | 行数 | 看什么 |
|:--|:--|:--|
| `memory` | ~90 | 最简形态：只注册工具 |
| `hello`（本文示例） | ~20 | 最小钩子 |
| `websearch` | ~110 | 工具 + 外部调用 |
| `blacklist` | ~300 | **三级语义 + prefilter + 工具 + HTTP + 数据落盘**（最值得读） |
| `schedule` | ~250 | 定时器 + 工具 + 面板端点 |
| `voice` | ~330 | 外部进程、超时控制、依赖缺失降级 |
| `grail` | ~200 | 纯文本渲染 + 大量 HTTP 端点 |

---

*本规范描述的是**已实现**的行为。改内核时若改变了插件契约，
必须同步更新本文档与 `PLUGIN-ARCH.md`。*
