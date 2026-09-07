# Pi Personal Preferences 安装与使用

本文档说明 `main` 分支中 schema 2 的 Pi Personal Preferences 安装、使用和数据边界。代码已通过独立包、临时目录真实 `pi install`、官方 RPC loader、双设备学习闭环和消融后的回归验证。

**升级注意**：当前版本直接使用最新数据格式，不读取或自动迁移旧 schema 1 数据。更新前应完整备份旧偏好目录；在新数据目录初始化后，通过新版组管理、remember 和启用入口重建需要保留的内容。旧反馈与 Git 历史留档，不直接复制到新版运行目录。程序更新不会授权模型发送反馈或证据，两个学习阶段默认关闭。

安装产物同时包含 Pi extension、Python CLI 和 Python core，不依赖 monorepo 中的 `skills/` 路径。

## 环境要求

- Pi `0.84.4` 或更高版本。
- Node.js `22.22.3` 或更高版本。
- Python `3.10` 或更高版本，命令名为 `python3`。
- Git。

## 安装

安装跟踪 `main` 的无版本 Git 来源：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences
```

以下旧 Release `v0.2.0` 仅用于回到旧版程序，不包含本文的新学习闭环；仅应与保留的旧数据目录配套使用。本次更新 `main` 不创建新 Release：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences@v0.2.0
```

从独立仓库 checkout 安装当前目录：

```bash
pi install .
```

在 `skills_lab` 开发仓库中调试时可以安装扩展子目录：

```bash
pi install ./extensions/pi-personal-preferences
```

从解压后的 release 产物安装：

```bash
pi install /absolute/path/to/pi-personal-preferences
```

安装目录必须包含：

```text
index.ts
src/
python/wikiskill_preference.py
python/wikiskill_preference_core/
```

### 使用 Pi 管理扩展

查看安装来源：

```bash
pi list
```

同步无版本 Git 安装源的最新提交：

```bash
pi update --extension git:github.com/tyf1996/pi-personal-preferences
```

移除扩展：

```bash
pi remove git:github.com/tyf1996/pi-personal-preferences
```

无版本 Git 安装源跟踪默认分支，可由 Pi 的 package update 检查和 `pi update --extensions` 更新；固定 tag 不会自动移动。

## 首次运行

启动 Pi 后执行：

```text
/pref
```

首次执行会自动初始化本地数据、创建默认 `global` 组并打开管理面板。默认数据目录为：

```text
~/.pi/agent/personal-preferences/
```

设置 `PI_CODING_AGENT_DIR` 后，数据目录改为：

```text
$PI_CODING_AGENT_DIR/personal-preferences/
```

显式指定组的 remember、组管理、目录启用和会话启用不依赖模型配置：

```text
/pref remember --group global 回答先给结论
```

## 配置反馈整理模型

默认 provider 配置引用当前 Pi 会话选择的模型、凭据和实际 endpoint：

```json
{
  "name": "pi",
  "thinking_level": "inherit",
  "timeout_seconds": 300
}
```

`inherit` 表示在反馈绑定时采用 Pi 当前会话的 thinking level。每个可发送 job 会冻结当时经过授权解析的 provider、model、API、实际 endpoint fingerprint、thinking、token 上限和 timeout；后续 `/model` 切换不会静默改写已排队 job。即使当前会话已经切到模型 B，只要冻结模型 A 仍可由 registry 恢复，后台仍按 A 的授权和 endpoint 发送。Pi 的凭据由 model registry 在绑定或实际发送时解析，不会写入个人偏好配置或 job。

Pi 模式也可以为反馈整理固定独立的 thinking level：

```json
{
  "name": "pi",
  "thinking_level": "medium",
  "timeout_seconds": 300
}
```

可用值为 `inherit`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`。实际支持范围取决于当前 Pi 模型；不支持 reasoning 的模型按 `off` 调用。`timeout_seconds` 是 Pi 模型桥接的总超时，默认 300 秒；高 thinking 模型需要更长时间时可以调大。

如需使用独立于 Pi 的 OpenAI-compatible 模型，将 `personal-preferences/config.json` 中的 `provider` 改为：

```json
{
  "name": "openai_compatible",
  "model": "your-model-name",
  "api_key_env": "PREFERENCE_MODEL_API_KEY",
  "base_url": "https://your-provider.example/v1",
  "thinking_level": "high",
  "timeout_seconds": 120
}
```

自定义模式的 thinking level 可用值为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`。除 `off` 外，该值通过 OpenAI-compatible 请求的 `reasoning_effort` 字段发送，endpoint 必须支持所选值。设置配置中声明的凭据环境变量后重新启动 Pi：

```bash
export PREFERENCE_MODEL_API_KEY='your-api-key'
```

生产入口只接受当前 schema 2 配置，不迁移旧 provider 占位配置，也不提供旧命令兼容、v1 migration 或 provider 静默兜底。旧 flat learning 配置和未知格式会封闭失败。状态查询、Dashboard 展示、feedback job 的 list/get/claim/renew/cancel 等数据操作不解析 Pi OAuth，也不把当前会话模型身份注入持久 job 校验。`/pref` 对 Pi readiness 显示“未检查”；只有绑定或实际发送才验证冻结模型的 registry、授权和 endpoint。

反馈整理和候选生成由 schema 2 的 `learning.extraction.enabled`、`learning.proposals.enabled` 控制，两者默认关闭。阶段分别支持 `provider`（默认继承或独立 fake/OpenAI-compatible/Pi）、`thinking_level`、`timeout_seconds` 和 `max_tokens`；阶段配置在发送前冻结，模型切换或 endpoint 变化会阻断旧任务。关闭时输入仍可靠保存在本机并显示为 blocked 状态，不调用模型。仅本机保存、无 UI `ask`、当前模型不可用或 Pi auth/OAuth 解析失败时，job 不写 `unavailable`、`fixture` 等占位模型。用户可以在管理页查看并显式绑定当前模型。无理由 `good` 保持为无理由反馈，不能被模型自行升级为强证据。设置页对系统/阶段开关、默认与阶段模型、thinking/timeout/max_tokens、触发策略、重试/每日预算、隐私、撤权和 snapshot 清理均走严格字段 allowlist、settings generation CAS 和持久事务；取消确认不会写入。

候选生成使用独立的精确发送授权。UI 会展示本次目标组、正式规则、确切 EvidenceRevision、heads、历史、coverage、冻结模型和 `input_signature`；用户确认后授权只覆盖该签名。自动模式必须在设置页按组明确 opt-in，scope=`new_evidence` 固定 group/model/endpoint，只由有效 `origin_verified` preference EvidenceRevision 触发；用户 revise/restore 产生的新有效修订也经过同一路径。单次 scope 绝不能扩大为持续授权；无授权只提示待授权且零模型请求。feedback 快照授权不会自动扩大为证据发送授权。FeedbackJob 与 ProposalJob 保留各自严格契约，同时竞争同一个 data-root worker lease，并共享每日模型请求预算。模型运行期间不持有数据锁，也不会退回当前会话的其他模型。

## 配置 GitHub 同步

### 第一台设备

先执行一次 `/pref`，再为个人偏好仓库设置私有 GitHub remote：

```bash
PREF_REPO="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/personal-preferences/repo"
git -C "$PREF_REPO" remote add origin git@github.com:YOUR_GITHUB_USER/YOUR_PRIVATE_REPO.git
```

打开 `/pref`，选择“同步偏好仓库”。首次同步会自动建立当前分支的 upstream；无需手工执行 `git push -u`。

### 其他设备

安装 extension 后，在首次执行 `/pref` 前克隆同一个私有仓库：

```bash
PREF_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/personal-preferences"
mkdir -p "$PREF_ROOT"
git clone git@github.com:YOUR_GITHUB_USER/YOUR_PRIVATE_REPO.git "$PREF_ROOT/repo"
```

然后启动 Pi 并执行 `/pref`。系统会保留克隆得到的组和规则，并创建该设备自己的本地启用关系。

## 日常使用

```text
/pref
/pref remember --group <组名> <规则>
/pref feedback
/pref feedback --group <组名> good
/pref feedback --group <组名> fix <原因>
```

`/pref` 面板可以管理组、组介绍、规则、目录启用、会话启用、反馈任务、学习证据、候选规则、规则来源、同步和 rollback。反馈从当前活动分支的真实用户消息和 `stopReason=stop` 的最终助手可见文本恢复；旧会话没有扩展 marker、用 `/tree` 回到最终助手节点、reload，或 fork/clone 继承这些消息 entry 后仍可引用同一来源。`toolUse` 和 `pending` 不截断任务；`error`、`aborted` 和 `length` 结束失败任务但不产生可反馈结果，之后的新用户请求从新任务开始。工具过程中的用户补充继续属于同一任务。marker 只辅助身份与去重；回撤到 final 时只定向检查其后的无正文 metadata 子链来恢复旧 marker，并在遇到消息或摘要时停止。实现不会读取无关分支正文、原生 session JSONL，也不会用 compaction/branch summary 冒充原文。

反馈任务详情显示原始反馈、真实请求与助手结果、模型绑定、授权、错误和 result reference；支持修改、显式绑定、重试、取消和删除。找不到完整来源或用户取消时，界面明确显示“本次反馈未保存”；只有 `feedback create` 已持久化成功后才显示“已保存”或“已入队”及任务 ID。取消保留本机反馈与 snapshot。修改或删除已完成反馈会联动派生证据：未发布修订从本机删除，已发布证据生成“撤回待发布”修订。普通“同步偏好仓库”不会自动导出该撤回；必须进入学习证据页预览并显式发布，其他设备才会收到撤回。

“管理学习证据”可查看来源、实际行为、用户期望、适用场景和上下文完整度，并执行来源片段修订、期望修订、重新归组、撤回、恢复、本机删除、影响查询和发布。恢复必须引用当前全部 heads，且只有用户操作可以生成 restore。后台整理结果遇到 withdraw 时保持 needs-review，不会自动复活证据；用户显式恢复后，待重整反馈才会重新排队。发布按修订逐页显示必要父修订闭包的完整待导出 JSON 正文、内容 digest 和 parents，用户查看全部正文并确认精确集合后才写入私有 Git 仓库。影响查询会返回真实关联的 feedback job、local proposal 和正式规则 operation；当前设备缺少私有来源正文时明确显示仅原设备可见。

“生成与审核候选规则”按单组准备最多 100 条且受总字节预算限制的证据。相同 `input_signature` 没有明确重试时不会再次调用模型。每批最多三项 add/replace/delete/noop；主机分配 change ID、独立任务计数、digest 和 Gate。证据不足、冲突或 coverage partial 只可预览，普通接受不能绕过 Gate；用户明确要写规则时继续使用独立的 `remember` 来源。审核页显示 diff、支持与反向证据、来源任务数、理由、边界和不确定项，支持逐项、多项、修改后接受、拒绝、暂不处理、继续审核、重新核验和任务取消。候选自身的暂存或拒绝决定不会让同批其他项自我过期；其他候选决定、新规则、新 evidence 或同步变化仍会触发 stale。Gate 与模型 confidence 均不表示偏好正确性证明。

删除规则时，模型填写 `opposing_evidence_refs` 只用于提出待核对关系，不能开放普通接受。UI 会逐条显示确切旧规则正文、rule revision/digest、EvidenceRevision、原始反馈、摘要和用户期望；用户明确确认至少两个去重来源确实反对该旧规则后，主机才允许进入正式接受。确认只保存在本机，并绑定确切规则和证据修订；规则或 evidence 变化后自动失效。

接受候选会在短锁事务内重新核验 group/rule revision、正文、digest、EvidenceRevision heads/view 和新反向证据。每项拒绝或接受都使用同一规范化 candidate fingerprint；证据引用顺序不影响 fingerprint，修改后接受仍记录原模型候选 fingerprint。跨设备同步仅保存逐项 fingerprint，不上传拒绝理由、候选长解释或私有 evidence 正文；即使规则后来人工删除或回滚，无新 evidence 的旧候选仍受抑制。

`groups.json` 与 `changes/<operation-id>.json` 在同一 Git commit 中写入。operation 必须绑定持久 transaction ID 和创建提交 marker；读取时验证不可变创建提交、单父提交、HEAD 祖先关系、提交路径、父/后 groups blob、受影响组 digest、真实 effect diff 及 proposal/change/rule/evidence 对应关系。只有全部成立的 operation+commit 才能补本机 receipt；孤立、伪造或篡改记录会封闭失败且不改变候选状态。重复 accept 即使更换 request ID 也不会重复应用。rollback 必须先预览目标 operation、HEAD 和 diff，再用精确 expected target 确认；回滚只撤规则/组效果并追加 `reverts_operation_id`，保留 evidence、withdraw 和审核历史。

子菜单中按 Esc 或 Ctrl+C 返回直接上一级；在顶层菜单按 Esc 或 Ctrl+C 退出面板。

成功的 `write`/`edit` 产物若随后被用户修改，会保存一条 `source_kind=user_edit` 的本机弱记录。该记录默认不建立整段会话 snapshot，也不等待模型；面板允许补充原因、选择必要的最小安全片段和归组。关闭 `capture_user_edits` 不影响显式 feedback。

偏好状态使用与 footer 其他信息一致的灰色，并显示在第一行右侧；左侧目录、Git 分支和会话名优先保留。状态使用可读的紧凑格式，例如：

```text
~/project (main)             启用：coding、communication、global · 共3组/5规则 · 本地
```

footer 第二行继续显示 token、context、模型和 thinking；其他扩展状态继续显示在后续行。

## 同步边界

当前 M6 中，以下内容位于个人偏好 Git 仓库，会跨设备同步：

```text
repo/groups.json
repo/version.json
repo/evidence/<evidence-id>/<revision-id>.json  # 仅显式批准的不可变修订闭包
repo/changes/<operation-id>.json                # 最小规则差异、来源、审核 fingerprint 与回滚关系
```

以下内容仅保存在当前设备，不进入 Git。它们是 latest-only schema 2 的本机配置、activation、授权 ledger、job、evidence-local、proposal、settings 和运行状态；当前格式不提供旧 inbox 或其他旧格式兼容：

```text
config.json                                  # schema 2 配置与嵌套 learning stage
device.json
local/activations.json                         # 当前设备的目录/会话启用关系
local/settings-state.json                      # settings generation 与 config digest
local/feedback-jobs.json                       # FeedbackJob ledger
local/feedback-snapshots/                      # 受限反馈上下文
local/consent.json                             # feedback 发送授权 ledger
local/learning-state.json                      # 共享预算与学习状态
local/worker.json                              # data-root worker lease
local/data.lock                                # data-root 短锁
local/transactions/                            # durable 本地事务记录
local/evidence/<evidence-id>/<revision-id>.json # 本机 EvidenceRevision
local/evidence-state.json                      # Evidence CAS/集合状态
local/proposal-jobs.json                       # ProposalJob ledger
local/proposals.json                           # 本机 Proposal 候选
local/proposal-state.json                      # Proposal CAS/集合状态
local/proposal-consent.json                    # 独立 Proposal 发送授权
local/decisions.json                           # 本机审核决定
local/proposal-receipts.json                   # apply 回执
local/delete-opposition-confirmations.json     # 删除候选的人工确认
local/last-run.json                            # 最近一次受限运行结果
local/raw-diffs/                               # 可选的本机最小 diff
local/metrics.jsonl                            # 受限本机指标
```

同一修订可同时存在于 `local/evidence/` 与 `repo/evidence/`，两处规范 JSON 内容必须一致，并只计为一个 DAG 节点。并发 upsert 形成冲突；并发 head 中存在 withdraw 时有效视图优先撤回；时间戳不参与覆盖。未获批准的祖先不会被导出，也不会通过裁剪 parents 伪造历史。已经发布的证据产生本机 withdraw 后会显示“撤回待发布”；普通 sync 不会传播。撤回修订可继续显式发布；旧发布授权不会自动导出新的敏感正文。

同步不会上传 snapshot、绝对路径、凭据、consent、worker lease、事务记录或本机 activation。Git rebase 后会重新校验证据 DAG；未知 JSONL/旧格式、缺父、环、自引、重复 parent、extractor restore、withdraw 后直接 upsert、同 revision ID 不同内容或路径 symlink 会停止同步和写入，不静默覆盖用户数据。push 失败时，本地成功 commit 会保留，`/pref` 会显示 push 错误和当前 sync state。未知费用保持 `cost_status=unknown`；当前只验证 fake/loopback/临时 bare remote，不声称真实 provider 计费、OAuth 刷新、托管远端或真实网络文件系统已验证。

自动化验证使用临时目录：独立扩展子树运行 `npm ci`、包内 `npm run check` 和 `npm pack`；`test/install-smoke.test.ts` 在临时 agentDir 中真实执行 `pi install` 后完成官方 RPC loader smoke。验证不读取真实用户凭据或偏好数据。实际部署还需核对本机数据切换、提供商行为和私有同步仓库；支持的锁实现为 POSIX `fcntl`，未验证网络文件系统并发或真实断电。
