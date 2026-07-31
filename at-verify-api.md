# AT验活 · 账号状态与套餐查询接口文档

> 用途：输入 ChatGPT 的 accessToken（AT）或完整 session JSON，验证账号是否正常，并返回账号套餐类型（free / plus / pro / team / enterprise）。适用于充值后验证账号是否升级成功、批量检查账号是否被删除或封禁。

## 1. 接口信息

| 项目 | 值 |
| --- | --- |
| 接口地址 | `POST https://api.cuixiaoxuan.com/api/account/verify` |
| 内容类型 | `application/json` |
| 浏览器入口 | https://boji1334.github.io/chatgpt-session-converter/at-verify.html |

## 2. 请求

### 2.1 请求体

```json
{
  "access_token": "eyJhbGciOi...",
  "account_id": "user-xxxxxxxxxx"        // 可选，建议带上
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `access_token` | string | 是 | ChatGPT accessToken（JWT），支持 `Bearer ` 前缀；也可传包含 accessToken 的完整 session JSON |
| `account_id` | string | 否 | ChatGPT Account ID，缺失时后端从 JWT 中自动提取 |

### 2.2 完整 session JSON 示例

接口同时支持直接传入 session JSON（前端页面会自动提取其中的 accessToken 再转发）：

```json
{
  "accessToken": "eyJhbGciOi...",
  "account": {
    "id": "user-xxxxxxxxxx",
    "planType": "plus"
  },
  "user": {
    "id": "user-xxxxxxxxxx",
    "email": "example@example.com"
  }
}
```

## 3. 响应

### 3.1 账号正常（HTTP 200）

```json
{
  "ok": true,
  "active": true,
  "plan_type": "plus",
  "email": "example@example.com",
  "account_id": "user-xxxxxxxxxx",
  "user_id": "user-xxxxxxxxxx",
  "token_expires_at": "2026-08-08T12:00:00.000Z",
  "message": "账号正常，套餐为 plus"
}
```

### 3.2 账号异常（HTTP 200，active 为 false）

```json
{
  "ok": true,
  "active": false,
  "plan_type": "plus",
  "email": "example@example.com",
  "account_id": "user-xxxxxxxxxx",
  "user_id": "user-xxxxxxxxxx",
  "token_expires_at": null,
  "upstream_status": 403,
  "error": "账号已被删除或被禁止访问"
}
```

| `upstream_status` | `error` 含义 |
| --- | --- |
| `401` | AT 已失效（已过期或已注销） |
| `403` | 账号已被删除或被禁止访问（被封） |
| `429` | 请求过于频繁（账号本身正常，稍后重试即可） |
| 其他 4xx/5xx | OpenAI 服务异常 |

### 3.3 验证服务不可用（HTTP 200，active 为 null）

```json
{
  "ok": true,
  "active": null,
  "plan_type": "free",
  "email": null,
  "account_id": null,
  "user_id": null,
  "token_expires_at": null,
  "error": "验证请求连接失败"
}
```

> `active: null` 表示后端暂时无法连接 OpenAI，此时 `plan_type` 来自 AT 的 JWT 快照，仅供参考。

### 3.4 参数错误（HTTP 400）

```json
{ "ok": false, "error": "缺少 access_token" }
```

### 3.5 频率限制（HTTP 429）

```json
{ "ok": false, "error": "请求过于频繁，请稍后重试" }
```

单 IP 限制：30 次 / 60 秒。

## 4. 响应字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 请求是否成功处理 |
| `active` | boolean/null | `true` 账号正常；`false` 账号异常（被删/封禁/AT失效）；`null` 验证服务不可用 |
| `plan_type` | string | 套餐类型，见下表 |
| `email` | string/null | 账号邮箱（可能为空） |
| `account_id` | string/null | ChatGPT Account ID |
| `user_id` | string/null | ChatGPT User ID |
| `token_expires_at` | string/null | AT 过期时间（ISO 8601） |
| `upstream_status` | int/null | OpenAI 上游返回的状态码 |
| `error` | string/null | 异常时的原因描述 |

### 套餐类型对照

| `plan_type` | 含义 |
| --- | --- |
| `free` | 免费版 |
| `plus` | Plus 付费版（20$/月） |
| `pro` | Pro 专业版（200$/月） |
| `team` | 团队版 |
| `enterprise` | 企业版 |
| 其他值 | OpenAI 后续新增的套餐，原样返回 |

> `plan_type` 优先取 OpenAI 服务端实时返回的套餐；服务端不可用时回退到 AT 中 JWT 携带的套餐快照。

## 5. 调用示例

### 5.1 curl

```bash
# 直接用 AT
curl -X POST https://api.cuixiaoxuan.com/api/account/verify \
  -H "Content-Type: application/json" \
  -d '{"access_token": "eyJhbGciOi...", "account_id": "user-xxxx"}'

# 带 Bearer 前缀的 AT
curl -X POST https://api.cuixiaoxuan.com/api/account/verify \
  -H "Content-Type: application/json" \
  -d '{"access_token": "Bearer eyJhbGciOi..."}'
```

### 5.2 Python

```python
import requests

resp = requests.post(
    "https://api.cuixiaoxuan.com/api/account/verify",
    json={"access_token": "eyJhbGciOi..."},
    timeout=20,
)
data = resp.json()
if data.get("ok") and data.get("active"):
    print(f"账号正常，套餐：{data['plan_type']}")
elif data.get("ok") and data.get("active") is False:
    print(f"账号异常：{data.get('error')}")
```

## 6. 验证充值是否成功的用法

充值 Plus（或其他套餐）后，**需要重新登录 ChatGPT 获取新的 AT**（旧 AT 的 JWT 里记录的还是充值前的套餐快照），然后用新 AT 调用本接口：

1. 返回 `active: true` 且 `plan_type: "plus"` → 充值成功，账号已升级 ✅
2. 返回 `active: true` 但 `plan_type: "free"` → 账号正常但尚未升级（可能充值未到账或用的旧 AT）
3. 返回 `active: false`（401/403）→ 账号异常，检查 AT 是否过期或账号是否被封 ❌
4. 返回 `active: null` → 验证服务暂不可用，稍后重试

## 7. 注意事项

- **安全性**：接口只把 AT 转发给 OpenAI 验证账号状态，服务端不存储任何凭据，验证完即丢弃。
- **CORS**：仅允许 `https://boji1334.github.io` 及本地开发地址调用，直接 curl 请求需要带 Origin 或从浏览器页面发起。
- **限流**：单 IP 30 次/分钟，批量验证建议加间隔。
- **AT 有效性**：ChatGPT AT 通常有效期约 1 个月；验证结果只代表当前 AT 的状态。
- **套餐实时性**：优先使用 OpenAI 服务端返回的套餐，但若 OpenAI 侧接口返回延迟或受限，会回退到 AT 内的 JWT 快照。
