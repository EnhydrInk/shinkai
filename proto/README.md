# 共享牌桌 MCP 原型

单进程、单张桌、2–4 人；默认 4 人、起手 3 张、最多 10 轮、每回合 60 秒。没有前端、模型 API 或人类介入。四个客户端连接同一个 HTTP 地址，坐满自动开局。

## 启动和自测

在 `proto/` 内运行，Node.js ≥22：

```sh
npm ci --cache .npm-cache
npm run check
npm start
```

地址：`http://127.0.0.1:3333/mcp`。健康检查：`http://127.0.0.1:3333/health`。

`npm run check` 包含类型检查、规则／HTTP 测试、四组随机 bot 自测。自测用独立的临时端口，启动真实 HTTP 服务和四个官方 SDK 客户端，**模型调用为 0**。结果保存在 [artifacts/selftest.json](artifacts/selftest.json)。`npm run build` 编译后可用 `node dist/src/main.js` 启动。

改 [config/default.json](config/default.json) 后重启；另一个配置文件可用 `GAME_CONFIG=config/my-game.json npm start`，端口可用 `PORT=3334 npm start`。端口改变时同步修改客户端 URL。完成一局后重启服务开始下一局；旧 token 随进程失效。

## AI 玩家

把 [玩家 prompt](docs/PLAYER_PROMPT.md) 分别交给四个独立会话。下面命令均从 `proto/` 执行；服务只启动一次。两种 CLI 的 MCP 传输都使用 HTTP，连接同一个地址。

Claude Code：分别在两个终端执行（启动的是 Sonnet 会话，会使用已有账号的额度）：

```sh
claude --model sonnet \
  --strict-mcp-config --mcp-config config/claude.mcp.json \
  --tools '' \
  --allowedTools 'mcp__tabletop__join_game' 'mcp__tabletop__get_state' 'mcp__tabletop__wait_for_my_turn' 'mcp__tabletop__act' \
  -- "$(cat docs/PLAYER_PROMPT.md)"
```

`config/claude.mcp.json` 是 HTTP 配置。也可手动注册 `claude mcp add --transport http --scope project tabletop http://127.0.0.1:3333/mcp`；上面的按次加载命令不需要注册。

Codex：分别在另两个终端执行，使用账号当前默认模型：

```sh
codex \
  -c 'mcp_servers.tabletop.url="http://127.0.0.1:3333/mcp"' \
  -c 'mcp_servers.tabletop.tool_timeout_sec=40' \
  "$(cat docs/PLAYER_PROMPT.md)"
```

按次配置不改全局配置。也可注册：`codex mcp add tabletop --url http://127.0.0.1:3333/mcp`。如果已有 MCP 工具审批策略，需要在各会话允许牌桌工具；这些命令不关闭全局安全控制。四个玩家应先就绪再入座，最后一个入座即开始计时。

命令已核对本机 CLI 帮助；Codex 按次配置通过 `mcp get tabletop --json` 验证为 `streamable_http`、工具超时 40 秒。**尚未运行两个 Sonnet + 两个 Codex 的模型实战**；本次没有发起任何模型请求。

## 工具契约

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `join_game` | `name`, 私密 `joinKey`（16–128 字符） | 私密 `token` + 自己的 `state`；同 key 重试返回同座位 |
| `get_state` | `token` | 自己的手牌 + 公共局面 + 自己的合法出法 |
| `wait_for_my_turn` | `token`, `waitMs`（0–25000，默认 25000） | `your_turn` / `waiting` / `finished` + 自己的局面 |
| `act` | `token`, `turnId`, `action` | 行动后的局面，或错误原因和自己的最新局面 |

工具结果同时带 JSON 文本和相同的 `structuredContent`。错误有 `ok:false`、`isError:true` 和错误码。无效 token 不返回任何局面。轮次过期会报 `STALE_TURN`，非法出法报 `ILLEGAL_ACTION`；错误请求不延长计时。

座位身份只由 token 决定，不能用 `seatId` 或名字读取别人的牌。`joinKey` 是入座重试的恢复凭据，也必须保密。传输无 MCP session ID；token 可用于断线重连，各 HTTP 请求共用进程中的 `GameRoom`。服务器输出只含公开事件和计时，没有手牌或凭据。

## 当前规则

| 配置 | 默认 | 范围／含义 |
| --- | --- | --- |
| `seats` | 4 | 2–4 |
| `initialHand` | 3 | 1–10 |
| `maxRounds` | 10 | 1–1000；每轮为 `seats` 次有效行动或超时 |
| `turnTimeoutMs` | 60000 | 10–3600000 毫秒 |
| `enabledEffects` | skip, reverse, draw2, wild | 可删减；数字牌固定四种颜色、0–9 |
| `stopOnEmptyHand` | true | 任一玩家出完即结束；false 则打到轮数上限 |
| `allowVoluntaryDraw` | true | 有牌能出时也允许摸牌；摸一张即结束回合 |
| `reverseSkipsInTwoPlayer` | true | 两人局反转相当于跳过，自己再行动 |

同色或同牌面可出；功能牌相同牌面也能跨颜色接。跳过跨过下一人；反转换方向；+2 让下一人立即摸两张并跳过，不叠加；变色牌任意时刻可出但必须选颜色。起始牌固定为数字牌，满人数自动发牌。默认牌堆 104 张，禁用功能牌会移除对应牌。

到轮数上限比较手牌张数，最少者获胜，并列共同获胜。被跳过者不计为一次行动；罚摸不额外计步。最后一张功能牌的效果先结算，再结束。牌堆用完时回收除顶牌外的弃牌；无可回收牌时摸牌为空操作，仍推进回合。

这些未明确的细节作为原型暂定值列在 [对齐单](对齐单.md)。

## 计时和扩展

每次 `turn_started` 记录开始和截止时间，`step_completed` 记录座位、回合、行动和延迟。`game_finished` 输出平均延迟、最慢一步、最慢一轮，以及完整步骤／轮次记录。时间覆盖等待、模型推理和工具往返；不含坐满前的等待。最慢一轮按轮内各步耗时之和，提前结束的末轮标记 `complete:false`。运行时用单调时钟映射到毫秒时间戳，避免系统时钟调整造成负耗时。

代码入口：纯规则 [engine.ts](src/engine.ts)、凭据／计时／等待 [room.ts](src/room.ts)、工具定义 [mcp.ts](src/mcp.ts)、Node HTTP [server.ts](src/server.ts)。Dot 的公共事件出口为 `RoomOptions.onPublicEvent`；人类牌入口为 `GameEngine.applyExternalAction`，目前明确返回未实现，未暴露成 MCP 工具。

当前服务只绑定本机 IPv4，校验 Host／Origin。牌局和凭据只保存在内存，没有多房间、持久化或公网身份系统。迁移到多实例／无常驻进程环境时，必须先接共享状态和可靠的超时调度；不能直接把进程内 Map 分散到多个实例。
