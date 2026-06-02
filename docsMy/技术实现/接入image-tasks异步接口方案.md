# 接入 image-tasks 异步接口方案

## 背景

当前项目生图调用为**同步阻塞**模式，前端 axios 等待上游返回（可能长达 10~60s），存在超时断连、无法中断、无队列感知等问题。

`chatgpt2api` 提供了一套**异步任务队列接口**（`/api/image-tasks/*`），可解决上述问题。本文档给出**最小改动**的接入方案。

---

## 接口对比

| 维度 | 当前同步接口 | image-tasks 异步接口 |
|------|------------|---------------------|
| 接口地址（文生图） | `POST /v1/images/generations` | `POST /api/image-tasks/generations` |
| 接口地址（图生图） | `POST /v1/images/edits` | `POST /api/image-tasks/edits` |
| 调用方式 | 同步阻塞等结果 | 提交立即返回，轮询获取 |
| 返回格式 | `{ data: [{b64_json, url}] }` | `{ id, status, data: [{url}] }` |
| 图片格式 | `b64_json` 或 `url` | 仅 `url`（图片已存在服务端） |
| 重复提交 | 每次新任务 | 幂等，相同 `client_task_id` 不重复执行 |

> 详细接口说明见：`chatgpt2api/docsMy/技术实现/image_tasks_对接指南.md`

---

## 最小改动方案

**改动范围：仅修改 `web/src/services/api/image.ts` 一个文件**，所有调用方（`image/page.tsx`、`canvas-assistant-panel.tsx`、`canvas-client-page.tsx`）无需改动，因为它们只依赖 `requestGeneration` 和 `requestEdit` 的返回值类型 `{id, dataUrl}`。

---

## 改动内容

### 新增：任务 ID 生成

```ts
import { nanoid } from "nanoid";

// 生成唯一任务 ID，作为 client_task_id 传给服务端
function newTaskId(): string {
    return nanoid();
}
```

### 新增：轮询函数

```ts
// 轮询间隔（ms）
const POLL_INTERVALS = [2000, 3000, 3000, 5000, 5000];
const POLL_DEFAULT_INTERVAL = 5000;
const POLL_TIMEOUT = 120_000;

async function pollImageTask(
    baseUrl: string,
    headers: Record<string, string>,
    taskId: string,
): Promise<Array<{ id: string; dataUrl: string }>> {
    const deadline = Date.now() + POLL_TIMEOUT;
    let attempt = 0;

    while (Date.now() < deadline) {
        const interval = POLL_INTERVALS[attempt] ?? POLL_DEFAULT_INTERVAL;
        await new Promise((r) => setTimeout(r, interval));
        attempt++;

        const resp = await axios.get<{
            items: Array<{
                id: string;
                status: string;
                data?: Array<{ url?: string }>;
                error?: string;
            }>;
        }>(`${baseUrl}/api/image-tasks?ids=${taskId}`, { headers });

        const task = resp.data.items?.[0];
        if (!task) throw new Error(`任务 ${taskId} 不存在`);

        if (task.status === "success") {
            const images = (task.data ?? [])
                .map((item) => item.url)
                .filter((url): url is string => Boolean(url))
                .map((url) => ({ id: nanoid(), dataUrl: url }));
            if (images.length === 0) throw new Error("任务完成但未返回图片");
            return images;
        }

        if (task.status === "error") {
            throw new Error(task.error || "图片生成失败");
        }
        // queued / running → 继续轮询
    }

    throw new Error("图片生成超时，请稍后重试");
}
```

### 改造：`requestGeneration`

```ts
export async function requestGeneration(config: AiConfig, prompt: string) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);

    // 仅 remote 模式走异步任务接口，直连模式保持原逻辑
    if (config.channelMode === "remote") {
        const taskId = newTaskId();
        const baseUrl = "";  // 相对路径，走当前域名
        const headers = aiHeaders(config, "application/json") as Record<string, string>;
        try {
            await axios.post(
                `/api/image-tasks/generations`,
                {
                    client_task_id: taskId,
                    model: config.model,
                    prompt: withSystemPrompt(config, prompt),
                    ...(quality ? { quality } : {}),
                    ...(requestSize ? { size: requestSize } : {}),
                },
                { headers },
            );
            const images = await pollImageTask(baseUrl, headers, taskId);
            refreshRemoteUser(config);
            return images;
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }

    // 直连模式：原有逻辑不变
    try {
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(config, "/images/generations"),
            {
                model: config.model,
                prompt: withSystemPrompt(config, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                response_format: "b64_json",
            },
            { headers: aiHeaders(config, "application/json") },
        );
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}
```

### 改造：`requestEdit`

```ts
export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[]) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const files = await Promise.all(
        references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })),
    );

    // 仅 remote 模式走异步任务接口
    if (config.channelMode === "remote") {
        const taskId = newTaskId();
        const headers = aiHeaders(config) as Record<string, string>;
        const formData = new FormData();
        formData.set("client_task_id", taskId);
        formData.set("model", config.model);
        formData.set("prompt", withSystemPrompt(config, prompt));
        if (quality) formData.set("quality", quality);
        if (requestSize) formData.set("size", requestSize);
        files.forEach((file) => formData.append("image", file));
        try {
            await axios.post(`/api/image-tasks/edits`, formData, { headers });
            const images = await pollImageTask("", headers, taskId);
            refreshRemoteUser(config);
            return images;
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }

    // 直连模式：原有逻辑不变
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withSystemPrompt(config, prompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    if (quality) formData.set("quality", quality);
    if (requestSize) formData.set("size", requestSize);
    files.forEach((file) => formData.append("image", file));
    try {
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(config, "/images/edits"),
            formData,
            { headers: aiHeaders(config) },
        );
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}
```

---

## 后端改动（Go）

需要在 `router/router.go` 添加两条代理路由，将 `/api/image-tasks/*` 转发给 `chatgpt2api`：

```go
// 新增：image-tasks 异步接口代理
v1.Any("/image-tasks",             gin.WrapF(handler.ProxyImageTasks))
v1.Any("/image-tasks/generations", gin.WrapF(handler.ProxyImageTasks))
v1.Any("/image-tasks/edits",       gin.WrapF(handler.ProxyImageTasks))
```

或者更简单，直接在前端请求时把 `/api/image-tasks/*` 指向 `chatgpt2api` 的地址（通过 Nginx 反向代理配置），**后端 Go 代码完全不用改**：

```nginx
# Nginx 配置：/api/image-tasks/* 直接转发给 chatgpt2api
location /api/image-tasks/ {
    proxy_pass http://chatgpt2api:8080/api/image-tasks/;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 300s;
}
```

> 推荐 Nginx 方案，改动最小，且 chatgpt2api 的鉴权 Token 和本项目的 Bearer Token 共用同一套，无需额外适配。

---

## 注意事项

### 1. 图片格式变化

异步接口返回的是 `url`（服务端图片链接），而非 `b64_json`。当前 `resolveImageDataUrl` 已支持 `url` 类型，**无需修改**：

```ts
function resolveImageDataUrl(item) {
    if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (item.url)      return item.url;  // ← 已支持
    return null;
}
```

但 `uploadImage` 目前接收 `dataUrl`，若返回的是 `https://...` 的外链 URL，需确认 `uploadImage` 能处理外链（下载后存入 IndexedDB）或直接存链接。

### 2. 服务重启后任务中断

`chatgpt2api` 重启后，`queued/running` 状态的任务会变为 `error`，错误信息为"服务已重启，未完成的图片任务已中断"。`pollImageTask` 遇到 `error` 状态会直接抛出，调用方可提示用户重新生成。

### 3. `n > 1` 的场景

`image-tasks` 接口固定返回 1 张图片（`n: 1`），不支持一次返回多张。当前生图工作台通过并行多个 slot 实现多图，**已天然适配**，无需改动。

### 4. 积分扣减

接入后端 `proxyAIRequest` 中的积分扣减逻辑需评估是否继续适用：异步接口的积分扣减在 `chatgpt2api` 侧已有账号管理，若两侧都扣，需协调清楚。推荐使用 Nginx 代理方案绕过本项目的 Go 后端，直接由 `chatgpt2api` 统一管理配额。

---

## 改动范围汇总

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `web/src/services/api/image.ts` | **修改** | 新增 `pollImageTask`，改造 `requestGeneration` / `requestEdit` remote 分支 |
| Nginx 配置 | **新增** | 转发 `/api/image-tasks/*` 到 `chatgpt2api` |
| `router/router.go` | 可选 | 若不用 Nginx，则在 Go 层新增代理路由 |
| 其他所有文件 | **不变** | 调用方接口签名不变，无需修改 |
