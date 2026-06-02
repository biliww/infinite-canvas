# 接入 image-tasks 异步接口方案

## 背景

`chatgpt2api` 已支持图片异步任务接口：

```text
POST /api/image-tasks/generations
POST /api/image-tasks/edits
GET  /api/image-tasks?ids=...
```

上一版方案把 `infinite-canvas` 的 `remote` 生图请求直接改成提交 `image-tasks`，但这样会有维护问题：后台已有的普通 OpenAI 兼容渠道不一定支持 `/api/image-tasks/*`，如果不区分协议，后端选渠道时可能把任务请求发到普通 `/v1` 渠道。

新方案改为协议驱动：后台新增渠道时通过 `protocol` 明确选择渠道能力。

```text
openai       普通 OpenAI 兼容接口，继续走 /v1/images/*、/v1/chat/*、/v1/videos/*
image_tasks  chatgpt2api 图片任务接口，专门走 /api/image-tasks/*
```

不建议使用 `myTask` 这类私有命名，因为协议名应表达真实能力，后续维护和排查日志更清楚。

## 目标

1. 保留现有同步图片接口和普通渠道能力不变。
2. 后台渠道新增 `image_tasks` 协议选项。
3. Go 后端新增 `/api/v1/image-tasks/*` 代理，只选择 `image_tasks` 协议渠道。
4. 普通 `/api/v1/images/*`、聊天、视频等接口只选择 `openai` 协议渠道，避免误选任务渠道。
5. 前端先回滚上一版“remote 自动强制走 image-tasks”的改动，后续如果要让画布自动使用异步任务，再增加明确开关或显式调用入口。

## 当前调用边界

### 同步生图链路

```text
web/src/services/api/image.ts
  requestGeneration/requestEdit
    -> /api/v1/images/generations
    -> /api/v1/images/edits
      -> handler/ai.go
        -> service.SelectModelChannel(model)
          -> 只选择 openai 协议渠道
        -> 上游 /v1/images/*
```

这条链路保持不变，画布、生图工作台、画布助手现有调用方无需调整。

### 异步任务链路

```text
调用方显式请求 /api/v1/image-tasks/generations 或 /api/v1/image-tasks/edits
  -> handler/ai_image_tasks.go
    -> service.SelectModelChannelByProtocol(model, "image_tasks")
    -> {channel.baseUrl 去掉 /v1}/api/image-tasks/*
  -> GET /api/v1/image-tasks?ids=...&model=...
    -> 优先使用内存记录中的提交渠道
    -> 未命中时只扫描 image_tasks 协议渠道
```

## 后台渠道协议

后台新增/编辑渠道时，`protocol` 下拉提供：

```text
OpenAI 兼容接口 -> openai
图片任务接口   -> image_tasks
```

保存配置时保留协议值；空协议仍按 `openai` 归一化，保持旧配置可继续使用。

`image_tasks` 渠道配置建议：

```json
{
  "protocol": "image_tasks",
  "name": "chatgpt2api image tasks",
  "baseUrl": "http://127.0.0.1:8000",
  "apiKey": "chatgpt2api-api-key",
  "models": ["gpt-image-1"],
  "weight": 1,
  "enabled": true
}
```

如果 `baseUrl` 填成 `http://127.0.0.1:8000/v1`，后端会在构造任务地址时去掉末尾 `/v1`，最终请求：

```text
http://127.0.0.1:8000/api/image-tasks/generations
```

## 后端实现

### 协议常量

在 `model/setting.go` 中定义：

```go
const (
    ModelChannelProtocolOpenAI     = "openai"
    ModelChannelProtocolImageTasks = "image_tasks"
)
```

### 渠道选择

`service/settings.go` 保留原方法名，但语义收窄：

```go
func SelectModelChannel(modelName string) (model.ModelChannel, error)
```

它只选择 `openai` 协议渠道，供现有同步代理继续使用。

新增协议选择方法：

```go
func SelectModelChannelByProtocol(modelName string, protocol string) (model.ModelChannel, error)
func ModelChannelsForModelByProtocol(modelName string, protocol string) ([]model.ModelChannel, error)
```

`image_tasks` 代理必须调用：

```go
service.SelectModelChannelByProtocol(modelName, model.ModelChannelProtocolImageTasks)
```

同步代理仍调用：

```go
service.SelectModelChannel(modelName)
```

这样普通接口不会误选异步渠道，异步接口也不会误选普通渠道。

### URL 构造

普通 OpenAI 兼容接口继续使用：

```go
BuildModelChannelURL(channel, "/images/generations")
```

它会保证 `/v1` 前缀。

`image_tasks` 使用：

```go
BuildModelChannelRootURL(channel, "/api/image-tasks/generations")
```

它会去掉渠道地址末尾的 `/v1`，直接从根路径拼接 `/api/image-tasks/*`。

### 任务代理

新增文件：

```text
handler/ai_image_tasks.go
```

新增路由：

```text
POST /api/v1/image-tasks/generations
POST /api/v1/image-tasks/edits
GET  /api/v1/image-tasks?ids=...&model=...
```

提交任务时：

1. 解析 `model` 和 `client_task_id`。
2. 读取用户并计算积分。
3. 只选择 `image_tasks` 协议渠道。
4. 扣积分。
5. 转发到 `chatgpt2api /api/image-tasks/*`。
6. 上游提交失败时退款。
7. 提交成功后记录 `userID + client_task_id -> channel`。

查询任务时：

1. 优先用内存记录里的渠道查询。
2. 记录丢失时，只扫描支持该模型的 `image_tasks` 渠道。
3. 找到任务后透传上游 JSON。
4. 找不到则返回 `items: []` 和 `missing_ids`。

## 前端处理

前端不能只看 `remote` 模式来决定是否走任务接口，因为普通 OpenAI 兼容渠道也可能是 remote。正确判断条件是当前模型对应的渠道协议。

后端公开配置新增：

```json
{
  "modelChannel": {
    "availableModels": ["gpt-image-2"],
    "modelProtocols": {
      "gpt-image-2": "image_tasks"
    }
  }
}
```

`useEffectiveConfig()` 会把这个映射合入 `AiConfig`：

```text
config.modelProtocols[config.model]
```

`web/src/services/api/image.ts` 的判断逻辑：

```ts
function isImageTaskModel(config: AiConfig) {
    return config.channelMode === "remote" && config.modelProtocols?.[config.model] === "image_tasks";
}
```

文生图：

```ts
requestGeneration()
  -> image_tasks 模型：POST /api/v1/image-tasks/generations，然后轮询 GET /api/v1/image-tasks
  -> openai 模型：POST /api/v1/images/generations
```

图生图：

```ts
requestEdit()
  -> image_tasks 模型：POST /api/v1/image-tasks/edits，然后轮询 GET /api/v1/image-tasks
  -> openai 模型：POST /api/v1/images/edits
```

这样画布、生图工作台、画布助手仍然调用原来的 `requestGeneration/requestEdit`，但会根据模型协议自动选择正确接口。

## 最小改动文件

```text
model/setting.go
service/settings.go
handler/ai_image_tasks.go
router/router.go
web/src/services/api/admin.ts
web/src/app/(admin)/admin/settings/page.tsx
web/src/services/api/image.ts
docs/pending-test.md
```

其中 `web/src/services/api/image.ts` 只按当前模型协议切换，不再把所有 remote 图片请求都强制切到任务接口。

## 验证清单

后台配置：

- 新增渠道时可选择 `图片任务接口`。
- 保存后 JSON 中 `protocol` 为 `image_tasks`。
- 旧渠道不填协议时仍归一化为 `openai`。

同步接口：

- `openai` 协议模型的普通文生图、图生图仍走 `/api/v1/images/*`。
- 后端只选择 `openai` 协议渠道。
- 配了 `image_tasks` 渠道后，不影响聊天、视频和其他 `openai` 模型。

异步接口：

- `image_tasks` 协议模型点击生图时，请求 `/api/v1/image-tasks/generations`。
- `image_tasks` 协议模型点击图生图时，请求 `/api/v1/image-tasks/edits`。
- `GET /api/v1/image-tasks?ids=...&model=...` 能查到同一个任务。
- 没有 `image_tasks` 渠道时，任务接口返回不可用渠道错误，不影响同步接口。

## 后续建议

后续可以继续增强：

1. 在任务查询到最终 `error` 时做一次性退款。
2. 把任务与渠道映射从内存改为数据库持久化。
3. 在管理后台公开模型选择处展示模型协议，减少同名模型来自不同协议时的歧义。

这样不会把渠道协议、调用模式和 UI 行为混在一起，后续合并主分支也更容易处理冲突。
