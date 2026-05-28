---
name: weread-to-getnote
description: 微信读书笔记 → Get笔记 → 知识库 全流程导入。底层引擎：notebridge CLI。
trigger: 导入读书笔记、微信读书、读书摘录、划线整理、知识库入库
version: 2.1.0
---

# weread-to-getnote

将微信读书笔记导入 Get 笔记并加入知识库。

---

## 快速开始（已配置好的用户）

```
1. 用户告诉你要导入什么 → 2. 问格式 → 3. 拉取数据 → 4. 展示确认 → 5. getnote save → 6. 推荐知识库 → 用户批准后 kb add
```

---

## 前置依赖（首次使用先完成这里）

### 1. 安装微信读书 Skill

```bash
claude skills add Tencent/WeChatReading
```

安装后验证：
```bash
claude skills list | grep weread
```

### 2. 获取微信读书 API Key

在微信读书 App →「我」→「设置」→「网络接入助手」复制 API Key（格式：`wrk-xxxxxxxx`）。

### 3. 配置 API Key

写入 Claude Code 配置（任选一种）：

**方式 A：settings.local.json**
```json
{
  "env": { "WEREAD_API_KEY": "wrk-xxxxxxxx" }
}
```

**方式 B：启动时注入**
```bash
export WEREAD_API_KEY=wrk-xxxxxxxx
```

### 4. 安装 Get 笔记 CLI

从 [getnote-cli releases](https://github.com/iswalle/getnote-cli/releases) 下载对应系统版本，或：

```bash
# macOS / Linux
curl -L -o /tmp/getnote.zip https://github.com/iswalle/getnote-cli/releases/download/v1.1.8/getnote-cli_1.1.8_linux_amd64.zip
unzip -o /tmp/getnote.zip -d /usr/local/bin/

# Windows
# 下载 windows_amd64.zip，解压后加入 PATH
```

### 5. 认证 Get 笔记

```bash
getnote auth login --api-key gk_live_xxxxx
```

验证：
```bash
getnote auth status
# 应显示 "Authenticated"
```

### 6. 安装 Get 笔记子 Skill（推荐）

让 Claude Code 能直接使用 getnote 相关命令的最佳体验：

```bash
claude skills add iswalle/getnote-cli
```

这会安装 `getnote-note`、`getnote-kb`、`getnote-auth` 等子 skill。安装后 Claude 能更准确地生成 `getnote` 命令。

### 7. 验证环境就绪

```bash
# 验证微信读书 API
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/user/notebooks","count":5,"skill_version":"1.0.3"}'

# 验证 Get 笔记 CLI
getnote notes -o json
```

---

## 工作流

### 0. 环境预检（可选）

如果怀疑环境有问题，先快速验证：
```bash
# 微信读书 API 是否通
curl -s --connect-timeout 5 -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/user/notebooks","count":1,"skill_version":"1.0.3"}' \
  | head -c 200

# Get 笔记 CLI 是否可用
getnote auth status
```

### 1. 确认导入内容

**必须先问用户**要导入什么。可能的情况：

- **指定书名** — 如「导《智人之上》的笔记」
- **指定几条划线** — 如「把《黑客与画家》里关于设计的挑几条」
- **某本书全部笔记** — 全书划线+想法
- **最新 N 条** — 不限书，最新的笔记
- **批量导入** — 多本书/全部书

**决策树**（根据用户输入判断）：

```
用户说了什么？
├─ 具体书名（"导《XXX》"）
│   └─ → 搜索该书，获取 bookId，进入步骤2
├─ 多条划线指定条件（"把关于设计的挑几条"）
│   └─ → 先拉取整本书的数据，筛选相关内容给用户确认
├─ "最新一条/最新笔记"
│   └─ → 调 /user/notebooks 取最近更新的书，取该书最新一条
├─ "全部笔记/所有书"
│   └─ → 进入「批量导入规则」流程
└─ 模糊/不确定
    └─ → 先 /user/notebooks 列出所有书让用户选
```

> 导入范围由用户决定，不要替用户选。

### 2. 确认格式

**每次都必须问**用户格式是否有特殊要求。默认格式：

```markdown
# 《书名》— 作者

> 共 N 条划线，N 条想法

## 划线摘录

### 章节名
> 划线原文
> 划线原文

## 个人想法
- 想法内容
```

**标题规则**：
- 单条划线/想法 → 以原文核心内容为标题
- 单本书全部笔记 → `《书名》读书笔记`

**默认标签**：`微信读书`、`读书笔记`
**可追加标签**：用户指定（如 `AI`、`产品思维`）

### 3. 拉取数据

通过微信读书 API Gateway 拉取笔记内容。

**3a 列出所有笔记本**（批量导入时先获取全部书的 bookId）

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/user/notebooks","count":100,"skill_version":"1.0.3"}'
```

> 返回 `books[]`，每本含 `bookId`、`title`、`author`、`cover`。
> 分页：传 `"lastSort":<上次最后一个排序值>` 获取下一页。

**3b 搜索书籍**（用户给书名时先搜 bookId）

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/store/search","keyword":"<书名>","count":5,"skill_version":"1.0.3"}'
```

回包取 `data[0].bookId`。如果搜索结果为空，告知用户并请用户确认书名。

**3c 拉取划线**

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/book/bookmarklist","bookId":"<bookId>","skill_version":"1.0.3"}'
```

关键字段：
- `chapterUid` — 章节 UID（用于分组和深度链接）
- `markText` — 划线原文
- `range` — 格式 `"起始-结束"`，拼接深度链接用

> 划线一次性返回，无分页。通过 `bookmarkCount` 判断是否有划线（`bookmarkCount == 0` → 该书无划线）。
> 返回的 `reviews[]` 是关联想法，与 `/review/list/mine` 去重合并。

**3d 拉取想法（点评）**

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/review/list/mine","bookId":"<bookId>","skill_version":"1.0.3"}'
```

关键字段：
- `content` — 想法内容
- `chapterUid` + `range` — 有这两个字段时才生成深度链接

> 想法可能分页：回包含 `totalCount`。传 `"cursor":<lastCursor>` 获取下一页。
> `reviewCount` 代表想法总数。

**3e 获取章节信息**（按章节分组划线时需要）

```bash
curl -s -X POST https://i.weread.qq.com/api/agent/gateway \
  -H "Authorization: Bearer $WEREAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"api_name":"/book/chapterinfo","bookId":"<bookId>","skill_version":"1.0.3"}'
```

### 4. 整理 + 展示给用户

将拉取的数据格式化，**展示给用户确认**后再保存。

**按章节分组展示**（划线多时推荐）：
```
1. 调 /book/chapterinfo 获取章节列表 → 建立 chapterUid→标题映射
2. 遍历划线，按 chapterUid 分组
3. 输出格式：
   ### 第X章 标题
   > 划线1
   > 划线2
```

**无章节/划线少时**（≤5条）：
```
直接平铺列表，不分组：
> 划线1
> 划线2
```

**想法单独列出**：划线和想法分开，想法放「个人想法」区块。
**去重**：划线接口返回的 `reviews[]` 可能与 `/review/list/mine` 重叠，展示给用户前先按 `reviewId` 去重。

### 5. 保存到 Get 笔记

用户确认内容后保存。

**命令行方式（内容短时）**：
```bash
getnote save "笔记内容" --title "《书名》读书笔记" --tag 微信读书 --tag 读书笔记 -o json
```

**Python 方式（内容长时，推荐）**：
```python
import subprocess, json
content = """长文本内容..."""
r = subprocess.run(
    ["getnote", "save", content, "--title", "《书名》读书笔记",
     "--tag", "微信读书", "--tag", "读书笔记", "-o", "json"],
    capture_output=True, text=True)
result = json.loads(r.stdout)
note_id = result.get("note_id")
# 如果方式是 dict + data 结构:
# note_id = result["data"]["note_id"]
print(f"note_id: {note_id}")
```

**重要**：
- 内容较长时（超过 200 字符）**必须**用 Python/node 写临时文件再 `getnote save`，不要用 Shell 单行字符串传参（会截断）
- 标签固定加 `微信读书` + `读书笔记`，再加用户指定的标签
- `getnote save` 对文本笔记是同步操作，直接返回 `note_id`
- 拿到 `note_id` 后记住，后续加入知识库要用
- 如果返回 `{"success":true,"data":{"note_id":"..."}}`，取 `data.note_id`

### 6. 加入知识库

**必须先问用户，批准后再加入。**

1. 列出知识库：
   ```bash
   getnote kbs -o json
   ```

2. 根据笔记内容推荐最合适的知识库，说明推荐理由

3. 用户确认后加入：
   ```bash
   getnote kb add <topic_id> <note_id>
   ```

> 知识库 ID 从 `getnote kbs -o json` → `data.topics[].topic_id` 获取。
> 可批量添加：`getnote kb add <topic_id> <note_id1> <note_id2>`

---

## 批量导入规则

当用户要求导入多本书/全部笔记时：

1. **先列出所有笔记本**（用 `3a` 的 `/user/notebooks` 接口）告知用户共多少本书、预计操作次数
2. **逐本处理** — 每本走完整流程（拉取→确认→保存→知识库），**不要一次性全自动**
3. **每本确认格式** — 第一本问格式，后续同格式可沿用
4. **知识库推荐** — 每本单独推荐，可能不同的书进不同的知识库
5. **速率控制** — 每本之间告知进度，避免在用户不知情时批量操作

---

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `WEREAD_API_KEY` 未设置 | 提示用户 export，给出具体命令 |
| getnote CLI 未安装 | 引导用户下载安装，附链接：https://github.com/iswalle/getnote-cli/releases |
| getnote 未认证 | 运行 `getnote auth login --api-key <key>` 引导认证 |
| API 返回 `errcode` 非 0 | 展示 `errcode` + 中文提示，通常 API Key 无效或过期 |
| 书未找到 | 展示搜索结果让用户确认（可能书名不精确），换关键词重试 |
| 该书无划线/想法 | `bookmarkCount==0` 且 `reviewCount==0` 告知用户换一本 |
| 书不在用户书架 | 仍然可以拉取划线（微信读书 API 不限书架），尝试直接拉取 |
| `getnote save` 失败 | 展示 stderr 错误信息。先跑 `getnote auth status` 检查认证 |
| API 配额超限 | 跑 `getnote quota` 查看剩余次数，建议等待配额重置 |
| 内容过长保存失败 | 改用 Python/node 写临时文件方式，不要用 Shell 传参 |
| 知识库添加失败 | 检查是否是订阅知识库（只读 → 只能用自己的 KB）。用 `getnote kbs` 区分 |
| 网络超时 | curl 加 `--connect-timeout 10 --max-time 30`，重试 1 次 |
| API 返回 `upgrade_info` | **立即暂停**，按指引升级 skill 版本后再继续 |

---

## 命令速查

| 用途 | 命令 | 说明 |
|------|------|------|
| 搜索书 | `curl ... -d '{"api_name":"/store/search","keyword":"...","count":5,"skill_version":"1.0.3"}'` | 书名→bookId |
| 列出笔记本 | `curl ... -d '{"api_name":"/user/notebooks","count":100,"skill_version":"1.0.3"}'` | 批量导入时用 |
| 拉取划线 | `curl ... -d '{"api_name":"/book/bookmarklist","bookId":"...","skill_version":"1.0.3"}'` | 一次性返回 |
| 拉取想法 | `curl ... -d '{"api_name":"/review/list/mine","bookId":"...","skill_version":"1.0.3"}'` | 可能分页 |
| 章节信息 | `curl ... -d '{"api_name":"/book/chapterinfo","bookId":"...","skill_version":"1.0.3"}'` | 分组用 |
| 保存笔记 | `getnote save "内容" --title "..." --tag ... -o json` | 文本同步返回 |
| 列出知识库 | `getnote kbs -o json` | 获取 topic_id |
| 加入知识库 | `getnote kb add <topic_id> <note_id>` | 可批量 |

curl 统一前缀：`curl -s -X POST https://i.weread.qq.com/api/agent/gateway -H "Authorization: Bearer $WEREAD_API_KEY" -H "Content-Type: application/json"`

## 注意事项

- 所有 API Key 通过环境变量注入，不在命令中明文暴露
- 不要在输出中包含用户的 API Key 或 token
- 确认格式时展示默认格式，用户说「默认」才跳过
- 知识库步骤**不能跳过用户确认**
- 微信读书 API 每次请求必须带 `"skill_version":"1.0.3"`
- 所有 Unix 时间戳展示为 YYYY-MM-DD 格式，阅读时长展示为 X小时Y分钟
