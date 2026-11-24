const $ = (id) => document.getElementById(id);
const pageSize = 9;
const maxFileSize = 10 * 1024 * 1024;
let status = { mode: 'demo', profiles: [] };
let tokens = [];
let selected = '';
let selectedToken = null;
let uploadedFile = null;
let page = 0;
let resultTotal = 0;
let assetRequest = 0;
let detailRequest = 0;
let auditOffset = 0;
let auditTotal = 0;
let searchTimer = 0;
let uploadRequest = 0;
let reviewDraft = null;

const fieldsByMethod = {
  Mint: [
    ['id', '资产 ID', 'text', '例如 ART-001'], ['to', '初始持有人地址', 'address'],
    ['name', '作品名称', 'text', '例如 山海之间'], ['image', '图片 URL 或站内路径', 'text', '上传图片后自动填写'],
    ['author', '作者声明', 'text'], ['orgName', '发行机构', 'text'],
    ['description', '作品描述', 'textarea'], ['contentHash', '作品 SHA-256 哈希', 'text', '上传图片后自动填写'],
    ['tokenURI', '元数据 URL（可选）', 'text', '供外部应用读取的持久地址', true],
    ['licenseHash', '许可文本 SHA-256（可选）', 'text', '64 位十六进制', true],
    ['reviewId', '已批准审核申请 ID（可选）', 'text', '从审核列表填入', true]
  ],
  Approve: [['id', '资产 ID', 'text'], ['spender', '授权地址（留空撤销）', 'address', '', true]],
  SetApprovalForAll: [['operator', '操作者地址', 'address'], ['approved', '授权状态', 'select', [['1', '授权'], ['0', '撤销']]]],
  Transfer: [['id', '资产 ID', 'text'], ['to', '接收方地址', 'address']],
  List: [['id', '资产 ID', 'text'], ['price', '挂牌价格（测试积分）', 'number'],
    ['expiryHeight', '截止区块高度（0 为不限期）', 'number', '0', true]],
  CancelListing: [['id', '资产 ID', 'text']],
  Buy: [['id', '资产 ID', 'text'], ['expectedSeller', '预期卖方', 'address', '选择挂牌资产后自动填写', true],
    ['expectedPrice', '预期价格（测试积分）', 'number', '选择挂牌资产后自动填写', true],
    ['expectedNonce', '预期订单序号', 'number', '选择挂牌资产后自动填写', true]],
  Burn: [['id', '资产 ID', 'text']],
  GrantCredits: [['to', '接收方地址', 'address'], ['amount', '发放数量', 'number']]
};

const address = () => status.profiles.find(p => p.alias === $('actor').value)?.address || '';
const profile = () => status.profiles.find(p => p.alias === $('actor').value);
const key = () => status.mode === 'demo' ? profile()?.demoKey : $('apiKey').value;
const field = (name) => $('fields').querySelector(`[name="${name}"]`);
const txLabel = () => status.mode === 'demo' ? '演示交易号' : '链上交易 ID';
const create = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const safeImage = (uri) => {
  try { const u = new URL(uri, location.href); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; }
  catch { return ''; }
};
async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

function renderFields() {
  const method = $('method').value;
  const root = $('fields'); root.replaceChildren(); uploadedFile = null; reviewDraft = null; uploadRequest++;
  $('submitReview').hidden = method !== 'Mint' || $('actor').value === 'issuer';
  if (method === 'Mint') {
    const label = create('label', 'upload-label', '上传作品原件（PNG、JPEG、WebP、SVG，最大 10 MiB）');
    const input = create('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
    input.addEventListener('change', () => uploadSelectedFile(input.files?.[0]));
    label.append(input); root.append(label, create('p', 'field-help', '上传后自动计算 SHA-256，并将图片地址与哈希填入铸造表单。'));
    const msg = create('p', 'upload-message'); msg.id = 'uploadMessage'; msg.setAttribute('role', 'status'); root.append(msg);
  }
  for (const [name, labelText, type, hint, optional] of fieldsByMethod[method]) {
    const label = create('label', '', labelText);
    let input;
    if (type === 'textarea') input = create('textarea');
    else if (type === 'select') {
      input = create('select');
      for (const [value, title] of hint) {
        const option = create('option', '', title); option.value = value; input.append(option);
      }
    } else {
      input = create('input'); input.type = type === 'address' ? 'text' : type;
      if (type === 'number') { input.min = ['expiryHeight', 'expectedNonce'].includes(name) ? '0' : '1'; input.step = '1'; }
      if (typeof hint === 'string') input.placeholder = hint;
    }
    input.name = name;
    input.required = !optional;
    if (name === 'id' && selected) input.value = selected;
    if (name === 'to' && method === 'Mint') input.value = address();
    if (method === 'Buy' && selectedToken?.id === selected) {
      if (name === 'expectedSeller') input.value = selectedToken.owner;
      if (name === 'expectedPrice' && selectedToken.listed) input.value = selectedToken.price;
      if (name === 'expectedNonce' && selectedToken.listed) input.value = selectedToken.orderNonce ?? 0;
    }
    if (name === 'expiryHeight') input.value = '0';
    label.append(input); root.append(label);
  }
  if (method === 'List') {
    const note = create('p', 'field-help', '截止高度必须大于当前区块高度；填 0 表示长期有效。');
    root.append(note);
    api('/api/chain-height').then(({ height }) => {
      if ($('method').value === 'List') note.textContent = `当前区块高度 ${height}；截止高度需大于该值，填 0 表示长期有效。`;
    }).catch(() => {});
  }
  if (method === 'Buy') root.append(create('p', 'field-help', '购买时会核对卖方、价格与订单序号。旧报价变更后将无法成交。'));
}

async function uploadSelectedFile(file) {
  const msg = $('uploadMessage');
  if (!msg || !file) return;
  const request = ++uploadRequest;
  uploadedFile = null;
  msg.className = 'upload-message';
  if (file.size > maxFileSize) { msg.classList.add('error'); msg.textContent = '文件超过 10 MiB'; return; }
  if (!key()) { msg.classList.add('error'); msg.textContent = '请先输入当前身份的 API 密钥'; return; }
  msg.textContent = '正在上传并计算哈希…';
  try {
    const localHash = await sha256(await file.arrayBuffer());
    const result = await api('/api/files', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-actor': $('actor').value,
        'x-api-key': key(), 'x-file-name': encodeURIComponent(file.name) },
      body: file
    });
    if (localHash && localHash !== result.sha256) throw Error('浏览器与服务器计算的哈希不一致');
    if (request !== uploadRequest || $('method').value !== 'Mint') return;
    const uri = result.url || result.uri;
    field('image').value = uri;
    field('contentHash').value = result.sha256;
    uploadedFile = { hash: result.sha256, uri, name: result.name };
    msg.textContent = `${result.name} 已上传 · SHA-256 ${result.sha256}${localHash ? '（浏览器复核一致）' : ''}`;
  } catch (err) { if (request === uploadRequest) { msg.classList.add('error'); msg.textContent = err.message; } }
}

async function loadSummary() {
  const [all, active, listed] = await Promise.all([
    api('/api/tokens?limit=1'), api('/api/tokens?status=active&limit=1'), api('/api/tokens?status=listed&limit=1')
  ]);
  $('totalCount').textContent = all.total;
  $('activeCount').textContent = active.total;
  $('listedCount').textContent = listed.total;
  if (address()) {
    const balance = await api(`/api/balances/${encodeURIComponent(address())}`);
    $('balanceCount').textContent = balance.balance;
  }
}

async function loadAssets() {
  const request = ++assetRequest;
  const params = new URLSearchParams({ offset: String(page * pageSize), limit: String(pageSize) });
  const q = $('search').value.trim();
  const filter = $('filter').value;
  if (q) params.set('q', q);
  if (filter === 'mine') { params.set('status', 'active'); params.set('owner', address()); }
  else if (filter !== 'all') params.set('status', filter);
  const data = await api(`/api/tokens?${params}`);
  if (request !== assetRequest) return;
  tokens = data.items || [];
  resultTotal = Number(data.total) || 0;
  renderAssets();
  const start = resultTotal ? page * pageSize + 1 : 0;
  const end = Math.min((page + 1) * pageSize, resultTotal);
  $('pageInfo').textContent = `${start}–${end} / ${resultTotal} 项资产`;
  $('prevPage').disabled = page === 0;
  $('nextPage').disabled = end >= resultTotal;
}

async function refresh() {
  await Promise.all([loadSummary(), loadAssets()]);
  if (selected) await showDetail(selected);
}

function renderAssets() {
  const grid = $('assetGrid'); grid.replaceChildren();
  $('empty').hidden = tokens.length > 0;
  for (const t of tokens) {
    let meta = {}; try { meta = JSON.parse(t.metadata); } catch {}
    const card = create('article', `asset-card${selected === t.id ? ' selected' : ''}`);
    card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `查看 ${meta.name || t.id}`);
    const visual = create('div', 'asset-image', '◇');
    const image = safeImage(meta.image);
    if (image) {
      visual.textContent = '';
      const img = create('img'); img.src = image; img.alt = meta.name || t.id;
      img.onerror = () => { img.remove(); visual.textContent = '◇'; };
      visual.append(img);
    }
    const badge = create('span', `badge${t.burned ? ' burned' : t.listed ? ' listed' : ''}`,
      t.burned ? '已销毁' : t.listed ? '交易中' : '流通中');
    visual.append(badge); card.append(visual);
    const body = create('div', 'asset-body');
    body.append(create('h3', '', meta.name || t.id), create('div', 'asset-id', `# ${t.id}`), create('div', 'asset-rule'));
    const row = create('div', 'asset-meta');
    row.append(create('span', '', t.listed ? '挂牌价格' : '持有人'),
      create('strong', t.listed ? 'asset-price' : '', t.listed ? `${t.price} 积分` : t.owner));
    body.append(row); card.append(body);
    const pick = () => {
      selected = t.id; selectedToken = t;
      renderAssets(); renderFields(); showDetail(t.id);
      $('console').scrollIntoView({ behavior: 'smooth' });
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    grid.append(card);
  }
}

async function verifyFile(id, localFile, output) {
  output.className = 'verify-result'; output.textContent = '正在计算并核对作品哈希…';
  try {
    const localHash = localFile ? await sha256(await localFile.arrayBuffer()) : '';
    const result = await api(`/api/tokens/${encodeURIComponent(id)}/verify`, localFile
      ? { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: localFile }
      : {});
    const matched = result.valid && (!localHash || localHash === result.actualHash);
    output.classList.add(matched ? 'valid' : 'error');
    output.textContent = `${matched ? '验真通过' : '验真失败'} · 文件 ${result.actualHash} · 链上登记 ${result.expectedHash}`;
  } catch (err) { output.classList.add('error'); output.textContent = err.message; }
}

async function showDetail(id) {
  const request = ++detailRequest;
  const root = $('detail'); root.className = ''; root.replaceChildren(create('div', 'detail-loading', '正在读取资产与履历…'));
  try {
    const [t, h] = await Promise.all([
      api(`/api/tokens/${encodeURIComponent(id)}`),
      api(`/api/tokens/${encodeURIComponent(id)}/history?limit=100`)
    ]);
    if (request !== detailRequest || selected !== id) return;
    selectedToken = t;
    let meta = {}; try { meta = JSON.parse(t.metadata); } catch {}
    root.replaceChildren(create('div', 'detail-title', meta.name || t.id));
    const lines = [
      ['资产 ID', t.id], ['状态', t.burned ? '已销毁' : t.listed ? '交易中' : '流通中'],
      ['持有人', t.owner], ['铸造方', t.creator], ['单项授权', t.approved || '未授权'],
      ['作品 SHA-256', t.contentHash], ['元数据 SHA-256', t.metadataHash || '未登记'],
      ['元数据 URL', t.tokenURI || '未登记'], ['许可 SHA-256', t.licenseHash || '未登记'],
      ['挂牌价格', t.listed ? `${t.price} 测试积分` : '—'],
      ['截止区块', t.listed ? (t.expiryHeight ? String(t.expiryHeight) : '不限期') : '—'],
      ['订单序号', t.listed ? String(t.orderNonce ?? 0) : '—']
    ];
    for (const [name, value] of lines) {
      const row = create('div', 'detail-line'); row.append(create('span', '', name), create('strong', '', value)); root.append(row);
    }
    const verify = create('div', 'verify-box');
    verify.append(create('h4', '', '作品文件验真'),
      create('p', '', '重新计算文件 SHA-256，与资产登记哈希比对。此结果证明文件内容一致，不代表版权归属。'));
    const controls = create('div', 'verify-controls');
    const stored = create('button', 'secondary-button', '核验平台留存文件'); stored.type = 'button';
    const local = create('input'); local.type = 'file'; local.setAttribute('aria-label', '选择本地文件验真');
    const check = create('button', 'secondary-button', '核验所选文件'); check.type = 'button';
    const result = create('p', 'verify-result'); result.setAttribute('role', 'status');
    stored.addEventListener('click', () => verifyFile(id, null, result));
    check.addEventListener('click', () => {
      if (!local.files?.[0]) { result.className = 'verify-result error'; result.textContent = '请先选择文件'; return; }
      verifyFile(id, local.files[0], result);
    });
    controls.append(stored, local, check); verify.append(controls, result); root.append(verify);
    root.append(create('div', 'history-title', `资产操作记录 · ${h.total}`));
    for (const r of [...(h.items || [])].reverse()) {
      const line = create('div', 'history-item');
      line.append(create('strong', '', `${r.action}${r.price ? ` · ${r.price} 积分` : ''}`),
        create('small', '', `${r.from || r.actor || '发行方'} → ${r.to || '—'} · ${txLabel()} ${r.txId || '—'}`));
      root.append(line);
    }
  } catch (err) {
    if (request !== detailRequest) return;
    root.className = 'detail-empty'; root.replaceChildren(create('div', '', err.message));
  }
}

async function loadAudit(reset = false) {
  if (reset) { auditOffset = 0; auditTotal = 0; $('auditList').replaceChildren(); }
  const data = await api(`/api/events?offset=${auditOffset}&limit=20`);
  auditTotal = Number(data.total) || 0;
  if (!auditOffset && !data.items?.length) $('auditList').append(create('p', 'audit-empty', '暂无扩展版审计记录。旧版演示数据可在资产详情中查看历史。'));
  for (const entry of data.items || []) {
    const item = create('article', 'audit-item');
    const title = create('strong', '', `${entry.action || entry.topic || '操作'} · ${entry.assetId || entry.id || entry.tokenId || '系统'}`);
    const note = create('small', '', `${entry.actor || entry.from || '—'} · ${txLabel()} ${entry.txId || '—'}${entry.blockHeight != null ? ` · 区块 ${entry.blockHeight}` : ''}`);
    item.append(title, note); $('auditList').append(item);
  }
  auditOffset += data.items?.length || 0;
  $('auditMore').hidden = auditOffset >= auditTotal;
}

async function buildMintInput(input) {
  const { name, image, author, orgName, description } = input;
  const contentHash = String(input.contentHash || '').toLowerCase();
  if (uploadedFile && uploadedFile.hash !== contentHash) throw Error('当前哈希与已上传文件不一致');
  const formMetadata = JSON.stringify({ name, image, author, orgName, description, seriesHash: contentHash });
  let metadata = formMetadata;
  if (input.reviewId && reviewDraft?.reviewId === input.reviewId) {
    const approved = JSON.parse(reviewDraft.metadata);
    if (approved.name !== name || approved.image !== image || approved.author !== author ||
      approved.orgName !== orgName || approved.description !== description || approved.seriesHash !== contentHash ||
      reviewDraft.assetId !== input.id || reviewDraft.to !== input.to || reviewDraft.tokenURI !== (input.tokenURI || reviewDraft.tokenURI) ||
      reviewDraft.licenseHash !== (input.licenseHash || ''))
      throw Error('铸造参数与批准申请不一致，请重新提交审核');
    metadata = reviewDraft.metadata;
  }
  input.contentHash = contentHash;
  input.metadata = metadata;
  const metadataHash = await sha256(new TextEncoder().encode(metadata));
  if (metadataHash) input.metadataHash = metadataHash;
  for (const name of ['name', 'image', 'author', 'orgName', 'description']) delete input[name];
  if (!input.tokenURI) delete input.tokenURI;
  if (!input.licenseHash) delete input.licenseHash;
  if (!input.reviewId) delete input.reviewId;
  return input;
}

function reviewStatus(state) {
  return { pending: '待审核', approved: '已批准', rejected: '已驳回', minted: '已铸造' }[state] || state;
}

function populateApprovedReview(item) {
  if (!item.metadata) throw Error('审核记录缺少原始元数据');
  const meta = JSON.parse(item.metadata);
  $('method').value = 'Mint'; renderFields();
  for (const [name, value] of Object.entries({
    id: item.assetId, to: item.to, name: meta.name, image: meta.image,
    author: meta.author, orgName: meta.orgName, description: meta.description,
    contentHash: item.contentHash, tokenURI: item.tokenURI, licenseHash: item.licenseHash,
    reviewId: item.reviewId
  })) {
    if (field(name)) field(name).value = value || '';
  }
  reviewDraft = item;
  $('submitReview').hidden = true;
  $('console').scrollIntoView({ behavior: 'smooth' });
  $('formMessage').classList.remove('error');
  $('formMessage').textContent = `已填入审核申请 ${item.reviewId}，请核对后铸造。`;
}

async function decideReview(item, decision, note) {
  const msg = $('reviewMessage'); msg.classList.remove('error'); msg.textContent = '正在提交审核结论…';
  try {
    await api(`/api/reviews/${encodeURIComponent(item.reviewId)}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key() || '' },
      body: JSON.stringify({ actor: $('actor').value, decision, note })
    });
    msg.textContent = decision === 'approve' ? '申请已批准' : '申请已驳回';
    await loadReviews();
  } catch (err) { msg.classList.add('error'); msg.textContent = err.message; }
}

async function loadReviews() {
  const msg = $('reviewMessage');
  if (!key()) {
    $('reviewList').replaceChildren();
    msg.className = 'review-message error'; msg.textContent = '请输入当前身份的 API 密钥以读取审核申请'; return;
  }
  const data = await api('/api/reviews?offset=0&limit=50', {
    headers: { 'x-actor': $('actor').value, 'x-api-key': key() }
  });
  const root = $('reviewList'); root.replaceChildren();
  if (!data.items?.length) { root.append(create('p', 'audit-empty', '当前身份暂无审核申请')); return; }
  for (const item of data.items) {
    const card = create('article', 'review-card');
    const head = create('div', 'review-card-head');
    head.append(create('h3', '', item.name || item.assetId),
      create('span', `review-status ${item.status}`, reviewStatus(item.status)));
    card.append(head,
      create('p', '', `资产 ${item.assetId} · 初始持有人 ${item.to} · 提交人 ${item.submitter}`),
      create('p', '', `作品 SHA-256 ${item.contentHash}`),
      create('p', '', `申请 ID ${item.reviewId}`));
    if (item.note) card.append(create('p', '', `审核备注：${item.note}`));
    if (item.status === 'pending' && item.submitter !== $('actor').value) {
      const actions = create('div', 'review-actions');
      const note = create('input'); note.placeholder = '审核备注（可选）'; note.maxLength = 1000;
      const approve = create('button', 'secondary-button', '批准'); approve.type = 'button';
      const reject = create('button', 'secondary-button', '驳回'); reject.type = 'button';
      approve.addEventListener('click', () => decideReview(item, 'approve', note.value));
      reject.addEventListener('click', () => decideReview(item, 'reject', note.value));
      actions.append(note, approve, reject); card.append(actions);
    }
    if (item.status === 'approved' && item.submitter !== $('actor').value) {
      const actions = create('div', 'review-actions');
      const use = create('button', 'secondary-button', '填入铸造表单'); use.type = 'button';
      use.addEventListener('click', () => {
        try { populateApprovedReview(item); }
        catch (err) { msg.className = 'review-message error'; msg.textContent = err.message; }
      });
      actions.append(use); card.append(actions);
    }
    root.append(card);
  }
  if (data.total > data.items.length) msg.textContent = `显示最近 ${data.items.length} / ${data.total} 条申请`;
}

async function submitReview() {
  if (!$('actionForm').reportValidity()) return;
  const msg = $('reviewMessage'); msg.classList.remove('error'); msg.textContent = '正在提交发行审核…';
  const button = $('submitReview'); button.disabled = true;
  try {
    const input = await buildMintInput(Object.fromEntries(new FormData($('actionForm'))));
    delete input.reviewId;
    const result = await api('/api/reviews', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key() || '' },
      body: JSON.stringify({ actor: $('actor').value, ...input })
    });
    msg.textContent = `审核申请已提交 · ${result.reviewId}`;
    $('reviews').scrollIntoView({ behavior: 'smooth' });
    await loadReviews();
  } catch (err) { msg.classList.add('error'); msg.textContent = err.message; }
  finally { button.disabled = false; }
}

async function submit(event) {
  event.preventDefault();
  const method = $('method').value;
  const input = Object.fromEntries(new FormData($('actionForm')));
  const msg = $('formMessage'); msg.classList.remove('error'); msg.textContent = '正在提交…';
  const submitButton = $('actionForm').querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    if (method === 'Mint') await buildMintInput(input);
    if (method === 'List') input.expiryHeight = input.expiryHeight || '0';
    if (method === 'Buy') {
      const t = await api(`/api/tokens/${encodeURIComponent(input.id)}`);
      if (!t.listed || t.burned) throw Error('该资产当前未挂牌');
      input.expectedSeller ||= t.owner;
      input.expectedPrice ||= String(t.price);
      input.expectedNonce ||= String(t.orderNonce ?? 0);
    }
    const result = await api('/api/actions', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key() || '' },
      body: JSON.stringify({ actor: $('actor').value, method, params: input }) });
    msg.textContent = `操作成功 · ${txLabel()} ${result.txId || '已确认'}`;
    if (input.id) selected = input.id;
    page = 0;
    await refresh();
    await loadAudit(true).catch(showAuditError);
    if (method === 'Mint') await loadReviews().catch(() => {});
  } catch (err) { msg.classList.add('error'); msg.textContent = err.message; }
  finally { submitButton.disabled = false; }
}

function showError(err) { $('formMessage').classList.add('error'); $('formMessage').textContent = err.message; }
function showAuditError(err) { $('auditList').replaceChildren(create('p', 'audit-empty', `审计记录暂不可用：${err.message}`)); $('auditMore').hidden = true; }
function showReviewError(err) { $('reviewMessage').className = 'review-message error'; $('reviewMessage').textContent = err.message; }
function scheduleAssets() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 0; loadAssets().catch(showError); }, 250);
}

async function init() {
  try {
    status = await api('/api/status');
    $('modeLabel').textContent = status.mode === 'demo' ? '本地演示模式' : '长安链连接待验证';
    $('modeSubLabel').textContent = status.mode === 'demo' ? '交易号为本地模拟' : '等待真实链查询';
    $('operationHint').textContent = status.mode === 'demo' ? '本地模拟账户提交，数据保存在演示文件' : '由服务端证书账户签名并提交';
    $('apiKey').hidden = status.mode === 'demo';
    const actor = $('actor'); actor.replaceChildren();
    for (const p of status.profiles) {
      const option = create('option', '', `${p.alias} · ${p.address}`); option.value = p.alias; actor.append(option);
    }
    actor.addEventListener('change', () => {
      if (status.mode !== 'demo') $('apiKey').value = '';
      page = 0; refresh().catch(showError); renderFields(); loadReviews().catch(showReviewError);
    });
    $('apiKey').addEventListener('change', () => loadReviews().catch(showReviewError));
    $('method').addEventListener('change', renderFields);
    $('search').addEventListener('input', scheduleAssets);
    $('filter').addEventListener('change', scheduleAssets);
    $('prevPage').addEventListener('click', () => { if (page > 0) { page--; loadAssets().catch(showError); } });
    $('nextPage').addEventListener('click', () => { if ((page + 1) * pageSize < resultTotal) { page++; loadAssets().catch(showError); } });
    $('auditMore').addEventListener('click', () => loadAudit().catch(showAuditError));
    $('reviewRefresh').addEventListener('click', () => loadReviews().catch(showReviewError));
    $('submitReview').addEventListener('click', submitReview);
    $('actionForm').addEventListener('submit', submit);
    $('goMint').addEventListener('click', () => { $('method').value = 'Mint'; renderFields(); $('console').scrollIntoView({ behavior: 'smooth' }); });
    renderFields(); await refresh();
    if (status.mode === 'chainmaker') { $('modeLabel').textContent = '长安链已连接'; $('modeSubLabel').textContent = '链上查询已响应'; }
    await loadAudit(true).catch(showAuditError);
    await loadReviews().catch(showReviewError);
  } catch (err) { showError(err); }
}
init();
