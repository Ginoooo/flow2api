# Flow2API Token Updater

本插件基于 [TheSmallHanCat/Flow2API-Token-Updater](https://github.com/TheSmallHanCat/Flow2API-Token-Updater)
的固定提交 [e1ed56627596209c9e77df381e3fe82e0a17c492](https://github.com/TheSmallHanCat/Flow2API-Token-Updater/commit/e1ed56627596209c9e77df381e3fe82e0a17c492)，
本地版本为 `1.3.1.2`。它同步 Google/Flow 登录 Cookie，不负责验证码求解，不与仓库的 `chrome-extension` 混用。

## 本地适配

- 保留上游同步协议及普通同步代码，继续发送 `login_account`、`google_cookies` 和 `protocol_mode`。
- 补充仅限 `google.com` 及其子域的 HTTP 主机权限。Chromium 根据 Cookie 自身的 Secure 属性检查 HTTP/HTTPS 主机权限；只有 HTTPS 权限可能漏读随 HTTPS 请求发送的非 Secure Cookie。改用域查询不能绕过此限制。
- 仍按 `https://flow.google.com/projects` 的请求范围收集 Cookie，不枚举其他站点，不通过 HTTP 发送 Cookie，也不调用 Google 个人资料接口。
- 增加 `webRequest` 只读权限，用于手动运行一次原生请求对照。未调用检测函数时不会安装请求监听器，检测结束、失败或超时都会移除监听器。

## 安装与同步

1. 在用于 Flow 的独立 Chrome/Chromium 配置中登录 Google，确认可以打开 `https://flow.google.com/projects`。
2. 在 `chrome://extensions` 开启开发者模式，加载仓库的 `token-updater` 目录。升级已有解压版时直接重新加载，接受权限变更，确认版本为 `1.3.1.2`。
3. 填写 HTTPS 服务地址，例如 `https://your-flow2api.example/api/plugin/update-token`，以及服务后台“插件连接配置”中的连接 Token。
4. 手动填写当前 Flow 账号邮箱，用于稳定更新同一账号；插件不自动抓取 Google 邮箱与配置作身份匹配。
5. 保存并批准目标服务地址的访问权限，点击“立即测试”，再到服务后台确认账号新增或更新。

服务端保留连接 Token 鉴权及原有 Cookie/RPC 验证，不额外要求上传入口先从网页读取邮箱。同步成功后仍需单独验证真实生成。

Cookie 与连接 Token 都是敏感凭据。不要上传原始请求头、Cookie 数组、浏览器配置或 `getConfig()` 输出，也不要将其写入 Git。
本目录仅包含公开运行文件，不包含配置后的凭据、ZIP 安装包或浏览器数据。

## 只读诊断

需要排障时，在该插件的 Service Worker Console 运行：

```javascript
console.log(JSON.stringify(await diagnoseNativeFlowSession(), null, 2))
```

检测只观察本扩展发往固定 Flow 页面的 GET，不修改或拦截请求，不上传诊断到服务端，不写账号或配置。
结果包含 Cookie 名称、数量、请求前后导出快照匹配布尔值和会话相关头名称，不包含 Cookie、邮箱、XSRF 或认证头的值。

`request_observed=false` 或 `cookie_header_observed=false` 表示观察不完整，不能据此认定没有发送 Cookie。
`before`、`after` 对照用于区分导出缺失与请求过程中的轮换。缺少可见会话头也不能单独排除浏览器内部会话机制。

## 离线测试

在仓库根目录使用支持 `node:test` 的 Node.js 运行，无需安装依赖：

```bash
node --test tests/token-updater-diagnostic.test.cjs
```

测试覆盖主机协议权限、完整 Cookie 收集、差异与轮换、作用域限制、脱敏及并发/超时清理。
离线测试使用虚构 Cookie，不代表真实 Google 会话已被服务器接受。