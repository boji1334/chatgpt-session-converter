# ChatGPT Session Converter

批量 JSON 转换工具。文件默认在当前浏览器中解析、转换和打包；额度实时检测通过可选的 Node.js 服务完成。

在线使用：https://boji1334.github.io/chatgpt-session-converter/

## 功能

- 选择或拖入多个 JSON 文件
- 粘贴单对象、数组、逐行 JSON 或连续 JSON
- 输出 CPA、sub2api、Cockpit、9router、Codex、AxonHub、Codex-Manager
- 下载一个合并 JSON
- 下载每个账号一个 JSON 文件的 ZIP
- CPA 多账号的合并 JSON 是数组；批量导入 CPAMP/CLIProxyAPI 时请解压 CPA ZIP，再上传其中的独立 JSON 文件
- 严格保持有效输入记录的顺序和数量，不自动去重
- 检查目标格式所需的 `account_id`、`id_token`、`refresh_token` 和过期时间
- 保留输入中的 `last_refresh`、过期时间、真实 `id_token` 和 `refresh_token`

## 安全边界

转换功能不会上传文件，也不写入浏览器存储。实时额度检测开启后，只会把检测所需的账号 token 临时发送到自有检测服务；服务端不保存 token、不返回 token，也不应记录请求体日志。

## 本地使用

直接打开 `index.html`，或启动任意静态文件服务器。

运行回归测试：

```bash
npm test
```

## 额度检测服务

复制 `server/.env.example` 为服务端环境配置，设置允许的前端来源，然后启动：

```bash
npm run start:quota
```

服务提供：

- `GET /healthz`
- `POST /api/quota/check`

将 `index.html` 中 `quota-api-url` 的内容设置为部署后的 API 地址，例如 `https://api.example.com/api/quota/check`。没有配置 API 地址时，页面仍可读取导入 JSON 中已有的本地额度快照。

## GitHub Pages

仓库根目录可以直接作为 GitHub Pages 的发布源，不需要构建步骤。

## 来源

格式转换逻辑参考并修改自 [gtxx3600/GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API) 和 [gtxx3600/CPA2sub2API](https://github.com/gtxx3600/CPA2sub2API)。项目按 MIT License 发布。
