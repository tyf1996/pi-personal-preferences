# Pi Personal Preferences

本扩展提供本机优先、人工确认的个人偏好流程。当前实现以 `/pref feedback` 的简化闭环为准；旧 M0–M7 中的 provider 设置、授权 ledger、预算、后台队列、EvidenceRevision DAG、Proposal/Gate 和旧 evolve 流程已被替代。

当前实现和 11 项新流程快速测试均已完成。安装与更新跟踪独立仓库的 `main` 分支，无需配置扩展自己的模型或学习授权。

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

开发 smoke 可以用 `PI_PREFERENCE_DATA_ROOT` 指向临时目录。扩展没有独立 provider、凭据、登录或模型参数设置；两次推理直接复用当前 Pi 模型、thinking 和 model registry。

## 命令

```text
/pref
/pref remember --group <组名> <规则>
/pref feedback [--group <组名>] good <理由>
/pref feedback [--group <组名>] fix <理由>
```

`good` 和 `fix` 都必须提供非空理由。省略评价类型时，界面只提供 `fix`、`good` 两项并继续要求理由。

`remember` 保留正式组和规则管理。省略 `--group` 时由用户选择组，不调用学习模型。

## 反馈流程

1. 扩展从 `SessionManager.getBranch()` 读取当前活动分支最近 10 轮完整真实对话。
2. 每轮包含用户请求、工具运行期间的用户补充，以及助手可见文本；thinking、system、AGENTS、工具调用和工具原始结果不会进入候选。
3. Space 临时勾选，方向键移动，Enter 完成，Esc 取消。选择器按终端高度滚动，当前项始终保持可见；没有勾选内容时明确显示“本次反馈未保存”。
4. 扩展展示理由、所选内容预览和当前 Pi 模型，然后把反馈与所选文本保存到本机。
5. 当前 Pi 模型调用一次，同时完成现有组识别和证据提取。未指定 `--group` 且模型无法确定现有组时，才询问用户选择或新建组；显式组不会再次询问。
6. 整理成功后，证据进入对应组。失败、取消或待分组不会删除已经保存的反馈与所选文本。

扩展不读取原生 session JSONL、不扫描无关分支、不写 session marker，也不使用后置 marker 或任务身份恢复来源。

## 规则演化

每组每新增 3 条已整理证据触发一次规则演化。阈值是内部常量，没有设置入口。

第二次 Pi 调用接收该组全部已积累证据和当前正式规则。实现不会裁成最近 100 条，也不会使用旧 Gate、独立任务计数或引用资格筛选。provider 因上下文容量或其他原因拒绝请求时，扩展报告错误并保留全部数据，不缩减输入重试。

模型返回该组完整建议规则列表。扩展保存候选、展示规则 diff，并只询问是否应用：

- 拒绝：正式规则不变；本批标记为已审阅，历史证据继续保留。
- 确认：再次校验组正文未在模型运行期间变化，然后写入 `groups.json` 并创建本机 Git 提交。
- 规则已变化：停止应用，不覆盖新内容，反馈和证据继续保留。

已审阅或拒绝的批次在没有新证据时不会再次运行。下一批仍把历史证据作为全量输入。

## 数据与同步

正式组和规则继续使用 schema 2：

```text
repo/groups.json
```

当前设备的启用关系继续使用 schema 2：

```text
local/activations.json
```

新反馈、所选对话、已整理证据、规则候选和批次审阅状态统一保存在：

```text
local/learning.json
```

这些本机内容不会进入偏好 Git 仓库。旧数据文件不会被初始化、反馈或升级流程删除。

`/pref` 中的“同步正式规则”是唯一网络同步入口。同步前会确认 outgoing history 和远端树只包含 `groups.json`；发现旧 evidence、changes、version 等非规则文件时停止，避免把私有反馈或证据作为规则同步的一部分上传或下载。扩展不会自动 push。

## 内部保护

- stdin 在取得写锁前完成有界读取和 JSON 解析。
- 本机文件使用固定路径、symlink/路径逃逸检查、严格 JSON 校验和原子替换。
- 写操作使用短 POSIX 文件锁；模型网络请求、远端 fetch/push 和用户输入等待不持有写锁。
- 所选对话正文不做静默截断；总量超过 4 MiB 时在保存和发送前明确拒绝。
- 模型输出在写入前按固定契约校验；原文引用必须逐字来自所选对话，已知凭据形态会从所选文本和模型结果中替换。
- CLI 使用流式 UTF-8 解码，跨 stdout/stderr chunk 的多字节字符保持完整。
- 规则写入前检查偏好仓库状态；Git 失败时恢复旧 `groups.json`，push 失败时保留本机提交。
- 正式规则只在当前有效组中注入，并低于安全、正确性、用户当前请求和 `AGENTS.md`。

## 开发检查

新流程使用一个小型 Node 测试文件，共 11 个确定性 case。当前本机参考运行全部通过，Node 报告 12.874 秒、墙钟 13.092 秒。测试只使用临时数据 root 和 fake `ctx.modelRegistry.complete`，不访问真实网络、模型、认证或用户数据：

```bash
npm --prefix extensions/pi-personal-preferences test
npm --prefix extensions/pi-personal-preferences run check-python
npm --prefix extensions/pi-personal-preferences run compile-python
npm --prefix extensions/pi-personal-preferences run typecheck
npm --prefix extensions/pi-personal-preferences run check
```

`npm run check` 和扩展 CI 都会运行这组快速测试。覆盖命令语法、活动分支投影、picker 键盘行为、联合归组/证据提取、3/6 条证据演化、拒绝/确认、正式规则注入、模型错误留存、引用边界、Git/文件失败恢复、并发规则冲突、stdin 锁前读取和分块 UTF-8 解码。六次反馈主流程固定断言 8 次模型调用：6 次联合归组/证据提取和第 3、6 条证据触发的 2 次规则演化。

Python 源位于 `skills/wikiskill/scripts/`，执行以下命令同步到独立扩展包：

```bash
npm --prefix extensions/pi-personal-preferences run sync-python
```
