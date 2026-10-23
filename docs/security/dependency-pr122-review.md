# PR #122 运行依赖审查

本轮更新根目录运行依赖。原始 `src/app` 清单、资源、Electron 42.1.0 与容器基础镜像继续作为固定重建输入。

## 依赖与生产路径

- AI SDK `7.0.148`、OpenAI provider `4.0.99` 与 provider-utils `5.0.65` 用于 OpenRouter 和 Command Code。`provider-session.ts` 转换工具 schema、历史工具结果、多模态消息、流式参数、返回消息与用量，并通过 AbortSignal 关闭取消的请求。
- `GHSA-rwvc-j5jr-mgvh` 影响旧 AI SDK 的文件下载结果对应；历史消息可以包含图片 URL。`GHSA-866g-f22w-33x8` 影响 provider-utils 的错误响应读取，生产 Chat Completions 请求可进入该路径。这两项由依赖升级处理。
- 根目录 Undici `8.12.3` 为生产 `proxyFetch` 提供 Fetch 和 ProxyAgent。Electron 打包清单固定版本、完整性散列、CJS 入口、类型入口、Node 要求与依赖闭包。
- Connect 与 connect-node 保持 `1.6.1`，匹配 protobuf `1.10.1` 和现有 transport 补丁。connect-node 对 Undici 的引用仅用于 Node 18 以下的 Headers polyfill，定向覆盖为 `6.28.1`。受支持的 Node 运行时使用全局 Headers；Connect HTTP 传输使用 Node HTTP 模块。升级后的依赖闭包不包含旧 busboy。
- KaTeX `0.18.3` 的生产 CSS 散列与安装版本一致；字体通过现有逐文件散列校验。

## 验证

测试执行真实 AI SDK、本地 HTTP/SSE 服务、生产 RPC、TLS 证书验证与 CONNECT 代理。覆盖文本和工具流、工具结果回传、图片、缓存读取和写入计量、错误响应、取消以及后续请求。TLS 测试证书在临时测试目录生成并清理。Windows 工作流运行新增 AI SDK 与代理测试。

生产构建检查实际生成的 Electron CJS 与复制后的运行依赖，并验证 renderer 的 KaTeX CSS 和字体。Electron 42.1.0 实测内嵌 Node 24.15.0；容器构建固定 Node 22.23.2，均满足 Undici 8 的 Node 22.19.0 最低要求。

外部 OpenRouter、Command Code 真人账号与模型输出质量未纳入本轮验证。测试结果证明本地协议兼容、依赖行为和资源清理。

## 告警范围

当前根目录 `npm audit` 中 AI、provider-utils、Undici、busboy 对应条目已消除。本轮没有将这些实际可达问题作为误报关闭。其余依赖告警继续保留；独立的原版清单告警需要结合固定资源的使用范围评估。CodeQL 和 Dependabot 的查询范围保持启用。

PR 增量 CodeQL 的 300、301、302 对应测试父进程指定的编译模块和本机 OpenSSL 路径。逐项调用来源、参数分离和权限依据见[测试入口审查](codeql-pr122-review.json)，按 `used in tests` 降噪。
