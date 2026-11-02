# AlwaysBack

> 参考了多个其他项目的集大成（？）之作，使用GPT 6-Sol High wish coding而来，谨慎使用

AlwaysBack 是单用户 QQ 角色对话服务原型。支持角色卡补全、显式关系状态、待审核的记忆与画像建议、QQ ID 鉴别、OneBot v11 正向 WebSocket，以及单独授权的群观察和主动私聊。架构与验收边界见 [`docs/DESIGN.md`](docs/DESIGN.md)。自动测试使用模拟模型和协议端；真实协议兼容性仍需在部署环境逐项验证。

| 能力 | 默认状态 | 说明 |
| --- | --- | --- |
| 授权用户私聊 | 配置后可用 | 以 `ownerQq` 和 `botQq` 校验身份；昵称不参与鉴别 |
| 群聊回复 | 无可回复群 | 只在 `groupIds` 内被明确点名时回复，读取本群有限历史 |
| 对话分析与用户画像 | 关闭 | 分别授权；生成的长期资料需人工审核 |
| 全群观察与远端群分析 | 分别关闭 | 本地观察与发送群文字到模型是两项独立授权 |
| 主动私聊 | 关闭 | 只向授权用户发送，受关系、免打扰和频率限制 |

## 许可

本项目按 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供源码，仅授权许可证规定的非商业用途。商业使用需要另行获得授权。此许可证不属于 OSI 定义的开源许可证。

## 快速开始

需要 Node.js 24 或更新版本，无 npm 依赖。还需一个已登录 QQ、提供 OneBot v11 正向 WebSocket 的协议端，以及兼容 Chat Completions 的模型接口。请在仓库根目录执行：

```powershell
Copy-Item config.example.json config.json
# 编辑 config.json：ownerQq 是唯一可私聊的用户 QQ 号；botQq 是机器人 QQ 号。
# onebotUrl 填 LLBot、SnowLuma 或 NapCat 开启的 OneBot v11 正向 WS 地址。
# groupIds 是允许回复的群；groupCallNames 是群聊中可触发回复的文字点名词。
# modelUrl 和 modelName 填模型服务地址与名称；不要把密钥写入 config.json。
$env:ALWAYSBACK_ONEBOT_TOKEN = '协议端 token' # 未设置 token 时可省略
$env:ALWAYSBACK_MODEL_API_KEY = '模型密钥'   # 模型服务不要求密钥时可省略
node src/cli.mjs doctor
node src/cli.mjs probe onebot
node src/cli.mjs probe model
node src/cli.mjs persona start examples/card.json
Copy-Item examples/answers.json data/answers.json
# 根据上一步实际输出的问题修改回答；不要直接使用示例内容。
notepad data/answers.json
node src/cli.mjs persona finalize data/answers.json
node src/cli.mjs relationship set friend
node src/cli.mjs serve
```

按顺序执行上面的命令；在记事本中保存实际回答后，再运行 `persona finalize`。`doctor` 解析配置并初始化被 Git 忽略的 `data/state.json`，不检查 QQ 或模型是否在线。`probe onebot` 只调用 `get_login_info`；`probe model` 只发送测试文本 `ping`。两个探测成功也不代表真实 QQ 对话已验证。

如果已有完整的 Markdown 角色卡，可跳过 `persona start/finalize`，改用 `node src/cli.mjs persona import 'C:\path\to\card.md'`。导入文件须以 `# 角色：名称` 开头；角色卡原文会保存在本机，并在私聊生成时送给模型。只有原文包含特定格式约定时才启用相应输出规则，例如包含“每条不超过 20 字”时最多拆发 8 条消息。

修改 `config.json` 后须重启服务。`groupIds` 是可回复群名单，不是全群观察名单；`groupCallNames` 是群内文字点名词。远程 OneBot 和模型地址分别要求 WSS 与 HTTPS。

### LLBot 辅助脚本

完成角色卡和关系设置后，也可运行 `./scripts/start-first-test.ps1 -LlbotConfigPath 'C:\path\to\llbot-config.json'`。脚本从 LLBot 配置读取与 `onebotUrl` 匹配的正向 WS token，先检查 OneBot 和模型连通性，再启动服务。模型密钥优先使用 `ALWAYSBACK_MODEL_API_KEY` 环境变量；旧式 `APIkey="..."` 文件可通过 `-TestApiPath` 显式指定。密钥不会写入项目配置。请勿提交 `config.json`、`data/` 或真实角色卡。

`./scripts/probe-recent-image.ps1 -LlbotConfigPath 'C:\path\to\llbot-config.json'` 可读取授权用户最近 30 条私聊中的最新图片，经 LLBot `get_image` 和模型做一次识图检查；它不会发送 QQ 消息，会在终端打印模型对图片的描述。
`./scripts/probe-group-status.ps1 -LlbotConfigPath 'C:\path\to\llbot-config.json'` 只读取白名单群的近期消息并输出不含正文的统计，用于检查 LLBot 群历史接口；不会发送 QQ 消息或调用模型。

角色卡初始分析及补全会把用户提供的设定发送给模型服务。运行中的私聊回复也会发送当前消息及有限历史给模型服务。图片探测会把所选图片送给模型；群状态探测不调用模型。

## 管理命令

```powershell
node src/cli.mjs consent show
node src/cli.mjs consent enable analysis --accept-disclosure
node src/cli.mjs consent enable profile --accept-disclosure
node src/cli.mjs consent disable analysis
node src/cli.mjs consent disable profile
node src/cli.mjs proactive status
node src/cli.mjs proactive enable
node src/cli.mjs proactive disable
node src/cli.mjs analyze now
node src/cli.mjs profile now
node src/cli.mjs proposals list
node src/cli.mjs proposals approve <建议ID>
node src/cli.mjs proposals reject <建议ID>
node src/cli.mjs erase conversations
node src/cli.mjs erase analysis
node src/cli.mjs erase profile
node src/cli.mjs erase all
```

- 启用分析前先运行 `consent show` 阅读告知；`--accept-disclosure` 表示确认该告知。对话分析和用户画像须分别授权。
- `analyze now` 与 `profile now` 生成候选资料；`proposals list` 查看待审建议，`approve` 后才参与私聊生成。
- `consent disable profile` 停止新画像分析和旧画像注入；`erase profile` 删除本机已有画像及其建议。
- `erase conversations` 只删除原始私聊历史。要一并删除衍生资料，使用 `erase analysis`、`erase profile`，或执行重置全部状态的 `erase all`。

### 主动私聊

`proactive enable|disable` 独立控制主动私聊，默认关闭；消息只发给 `ownerQq`，不会主动在群里发言。默认频率只依据用户显式设置的关系状态：

| 关系 | 随机间隔 | 用户最短空闲 | 滚动 24 小时上限 |
| --- | --- | --- | --- |
| `stranger` | 不主动联系 | — | 0 |
| `friend` | 4–8 小时 | 90 分钟 | 2 次 |
| `partner` | 2–4 小时 | 60 分钟 | 3 次 |

共同条件为近 7 天有私聊、北京时间 23:00–08:00 免打扰、连续 2 次未获回复后停发。关系变更会重新排期；服务离线或错过计划时间不补发。模型可跳过，发送前会复查开关、新私聊和关系状态。成功取得 QQ 回执后才写入私聊历史；回执失败或不明时不自动重发。用 `proactive status` 查看计划和尝试记录，具体参数见 [`config.example.json`](config.example.json)。

### 数据与隐私

`data/state.json` 是本机明文数据，包含聊天正文与衍生资料；请限制目录访问。`config.json` 保存账号和服务地址，密钥通过环境变量提供。角色卡、用户画像和真实聊天记录可能涉及私人信息，不要提交到仓库。

## 全群观察与角色短期想法

群聊角色卡另有独立的公开关系配置：在 `config.json` 中填写 `groupPersona.publicOwnerRelationship` 和对应的 `forRelationship`（`stranger`、`friend` 或 `partner`）。只有当前显式关系与配置相符时，群回复才会使用这段文字。`doctor` 显示配置是否生效。修改配置后须重启服务。原始角色卡“人物关系（记忆锚点）”仍不直接进入群聊；若要公开其他人物关系，需另行审核并配置。群中发言者的昵称不能用于推断他就是授权用户。

群观察与群回复分开。`groupIds` 仍只表示可回复群；`group-observation enable` 后，本机接收 OneBot 实际推送的所有已加入群普通文字消息，可在 `config.json` 的 `groupObservation.excludedGroupIds` 排除群。观察不会触发回复、取图、群历史查询或逐条模型调用。协议端若未推送某群，本服务无法补看，`status` 也不能证明全群覆盖。

群观察和远端分析默认都关闭。先用 `consent show` 阅读告知，再分别启用：

```powershell
node src/cli.mjs group-observation status
node src/cli.mjs group-observation probe-feed
node src/cli.mjs group-observation enable --accept-disclosure
node src/cli.mjs group-observation remote-enable --accept-disclosure
node src/cli.mjs group-observation analyze
node src/cli.mjs group-observation remote-disable
node src/cli.mjs group-observation clear all
node src/cli.mjs group-observation clear 123456789
node src/cli.mjs group-observation disable
```

启用远端分析后，只有新收到的群消息进入待分析缓冲；此前仅在本地观察期间收到的消息不会补传。每条文字最多 500 字，媒体只保存类型，不下载附件。原始缓冲最长保留 24 小时，想法最长保留 30 天。批量分析默认最短间隔 30 分钟，每轮最多 4 群、每群 5 条、6000 字；每日另有限次和输入预算，详见 [`config.example.json`](config.example.json)。字符和估算 token 预算不是精确的 token 硬额度。

`status` 可查看缓冲数量、群号、短期想法及来源、丢弃计数和跳过原因。`clear GROUP_QQ` 删除该群缓冲及所有引用该群的想法；`clear all` 删除全部。关闭远端分析清理派生想法并停止新外传；关闭本地观察还会清理缓冲。想法只作为私聊或主动私聊的可选话题，不改变主动联系的任何闸门。群回复不注入其他群的观察。群内说法只表示群里有人讨论，不能当成已证实的现实事实。

`probe-feed` 只读取登录信息与已加入群列表，并被动监听 20 秒；不记录消息正文。若 OneBot 连接配置了令牌，先设置 `ALWAYSBACK_ONEBOT_TOKEN`。一次短时探测不能证明协议端覆盖所有已加入群，也不能证明真实 QQ 消息送达。

## 时间感知

普通私聊、群聊和主动私聊的每次模型请求都包含 `timeContext`。它由服务端按 `Asia/Shanghai` 生成，包含 `now`（北京时间，精确到分钟）、`weekday`、`nowUtc`；有近期历史时还包含 `minutesSinceLastMessage`，表示距离**本次提供的最后一条历史消息**的分钟数。普通私聊和群聊在 OneBot 事件时间有效时另带 `currentMessageAt`。历史中的 `at` 为各条消息的时间，不能当作当前时间。

OneBot 事件时间只有落在服务端当前时间前 7 天至后 5 分钟内才会采用；否则不传 `currentMessageAt`，私聊入库时使用服务端时间。群历史取不到时仍提供当前时间，但不提供该群的历史间隔。模型被要求以 `timeContext` 回答“现在、今天、明天、星期几”等问题，仅在话题需要时提及时间；它不能据此知道天气、用户日程或现实活动。时间准确性取决于运行机器的系统时钟，服务不自行联网校时。

本地验证可运行 `node --test`，检查固定时钟下私聊、群聊和主动私聊装配出的时间字段。真实效果可在 QQ 中询问当天日期、星期和时间，再与北京时间核对；本地测试不能保证模型每次都遵循提示。

## 运行边界

- 时间感知只向模型提供事实和指令，不代替模型输出校验；具体字段与边界见上节。
- 私聊仅处理 `ownerQq` 发给 `botQq` 的 OneBot v11 消息；其他用户私聊不触发模型或回复。昵称与群名片不参与鉴别。
- 白名单群内任意成员的消息，结构化消息段明确 `@botQq`，或文字段包含 `groupCallNames` 中任一点名词，即可触发回复；单独 `@` 也可触发。图片中的文字不会被当作点名词。未列入白名单的群和未触发点名的消息不回复。触发时从 OneBot `get_group_msg_history` 读取本群最多 `groupHistoryLimit` 条、12 小时内的历史，按时间顺序提供发言者、机器人回复和窗口内引用关系；每条正文最多 320 字、总量最多 6000 字。历史图片、语音等只提供类型占位，不声称看到了内容。群聊注入公开人格及显式公开的关系描述，不注入 QQ 身份、私聊记录、记忆和画像。群回复路径不保存正文；开启观察后，收到的普通群消息会按上述限额短期保存。若历史接口失败，模型请求会明确带上“历史不可用”的标记。
- 支持文本和图片段（纯图或图文，单条最多 4 张、每张最多 8 MiB，JPEG/PNG/GIF/WebP）。通过 OneBot `get_image` 读取图片后发送给支持视觉的模型；图片字节不写入本地会话历史，仅记录 `[图片×数量]` 标记。图片读取失败会明确回复，避免假装识图。语音、反向 WebSocket 和平台扩展动作尚未支持。三个协议端共享 OneBot 适配层，但尚未分别做真实兼容性测试。
- 每天本地时间达到 `analysisHourLocal` 后运行一次已授权的整理；服务不运行时不会执行。失败后记录错误并在下次定时检查时重试。重复消息采用有限的近期 ID 窗口去重；回执未知时不自动重发。
- 本地数据为单机 JSON 状态文件，写入有进程间文件锁和原子替换。若进程异常退出留下 `.lock`，先确认所有实例均已退出，再手动移除锁文件。

## 验证

```powershell
node --test
```

自动测试使用模拟模型、模拟发送端和本地 WebSocket 协议端，覆盖身份、群聊准入、公开人格隔离、时间上下文、主动联系闸门、许可、建议审核、鉴权头、去重与图片请求结构。测试通过不证明真实 QQ 外发，也不保证模型每次遵守时间提示。LLBot 曾做过单机只读群历史与图片通路探测；SnowLuma、NapCat 尚未实测。真实部署须分别核对接收、模型调用、发送回执与 QQ 收件。
