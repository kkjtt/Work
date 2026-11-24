const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./file-store');

// Review is an API-gateway business workflow. The contract still enforces
// issuer and owner rules independently; direct chain calls bypass this queue.
class ReviewStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = saved.version === 1 && Array.isArray(saved.items) ? saved : this.empty();
    } catch { this.state = this.empty(); }
  }

  empty() { return { version: 1, items: [] }; }

  persist() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  submit(actor, params) {
    if (!params.id || !params.to || !/^[a-f0-9]{64}$/.test(String(params.contentHash || '').toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(String(params.metadataHash || '').toLowerCase()))
      throw new HttpError(400, '审核申请缺少有效资产参数');
    if (this.state.items.some(item => item.assetId === params.id &&
      ['pending', 'approved', 'minted'].includes(item.status)))
      throw new HttpError(409, '该资产已有待处理或已完成的审核申请');
    let metadata;
    try { metadata = JSON.parse(params.metadata); }
    catch { throw new HttpError(400, '元数据 JSON 格式无效'); }
    const item = {
      reviewId: crypto.randomUUID(), assetId: params.id, to: params.to,
      name: String(metadata.name || ''), metadata: params.metadata,
      contentHash: String(params.contentHash).toLowerCase(),
      metadataHash: String(params.metadataHash).toLowerCase(),
      tokenURI: params.tokenURI, licenseHash: params.licenseHash || '',
      submitter: actor, status: 'pending', createdAt: new Date().toISOString(),
      decisionAt: null, reviewer: null, note: '', txId: null
    };
    this.state.items.push(item);
    this.persist();
    return structuredClone(item);
  }

  get(reviewId) {
    const item = this.state.items.find(entry => entry.reviewId === reviewId);
    if (!item) throw new HttpError(404, '审核申请不存在');
    return item;
  }

  list(params, actor, canReview) {
    const offset = Math.max(0, Number(params.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const items = this.state.items.filter(item =>
      (canReview || item.submitter === actor) &&
      (!params.status || item.status === params.status));
    return { total: items.length, items: structuredClone(items.slice().reverse().slice(offset, offset + limit)) };
  }

  decide(reviewId, reviewer, decision, note, independent = true) {
    const item = this.get(reviewId);
    if (item.status !== 'pending') throw new HttpError(409, '审核申请已处理');
    if (independent && item.submitter === reviewer) throw new HttpError(403, '不能审核自己提交的申请');
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, '审核结论无效');
    if (String(note || '').length > 1000) throw new HttpError(400, '审核备注过长');
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    item.reviewer = reviewer;
    item.note = String(note || '');
    item.decisionAt = new Date().toISOString();
    this.persist();
    return structuredClone(item);
  }

  assertApproved(reviewId, params) {
    const item = this.get(reviewId);
    if (item.status !== 'approved') throw new HttpError(409, '审核申请尚未批准');
    if (item.assetId !== params.id || item.to !== params.to ||
      item.contentHash !== String(params.contentHash || '').toLowerCase() ||
      item.metadataHash !== String(params.metadataHash || '').toLowerCase() ||
      item.tokenURI !== params.tokenURI || item.licenseHash !== (params.licenseHash || ''))
      throw new HttpError(409, '铸造参数与批准申请不一致');
    return item;
  }

  markMinted(reviewId, txId) {
    const item = this.get(reviewId);
    if (item.status !== 'approved') throw new HttpError(409, '审核申请状态无效');
    item.status = 'minted';
    item.txId = txId || null;
    item.mintedAt = new Date().toISOString();
    this.persist();
    return structuredClone(item);
  }
}

module.exports = { ReviewStore };
