# opencodez-free

一个**本地运行**的 OpenAI 兼容服务，把 [OpenCode Zen](https://opencode.ai/zen) 的
**免费匿名模型通道**暴露成 `http://127.0.0.1:8787/v1`，并自带一套 Web 管理面板。

**不需要注册、不需要登录任何账号**——上游那条通道本来就免 key。启动时会自动生成一个
本地访问密钥，填进你的客户端即可（详见[关于密钥](#关于密钥)）。任何支持 OpenAI 协议的
客户端（ChatBox、Cherry Studio、Continue、Cline、各种 SDK……）填上地址和密钥就能用。

> 本项目改造自 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)。
> 原项目是一个 **DSH（DeepSeek Harness）插件**，只能跑在 DSH 进程里；改造后它
> 变成一个**独立的本地 HTTP 服务**，与任何编辑器或客户端解耦。
> 管理面板的设计语言参考 [workbuddy-free](https://github.com/Patrick-mufeng/workbuddy-free)
> 的 PIXEL OPS（像素终端风格）。

---

## 界面预览

| 视图 | 作用 |
| --- | --- |
| **运行概览** | 服务状态、Base URL 一键复制、模型目录状态、最近请求的耗时与用量 |
| **用量统计** | 累计 token / 请求 / 失败，按日或按小时的「消费节律」柱图，模型分布 |
| **诊断中心** | **批量实测每个模型是否真的可用**（首字节延迟、失败原因分类） |
| **模型与档位** | 上下文长度、最大输出、输入类型、每模型支持的思考档位 |
| **配置** | 图形化改配置（保存即生效，无需重启），含密钥、看门狗、统计保留 |
| **运行日志** | 按「对话 / 任务 / 系统」分频道的实时日志，增量拉取 |

访问 <http://127.0.0.1:8787/panel/>。

---

## 为什么能免 key

OpenCode 官方会为**未登录用户**提供一条免费通道（OpenCode 自己的 CLI 就在用它）。
该通道对请求有三项硬性要求，本服务负责补齐：

| 要求 | 说明 |
| --- | --- |
| `User-Agent` | 必须是 OpenCode CLI 的 UA |
| 会话 ID 形状 | 必须是 `ses_<12位hex><14位base62>` |
| 请求体形状 | 必须 `stream: true`，且 `tools` 里必须有名为 `bash` 和 `read` 的函数 |

三项缺一都会得到 `403 FreeTierError`。本服务自动完成这些伪装，客户端无需感知。

---

## 快速开始

环境要求：**Node.js ≥ 22.18**（用到原生 TypeScript 支持）。**没有任何 npm 依赖，
不需要 `npm install`，不需要编译。**

```sh
cd opencodez-free
node src/index.ts
```

启动后：

```
server listening {"url":"http://127.0.0.1:8787","api":"http://127.0.0.1:8787/v1"}
panel: http://127.0.0.1:8787/panel/

  ================================================================
   Credentials generated for this service.
  ================================================================

   Agent key (send to http://127.0.0.1:8787/v1):
       ozk_THIS_IS_AN_EXAMPLE_KEY_REPLACED_AT_RUNTIME_A

   Panel key (unlocks http://127.0.0.1:8787/panel/):
       ozk_THIS_IS_AN_EXAMPLE_KEY_REPLACED_AT_RUNTIME_B

   Agent key file: C:\Users\you\.opencodez-free\agent-key.txt
   Panel key file: C:\Users\you\.opencodez-free\api-key.txt

   Reused on every later start; delete a file to rotate that key.
   Run with --no-auth to turn authentication off.

catalog ready: 13 model(s) exposed of 87 live
```

- **Agent key** → 填进 Agent / 客户端的 API Key 字段
- **Panel key** → 打开面板时输入

两者都是首次生成、之后复用，面板上随时可查看和复制。

也可以直接用 npm 脚本：

```sh
npm start          # 同上
npm run dev        # 文件变更自动重启
npm test           # 运行测试（219 个用例）
```

---

## 关于密钥

服务用**两个互相独立**的凭证，默认状态不同：

| 凭证 | 默认 | 用途 | 存放 |
| --- | --- | --- | --- |
| **Agent 接入密钥** | **开启** | Agent / 客户端调 `/v1` 用 | `~/.opencodez-free/agent-key.txt` |
| **面板登录密钥** | **关闭** | 进 `/panel/` 用 | `~/.opencodez-free/api-key.txt`（开启后才有） |

为什么默认不一样：`/v1` 端口本机上任何程序都能访问，不设防就等于把免费通道敞开给所有人；
而面板只是你自己看自己的服务，且只绑定回环地址，再加一道密码是纯粹的摩擦。
**所以本地自己用，面板直接打开、不用输密码，而 Agent 必须带密钥。**

### Agent 怎么接

```
Base URL:  http://127.0.0.1:8787/v1
API Key:   ozk_...   ← 启动日志里的 Agent key，或面板「运行概览」页复制
```

鉴权头**接受三种写法**，绝大多数 Agent 客户端不用改配置就能接：

```sh
# OpenAI 官方 SDK / 大多数客户端
-H "Authorization: Bearer ozk_xxx"

# Anthropic 风格客户端与不少网关
-H "x-api-key: ozk_xxx"

# Azure 风格
-H "api-key: ozk_xxx"
```

（裸的 `Authorization: ozk_xxx` 不带 `Bearer` 前缀也接受。）

### 想给面板也加密码

面板「配置 → 访问密钥」里打开「打开面板需要密钥」，会自动生成一个面板密钥。
命令行则用 `--panel-auth`；也可以在配置里写 `"panelAuth": true`。
共用电脑、或者你把服务暴露给局域网/公网时，建议打开。

### 轮换与自定义

- 面板「配置 → 访问密钥」里两个密钥**可以分别**显示、复制、重新生成，互不影响。
  轮换 Agent 密钥不会把你踢出面板；轮换面板密钥会自动更新当前浏览器会话。
- 想固定用自己的密钥：填「自定义密钥」两个输入框，或用 `--agent-key` / `--api-key`
  （也可用 `OPENCODEZ_AGENT_KEY` / `OPENCODEZ_API_KEY`）。指定后不再自动生成或轮换。
- 忘了密钥：看启动日志、看面板概览页，或直接读上面那两个文件。
- **密钥不写进 `config.json`**，各自单独存文件。`config.json` 是最容易被复制、
  贴进 issue 的那个文件，密钥不该跟着走；面板保存配置也不会把密钥写回去。
- 彻底关掉 API 鉴权：`--no-auth`（或配置 `"auth": false`）。同样不建议。

## 命令行参数

```
node src/index.ts [选项]

  --host <host>                  监听地址（默认 127.0.0.1）
  --port <port>                  监听端口（默认 8787；0 表示随机端口）
  --api-key <key>                直接使用这个面板密钥（跳过自动生成）
  --agent-key <key>              直接使用这个 Agent 密钥
  --no-auth                      完全关闭客户端鉴权
  --config <path>                配置文件路径（默认 ~/.opencodez-free/config.json）
  --zen-base-url <url>           上游 Zen 地址
  --metadata-url <url>           models.dev 元数据地址
  --refresh-seconds <n>          模型列表刷新间隔（默认 300，最小 30）
  --cache-path <path>            models.dev 缓存路径
  --default-model <id>           请求未指定 model 时使用的默认模型
  --expose-all-models            暴露全部在线模型（而非仅免费模型）
  --no-reasoning                 不返回思考内容
  --first-event-ms <n>           看门狗：等待首个流事件（默认 60000）
  --body-idle-ms <n>             看门狗：流中途静默容忍（默认 120000）
  --responses-body-idle-ms <n>   Responses 模型的静默容忍下限（默认 300000）
  --max-rotates <n>              内容开始前的重试次数（默认 3）
  --max-body-bytes <n>           请求体上限（默认 33554432）
  --stats-keep-days <n>          用量明细保留天数（默认 30）
  --stats-path <path>            用量历史文件路径
  --no-panel                     关闭管理面板
  --log-level <level>            silent | error | warn | info | debug（默认 info）
  --help, -h                     显示帮助
  --version, -v                  显示版本
```

所有参数都有对应的环境变量，前缀 `OPENCODEZ_`，例如 `OPENCODEZ_PORT`、
`OPENCODEZ_API_KEY`、`OPENCODEZ_AGENT_KEY`、`OPENCODEZ_AUTH`、`OPENCODEZ_LOG_LEVEL`、`OPENCODEZ_PANEL`。

### 配置文件

`~/.opencodez-free/config.json`（支持 `//` 注释）。**面板「配置」页保存的也是这个文件，
且保存后立即生效**（监听地址、端口、面板开关这三项需要重启）：

```jsonc
{
  "port": 8787,
  "auth": true,
  "refreshSeconds": 300,
  "includeReasoning": true
}
```

优先级：**命令行 > 环境变量 > 配置文件 > 默认值**。

> 面板保存**只会写它自己表单里的字段**，不会碰配置文件里的其他内容——
> 手工加的选项不会被面板覆盖掉。密钥也不在这个文件里（见上文「关于密钥」）。

### 用量统计

统计按自然日聚合（本地时区），落盘在 `~/.opencodez-free/stats.json`：

- **累计口径**（面板头条）从第一次请求起累加，**不随保留窗口缩减**。
- **区间口径**（图表与排行）只覆盖 `statsKeepDays` 天内的明细。

两个口径刻意分开，所以头条数字永远大于等于区间数字，不会出现「用了一阵子总量变小了」。
面板上的「清空显示」只清最近请求的显示，**不动累计统计**。

---

## 它是怎么工作的

```
你的客户端                     浏览器
   │  POST /v1/chat/completions    │  GET /panel/
   │  Authorization: Bearer ozk_…  │  （页面可打开，API 需密钥）
   ▼                               ▼
opencodez-free（本地 Node 服务，127.0.0.1）
   │  · 校验客户端密钥（默认开启，首次启动自动生成）
   │  · 补齐免费通道要求的请求体形状（stream + bash/read 工具）
   │  · 注入 CLI 伪装头（UA、规范会话 ID、请求/项目 ID）
   │  · 看门狗监控流活性，必要时换新身份重试
   │  · 统计用量、记录日志、响应面板 API
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   │  SSE（含 ": keep-alive" 心跳与 reasoning 字段）
   ▼
本地聚合 / 协议翻译 → 返回给你的客户端
```

几个实现要点：

- **会话身份**：`ses_*` 由对话首条 user 消息派生（SHA-256），同一对话稳定、
  不可逆，从而保留上游的 prompt cache 亲和性。
- **模型目录**：三级回退 —— 在线 `GET /v1/models` ∩ models.dev 免费判定，
  失败时用本地缓存，再失败用编译期校验过的内置列表。
- **看门狗**：上游会先发 `: keep-alive` 心跳再出内容；心跳不算活性，因此
  连接卡死能及时暴露，而不是把一次对话挂死几十分钟。
- **失败重试**：内容开始前失败会用新会话身份重试；一旦有内容输出就绝不重放，
  避免重复计费或重复内容。地区限制（`RegionError`）属于确定性失败，不重试。
  **思考档位被拒是第四种情况**：去掉该字段重试一次（见上文「推理内容」）。
- **面板零依赖**：面板是纯静态 HTML + 原生 JS，由服务自身提供，没有构建步骤，
  也没有前端框架。

---

## 项目结构

```
src/
  index.ts      入口：读配置、解析密钥、起服务、装配面板、优雅退出
  config.ts     配置合并（默认值 / 文件 / 环境变量 / 命令行）与密钥生成
  server.ts     HTTP 路由与请求处理（含用量记账）
  upstream.ts   上游客户端：伪装头、看门狗、SSE 解析、重试
  catalog.ts    模型目录：三级回退、免费判定、缓存
  gate.ts       免费通道的请求体形状与 effort 映射
  responses.ts  Responses API ⇄ Chat Completions 互转
  openai.ts     流式分片聚合为完整响应
  ids.ts        会话/请求 ID 派生与伪装头
  stats.ts      用量统计：按日/时聚合、累计总量、落盘
  logring.ts    有界日志环形缓冲，供面板读取
  probe.ts      模型实测：单模型与批量队列
  panel.ts      面板 HTTP API（鉴权、密钥读写、配置读写、各视图数据）
  logger.ts     日志（同时写入 stderr 与面板环形缓冲）
panel/
  index.html    面板页面（含全部 CSS，PIXEL OPS 设计令牌）
  app.js        面板逻辑：路由、图表、主题、密钥、轮询
test/           203 个用例：node:test，全部离线（stub 上游）
```

运行时状态都在 `~/.opencodez-free/`：

| 文件 | 内容 |
| --- | --- |
| `agent-key.txt` | 自动生成的 **Agent 接入密钥**（可删，删了会重新生成） |
| `api-key.txt` | 自动生成的**面板登录密钥**（可删，删了会重新生成） |
| `config.json` | 面板保存的配置（**不含密钥**） |
| `stats.json` | 用量历史 |
| `models.dev.json` | 模型元数据缓存 |
| `server.json` | 当前进程的端口等信息，供工具发现 |

---

## 常见问题

**Q: model 找不到 / 404？**
先 `curl http://127.0.0.1:8787/v1/models` 看当前可用的 id。Zen 的免费模型列表
轮换很频繁，上面的 id 随时可能上下线。如果某个模型明明在线却没被列出，
可能是 models.dev 把它标成了 deprecated —— 用 `--expose-all-models` 可以看到
全部在线模型。

**Q: 列出来的模型却调用失败？**
**这是常态，也是面板「诊断中心」存在的理由。** 免费通道的模型列表里混着几类
实际不可用的条目：地区限制的（`RegionError`）、上游端点下线的、协议不匹配的、
以及返回 200 但内容为空的。点「诊断中心 → 开始实测」跑一遍，就能拿到每个模型的
真实可用性与首字节延迟，然后只把可用的填进客户端。

**Q: 返回 `This model is not available in your country`？**
这是上游的地区限制（`RegionError`），与本地服务无关。比如 `muse-spark-*`
系列只在部分区域可用。换一个模型即可 —— 本服务会把其他模型翻译成
Chat Completions 时不受这一步影响。用「诊断中心」找出你所在地区真正可用的模型。

**Q: 返回 403 FreeTierError？**
理论上不会：请求体形状和伪装头都由本服务自动处理。如果遇到，可能是上游改了
校验规则，请更新本服务。

**Q: 我设的思考档位没生效？**
部分免费模型只接受它自己的档位阶梯，会拒绝别的值。本服务会自动去掉该字段重试，
所以请求仍然成功，但档位按模型默认值走。用「模型与档位」页看每个模型声明支持什么。

**Q: 端口被占用？**
`--port 8899` 换一个，或 `--port 0` 让系统分配（启动日志与面板都会显示实际端口）。

**Q: 想让它更安全？**
默认就只监听 `127.0.0.1`，并且**默认要求密钥**，所以本机上不认识的其他程序也用不了。
不要用 `--host 0.0.0.0` 暴露到公网，除非你确实清楚风险。想进一步收紧可以改密钥
（面板「配置 → 重新生成」）或换个端口。

**Q: 密钥是什么？我要去哪里找？**
见上文[关于密钥](#关于密钥)。一句话：启动日志里会打印，面板「运行概览」页也能看到并复制，
Agent 密钥在 `~/.opencodez-free/agent-key.txt`。

**Q: 为什么面板不用输密码？**
默认如此——面板只绑定本机、只看你自己的服务，再加一道密码没必要。想让面板也要密码，
在「配置 → 访问密钥」里打开「打开面板需要密钥」即可（或用 `--panel-auth`）。

**Q: 面板打不开 / 不想要？**
面板默认开启，访问 `/panel/`。用 `--no-panel` 或配置 `"panel": false` 完全关闭。

---

## License

MIT —— 与原项目一致。
