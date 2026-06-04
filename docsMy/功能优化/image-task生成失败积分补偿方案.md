# image task 生成失败积分补偿方案

## 背景

当前项目已支持 `image_tasks` 协议的异步生图接口：

```text
POST /api/v1/image-tasks/generations
POST /api/v1/image-tasks/edits
GET  /api/v1/image-tasks?ids=...&model=...
```

前端在 `web/src/services/api/image.ts` 中为每张图片生成一个 `client_task_id`，先提交任务，再轮询任务状态。后端在 `handler/ai_image_tasks.go` 中代理任务提交和任务查询。

用户关心的问题是：图片任务已经提交成功，但最终任务状态变成失败时，是否还会扣算力点；如果失败不应扣分，应该在什么时机退款或结算。

## 当前扣分逻辑

当前 `image_tasks` 模式的扣分发生在任务提交阶段：

```text
proxyImageTaskSubmit
  -> readAIRequest
  -> readImageTaskClientID
  -> ModelCost
  -> SelectModelChannelByProtocol
  -> ConsumeUserCredits
  -> forwardAIRequest
  -> putImageTaskRecord
```

也就是说，只要后端准备向上游提交任务，就会先调用 `ConsumeUserCredits` 预扣算力点。

当前会自动退款的场景只有提交请求失败：

```text
1. 创建上游请求失败
2. 请求上游网络失败
3. 上游提交接口返回 4xx / 5xx
```

这些情况会调用：

```text
RefundUserCredits(user.ID, modelName, credits, path)
```

当前不会自动退款的场景：

```text
1. 上游提交任务成功，返回任务 ID
2. 后续轮询 GET /image-tasks 时任务状态变成 error
3. 前端轮询超时
4. 任务记录过期或查不到，前端认为任务失败
5. 任务 success 但 data 为空，前端认为生成失败
```

因此，按当前代码看：`image_tasks` 只要提交成功就会扣分，最终生成失败不会自动补偿。用户感觉“任务模式好像最后一次请求才算”更接近上游服务的业务语义，但本项目自己的积分是在第一次提交时扣掉的。

## 为什么不能只靠前端判断退款

前端能知道“这次调用失败了”，但不能直接决定是否退算力点，原因有三个：

```text
1. 算力点余额在后端，退款必须由后端写用户余额和 credit_logs。
2. 前端失败不一定等于上游最终失败，比如用户关闭页面、网络断开、轮询超时。
3. 退款必须幂等，否则刷新、重试、重复轮询可能重复返还。
```

所以生成失败不扣分的核心不在前端，而在后端需要识别任务的最终状态，并保证每个 `client_task_id` 只结算或退款一次。

## 方案一：提交时不扣分，成功后再扣分

### 流程

```text
1. 提交 image task 时不调用 ConsumeUserCredits。
2. 只检查用户当前算力点是否足够。
3. 任务成功后，在查询到 status=success 时再扣分。
4. 任务失败时不扣分。
```

### 优点

```text
1. 用户理解最简单：最终成功才扣分。
2. 失败任务天然不扣分，不需要退款流水。
```

### 问题

```text
1. 并发风险大：用户可以同时提交很多任务，提交时余额足够，但成功结算时余额可能不够。
2. 任务成功后扣分失败会变成坏账：图片已经生成出来，但用户余额不足。
3. 如果前端不再轮询，后端可能永远等不到成功扣分时机。
4. 需要后端定时扫描未结算任务，否则结算依赖用户查询接口。
```

### 结论

不推荐作为第一版实现。它看起来简单，但会把扣分从“提交时确定”变成“异步成功后不确定”，需要额外的冻结余额或后台结算机制兜底。

## 方案二：提交时冻结算力点，最终成功才正式扣分

### 流程

```text
1. 用户提交任务时检查余额。
2. 把本次任务消耗记为冻结额度，不立即减少可用余额之外的总余额。
3. 任务 success 时把冻结额度转为正式消耗。
4. 任务 error / canceled / expired 时释放冻结额度。
```

### 需要的数据结构

理想结构是把用户余额拆成可用和冻结：

```text
users.credits           可用算力点
users.frozen_credits    冻结算力点
```

或者新增任务扣费表：

```text
image_task_billings
  id
  user_id
  task_id
  model
  path
  credits
  status: reserved / consumed / refunded
  channel_id
  created_at
  updated_at
```

### 优点

```text
1. 业务语义最严谨：提交时占额度，成功才消费，失败释放。
2. 能防止用户余额被并发任务透支。
3. 后续可以展示“冻结中算力点”。
```

### 问题

```text
1. 改动较大，需要调整用户表或新增计费表。
2. 后台用户余额展示、流水类型、管理后台都要一起改。
3. 需要考虑任务长时间 pending 时冻结多久、如何释放。
```

### 结论

这是长期最完整的方案，但不适合当前最小改动。项目目前还没有冻结余额概念，直接引入会牵动较多页面和文档。

## 方案三：继续提交时预扣，最终失败后补偿退款

### 流程

```text
1. 提交任务时保持当前逻辑，先调用 ConsumeUserCredits。
2. 提交失败继续立即 RefundUserCredits。
3. 提交成功后记录任务扣费信息。
4. 查询任务时解析上游 items。
5. 当任务进入 error / canceled / expired 等最终失败状态时，调用 RefundUserCredits。
6. 同一个 task_id 只允许退款一次。
7. 任务 success 后标记为 consumed，不再允许退款。
```

### 推荐原因

```text
1. 和当前代码最兼容，保留已有“先扣后退”的模型。
2. 不需要改用户余额结构。
3. 能解决用户最关心的“最终生成失败不应扣分”。
4. 通过 credit_logs 可以清晰看到先扣分、后返还的流水。
```

### 需要补齐的问题

当前 `imageTaskStore` 是进程内 map：

```text
userID + taskID -> channel / credits / model / path
```

它可以用于短期内轮询补偿，但服务重启会丢失记录。为了避免漏退，建议新增持久化表保存任务计费状态。

推荐新增表：

```text
image_task_billings
  id
  user_id
  task_id
  model
  path
  credits
  channel_id
  status
  refund_credit_log_id
  created_at
  updated_at
```

状态建议：

```text
charged     已预扣
consumed    任务成功，扣费最终确认
refunded    任务失败，已返还
unknown     长时间未查到最终态，需要人工或定时任务处理
```

也可以第一版不新增表，先用 `credit_logs.related_id = task_id` 做幂等判断。但更推荐新增表，因为 `credit_logs` 是流水，不适合承载任务状态机。

## 推荐落地方案

建议采用“方案三：先扣分，最终失败补偿退款”，分两步落地。

第一步做最小可用版：

```text
1. 提交成功后，除内存 imageTaskStore 外，把 task_id、user_id、model、path、credits、channel_id 写入 image_task_billings。
2. 查询任务状态时，如果上游返回 status=error，就查 billing 是否还是 charged。
3. 如果是 charged，就调用 RefundUserCredits，并把 billing 更新为 refunded。
4. 如果上游返回 status=success，就把 billing 更新为 consumed。
5. 所有更新都按 user_id + task_id 做唯一约束，避免重复退款。
```

第二步做兜底能力：

```text
1. 增加定时任务扫描长期 charged 的 image_task_billings。
2. 对超过一定时间仍未 consumed/refunded 的任务重新查询上游。
3. 查询到失败就退款，查询到成功就确认消费。
4. 查询不到或上游不可用时保留 charged，超过更长时间可标记 unknown。
```

## 最终失败状态如何判断

第一版建议只处理明确失败状态：

```text
error
failed
canceled
cancelled
expired
```

不要把前端轮询超时直接当成失败退款。超时只代表当前页面没等到结果，不代表上游任务最终失败。超时场景应继续保留 `charged`，交给后端定时任务或后续查询确认。

`success` 但图片数据为空也要谨慎处理。它可能是上游响应格式异常，第一版可以先不自动退款，只记录日志；如果确认上游确实会用这种形式表示失败，再加入补偿条件。

## 幂等规则

退款必须满足下面规则：

```text
1. image_task_billings 对 user_id + task_id 建唯一索引。
2. 只有 status=charged 时允许退款。
3. 退款和 billing 状态更新最好放在同一个数据库事务中。
4. RefundUserCredits 成功后写入 refund_credit_log_id。
5. 重复轮询同一个 error 任务时，看到 status=refunded 直接透传响应，不再退款。
```

如果暂时不做事务，至少要先用条件更新抢占状态：

```text
UPDATE image_task_billings
SET status = 'refunding'
WHERE user_id = ? AND task_id = ? AND status = 'charged'
```

只有更新成功的一方才能执行退款，避免并发重复返还。

## 前端需要改什么

前端不需要决定是否退款，只需要保持当前轮询逻辑。

可以优化的点：

```text
1. 任务失败时提示“生成失败，算力点将自动返还”。
2. task.status=error 后调用 hydrateUser 刷新用户余额。
3. 批量生成时，部分失败只刷新一次用户信息。
```

但这些只是体验优化，不是计费正确性的核心。

## 对当前问题的直接回答

当前 `image_tasks` 模式下：

```text
提交失败：会退款，最终不扣分。
提交成功但最终生成失败：当前不会自动退款，会扣分。
前端轮询失败或超时：当前不会自动退款，会扣分。
```

推荐调整为：

```text
提交时先扣分。
提交失败立即退。
任务最终成功则确认消费。
任务最终失败则自动补偿退款。
任务超时不立刻退，等后端确认最终失败后再退。
```

这样既符合异步任务“最后结果才算”的用户预期，又不需要一开始就引入冻结余额体系，改动范围相对可控。
