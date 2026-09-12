# Pi Personal Preferences

本扩展提供本机优先、人工确认的个人偏好流程。当前实现以 `/pref feedback` 的简化闭环为准；旧 M0–M7 中的 provider 设置、授权 ledger、预算、后台队列、EvidenceRevision DAG、Proposal/Gate 和旧 evolve 流程已被替代。

当前实现采用进程内后台整理和主动待办处理，无需配置扩展自己的模型或学习授权。安装与更新继续跟踪独立仓库的 `main` 分支。

## 环境

- Pi `0.84.4` 或更高版本。
- Node.js `22.22.3` 或更高版本。
- Python `3.10` 或更高版本，命令名为 `python3`。
- Git。

## 安装

从独立仓库安装或更新：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences
pi update --extension git:github.com/tyf1996/pi-personal-preferences
```

更新后，在已打开的 Pi 会话中执行 `/reload` 或重新启动 Pi，加载新的 TypeScript 入口和配套 Python 后端。更新扩展不会清空或迁移个人偏好数据。

从仓库目录安装：

```bash
pi install ./extensions/pi-personal-preferences
```

独立包目录也可以直接安装：

```bash
pi install /absolute/path/to/pi-personal-preferences
```

安装产物包含：

```text
index.ts
src/
python/wikiskill_preference.py
python/wikiskill_preference_core/
```

首次执行 `/pref` 时会初始化数据并创建 `global` 组。默认数据目录为：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/personal-preferences/
```

开发 smoke 可以用 `PI_PREFERENCE_DATA_ROOT` 指向临时目录。扩展没有独立 provider、凭据、登录或模型参数设置；普通后台两阶段和主动重新整理都捕获操作开始时的 Pi 模型、thinking 和 model registry。

## 命令

```text
/pref
/pref remember --group <组名> <规则>
/pref feedback [--group <组名>] good <理由>
/pref feedback [--group <组名>] fix <理由>
```

`good` 和 `fix` 都必须提供非空理由。省略评价类型时，界面只提供 `fix`、`good` 两项并继续要求理由。

`remember` 保留正式组和规则管理。省略 `--group` 时由用户选择组，不调用学习模型。

`/pref` 主菜单及其业务子菜单使用上下键移动，Right 或 Enter 进入，Left、Esc 或 Ctrl+C 返回。返回后保留本次 `/pref` 调用内的选中位置；菜单不再显示“返回”或“退出”伪业务项。文本输入、编辑器、确认框和非 TUI/RPC 模式继续使用 Pi 原生交互。

## 反馈流程

1. 扩展从 `SessionManager.getBranch()` 读取当前活动分支最近 10 轮完整真实对话。
2. 新采集轮次只保存一份 `events`：按原 message 顺序记录每个 user/assistant 文本块，并在原发起位置和最后匹配成功结果位置记录 `file_change_call`／`file_change_result`。同一 assistant message 内的 text/call/text 也保持块顺序；时间戳不参与排序。
3. 成功 edit/write 在筛选后按调用源顺序获得轮内局部 `change-N`，call 与唯一 result 显式配对。失败、孤立、错名、未结束调用及 read/bash 完全排除；patch/diff、替换 fallback、空 write、正文空白与脱敏规则不变。
4. 旧 `{user,assistant,file_changes?}` 继续原样读取，不迁移或伪造 events；旧格式的交错先后未知。Space 临时勾选，方向键移动，Enter 完成，Left/Esc 取消；预览摘要和成功数量从所选快照派生。选择完成后原样保存快照、启动后台任务并立即归还主输入框。
5. 后台复用提交时捕获的 Pi 模型、thinking、registry、数据根和所选文本，一次完成现有组识别与证据提取；后台只发通知，不打开选择、确认、输入或编辑界面。
6. 明确有效组直接生成证据；组不确定或已失效时保存完整提取结果，并提示打开 `/pref → 处理待办`。用户主动选组后复用该结果，不重复第一次模型调用。
7. `/pref` 主菜单中的“反馈与证据”提供模型证据的只读滚动详情；“处理待办”处理待分组、失败重试、规则生成和候选确认。反馈待办还可在行操作中选择“删除此待办”，经显示反馈类型、当前状态和理由摘要的二次确认后移除该反馈及其选中对话、提取结果和失败信息；取消、Esc、关闭和拒绝均不写入、不调用模型。已整理反馈、证据、规则、候选和其他反馈不会被删除。
8. 失败、取消、待分组或会话退出不会删除已经保存的反馈、理由、所选文本或有效提取结果；删除仅适用于 `saved`、`pending_group` 和 `failed` 待办，并在短锁内按状态 CAS 校验。

扩展不读取原生 session JSONL、不扫描无关分支、不写 session marker，也不使用后置 marker 或任务身份恢复来源。

## 查看与重新整理

“反馈与证据”默认只展示模型证据：摘要、助手实际行为、用户期望、适用范围及带角色的支持引文。引文可来自所选 user、assistant 或成功文件改动正文，文件改动来源显示为“文件改动”。原评价理由、模型配置、完整所选对话和整份补丁继续保存在本机，但不默认拼入结果视图。

在该列表按 Space 可编辑当前反馈的 `good`／`fix` 类型与完整理由。类型先暂存在内存，随后由 Pi 原生多行编辑器预填原理由；提交编辑器即覆盖保存，不再增加确认屏。取消、无变化或校验失败不会写入或调用模型。已有证据继续保留并提示主动重新整理；尚未形成证据时清除旧评价产生的 extraction/error，等待用户主动继续。三个反馈列表中的理由只在标签中归一为空格，保存正文和后续模型输入保持完整。

所有已保存反馈都可从 `/pref → 重新整理反馈` 主动重新整理。该流程使用原评价、完整理由、原样保存的新 events 或旧轮次快照和操作开始时的当前 Pi 模型，阻塞等待一次新的提取调用；已有 extraction 也不会复用旧结果冒充重新整理。新结果先以只读滚动视图预览，只有明确确认才原位覆盖：

- 保留或 Esc：原反馈、证据、候选和规则不变。
- 确认：保持 feedback ID、已有 evidence ID、证据创建时间和证据数量，只更新模型结果、实际模型及必要组关联。
- 原有效组固定。
- 从未指定组时，模型明确识别的有效组可直接采用；模型不确定时才在返回后选择现有组。
- 原显式组或原证据所属组已失效时，模型返回后必须人工选择现有组，不能静默采用模型替代组。
- 证据内容或组关联改变时，包含该证据的待确认规则候选失效；正式规则不变，也不自动调用规则模型。
- 目标反馈、旧证据或目标组在等待期间变化时拒绝覆盖；无关反馈新增不影响确认。

## 规则演化

每组每新增 3 条已整理证据触发一次规则演化。阈值是内部常量，没有设置入口。

第二次 Pi 调用在后台接收该组全部已积累证据、各自原评价与理由、带角色的引文和当前正式规则。实现不会裁成最近 100 条，也不会使用旧 Gate、独立任务计数或引用资格筛选。provider 因上下文容量或其他原因拒绝请求时，扩展报告错误并保留全部数据，不缩减输入重试。

模型返回该组完整建议规则列表。后台只保存候选并提示打开 `/pref → 处理待办`，不会弹确认框。用户主动进入主菜单待办后可完整滚动查看规则差异，并作一次整组决定：

- 稍后或 Esc：候选保持待确认，不改变审阅计数。
- 拒绝：正式规则不变；仅候选涵盖的证据标记为已审阅，历史证据继续保留。
- 应用：再次校验组正文未在模型运行期间变化，然后写入 `groups.json` 并创建本机 Git 提交。
- 规则、证据集合或同一 evidence ID 的内容在生成期间变化：停止保存候选，不覆盖数据，保留主动重新生成入口。

待确认期间新增证据不会使旧候选自动失效或重复收费生成。决定旧候选时，新加入且未被候选涵盖的证据不会被顺带消费。

### 手动演化规则

`/pref` 主菜单始终提供“手动演化规则”。用户选择一个有已整理证据的有效组，再从该组全部当前或历史证据中勾选至少一条；正式规则、待分组结果和失效组证据不作为材料。选择器默认全不选，空选或取消不会调用模型。

选择完成后，扩展固定当前 root、模型、thinking、组和所选证据快照，阻塞调用当前 Pi 模型一次。预览显示所选证据摘要、生成理由、完整现有/建议规则和增删 diff；只有 `A` 明确确认才应用，Right/Enter、R、Left、Esc 或 Ctrl+C 均保留原规则。

手动确认只更新 `groups.json` 并创建必要的 Git 提交，不写 `learning.json`，不消费自动三条计数、不创建手动 pending，也不触发额外模型调用。已有自动候选可并存；手动改变规则后，旧候选继续由现有 digest 和 already-applied 恢复规则处理。建议无变化时不增加 revision 或创建空提交。

## 数据与同步

正式组和规则继续使用 schema 2：

```text
repo/groups.json
```

当前设备的启用关系继续使用 schema 2：

```text
local/activations.json
```

新反馈、所选对话的单份有序 `events`（旧记录仍可为 `{user,assistant,file_changes?}`）、可选的已校验联合提取结果、已整理证据、规则候选和批次审阅状态统一保存在：

```text
local/learning.json
```

这些本机内容不会进入偏好 Git 仓库。旧数据文件不会被初始化、反馈或升级流程删除。

`/pref` 中的“同步正式规则”是唯一网络同步入口。同步前会确认 outgoing history 和远端树只包含 `groups.json`；发现旧 evidence、changes、version 等非规则文件时停止，避免把私有反馈或证据作为规则同步的一部分上传或下载。扩展不会自动 push。

## 内部保护

- stdin 在取得写锁前完成有界读取和 JSON 解析。
- 本机文件使用固定路径、symlink/路径逃逸检查、严格 JSON 校验和原子替换。
- 写操作使用短 POSIX 文件锁；模型网络请求、远端 fetch/push 和用户输入等待不持有写锁。
- 全部 events（或旧轮次字段）共同计入 4 MiB 快照上限；超限在保存和发送前明确拒绝，不裁剪事件。
- 模型输出在写入前按固定契约校验；新格式引文必须完整来自单个 user/assistant 事件或单条成功 result，不能来自 path、call_id 或跨事件拼接。旧格式继续按单字段校验；展示和规则演化派生 `user`、`assistant`、`both`、`tool` 或 `unknown` 角色。
- CLI 使用流式 UTF-8 解码，跨 stdout/stderr chunk 的多字节字符保持完整。abort、timeout 和 I/O 错误会保留首错，并在父进程 close 且自有 POSIX 进程组消失后才结束；500ms 后可升级 SIGKILL，1 秒仍未关闭时明确抛出 `PreferenceCliCleanupError`。
- 规则写入前检查偏好仓库状态；Git 失败时恢复旧 `groups.json`，push 失败时保留本机提交。
- 后台 Promise、主动重新整理、评价编辑的列表/CLI/类型选择和状态刷新都归当前 session 生命周期所有。shutdown/reload 会停止新刷新并取消已启动查询；Pi 原生 editor 没有 signal 参数，宿主编辑器本身不会被冒充为已取消，但其返回后会重新检查存活，关闭后不保存或操作旧 UI。资源无法在内部上界内关闭时 shutdown 明确失败，不静默继续清理数据根。
- 评价编辑在短锁内比较打开编辑时的 `{sentiment,reason}`，再以一次原子写覆盖；并发评价变化会拒绝。`feedback-extracted`、`feedback-complete` 和 `feedback-fail` 同样携带任务开始时的评价，旧成功或失败回调不能污染新评价。
- 重新整理的 prepare 不改业务记录；确认 apply 在一个短锁内校验反馈／旧证据快照和目标组 digest，并原子更新 `learning.json`。
- 手动演化 prepare 同时绑定目标组与所选证据投影，前后端均执行 4 MiB 门禁；apply 复核组和所选证据 digest，只修改正式规则/Git。未选证据变化不误阻止应用。
- 正式规则只在当前有效组中注入，并低于安全、正确性、用户当前请求和 `AGENTS.md`；反馈、证据和未确认候选不通过消息 API 进入日常模型上下文。

偏好片段成功注入且仍存在于当前系统提示时，扩展会在主 Agent 每次模型调用（包括工具循环）使用的请求副本末尾临时追加隐藏的 `custom` 消息“请牢记偏好规则。”。提醒不会写入会话、改写用户文本、调用 CLI、读取磁盘或触发额外模型请求；同一请求中的旧提醒只按扩展专用 `customType` 去重。关闭、注入失败、reload/shutdown 或偏好片段被后置扩展移除时不追加。

## 开发检查

新流程使用一个小型 Node 测试文件。测试只使用临时数据 root、包内 Python 和 fake `ctx.modelRegistry.complete`，不访问真实网络、模型、认证或用户数据：

```bash
npm --prefix extensions/pi-personal-preferences test
npm --prefix extensions/pi-personal-preferences run check-python
npm --prefix extensions/pi-personal-preferences run compile-python
npm --prefix extensions/pi-personal-preferences run typecheck
npm --prefix extensions/pi-personal-preferences run check
```

`npm run check` 和扩展 CI 都会运行这组快速测试。P01–P04 覆盖每次请求末尾提醒、请求副本与精确去重、关闭/失败/片段缺失边界，以及 reload 和迟到 generation 保护。U01–U08 覆盖常驻入口、多选、单条/历史证据、精确模型输入、完整预览、零写取消、规则事务、自动候选分支及shutdown。T01–T08 覆盖 message/块顺序、最终成功结果原位置、局部 call_id、新旧结构校验、4 MiB、后台与重整精确快照、单事件引文和选择器派生。C01–C07 继续覆盖成功 edit/write 配对、patch/diff 与替换 fallback、非连续轮次、工具引文及三条触发；N01–N04 覆盖真实 SelectList 上下左右键、层级返回、按稳定值记忆、动态条目、短终端和 RPC 原生选择。Q01–Q06 使用受控 gate 和真实子进程验证重叠状态刷新、批内失败、abort/timeout、父进程先退出且后代忽略 SIGTERM、明确 cleanup 超期，以及 shutdown 后再删除临时根。套件继续保留 R01–R10、两阶段 shutdown、Git/文件保护和分块 UTF-8 解码等断言。替身消息和模型只证明输入、调用与持久化边界，不代表完整磁盘副作用发现或真实 provider 语义质量。

Python 源位于 `skills/wikiskill/scripts/`，执行以下命令同步到独立扩展包：

```bash
npm --prefix extensions/pi-personal-preferences run sync-python
```
