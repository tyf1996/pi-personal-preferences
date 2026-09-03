# Pi Personal Preferences 安装与使用

本文档用于安装并启用 WikiSkill 个人偏好分组系统。安装产物同时包含 Pi extension、Python CLI 和 Python core，不依赖 monorepo 中的 `skills/` 路径。

## 环境要求

- Pi `0.84.4` 或更高版本。
- Node.js `22.22.3` 或更高版本。
- Python `3.10` 或更高版本，命令名为 `python3`。
- Git。

## 安装

推荐跟踪 GitHub `main`，后续可同步最新提交：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences
```

如需固定版本，安装指定 Release tag：

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

## 配置归组与自动演化模型

默认配置直接复用当前 Pi 会话选择的模型、凭据和 endpoint：

```json
{
  "name": "pi",
  "thinking_level": "inherit",
  "timeout_seconds": 300
}
```

`inherit` 表示跟随 Pi 当前会话的 thinking level；使用 `/model` 切换模型后，扩展随当前模型切换。Pi 的凭据由 model registry 在调用时解析，不会写入个人偏好配置，也不会序列化到 TypeScript 与 Python CLI 之间的模型桥接协议。

Pi 模式也可以为偏好归组和演化固定独立的 thinking level：

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

旧版未修改的 `configured-model` 占位配置会自动迁移到 Pi 模式；已有自定义模型配置会保留，并补入 `thinking_level: "medium"`。`/pref` 摘要会显示模型来源、provider、model、thinking level、timeout 和 readiness。模型 ready 后，未指定 `--group` 的 remember、feedback、文件修改归组和自动演化会调用模型。

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

`/pref` 面板可以管理组、组介绍、规则、目录启用、会话启用、同步和 rollback。子菜单中按 Esc 或 Ctrl+C 返回直接上一级；在顶层菜单按 Esc 或 Ctrl+C 退出面板。

底部状态使用主题色和紧凑格式，例如：

```text
pref global · 1g/2r · gpt-5.6-sol:xh · local
```

## 同步边界

以下内容位于个人偏好 Git 仓库中，会跨设备同步：

```text
repo/groups.json
repo/evidence/
repo/version.json
```

以下内容仅保存在当前设备，不进入 Git：

```text
local/activations.json
local/inbox.jsonl
local/metrics.jsonl
```

因此不同设备共享组、介绍、规则和 evidence，各自维护目录与会话启用关系。push 失败时，本地成功 commit 会保留，`/pref` 会显示 push 错误和当前 sync state。
