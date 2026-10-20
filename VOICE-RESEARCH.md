# QQ 语音功能调研（2026-10-21）

> 结论先行：**能发，且改动很小** —— NapCat 自己会做 silk 转码，我们只需发 `record` 段。

## 一、技术链路（已核实）

```
我们 → OneBot HTTP: send_group_msg{message:[{type:'record', data:{file:'<任意音频URL或本地路径>'}}]}
     → NapCat 收到后：下载到本地 → 内置 silk/ffmpeg 转码为 silk → 发送
     → QQ 客户端收到语音
```

**关键事实**（来自 NapCat 官方文档 `napneko.github.io/develop/file`）：

> 「发送时：接口请求后，NapCat 下载到本地，**内置 silk/ffmpeg 进行转码 silk 后并进行发送**」

也就是说 **silk 转码由 NapCat 负责，我们不需要自己处理**。传 mp3/wav 的 URL 或路径即可。

**本机已具备条件**（实测）：
- NapCat 自带 ffmpeg：`/home/lyy/napcat/shell/native/ffmpeg` ✅
- 系统 ffmpeg：`/usr/bin/ffmpeg` ✅

## 二、我们缺什么

| 环节 | 现状 | 需要做的 |
|:--|:--|:--|
| 发送 record 段 | `onebot.js` 只**解析**收到 record（`[语音]`），未实现发送 | 加 `sendRecord()` |
| 音频来源 | 无 TTS | 接一个 TTS |
| 收到语音听懂（STT） | 只显示 `[语音]` 占位 | 调 `/get_record?out_format=mp3` 拿音频 → STT |

## 三、TTS 选型（按本机条件）

| 方案 | 成本 | 中文质量 | 部署 | 结论 |
|:--|:--|:--|:--|:--|
| **本机 edge-tts**（微软 Edge 在线接口） | 免费 | 好 | `pip install edge-tts`，无需 key | ✅ **首选** |
| GPT-SoVITS / Bert-VITS2 | 免费 | 极好（可克隆音色） | 需 GPU/大内存，本机 12G 无 GPU | ⚠️ 重任务，须走 cutout-guard |
| 阿里云/腾讯云 TTS | 按量付费 | 好 | 需 key | 备选 |
| macOS `say` / espeak | 免费 | 差 | 本机是 Linux | ❌ |

**推荐**：`edge-tts`（零成本、免 key、中文自然、命令行即可出 mp3）→ 生成 mp3 → 发 record 段。

## 四、实施建议

做成插件 `voice`（与现有插件体系一致）：
- 工具 `send_voice(text)`：edge-tts 合成 → 临时 mp3 → record 段发送
- 工具 `hear_voice(messageId)`（可选，STT）：`/get_record` 取 mp3 → 语音识别
- 配置：音色（`zh-CN-XiaoxiaoNeural` 等）、语速、是否自动把长文本转语音

⚠️ 注意：edge-tts 走微软在线接口，需要出网；本机可出网，但要确认不被墙。

## 五、待确认

- [ ] 是否需要 STT（听懂群友语音）？还是只要"能说"
- [ ] TTS 音色偏好
