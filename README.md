# ChatGPT Session Converter

纯前端批量 JSON 转换工具。所有文件都在当前浏览器中解析、转换和打包，不上传文件，也不写入浏览器存储。

在线使用：https://boji1334.github.io/chatgpt-session-converter/

## 功能

- 选择或拖入多个 JSON 文件
- 粘贴单对象、数组、逐行 JSON 或连续 JSON
- 输出 CPA、sub2api、Cockpit、9router、Codex、AxonHub、Codex-Manager
- 下载一个合并 JSON
- 下载每个账号一个 JSON 文件的 ZIP
- CPA 多账号的合并 JSON 是数组；CPAMP/CLIProxyAPI 批量导入请使用独立 JSON ZIP
- 严格保持有效输入记录的顺序和数量，不自动去重
- 检查目标格式所需的 `account_id`、`id_token`、`refresh_token` 和过期时间
- 保留输入中的 `last_refresh`、过期时间、真实 `id_token` 和 `refresh_token`

## 安全边界

页面不包含第三方脚本或远程资源，并通过 Content Security Policy 设置 `connect-src 'none'`，从浏览器层面禁止页面发起网络连接。

## 本地使用

直接打开 `index.html`，或启动任意静态文件服务器。

运行回归测试：

```bash
npm test
```

## GitHub Pages

仓库根目录可以直接作为 GitHub Pages 的发布源，不需要构建步骤。

## 来源

格式转换逻辑参考并修改自 [gtxx3600/GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API) 和 [gtxx3600/CPA2sub2API](https://github.com/gtxx3600/CPA2sub2API)。项目按 MIT License 发布。
