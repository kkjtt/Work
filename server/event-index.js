const fs = require('node:fs');
const path = require('node:path');

// This is a checkpointed projection of GetEvents contract state. It is not a
// node-wide event subscription, so it only indexes this application's contract.
class EventIndex {
  constructor(file, driver, mode, scope = '') {
    this.file = path.resolve(file);
    this.driver = driver;
    this.source = mode === 'chainmaker' ? 'chainmaker-contract-state' : 'demo-contract-state';
    this.scope = String(scope);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = saved.version === 3 && saved.source === this.source && saved.scope === this.scope &&
        Number.isSafeInteger(saved.checkpoint) && Array.isArray(saved.items)
        ? saved : this.empty();
    } catch { this.state = this.empty(); }
    this.syncing = null;
  }

  empty() { return { version: 3, source: this.source, scope: this.scope, checkpoint: 0, items: [] }; }

  persist() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state));
    fs.renameSync(temporary, this.file);
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async doSync() {
    const head = await this.driver.query('GetEvents', { offset: '0', limit: '1' });
    const total = Number(head.total);
    if (!Number.isSafeInteger(total) || total < 0) throw Error('事件总数无效');
    if (total < this.state.checkpoint || this.state.items.length !== this.state.checkpoint) {
      this.state = this.empty();
      this.persist();
    }
    if (this.state.checkpoint > 0) {
      const offset = this.state.checkpoint - 1;
      const tail = await this.driver.query('GetEvents', { offset: String(offset), limit: '1' });
      const known = this.state.items[offset];
      const current = tail.items?.[0];
      if (!current || current.txId !== known.txId || current.action !== known.action ||
          String(current.tokenId || current.assetId || current.id || '') !== known.tokenId) {
        this.state = this.empty();
        this.persist();
      }
    }
    while (this.state.checkpoint < total) {
      const offset = this.state.checkpoint;
      const page = await this.driver.query('GetEvents', { offset: String(offset), limit: '100' });
      if (!Array.isArray(page.items) || page.items.length === 0) throw Error('事件索引同步中断');
      for (const [i, item] of page.items.entries()) {
        const tokenId = String(item.tokenId || item.assetId || item.id || '');
        this.state.items.push({ ...item, index: offset + i, id: tokenId, tokenId,
          source: this.source });
      }
      this.state.checkpoint += page.items.length;
      this.persist();
    }
    return this.state.checkpoint;
  }

  query(params = {}) {
    const offset = Math.max(0, Number(params.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const items = this.state.items.filter(item =>
      (!params.id || item.tokenId === params.id) &&
      (!params.actor || item.actor === params.actor) &&
      (!params.action || item.action === params.action));
    return { total: items.length, items: items.reverse().slice(offset, offset + limit),
      source: this.source, checkpoint: this.state.checkpoint };
  }
}

module.exports = { EventIndex };
