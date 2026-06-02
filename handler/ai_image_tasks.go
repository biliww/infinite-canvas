package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// imageTaskRecord 记录异步图片任务和上游渠道的绑定关系，保证提交和查询使用同一渠道。
type imageTaskRecord struct {
	UserID  string
	TaskID  string
	Model   string
	Path    string
	Channel model.ModelChannel
	Credits int
	Created time.Time
}

// imageTaskStore 保存当前进程内的任务渠道映射，服务重启后允许通过模型扫描兜底。
var imageTaskStore = struct {
	sync.RWMutex
	items map[string]imageTaskRecord
}{items: map[string]imageTaskRecord{}}

const imageTaskRecordTTL = 6 * time.Hour

// AIImageTaskGeneration 代理文生图异步任务提交请求到 image_tasks 协议渠道。
func AIImageTaskGeneration(w http.ResponseWriter, r *http.Request) {
	proxyImageTaskSubmit(w, r, "/image-tasks/generations")
}

// AIImageTaskEdit 代理图生图异步任务提交请求到 image_tasks 协议渠道。
func AIImageTaskEdit(w http.ResponseWriter, r *http.Request) {
	proxyImageTaskSubmit(w, r, "/image-tasks/edits")
}

// AIImageTasks 查询异步图片任务状态，优先使用提交时记录的渠道，避免轮询落到其他上游。
func AIImageTasks(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	taskID := firstImageTaskID(r.URL.Query().Get("ids"))
	if taskID == "" {
		Fail(w, "缺少任务 ID")
		return
	}
	if record, ok := getImageTaskRecord(user.ID, taskID); ok {
		proxyImageTaskQuery(w, r, record.Channel)
		return
	}
	modelName := strings.TrimSpace(r.URL.Query().Get("model"))
	if modelName == "" {
		Fail(w, "缺少模型名称")
		return
	}
	channels, err := service.ModelChannelsForModelByProtocol(modelName, model.ModelChannelProtocolImageTasks)
	if err != nil {
		FailError(w, err)
		return
	}
	for _, channel := range channels {
		payload, status, headers, err := requestImageTaskQuery(r, channel)
		if err != nil || status >= http.StatusBadRequest {
			continue
		}
		if imageTaskPayloadHasID(payload, taskID) {
			writeRawResponse(w, status, headers, payload)
			return
		}
	}
	writeJSON(w, map[string]any{"items": []any{}, "missing_ids": []string{taskID}})
}

// proxyImageTaskSubmit 负责扣积分、选择 image_tasks 渠道并把任务提交给 chatgpt2api。
func proxyImageTaskSubmit(w http.ResponseWriter, r *http.Request, path string) {
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI image task request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	taskID := readImageTaskClientID(body, contentType)
	if taskID == "" {
		Fail(w, "缺少任务 ID")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	credits, err := service.ModelCost(modelName)
	if err != nil {
		log.Printf("AI image task read model cost failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	channel, err := service.SelectModelChannelByProtocol(modelName, model.ModelChannelProtocolImageTasks)
	if err != nil {
		log.Printf("AI image task select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
		FailError(w, err)
		return
	}
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelRootURL(channel, "/api"+path), bytes.NewReader(body))
	if err != nil {
		_ = service.RefundUserCredits(user.ID, modelName, credits, path)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	ok = forwardAIRequest(w, request, func() {
		if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
			log.Printf("AI image task refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
		}
	})
	if ok {
		putImageTaskRecord(imageTaskRecord{
			UserID:  user.ID,
			TaskID:  taskID,
			Model:   modelName,
			Path:    path,
			Channel: channel,
			Credits: credits,
			Created: time.Now(),
		})
	}
}

// proxyImageTaskQuery 使用指定渠道查询任务状态并把上游响应原样返回给前端。
func proxyImageTaskQuery(w http.ResponseWriter, r *http.Request, channel model.ModelChannel) {
	payload, status, headers, err := requestImageTaskQuery(r, channel)
	if err != nil {
		log.Printf("AI image task query failed: url=%s err=%v", service.BuildModelChannelRootURL(channel, "/api/image-tasks"), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	if status >= http.StatusBadRequest {
		log.Printf("AI image task upstream error: status=%d body=%s", status, strings.TrimSpace(string(payload[:min(len(payload), 4096)])))
		Fail(w, "AI 接口请求失败")
		return
	}
	writeRawResponse(w, status, headers, payload)
}

// requestImageTaskQuery 请求 chatgpt2api 的任务查询接口，保留原始状态码和响应头。
func requestImageTaskQuery(r *http.Request, channel model.ModelChannel) ([]byte, int, http.Header, error) {
	target := service.BuildModelChannelRootURL(channel, "/api/image-tasks")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, response.StatusCode, response.Header, err
	}
	return payload, response.StatusCode, response.Header, nil
}

// forwardAIRequest 转发上游请求，并在网络失败或上游错误时执行补偿逻辑。
func forwardAIRequest(w http.ResponseWriter, request *http.Request, onFailure func()) bool {
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: url=%s err=%v", request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, "AI 接口请求失败")
		return false
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		log.Printf("AI upstream error: url=%s status=%d body=%s", request.URL.String(), response.StatusCode, strings.TrimSpace(string(payload)))
		if onFailure != nil {
			onFailure()
		}
		Fail(w, "AI 接口请求失败")
		return false
	}
	writeStreamResponse(w, response)
	return true
}

// writeStreamResponse 把上游响应流复制给调用方，跳过会干扰代理的 Content-Length。
func writeStreamResponse(w http.ResponseWriter, response *http.Response) {
	for key, values := range response.Header {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

// writeRawResponse 写出已读取的上游响应体，保留必要响应头并过滤传输相关头。
func writeRawResponse(w http.ResponseWriter, status int, headers http.Header, payload []byte) {
	for key, values := range headers {
		if strings.EqualFold(key, "Content-Length") || strings.EqualFold(key, "Content-Encoding") || strings.EqualFold(key, "Transfer-Encoding") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// readImageTaskClientID 从 JSON 或 multipart 请求中读取客户端传入的任务 ID。
func readImageTaskClientID(body []byte, contentType string) string {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return ""
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(64 << 20)
		if err != nil {
			return ""
		}
		defer form.RemoveAll()
		if values := form.Value["client_task_id"]; len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
		return ""
	}
	var payload struct {
		ClientTaskID string `json:"client_task_id"`
	}
	_ = json.Unmarshal(body, &payload)
	return strings.TrimSpace(payload.ClientTaskID)
}

// firstImageTaskID 从逗号分隔的 ids 参数中取第一个有效任务 ID。
func firstImageTaskID(ids string) string {
	for _, item := range strings.Split(ids, ",") {
		if taskID := strings.TrimSpace(item); taskID != "" {
			return taskID
		}
	}
	return ""
}

// putImageTaskRecord 缓存任务与渠道关系，保证后续轮询继续访问同一个上游。
func putImageTaskRecord(record imageTaskRecord) {
	cleanupImageTaskRecords()
	imageTaskStore.Lock()
	defer imageTaskStore.Unlock()
	imageTaskStore.items[imageTaskKey(record.UserID, record.TaskID)] = record
}

// getImageTaskRecord 读取任务与渠道关系，未命中时由调用方决定是否扫描渠道。
func getImageTaskRecord(userID string, taskID string) (imageTaskRecord, bool) {
	cleanupImageTaskRecords()
	imageTaskStore.RLock()
	defer imageTaskStore.RUnlock()
	record, ok := imageTaskStore.items[imageTaskKey(userID, taskID)]
	return record, ok
}

// cleanupImageTaskRecords 清理过期的内存任务记录，避免长期运行时无限增长。
func cleanupImageTaskRecords() {
	now := time.Now()
	imageTaskStore.Lock()
	defer imageTaskStore.Unlock()
	for key, record := range imageTaskStore.items {
		if now.Sub(record.Created) > imageTaskRecordTTL {
			delete(imageTaskStore.items, key)
		}
	}
}

// imageTaskKey 生成用户隔离的任务缓存键，防止不同用户相同任务 ID 串用渠道。
func imageTaskKey(userID string, taskID string) string {
	return userID + ":" + taskID
}

// imageTaskPayloadHasID 判断上游查询响应中是否包含目标任务 ID。
func imageTaskPayloadHasID(payload []byte, taskID string) bool {
	var data struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		return false
	}
	for _, item := range data.Items {
		if item.ID == taskID {
			return true
		}
	}
	return false
}
