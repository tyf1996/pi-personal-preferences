# Pi Personal Preferences 安装与使用

本文档用于安装并启用 WikiSkill 个人偏好分组系统。安装产物同时包含 Pi extension、Python CLI 和 Python core，不依赖 monorepo 中的 `skills/` 路径。

## 环境要求

- Pi `0.84.4` 或更高版本。
- Node.js `22.22.3` 或更高版本。
- Python `3.10` 或更高版本，命令名为 `python3`。
- Git。

## 安装

推荐安装固定的 GitHub Release：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences@v0.1.0
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

升级到新的固定版本：

```bash
pi install git:github.com/tyf1996/pi-personal-preferences@v0.2.0
```

移除扩展：

```bash
pi remove git:github.com/tyf1996/pi-personal-preferences
```

固定 tag 不会被 `pi update --extensions` 自动移动；升级时显式安装新的 tag。

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

编辑 `personal-preferences/config.json` 中的 `provider`。OpenAI-compatible 配置示例：

```json
{
  "name": "openai_compatible",
  "model": "your-model-name",
  "api_key_env": "PREFERENCE_MODEL_API_KEY",
  "base_url": "https://your-provider.example/v1"
}
```

设置配置中声明的凭据环境变量，然后重新启动 Pi：

```bash
export PREFERENCE_MODEL_API_KEY='your-api-key'
```

`/pref` 摘要会显示 provider、model、endpoint readiness、credential 环境变量名称及 readiness。全部 ready 后，未指定 `--group` 的 remember、feedback、文件修改归组和自动演化才会调用模型。

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

`/pref` 面板可以管理组、组介绍、规则、目录启用、会话启用、同步和 rollback。

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
