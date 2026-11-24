# 长安链 NFT 铸造与交易系统

一个可本地运行的数字作品登记与流转系统，包含长安链 `DOCKER_GO` 合约源码、Node.js API、浏览器界面和持久化本地演示模式。扩展版加入作品上传、自动计算 SHA-256、下载验真、条件购买、审核草稿、全局审计记录与分页检索。购买使用**不可兑付测试积分**。

首页横幅增加纯 CSS 离子轨道动画；系统设置为“减少动态效果”时自动停用动画。

当前验收范围是本机演示模式。`chainmaker` 配置和 Go 合约用于后续真实链联调；本项目尚未在真实长安链部署。合约加入部分 [CMNFA 接口](https://pkg.go.dev/chainmaker.org/chainmaker/contract-utils/standard#CMNFA)风格的方法和事件，但尚未完成标准兼容性及浏览器识别验证。

## 功能

- **作品上传与验真**：支持 PNG、JPEG、WebP 与安全 SVG，上传后服务器计算 SHA-256，浏览器独立复核；文件按哈希保存在 `data/objects/`，可对平台留存文件或所选本地文件重新验真。
- **铸造**：发行方指定资产 ID、初始持有人、元数据和作品 SHA-256；合约计算元数据原始字节的 SHA-256，保存 `metadataHash`、`tokenURI` 与可选许可摘要。资产 ID 销毁后不能再用。
- **授权**：所有者可单项授权或授权某个操作者管理全部资产，也可撤销。
- **转移**：所有者、单项被授权人、全局操作者可转移；转移后自动清除单项授权和挂牌。
- **交易**：挂牌可设置截止区块高度，重复挂牌递增订单序号；购买可核对卖方、价格和序号，积分结算和权属变更在同一操作中完成。
- **查询与溯源**：分页搜索资产、查询详情和单资产历史；全局操作流水按需投影到本地索引，支持查看链上合约记录或演示记录来源。
- **业务审核**：网关支持草稿提交、独立审核、批准或拒绝。可配置为铸造前必须审核；审核状态属于网关数据，不替代链上签名和合约权限。
- **销毁**：所有者或被授权人销毁；保留历史记录，禁止后续转移和交易。

## 立即体验

需要 Node.js 20 或更新版本。在项目目录执行：

```powershell
npm start
```

打开 `http://127.0.0.1:3000`。默认身份 `issuer` 可铸造，`alice` 和 `bob` 可模拟持有与购买。建议先在“铸造资产”中上传作品图片，核对自动填入的哈希，铸造给 `alice`；随后在资产详情中核验留存文件，切换账户做授权、挂牌、积分发放、购买、审计查询与销毁。演示身份和密钥只供本机试用。

演示状态写入 `data/demo-state.json`；作品写入 `data/objects/`；审核数据和事件索引分别写入 `data/reviews.json`、`data/event-index.json`。重启后保留。当前 `config.demo.json` 的 `requireMintReview` 为 `false`，因此既可直接铸造，也可展示审核流程。要强制先审核，改为 `true` 并让审核人完成批准后再提交带 `reviewId` 的铸造请求。

审核属于网关流程，直接向合约提交交易可以绕过该审批记录；链上发行权限仍由合约检查。作品内容摘要只能用于核对文件一致性和登记记录，不能单独证明版权归属。

```powershell
npm test
```

## 接入长安链

### 1. 准备链与合约

需要支持 `DOCKER_GO` 的长安链节点、CMC 命令行工具、各用户的签名与 TLS 证书、Go 工具链和 7-Zip。官方文档要求 Docker VM 在 Linux 运行；本工程的构建脚本输出 Linux 可执行文件并打包为 `.7z`。当前本机没有 Go 工具链或可用链节点，Go 合约仍需在目标 Linux 环境编译和实链验收。

在 Linux 环境中：

```bash
cd contract
./build.sh
```

合约依赖固定为 `contract-sdk-go/v2 v2.3.9`。将 `contract/nft_market.7z` 部署到链上：

```bash
./cmc client contract user create \
  --contract-name=nft_market \
  --runtime-type=DOCKER_GO \
  --byte-code-path=/absolute/path/to/contract/nft_market.7z \
  --version=2.0 \
  --sdk-conf-path=/absolute/path/to/sdk_config.yml \
  --admin-key-file-paths=/path/to/admin1.tls.key,/path/to/admin2.tls.key \
  --admin-crt-file-paths=/path/to/admin1.tls.crt,/path/to/admin2.tls.crt \
  --sync-result=true \
  --params='{}'
```

`admin-key-file-paths` / `admin-crt-file-paths` 要按链的多签策略填写。**部署交易的发起账户就是合约发行方**；服务配置中的 `issuer` 证书必须对应同一链上地址。

使用 CMC 验证：

```bash
./cmc client contract user get \
  --contract-name=nft_market \
  --method=GetSchemaVersion \
  --sdk-conf-path=/absolute/path/to/sdk_config.yml \
  --params='{}'
```

### 2. 配置 Node SDK 网关

从[长安链官方 Node SDK 仓库](https://git.chainmaker.org.cn/chainmaker/sdk-nodejs)克隆 SDK 并在 SDK 目录安装依赖。复制 `config.chainmaker.example.json` 为 `config.chainmaker.json`，填写 `sdkPath`、链 ID、节点证书、各账户的证书路径、地址与不同的随机 API 密钥。

`sdkPath` 指向 SDK 仓库根目录。`profiles` 中每个账户各自创建 SDK 客户端，提交交易时由该账户签名；API 密钥只在服务端配置中保存。将 `publicBaseUrl` 设为长期可访问的 HTTPS 服务地址，让元数据与作品 URI 可由外部应用读取。请通过环境变量选择配置文件：

```powershell
$env:NFT_CONFIG = (Resolve-Path .\config.chainmaker.json).Path
npm start
```

服务默认监听 `127.0.0.1:3000`。真实链模式的界面需要手动输入所选账户的 API 密钥。不要把真实证书或 `config.chainmaker.json` 提交到仓库。若要开放给其他机器，需在网关前增加 HTTPS、身份认证、访问控制和审计。

**当前验证范围：** Node 测试和本地 API 演示流程。Go 合约源码已扩展，但本机缺少 Go 工具链和长安链节点，因此未完成 Go 编译、真实链交易、CMNFA 标准测试及浏览器识别。部署前先核验 `GetSchemaVersion`、`GetAdmin`、`GetBlockHeight`，再用真实地址完成 `Mint → List → Buy → GetEvents`。Node SDK 与目标链版本也需单独联调。旧版合约的状态键格式不同，不能直接原地升级；详见 `contract/README.md`。

## API

读接口无需 API 密钥：

```text
GET /api/status
GET /api/chain-height
GET /api/tokens?q=山海&status=active&offset=0&limit=20
GET /api/tokens/:id
GET /api/tokens/:id/history?offset=0&limit=20
GET /api/tokens/:id/metadata
GET /api/tokens/:id/verify
GET /api/files/:sha256
GET /api/events?offset=0&limit=20
GET /api/balances/:address
GET /api/operators?owner=...&operator=...
```

`POST /api/files` 使用请求头 `x-actor`、`x-api-key`、`x-file-name`（URI 编码文件名）和图片原始字节，单文件上限 10 MiB，返回作品 URI 和 SHA-256。`POST /api/tokens/:id/verify` 用所选文件原始字节核对链上摘要。`POST /api/reviews`、`POST /api/reviews/:reviewId/decision` 用于审核流程，`GET /api/reviews` 查看审核记录；写接口须用对应身份的 API 密钥。

链上业务操作使用 `POST /api/actions`，请求头 `x-api-key` 对应 `actor`：

```json
{
  "actor": "issuer",
  "method": "Mint",
  "params": {
    "id": "ART-001",
    "to": "alice",
    "metadata": "{\"name\":\"山海之间\",\"image\":\"/api/files/dc49100e74fa53ad7b146a55b1e9b73fbf84c606071b6082341c57211c734138\",\"author\":\"作者\",\"orgName\":\"发行机构\",\"description\":\"作品描述\",\"seriesHash\":\"dc49100e74fa53ad7b146a55b1e9b73fbf84c606071b6082341c57211c734138\"}",
    "contentHash": "dc49100e74fa53ad7b146a55b1e9b73fbf84c606071b6082341c57211c734138"
  }
}
```

支持的 `method`：`Mint`、`Approve`、`SetApprovalForAll`、`Transfer`、`Burn`、`List`、`CancelListing`、`Buy`、`GrantCredits`。`GrantCredits` 只允许发行方调用。`Mint` 还可传 `licenseHash`、`reviewId`、`tokenURI`；网关会计算或校验 `metadataHash`。`List` 可传 `expiryHeight`，`Buy` 建议传 `expectedSeller`、`expectedPrice`、`expectedNonce`。演示账户不能作为真实链地址使用。

上面的 JSON 示例使用了仓库中的 `web/art.svg` 的真实 SHA-256；先将该文件上传到 `/api/files`，其 `/api/files/<sha256>` 地址才会存在。

`GET /api/events` 使用合约 `GetEvents` 的全局记录按请求同步到 `data/event-index.json` 并保存检查点；这是应用合约状态的轮询投影，不是节点级实时订阅。真实链模式的查询性能与事件同步行为尚待联调。资产筛选在真实链适配器中当前仍按页读取后过滤，适合小规模验证。

## 目录

```text
contract/     长安链 Go 合约及 Linux 构建脚本
server/       HTTP API、文件存储、审核、事件索引、SDK 适配器、演示驱动与测试
web/          浏览器管理台
config.*.json 配置示例
```

参考：[长安链 Go 合约开发文档](https://docs.chainmaker.org.cn/v2.3.1/html/instructions/%E4%BD%BF%E7%94%A8Golang%E8%BF%9B%E8%A1%8C%E6%99%BA%E8%83%BD%E5%90%88%E7%BA%A6%E5%BC%80%E5%8F%91.html)、[长安链 Node SDK 文档](https://docs.chainmaker.org.cn/v2.3.4/html/sdk/NodejsSDK%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.html)。
