# 第三方提示词库同步链路分析

## 概述

无限画布项目通过后端 Go 服务直接从 GitHub 远程仓库的 raw 文件拉取 Markdown 内容，经过正则解析后写入本地 SQLite/MySQL/PostgreSQL 数据库。整个同步是**手动触发、按分类逐个执行**的，不涉及定时任务或 CI/CD。

---

## 同步链路全景

```
用户操作 (前端)
    ↓
React 组件 (page.tsx)
    ↓
React Hook (use-admin-prompts.ts)
    ↓
API Service (admin.ts)
    ↓ HTTP POST /api/admin/prompt-categories/sync
后端路由 (router.go)
    ↓
Handler (admin.go → AdminSyncPromptCategories)
    ↓
Service (prompt_fetch.go → SyncPromptCategory)
    ↓
  ┌─────────────────────────────────────────┐
  │  buildPromptCategory(category)          │
  │    ↓                                    │
  │  fetchText(raw.githubusercontent.com)   │
  │    ↓                                    │
  │  正则解析 Markdown                      │
  │    ↓                                    │
  │  构建 []model.Prompt                    │
  └─────────────────────────────────────────┘
    ↓
Repository (prompt.go → ReplacePromptCategory)
    ↓
数据库 (SQLite / MySQL / PostgreSQL)
```

---

## 逐层详解

### 1. 前端 UI 层

**文件**: `web/src/app/(admin)/admin/prompts/page.tsx`

- 管理后台 `/admin/prompts` 页面有一个「同步」按钮
- 点击后弹出 Modal，列出所有 `remote: true` 的提示词分类
- 每个分类右侧有一个「同步」按钮，点击后触发同步

```tsx
// 同步按钮触发
<Button onClick={async () => {
  await syncCategory(item.category);  // 调用 hook 中的同步方法
  setIsSyncOpen(false);
}}>同步</Button>
```

### 2. 前端 Hook 层

**文件**: `web/src/app/(admin)/admin/prompts/use-admin-prompts.ts`

- 使用 TanStack Query 的 `useMutation` 管理同步状态
- 同步成功后自动刷新分类和提示词列表缓存

```typescript
const syncMutation = useMutation({
  mutationFn: (category: string) => syncAdminPromptCategory(token, category),
  onSuccess: async (categories) => {
    queryClient.setQueryData(["admin", "prompt-categories", token], categories);
    await queryClient.invalidateQueries({ queryKey: ["admin", "prompts"] });
    message.success("远程提示词源已同步");
  },
});
```

### 3. 前端 API Service 层

**文件**: `web/src/services/api/admin.ts`

- `syncAdminPromptCategory(token, category)` 发送 POST 请求到 `/api/admin/prompt-categories/sync`
- 请求体为 `{ category: "分类标识" }`

```typescript
export async function syncAdminPromptCategory(token: string, category: string) {
  return apiPost<AdminPromptCategory[]>("/api/admin/prompt-categories/sync", { category }, token);
}
```

### 4. 后端路由层

**文件**: `router/router.go`

- 路由注册在 `/api/admin` 分组下，需要 `middleware.AdminAuth` 鉴权

```go
admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
```

### 5. 后端 Handler 层

**文件**: `handler/admin.go`

- `AdminSyncPromptCategories` 解析请求体中的 `category` 字段
- 调用 `service.SyncPromptCategory(category)`
- 记录同步开始/失败/完成的日志

```go
func AdminSyncPromptCategories(w http.ResponseWriter, r *http.Request) {
    var request adminSyncRequest
    _ = json.NewDecoder(r.Body).Decode(&request)
    log.Printf("sync prompt category start category=%s", request.Category)
    categories, err := service.SyncPromptCategory(request.Category)
    if err != nil {
        log.Printf("sync prompt category failed category=%s err=%v", request.Category, err)
        Fail(w, err.Error())
        return
    }
    log.Printf("sync prompt category done category=%s", request.Category)
    OK(w, categories)
}
```

### 6. 后端 Service 层（核心逻辑）

**文件**: `service/prompt_fetch.go`

这是整个同步链路的核心，包含以下关键逻辑：

#### 6.1 分类入口

```go
func SyncPromptCategory(category string) ([]model.PromptCategory, error) {
    // 1. 在内置分类列表中查找匹配的分类
    for _, item := range repository.PromptCategories() {
        if item.Category != category { continue }
        // 2. 调用对应的构建函数，从远程拉取并解析
        items, err := buildPromptCategory(item.Category)
        if err != nil { return nil, err }
        // 3. 用新数据替换数据库中该分类的全部提示词
        if err := repository.ReplacePromptCategory(item, items); err != nil {
            return nil, err
        }
        return repository.ListPromptCategories()
    }
    return nil, errors.New("未知提示词分类")
}
```

#### 6.2 分类分发

```go
func buildPromptCategory(category string) ([]model.Prompt, error) {
    switch category {
    case "gpt-image-2-prompts":          → buildGptImage2Prompts()
    case "awesome-gpt-image":            → buildAwesomeGptImagePrompts()
    case "awesome-gpt4o-image-prompts":  → buildAwesomeGpt4oImagePrompts()
    case "youmind-gpt-image-2":          → buildYouMindGptImage2Prompts()
    case "youmind-nano-banana-pro":      → buildYouMindNanoBananaProPrompts()
    }
    return nil, errors.New("未知提示词分类")
}
```

#### 6.3 远程文件拉取

```go
func fetchText(baseURL, file string) (string, error) {
    // 通过 HTTP GET 请求从 raw.githubusercontent.com 获取文件内容
    // 超时 30 秒
    request, _ := http.NewRequest(http.MethodGet, baseURL+"/"+file, nil)
    client := http.Client{Timeout: 30 * time.Second}
    response, err := client.Do(request)
    // ...
    data, err := io.ReadAll(response.Body)
    return string(data), err
}
```

#### 6.4 各仓库的解析策略

| 仓库 | 分类标识 | 远程 Base URL | 拉取文件 | 解析方式 |
|------|---------|--------------|---------|---------|
| EvoLinkAI/awesome-gpt-image-2-API-and-Prompts | `gpt-image-2-prompts` | `https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main` | `data/ingested_tweets.json` + `README.md` + `cases/*.md` | JSON 解析 + 正则提取 Markdown 中的 Case 和 Prompt |
| ZeroLu/awesome-gpt-image | `awesome-gpt-image` | `https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main` | `README.zh-CN.md` | 按 `## ` 和 `### ` 分块，正则提取标题、提示词、图片 |
| ImgEdify/Awesome-GPT4o-Image-Prompts | `awesome-gpt4o-image-prompts` | `https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main` | `README.zh-CN.md` | 按 `### ` 分块，正则提取标题和 `` `提示词文本` `` |
| YouMind-OpenLab/awesome-gpt-image-2 | `youmind-gpt-image-2` | `https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main` | `README_zh.md` | 按 `### ` 分块，正则提取 `No.X: 标题` 和提示词代码块 |
| YouMind-OpenLab/awesome-nano-banana-pro-prompts | `youmind-nano-banana-pro` | `https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main` | `README_zh.md` | 同上 |

#### 6.5 数据构建

每个 `build*` 函数的流程一致：

1. **fetchText** → 从 raw.githubusercontent.com 拉取 Markdown/JSON
2. **正则解析** → 提取标题、提示词、图片 URL、分类标签
3. **构建 model.Prompt** → 填充 ID、Title、CoverURL、Prompt、Tags、Preview 等字段
4. **返回 []model.Prompt**

```go
// 示例：buildAwesomeGptImagePrompts 流程
markdown, err := fetchText(awesomeGptImageRawBase, "README.zh-CN.md")
// 按 ## 分块 → 提取分类标签
// 按 ### 分块 → 提取标题、提示词、图片
// 构建 Prompt 结构体
items = append(items, model.Prompt{
    ID: "awesome-gpt-image-" + leftPad(len(items)+1),
    Title: title,
    CoverURL: cover,
    Prompt: prompt,
    Tags: tags,
    Preview: markdownPreview(images),
})
```

### 7. 后端 Repository 层

**文件**: `repository/prompt.go`

#### 7.1 替换整个分类

```go
func ReplacePromptCategory(category model.PromptCategory, items []model.Prompt) error {
    return db.Transaction(func(tx *gorm.DB) error {
        // 1. 删除该分类下的所有旧数据
        tx.Where("category = ?", category.Category).Delete(&model.Prompt{})
        // 2. 批量插入新数据
        for i := range items {
            items[i].Category = category.Category
            items[i].GithubURL = ""  // 不持久化 GithubURL
        }
        tx.Create(&items)
    })
}
```

### 8. 数据库层

**文件**: `repository/db.go`

- 支持 SQLite（默认）、MySQL、PostgreSQL 三种存储
- Prompt 表通过 GORM AutoMigrate 自动建表

**文件**: `model/prompt.go`

```go
type Prompt struct {
    ID        string   `json:"id" gorm:"primaryKey"`
    Title     string   `json:"title"`
    CoverURL  string   `json:"coverUrl"`
    Prompt    string   `json:"prompt"`
    Tags      []string `json:"tags" gorm:"serializer:json"`  // JSON 序列化存储
    Category  string   `json:"category" gorm:"index"`
    GithubURL string   `json:"githubUrl" gorm:"-"`           // 不持久化，运行时注入
    Preview   string   `json:"preview"`
    CreatedAt string   `json:"createdAt"`
    UpdatedAt string   `json:"updatedAt"`
}

type PromptCategory struct {
    Category    string `json:"category" gorm:"primaryKey"`
    Name        string `json:"name"`
    Description string `json:"description"`
    GithubURL   string `json:"githubUrl"`
    Remote      bool   `json:"remote"`   // 标记是否为远程源
    UpdatedAt   string `json:"updatedAt"`
}
```

**内置分类定义**（`repository/db.go`）：

```go
var promptCategories = []model.PromptCategory{
    {Category: "system", Name: "系统", Description: "系统提示词分类"},
    {Category: "gpt-image-2-prompts", Name: "GPT Image 2 Prompts", GithubURL: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts", Remote: true},
    {Category: "awesome-gpt-image", Name: "Awesome GPT Image", GithubURL: "https://github.com/ZeroLu/awesome-gpt-image", Remote: true},
    {Category: "awesome-gpt4o-image-prompts", Name: "Awesome GPT4o Image Prompts", GithubURL: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", Remote: true},
    {Category: "youmind-gpt-image-2", Name: "YouMind GPT Image 2", GithubURL: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", Remote: true},
    {Category: "youmind-nano-banana-pro", Name: "YouMind Nano Banana Pro", GithubURL: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", Remote: true},
}
```

---

## 关键特性

### 同步方式
- **手动触发**：用户在管理后台点击「同步」按钮触发
- **按分类同步**：每次只同步一个分类，不会全量同步
- **全量替换**：同步时先删除该分类下的所有旧数据，再批量插入新数据
- **无定时任务**：没有 cron、没有 CI/CD 自动同步

### 数据来源
- 全部通过 `raw.githubusercontent.com` 直接拉取文件内容
- 不需要 git clone，直接 HTTP GET 获取单个文件
- 超时时间 30 秒

### 数据解析
- 使用正则表达式解析 Markdown 结构
- 不同仓库的 Markdown 格式不同，各自有独立的解析逻辑
- 提取的内容包括：标题、提示词文本、图片 URL、分类标签

### 数据存储
- 提示词数据存储在本地数据库（SQLite/MySQL/PostgreSQL）
- 同步时不保留 `GithubURL` 字段（`gorm:"-"` 不持久化）
- `GithubURL` 在查询时从 `PromptCategory` 动态注入

---

## 同步时序图

```
用户                    前端                     后端                     GitHub
 │                       │                        │                        │
 │  点击「同步」按钮      │                        │                        │
 ├──────────────────────>│                        │                        │
 │                       │  POST /prompt-categories/sync                    │
 │                       │  { category: "awesome-gpt-image" }               │
 │                       ├───────────────────────>│                        │
 │                       │                        │  GET README.zh-CN.md   │
 │                       │                        ├───────────────────────>│
 │                       │                        │  Markdown 内容          │
 │                       │                        │<───────────────────────┤
 │                       │                        │                        │
 │                       │                        │  正则解析 Markdown      │
 │                       │                        │  构建 []Prompt          │
 │                       │                        │                        │
 │                       │                        │  DELETE + INSERT (事务) │
 │                       │                        │  (操作数据库)           │
 │                       │                        │                        │
 │                       │  返回更新后的分类列表    │                        │
 │                       │<───────────────────────┤                        │
 │  同步成功提示           │                        │                        │
 │<──────────────────────┤                        │                        │
```

---

## 注意事项

1. **网络依赖**：同步需要访问 `raw.githubusercontent.com`，国内可能需要代理
2. **格式脆弱**：依赖正则解析 Markdown，如果远程仓库修改了文档格式，同步会失败或遗漏数据
3. **全量覆盖**：每次同步会删除旧数据，用户在本地对远程提示词的修改会被覆盖
4. **无增量同步**：不支持增量更新，每次都全量拉取和替换
5. **无版本控制**：不记录每次同步的版本差异，无法回滚到历史版本
