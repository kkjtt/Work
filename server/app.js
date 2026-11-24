const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDemo } = require('./demo');
const { createChainMaker } = require('./chainmaker');
const { FileStore, HttpError, MAX_FILE_BYTES, digestRequest } = require('./file-store');
const { EventIndex } = require('./event-index');
const { ReviewStore } = require('./review-store');

const root = path.resolve(__dirname, '..');
const configFile = process.env.NFT_CONFIG || path.join(root, 'config.demo.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const mode = config.mode;
if (!['demo', 'chainmaker'].includes(mode)) throw Error('mode must be demo or chainmaker');
const driver = mode === 'demo'
  ? createDemo(path.resolve(root, config.dataFile || 'data/demo-state.json'))
  : createChainMaker(config);
const files = new FileStore(path.resolve(root, config.uploadDir || 'data/objects'));
const eventScope = mode === 'chainmaker'
  ? `${config.chainId || ''}:${config.contractName || ''}`
  : path.resolve(root, config.dataFile || 'data/demo-state.json');
const events = new EventIndex(path.resolve(root, config.eventIndexFile || 'data/event-index.json'), driver, mode, eventScope);
const reviews = new ReviewStore(path.resolve(root, config.reviewFile || 'data/reviews.json'));
const reviewers = new Set(config.reviewers || ['issuer']);
const publicBaseUrl = config.publicBaseUrl ? new URL(config.publicBaseUrl) : null;
if (publicBaseUrl && !['http:', 'https:'].includes(publicBaseUrl.protocol))
  throw Error('publicBaseUrl must use http or https');
const publicUrl = uri => publicBaseUrl ? new URL(uri, publicBaseUrl).href : uri;

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
const apiError = (res, code, message) => json(res, code, { error: message });

function actorFor(req, alias) {
  const profile = config.profiles[alias];
  if (!profile) throw new HttpError(401, '未知账户');
  const supplied = req.headers['x-api-key'];
  if (!supplied || typeof supplied !== 'string') throw new HttpError(401, '账户密钥无效');
  const left = crypto.createHash('sha256').update(supplied).digest();
  const right = crypto.createHash('sha256').update(profile.apiKey).digest();
  if (!crypto.timingSafeEqual(left, right)) throw new HttpError(401, '账户密钥无效');
  return alias;
}

async function body(req) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100000) throw new HttpError(413, '请求过大');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'JSON 格式无效'); }
}

function pagination(searchParams) {
  const offset = Number(searchParams.get('offset') || 0);
  const limit = Number(searchParams.get('limit') || 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, '分页参数无效');
  return { offset: String(offset), limit: String(limit) };
}

function localUploadHash(image) {
  let uri = String(image || '');
  if (publicBaseUrl && /^https?:\/\//i.test(uri)) {
    try {
      const parsed = new URL(uri);
      if (parsed.origin !== publicBaseUrl.origin) return null;
      uri = parsed.pathname;
    } catch { return null; }
  }
  const match = uri.match(/^\/api\/files\/([a-f0-9]{64})$/);
  return match ? match[1] : null;
}

async function prepareMint(params) {
  if (typeof params.id !== 'string' || !params.id.trim() || params.id.length > 128 ||
    params.id.includes('/') || /[\x00-\x1f\x7f]/.test(params.id) ||
    typeof params.to !== 'string' || !params.to || params.to.length > 128 || /[\/\s]/.test(params.to))
    throw new HttpError(400, '资产 ID 或接收地址无效');
  if (!/^[a-f0-9]{64}$/i.test(String(params.contentHash || '')))
    throw new HttpError(400, '作品摘要必须为 SHA-256');
  if (params.licenseHash && !/^[a-f0-9]{64}$/i.test(String(params.licenseHash)))
    throw new HttpError(400, '许可文本摘要必须为 SHA-256');
  if (typeof params.metadata !== 'string' || Buffer.byteLength(params.metadata, 'utf8') > 8192)
    throw new HttpError(400, '元数据格式无效或过大');
  let metadata;
  try { metadata = JSON.parse(params.metadata); }
  catch { throw new HttpError(400, '元数据 JSON 格式无效'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
    typeof metadata.name !== 'string' || !metadata.name.trim() ||
    typeof metadata.image !== 'string' || !metadata.image.trim() ||
    !((metadata.image.startsWith('/') && !metadata.image.startsWith('//')) ||
      /^https?:\/\//i.test(metadata.image)))
    throw new HttpError(400, '元数据需要作品名和有效图片地址');
  const uploadHash = localUploadHash(metadata.image);
  if (uploadHash) {
    const { actualHash } = await files.hashStored(uploadHash);
    if (actualHash !== uploadHash) throw new HttpError(409, '已上传文件与登记摘要不一致');
    if (String(params.contentHash || '').toLowerCase() !== uploadHash)
      throw new HttpError(400, '作品哈希与已上传文件不一致');
  }
  const metadataHash = crypto.createHash('sha256').update(params.metadata, 'utf8').digest('hex');
  if (params.metadataHash && String(params.metadataHash).toLowerCase() !== metadataHash)
    throw new HttpError(400, '元数据哈希不匹配');
  const tokenURI = params.tokenURI || publicUrl(`/api/tokens/${encodeURIComponent(params.id)}/metadata`);
  if (typeof tokenURI !== 'string' || tokenURI.length > 2048 ||
    !((tokenURI.startsWith('/') && !tokenURI.startsWith('//')) || /^https?:\/\//i.test(tokenURI)))
    throw new HttpError(400, '元数据 URI 无效');
  return { ...params, contentHash: String(params.contentHash).toLowerCase(), metadataHash, tokenURI };
}

function serveFile(res, sha256) {
  const file = files.get(sha256);
  res.writeHead(200, {
    'content-type': file.mimeType,
    'content-length': file.size,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'cross-origin-resource-policy': 'same-origin'
  });
  fs.createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, { mode, profiles: Object.entries(config.profiles).map(([alias, p]) => ({
        alias, address: p.address || alias, demoKey: mode === 'demo' ? p.apiKey : undefined
      })), reviewers: [...reviewers], requireMintReview: config.requireMintReview === true });
    }
    if (url.pathname === '/api/chain-height' && req.method === 'GET')
      return json(res, 200, await driver.query('GetBlockHeight'));
    if (url.pathname === '/api/files' && req.method === 'POST') {
      actorFor(req, req.headers['x-actor']);
      const uploaded = await files.put(req, req.headers['x-file-name']);
      return json(res, 201, { ...uploaded, url: publicUrl(uploaded.uri) });
    }
    let match = url.pathname.match(/^\/api\/files\/([a-f0-9]{64})$/);
    if (match && req.method === 'GET') return serveFile(res, match[1]);
    if (url.pathname === '/api/tokens' && req.method === 'GET') {
      const params = { ...pagination(url.searchParams),
        search: url.searchParams.get('q') || url.searchParams.get('search') || '',
        status: url.searchParams.get('status') || 'all',
        owner: url.searchParams.get('owner') || '' };
      const filtered = !!(params.search || params.status !== 'all' || params.owner);
      return json(res, 200, await driver.query(filtered ? 'SearchTokens' : 'ListTokens', params));
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const params = { ...pagination(url.searchParams), id: url.searchParams.get('id') || '',
        actor: url.searchParams.get('actor') || '', action: url.searchParams.get('action') || '' };
      await events.sync();
      return json(res, 200, events.query(params));
    }
    if (url.pathname === '/api/reviews' && req.method === 'POST') {
      const input = await body(req);
      const actor = actorFor(req, input.actor);
      const params = await prepareMint(input);
      return json(res, 201, reviews.submit(actor, params));
    }
    if (url.pathname === '/api/reviews' && req.method === 'GET') {
      const actor = actorFor(req, req.headers['x-actor']);
      const page = pagination(url.searchParams);
      return json(res, 200, reviews.list({ ...page, status: url.searchParams.get('status') || '' },
        actor, reviewers.has(actor)));
    }
    match = url.pathname.match(/^\/api\/reviews\/([a-f0-9-]{36})\/decision$/);
    if (match && req.method === 'POST') {
      const input = await body(req);
      const actor = actorFor(req, input.actor);
      if (!reviewers.has(actor)) throw new HttpError(403, '仅审核员可处理申请');
      return json(res, 200, reviews.decide(match[1], actor, input.decision, input.note,
        config.requireIndependentReview !== false));
    }
    match = url.pathname.match(/^\/api\/tokens\/([^/]+)\/verify$/);
    if (match && (req.method === 'POST' || req.method === 'GET')) {
      const id = decodeURIComponent(match[1]);
      const token = await driver.query('GetToken', { id });
      const expectedHash = String(token.contentHash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new HttpError(400, '资产缺少有效内容哈希');
      const actualHash = req.method === 'POST'
        ? (await digestRequest(req, MAX_FILE_BYTES)).sha256
        : (await files.hashStored(expectedHash)).actualHash;
      return json(res, 200, { id, expectedHash, actualHash, valid: actualHash === expectedHash,
        source: req.method === 'POST' ? 'provided-file' : 'stored-file' });
    }
    match = url.pathname.match(/^\/api\/tokens\/([^/]+)\/metadata$/);
    if (match && req.method === 'GET') {
      const token = await driver.query('GetToken', { id: decodeURIComponent(match[1]) });
      try { JSON.parse(token.metadata); }
      catch { throw new HttpError(500, '资产元数据无效'); }
      const actualHash = crypto.createHash('sha256').update(token.metadata, 'utf8').digest('hex');
      if (token.metadataHash && String(token.metadataHash).toLowerCase() !== actualHash)
        throw new HttpError(409, '资产元数据与登记摘要不一致');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'x-metadata-sha256': actualHash });
      return res.end(token.metadata);
    }
    match = url.pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (match && req.method === 'GET')
      return json(res, 200, await driver.query('GetToken', { id: decodeURIComponent(match[1]) }));
    match = url.pathname.match(/^\/api\/tokens\/([^/]+)\/history$/);
    if (match && req.method === 'GET')
      return json(res, 200, await driver.query('GetHistory', { id: decodeURIComponent(match[1]),
        ...pagination(url.searchParams) }));
    match = url.pathname.match(/^\/api\/balances\/([^/]+)$/);
    if (match && req.method === 'GET')
      return json(res, 200, await driver.query('GetBalance', { address: decodeURIComponent(match[1]) }));
    if (url.pathname === '/api/operators' && req.method === 'GET')
      return json(res, 200, await driver.query('GetOperator', Object.fromEntries(url.searchParams)));
    if (url.pathname === '/api/actions' && req.method === 'POST') {
      const input = await body(req);
      const actor = actorFor(req, input.actor);
      const allowed = new Set(['Mint','Approve','SetApprovalForAll','Transfer','Burn','List','CancelListing','Buy','GrantCredits']);
      if (!allowed.has(input.method) || typeof input.params !== 'object' || !input.params || Array.isArray(input.params))
        throw new HttpError(400, '无效操作');
      const params = input.method === 'Mint' ? await prepareMint(input.params) : input.params;
      const reviewId = input.method === 'Mint' ? params.reviewId : null;
      if (input.method === 'Mint' && config.requireMintReview === true && !reviewId)
        throw new HttpError(403, '铸造需要已批准的审核申请');
      if (reviewId) reviews.assertApproved(reviewId, params);
      const contractParams = { ...params };
      delete contractParams.reviewId;
      const result = await driver.invoke(actor, input.method, contractParams);
      if (reviewId) reviews.markMinted(reviewId, result.txId);
      return json(res, 200, result);
    }
    if (req.method !== 'GET') return apiError(res, 405, '不支持的请求方法');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html','app.js','style.css','art.svg'].includes(name)) return apiError(res, 404, '未找到');
    const mime = { 'index.html':'text/html; charset=utf-8', 'app.js':'text/javascript; charset=utf-8',
      'style.css':'text/css; charset=utf-8', 'art.svg':'image/svg+xml' };
    res.writeHead(200, { 'content-type': mime[name], 'x-content-type-options': 'nosniff' });
    fs.createReadStream(path.join(root, 'web', name)).pipe(res);
  } catch (err) {
    if (!res.headersSent) apiError(res, err.status || 400, err.message || '请求失败');
    else res.destroy();
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
module.exports = { server, host, port, mode };
