import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ImageTask = {
    id?: string;
    status?: "queued" | "running" | "success" | "error" | string;
    data?: Array<{ url?: string; revised_prompt?: string }>;
    error?: string;
    code?: number;
    msg?: string;
};
type ImageTaskListResponse = {
    items?: ImageTask[];
    missing_ids?: string[];
    code?: number;
    msg?: string;
};

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". Returns undefined when quality is auto. */
function resolveSize(quality: string, ratio: string): string | undefined {
    const basePixels = QUALITY_BASE[quality];
    if (!basePixels || ratio === "auto" || !ratio) return undefined;

    const parts = ratio.split(":");
    if (parts.length !== 2) return undefined;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) return undefined;

    const targetPixels = basePixels * basePixels;
    const isLandscape = w >= h;
    const longRatio = isLandscape ? w / h : h / w;

    const longSideRaw = Math.sqrt(targetPixels * longRatio);
    const longSide = Math.floor(longSideRaw / 16) * 16;
    const shortSide = Math.round((longSide / longRatio) / 16) * 16;

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;

    return `${width}x${height}`;
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value === "auto") return undefined;
    if (/^\d+x\d+$/.test(value)) return value;
    return (quality && resolveSize(quality, value)) || value;
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const images =
        payload.data
            ?.map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    return images;
}

// assertApiSuccess 检查本项目后端包装响应，避免错误响应被当成上游成功结果继续处理。
function assertApiSuccess(payload: { code?: number; msg?: string } | undefined, fallback: string) {
    if (typeof payload?.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || fallback);
    }
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

// aiImageTaskUrl 构造图片任务接口地址，remote 走本项目后端代理，local 直连 chatgpt2api 根路径。
function aiImageTaskUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${baseUrl}${path.replace(/^\/image-tasks/, "/api/image-tasks")}`;
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote"
        ? {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
          }
        : {
              Authorization: `Bearer ${config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

const IMAGE_TASK_POLL_INTERVALS = [2000, 3000, 3000, 5000, 5000];
const IMAGE_TASK_POLL_DEFAULT_INTERVAL = 5000;
const IMAGE_TASK_POLL_TIMEOUT_MS = 180_000;

// isImageTaskModel 判断当前 remote 模型是否来自 image_tasks 协议渠道。
function isImageTaskModel(config: AiConfig) {
    return config.channelMode === "remote" && config.modelProtocols?.[config.model] === "image_tasks";
}

// newImageTaskId 生成前后端幂等识别用的客户端任务 ID。
function newImageTaskId(prefix: "gen" | "edit") {
    return `ic-${prefix}-${Date.now()}-${nanoid()}`;
}

// sleep 用于控制图片任务轮询间隔。
function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// pollImageTask 轮询单个图片任务，成功后转换为现有调用方使用的图片数组结构。
async function pollImageTask(config: AiConfig, taskId: string) {
    const deadline = Date.now() + IMAGE_TASK_POLL_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
        const interval = IMAGE_TASK_POLL_INTERVALS[attempt] ?? IMAGE_TASK_POLL_DEFAULT_INTERVAL;
        await sleep(interval);
        attempt++;

        const response = await axios.get<ImageTaskListResponse>(
            aiImageTaskUrl(config, `/image-tasks?ids=${encodeURIComponent(taskId)}&model=${encodeURIComponent(config.model)}`),
            { headers: aiHeaders(config) },
        );
        assertApiSuccess(response.data, "图片任务查询失败");

        const task = response.data.items?.[0];
        if (!task) {
            if (response.data.missing_ids?.includes(taskId)) throw new Error("图片任务不存在或已过期");
            continue;
        }
        if (task.status === "success") {
            const images = (task.data ?? [])
                .map((item) => item.url)
                .filter((url): url is string => Boolean(url))
                .map((dataUrl) => ({ id: nanoid(), dataUrl }));
            if (!images.length) throw new Error("图片任务完成但没有返回图片");
            return images;
        }
        if (task.status === "error") {
            throw new Error(task.error || "图片生成失败");
        }
    }
    throw new Error("图片生成超时，请稍后重试");
}

// requestImageTaskGeneration 提交文生图任务并轮询返回图片 URL。
async function requestImageTaskGeneration(config: AiConfig, prompt: string, count: number, quality: string | undefined, requestSize: string | undefined) {
    const taskIds = Array.from({ length: count }, () => newImageTaskId("gen"));
    try {
        await Promise.all(
            taskIds.map((taskId) =>
                axios
                    .post<ImageTask>(
                        aiImageTaskUrl(config, "/image-tasks/generations"),
                        {
                            client_task_id: taskId,
                            model: config.model,
                            prompt: withSystemPrompt(config, prompt),
                            quality: quality || "auto",
                            ...(requestSize ? { size: requestSize } : {}),
                        },
                        { headers: aiHeaders(config, "application/json") },
                    )
                    .then((response) => assertApiSuccess(response.data, "图片任务提交失败")),
            ),
        );
        const images = (await Promise.all(taskIds.map((taskId) => pollImageTask(config, taskId)))).flat();
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

// requestImageTaskEdit 提交图生图任务并轮询返回图片 URL。
async function requestImageTaskEdit(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, quality: string | undefined, requestSize: string | undefined) {
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const taskIds = Array.from({ length: count }, () => newImageTaskId("edit"));
    try {
        await Promise.all(
            taskIds.map((taskId) => {
                const formData = new FormData();
                formData.set("client_task_id", taskId);
                formData.set("model", config.model);
                formData.set("prompt", withSystemPrompt(config, prompt));
                formData.set("quality", quality || "auto");
                if (requestSize) {
                    formData.set("size", requestSize);
                }
                files.forEach((file) => formData.append("image", file));
                return axios.post<ImageTask>(aiImageTaskUrl(config, "/image-tasks/edits"), formData, { headers: aiHeaders(config) }).then((response) => assertApiSuccess(response.data, "图片任务提交失败"));
            }),
        );
        const images = (await Promise.all(taskIds.map((taskId) => pollImageTask(config, taskId)))).flat();
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

export async function requestGeneration(config: AiConfig, prompt: string) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    if (isImageTaskModel(config)) {
        return requestImageTaskGeneration(config, prompt, n, quality, requestSize);
    }
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
            {
                headers: aiHeaders(config, "application/json"),
            },
        );
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[]) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    if (isImageTaskModel(config)) {
        return requestImageTaskEdit(config, prompt, references, n, quality, requestSize);
    }
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withSystemPrompt(config, prompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/edits"), formData, { headers: aiHeaders(config) });
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
    let buffer = "";
    let answer = "";
    let processedLength = 0;

    try {
        const response = await axios.post(
            aiApiUrl(config, "/chat/completions"),
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                } as Record<string, string>,
                responseType: "text",
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
