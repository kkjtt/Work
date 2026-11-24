# NFT 合约扩展接口

此合约采用长安链 `DOCKER_GO` 运行时，继续使用项目自定义业务接口。已增加若干 CMNFA 风格参数、批量方法和事件，**尚未完成 CMNFA 规范一致性测试及浏览器识别验证**；例如当前 `TokenURI` 是逐资产显式 URI，尚未采用标准建议的分类 URI 拼接规则。不能把本合约登记为已符合 CMNFA 的合约。

## 状态与版本

- 新部署时 `InitContract` 写入 `schema_version=2`，由部署交易的签名者担任发行方。
- 所有动态状态键使用 UTF-8 十六进制编码，键名只含数字、字母、点、下划线和连字符；此格式与旧版含 `/` 的键不兼容。旧版合约即使没有资产，也可能有积分或全局授权，因此 `UpgradeContract` 一律拒绝旧版原地升级，须另行设计资产、余额、授权及历史迁移。
- `GetSchemaVersion` 返回版本字符串；`GetAdmin` 返回发行方地址。

## 铸造

`Mint` 参数：`id`（也接受 `tokenId`）、`to`、`metadata`、`contentHash`；可选 `categoryName`、`metadataHash`、`tokenURI`、`licenseHash`。`metadata` 是 JSON 原始字符串，至少包含 `name`、`image`，上限 8192 字节。合约对原始 `metadata` 字节计算 SHA-256 并存入 `metadataHash`；如果调用者提供 `metadataHash`，必须与计算值一致。`contentHash` 和可选 `licenseHash` 仅验证为 64 位十六进制；合约无法读取链下文件，文件内容验真由上传服务完成。

`MintBatch` 参数 `tokens` 为 JSON 数组，最多 10 项。每项至少包含 `tokenId`、`to`、`metadata`，并提供扩展字段 `contentHash`，或在元数据中提供 `seriesHash` 作为作品摘要。`metadata` 可为 JSON 对象、JSON 字符串或 Go `[]byte` 序列化的 base64 字符串。`SetApproval` 支持 `owner, to, tokenId, isApproval`；`TransferFrom` 支持 `from, to, tokenId`；`TransferFromBatch` 支持 `from, to, tokenIds`（JSON 字符串数组，最多 50 项）。这些方法沿用原有权限与账本规则，并追加 CMNFA 风格的小写主题事件。

通过 SDK/CMC 传参时，`tokens` 和 `tokenIds` 是**字符串值**，其内容分别为 JSON 数组：

```json
{"tokens":"[{\"tokenId\":\"ART-001\",\"to\":\"alice\",\"metadata\":{\"name\":\"山海之间\",\"image\":\"https://example.com/art.svg\"},\"contentHash\":\"<上传文件的真实 SHA-256>\"}]"}
```

```json
{"from":"alice","to":"bob","tokenIds":"[\"ART-001\",\"ART-002\"]"}
```

示例哈希为说明性占位内容，实际铸造必须使用上传文件计算出的 SHA-256。批量调用在单笔合约交易中逐项处理，任何一项失败都返回错误；真实链事务回滚仍需在目标链联调中验证。

`GetToken` 返回资产，包括 `contentHash`、`metadataHash`、`tokenURI`、`licenseHash`、`expiryHeight`、`orderNonce` 等字段。`OwnerOf` 和 `TokenURI` 支持 `id` 或 `tokenId` 参数。

## 挂牌与购买

- `List` 参数：`id`、`price`、可选 `expiryHeight`。缺省或 `0` 表示不限区块高度；非零时不得早于当前区块。每次挂牌递增 `orderNonce`。
- `Buy` 参数：`id`，可选 `expectedSeller`、`expectedPrice`、`expectedNonce`。提供时必须与当前挂牌逐项一致。调用方应始终传三项以防页面读取报价后挂牌发生变化。超过截止区块时拒绝购买。
- `Transfer`、`Buy`、`Burn`、`CancelListing` 会清除挂牌价格及截止高度，但保留递增后的订单序号，避免旧报价再次有效。成交积分属于不可兑付测试积分，结算与所有权变更保留在同一合约调用中。

## 查询与审计

- `GetBlockHeight` 返回 `{"height": n}`。
- `GetHistory` 返回单资产操作记录，新增 `actor`、`assetId`、`blockHeight`。
- `GetEvents` 返回按合约写入顺序排列的全局记录 `{"total": n, "items": [...]}`，支持 `offset`、`limit`，单页最多 100 条；包括 `SetApprovalForAll` 和 `GrantCredits`。
- 每次写操作继续发送原有业务主题事件，并新增统一 `AssetAction` 事件，字段依次为 `action, assetId, actor, from, to, price, amount, txId, orderNonce, expiryHeight, approved`。订阅服务应按链 ID、交易 ID、事件序号去重。

## 构建与联调

在 Linux 上执行 `./build.sh`，产出 `nft_market.7z`。部署后先调用 `GetSchemaVersion`、`GetAdmin`、`GetBlockHeight`，再用真实证书地址按 `Mint → List → Buy → GetEvents` 联调。此仓库目前没有连接真实长安链节点，本目录的 Go 测试与实际链行为需要在具备 Go 工具链和目标链的环境执行。

参考：[长安链合约键限制](https://docs.chainmaker.org.cn/instructions/%E6%99%BA%E8%83%BD%E5%90%88%E7%BA%A6%E5%BC%80%E5%8F%91.html)、[CMNFA 官方接口](https://pkg.go.dev/chainmaker.org/chainmaker/contract-utils/standard#CMNFA)、[合约 Go SDK](https://pkg.go.dev/chainmaker.org/chainmaker/contract-sdk-go/v2/sdk)。
