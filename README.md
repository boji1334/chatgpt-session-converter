# ChatGPT Session Converter

批量 JSON 转换工具。文件默认在当前浏览器中解析、转换和打包；额度实时检测通过可选的 Node.js 服务完成。

在线使用：https://boji1334.github.io/chatgpt-session-converter/

越接码下载sub2文件：https://boji1334.github.io/chatgpt-session-converter/at-to-sub2api.html

越接码下载CPA文件：https://boji1334.github.io/chatgpt-session-converter/at-to-cpa.html

## 功能

- 选择或拖入多个 JSON 文件
- 粘贴单对象、数组、逐行 JSON 或连续 JSON
- 使用“越接码下载sub2文件”独立入口粘贴 ChatGPT AT 或完整 session JSON，注册 Runtime 并下载可在 sub2api“数据导入”中直接上传的 Agent Identity 数据文件
- 使用“越接码下载CPA文件”独立入口粘贴 ChatGPT AT 或完整 session JSON，注册 Agent Runtime 并下载本站适配版 CLIProxyAPI 可直接导入的 Codex Agent Identity auth JSON
- 两个独立下载入口分别显示服务端累计的全部、成功和失败下载次数
- 输出 CPA、sub2api、Cockpit、9router、Codex、AxonHub、Codex-Manager
- 下载一个合并 JSON
- 下载每个账号一个 JSON 文件的 ZIP
- CPA 多账号的合并 JSON 是数组；批量导入 CPAMP/CLIProxyAPI 时请解压 CPA ZIP，再上传其中的独立 JSON 文件
- 严格保持有效输入记录的顺序和数量，不自动去重
- 检查目标格式所需的 `account_id`、`id_token`、`refresh_token` 和过期时间
- 保留输入中的 `last_refresh`、过期时间、真实 `id_token` 和 `refresh_token`

## 安全边界

常规格式转换不会上传文件，也不写入浏览器存储。实时额度检测会把检测所需的账号 token 临时发送到自有服务。“越接码下载sub2文件”会在浏览器本地生成 Ed25519 私钥，只把 AT 和公钥临时发送到自有服务，再由服务向 OpenAI 注册 Agent Runtime；私钥不会离开浏览器。服务端不保存 token、不返回 token，也不应记录请求体日志。

## 本地使用

直接打开 `index.html`，或启动任意静态文件服务器。

运行回归测试：

```bash
npm test
```

## 后端服务

复制 `server/.env.example` 和 `server/agent.env.example` 为服务端环境配置，设置允许的前端来源。安装 Python Agent 后端依赖并分别启动两个服务：

```bash
python -m pip install -r server/requirements-agent.txt
npm run start:quota
npm run start:agent
```

服务提供：

- `GET /healthz`
- `POST /api/quota/check`
- `POST /api/agent/register`
- `GET /api/downloads?page=at-to-sub2api|at-to-cpa`
- `POST /api/downloads`

Agent 注册接口由 `server/agent_backend.py` 提供，注册请求逻辑直接按 `codex_agent(2).py` 移植，使用 `curl_cffi` 的 Chrome impersonation。浏览器只提交 AT 与 Ed25519 公钥，私钥不会发送到后端。

将 `index.html` 中 `quota-api-url`、两个下载页中的 `agent-api-url` 和 `download-api-url` 设置为部署后的 API 地址。额度 API 未配置时，主页面仍可读取导入 JSON 中已有的本地额度快照；Agent Identity 注册和下载统计需要可用的后端服务。

## GitHub Pages

仓库根目录可以直接作为 GitHub Pages 的发布源，不需要构建步骤。

## 来源

格式转换逻辑参考并修改自 [gtxx3600/GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API) 和 [gtxx3600/CPA2sub2API](https://github.com/gtxx3600/CPA2sub2API)。项目按 MIT License 发布。
