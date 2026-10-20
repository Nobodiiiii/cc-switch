# 路由矩阵（Route Matrix）

这个扩展为 Codex 增加「路由矩阵」模式，与「直连 / 路由 / 聚合」并列。主路由可同时加入多个官方供应商，手动选择当前账号；带前缀的多个副路由各自聚合模型。它基于 CC Switch 4.0.16（上游 `f92ff0b`）。

Windows CI 也会产出包含前端资源的独立测试程序，位于构建的 `cc-switch-route-matrix-windows-x64` artifact。它是未签名的调试构建，不是安装包。运行前先退出原来的 CC Switch，避免被单实例检查切回原版；程序使用现有 CC Switch 数据目录，正式使用前可用上游内置备份功能保存配置。

## 使用

1. 在 CC Switch 的 Codex 页面添加所需供应商。官方账号卡片必须绑定 CC Switch 账号管理中的具体 ChatGPT 账号。
2. 在 Codex 页面上方选择「路由矩阵」页签。查看页签不会启用模式，启用需要点击页面内的切换按钮。
3. 在「主路由供应商（可多选）」中勾选多个官方账号或其他供应商，再添加不带前缀的模型 ID。界面自动为所选供应商创建同名映射，实际模型名可分别调整。在「当前供应商」选择默认账号；也能为单个模型指定供应商，因此不同的原始模型名可以同时使用不同供应商。主路由不自动故障转移。
4. 添加副路由，为每组设置唯一前缀。比如前缀 `backup` 下的 `gpt-test` 发布成 `rm-backup/gpt-test`。模型与目标映射只在该路由内部有效。
5. 副路由按需开启故障转移，分别设置额外尝试次数、首包超时、流静默超时、普通请求超时、失败阈值和冷却秒数。先尝试所选供应商，再按该模型的映射列表顺序尝试其余供应商；主路由始终手动切换。
6. 首次点「保存并切换到路由矩阵」。之后调整所选供应商、当前账号、模型映射、前缀和策略只需点「保存配置」。

保存一次配置后，下一次请求读取新配置；已开始的请求继续使用原配置。主路由切换不会更改副路由，副路由的失败也不会触发主路由的熔断或改变上游原有路由状态。

## 无需重启的范围

代理地址固定后，供应商/官方账号切换、映射、路由增删和故障转移策略在服务器端热生效，不改写 `auth.json`，不重启 Codex 或代理。

首次接入需要客户端采用 `cc_switch_matrix` 连接。已经运行、仍连旧地址的 Codex 不会被这个扩展强制接管；客户端是否支持重载连接决定是否需要首次重载/重启。旧会话如果固定记录了原供应商，可能需要新建会话。

模型目录由 `/route-matrix/v1/models` 动态返回，配置使用 `model_catalog_url`，移除会屏蔽动态发现的 `model_catalog_json`。[OpenAI 配置参考](https://developers.openai.com/codex/config-reference/)明确把文件目录描述为启动时加载。动态目录何时重新显示在选择器中仍由 Codex 的缓存/刷新机制决定；扩展不会操作或重启 Codex 进程。可在支持任意模型 ID 的客户端直接输入新增 ID。

接入时也会启用 Codex 的 `features.api_key_model_discovery`，确保本地令牌连接能够读取动态目录，断开时恢复原值。此开关和目录认证行为已对照 [OpenAI 的配置供应商实现及测试](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/provider.rs)核实。

跨供应商/账号不可共用的远端 `previous_response_id`、加密推理状态等仍受上游约束。扩展复用 CC Switch 的历史与协议适配，但不能让一个账号读取另一个账号的远端响应。上游已开始向客户端返回流内容后，不重放整个请求，以免重复生成或调用工具。

## 配置和恢复

- 路由配置保存于 CC Switch 数据库的 `settings.route_matrix_v1`，不改变数据库表结构。
- 引用供应商 ID；密钥继续由上游供应商配置管理，官方 token 由现有 OAuth 管理器在每次请求发送前获取/刷新。
- 官方请求只使用卡片绑定账号，拒绝未绑定的官方卡片；不依赖当前 Codex 进程持有哪个官方 token。
- 本地连接使用独立随机令牌，上游请求的认证头由对应供应商重新生成，内部路由标记不会转发。
- 「恢复原连接并停用」只恢复原来的模型、供应商和文件目录设置，保留接入后对项目、MCP 等其他配置的修改。不修改官方登录文件。
- 当前模式同时显示在模式页签、侧栏和托盘。切到直连、路由或聚合时先退出矩阵；切换失败会尝试恢复矩阵。编辑供应商卡片只更新映射引用的配置，不覆盖矩阵连接。托盘显示当前主路由账号，账号切换在矩阵页中完成。
- 已有配置没有 `providerIds` 字段时，界面从模型映射和当前供应商恢复主路由成员，保存多选后使用显式名单。
- CC Switch 需保持运行。重开本扩展版 CC Switch 时会恢复服务；普通路由的启动/关闭及其他应用仍由上游管理。
- 前缀移除后保留归属，不能转给不同 ID 的新路由。未知、损坏、已移除的模型 ID 直接报错，不回落到主路由。
- 供应商被删除后，相关路由会明确报错。先移除失效映射再保存；即使映射失效也可以断开连接。

模型能力参数可以填 Codex 原生目录 JSON，例如 `context_window`、`input_modalities`、`supported_reasoning_levels`。默认使用仓库内的 Responses 目录模板，并保守地声明文本输入；需要根据实际供应商填写能力参数。目录声明不会改变上游模型能力。

## 独立性与上游更新

核心代码集中在：

- `src-tauri/src/route_matrix/`：配置版本/校验、名称空间、路由快照、独立熔断冷却、连接备份与恢复。
- `src-tauri/src/commands/route_matrix.rs`：三个独立 Tauri 命令。
- `src/components/route-matrix/` 和 `src/lib/api/routeMatrix.ts`：配置界面及类型接口。

少量接点负责命令注册、代理子路径、请求上下文和逐供应商转发；认证刷新、Responses/Chat/Anthropic 转换和流处理继续使用上游实现。原有路由/聚合路径不调用矩阵选路，也不共享矩阵的健康状态。配置升级通过 `version` 显式处理；未知版本报错，避免悄悄按错误策略路由。

合并上游时重点检查这些接点，运行下面检查。上游非重大更新通常可保持模块不变；无法保证未包含此扩展的官方二进制直接识别该连接，升级前应先断开矩阵或使用合并扩展后的构建。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run tests/components/RouteMatrixPanel.test.tsx tests/components/SwitchModePanel.test.tsx
pnpm build:renderer
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib route_matrix:: -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib route_matrix_mode_ -- --test-threads=1
```

`.github/workflows/route-matrix.yml` 在功能分支更新时运行 Windows 构建与兼容性测试。HTTP 测试只连接本机假上游，在同一代理进程中改配置，验证目标模型、认证隔离、故障转移、SSE、压缩和拒绝跨路由回落，不读取实际账号。
