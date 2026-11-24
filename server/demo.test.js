const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDemo } = require('./demo');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nft-'));
  return { driver: createDemo(path.join(dir, 'state.json')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../web/art.svg'))).digest('hex');
const mint = (driver, id = 'ART-1') => driver.invoke('issuer', 'Mint', {
  id, to: 'alice', metadata: JSON.stringify({ name: '测试作品', image: 'https://example.com/art.png' }), contentHash: hash
});

test('mint, approve, transfer, list, buy and burn lifecycle', () => {
  const { driver, cleanup } = fixture();
  try {
    const minted = mint(driver);
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'alice');
    assert.equal(driver.query('GetHistory', { id: 'ART-1' }).items[0].txId, minted.txId);
    assert.throws(() => driver.invoke('bob', 'Transfer', { id: 'ART-1', to: 'bob' }), /未授权/);
    driver.invoke('alice', 'Approve', { id: 'ART-1', spender: 'bob' });
    driver.invoke('bob', 'Transfer', { id: 'ART-1', to: 'bob' });
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).approved, '');
    driver.invoke('bob', 'List', { id: 'ART-1', price: '50' });
    assert.throws(() => driver.invoke('alice', 'Buy', { id: 'ART-1' }), /余额不足/);
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'bob');
    driver.invoke('issuer', 'GrantCredits', { to: 'alice', amount: '50' });
    driver.invoke('alice', 'Buy', { id: 'ART-1' });
    assert.equal(driver.query('GetBalance', { address: 'alice' }).balance, 0);
    assert.equal(driver.query('GetBalance', { address: 'bob' }).balance, 50);
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'alice');
    driver.invoke('alice', 'Burn', { id: 'ART-1' });
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).burned, true);
    assert.throws(() => mint(driver), /已使用/);
    assert.equal(driver.query('GetHistory', { id: 'ART-1' }).total, 6);
  } finally { cleanup(); }
});

test('operator authorization and listing invalidation', () => {
  const { driver, cleanup } = fixture();
  try {
    mint(driver);
    driver.invoke('alice', 'SetApprovalForAll', { operator: 'bob', approved: '1' });
    assert.equal(driver.query('GetOperator', { owner: 'alice', operator: 'bob' }).approved, true);
    driver.invoke('alice', 'List', { id: 'ART-1', price: '10' });
    driver.invoke('bob', 'Transfer', { id: 'ART-1', to: 'issuer' });
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).listed, false);
    assert.throws(() => driver.invoke('alice', 'Buy', { id: 'ART-1' }), /不可购买/);
  } finally { cleanup(); }
});

test('only issuer can mint or issue demo credits', () => {
  const { driver, cleanup } = fixture();
  try {
    assert.throws(() => driver.invoke('alice', 'Mint', { id: 'x' }), /发行方/);
    assert.throws(() => driver.invoke('bob', 'GrantCredits', { to: 'bob', amount: '100' }), /发行方/);
    assert.equal(driver.query('ListTokens').total, 0);
  } finally { cleanup(); }
});

test('mint stores a reproducible metadata digest and exposes searchable audit records', () => {
  const { driver, cleanup } = fixture();
  try {
    const metadata = '{ "name": "山海之间", "image": "https://example.com/art.svg", "author": "测试作者" }';
    const metadataHash = crypto.createHash('sha256').update(metadata).digest('hex');
    const minted = driver.invoke('issuer', 'Mint', {
      id: '作品-001', to: 'alice', metadata, contentHash: hash,
      metadataHash, tokenURI: 'https://example.com/作品-001.json', licenseHash: hash
    });
    const token = driver.query('GetToken', { id: '作品-001' });
    assert.equal(token.metadataHash, metadataHash);
    assert.equal(token.metadata, metadata);
    assert.equal(token.tokenURI, 'https://example.com/作品-001.json');
    assert.equal(driver.query('SearchTokens', { search: '山海', status: 'active' }).total, 1);
    assert.equal(driver.query('SearchTokens', { status: 'burned' }).total, 0);
    const audit = driver.query('GetEvents', { id: '作品-001' });
    assert.equal(audit.total, 1);
    assert.equal(audit.items[0].actor, 'issuer');
    assert.equal(audit.items[0].txId, minted.txId);
    assert.equal(audit.items[0].blockHeight, 1);
    assert.throws(() => driver.invoke('issuer', 'Mint', {
      id: '作品-002', to: 'alice', metadata, contentHash: hash, metadataHash: 'a'.repeat(64)
    }), /元数据哈希/);
    assert.equal(driver.query('GetBlockHeight').height, 1);
  } finally { cleanup(); }
});

test('stale or expired quotations cannot move assets or credits', () => {
  const { driver, cleanup } = fixture();
  try {
    mint(driver);
    driver.invoke('issuer', 'GrantCredits', { to: 'bob', amount: '100' });
    const listed = driver.invoke('alice', 'List', { id: 'ART-1', price: '50', expiryHeight: '5' }).data;
    assert.equal(listed.orderNonce, 1);
    assert.throws(() => driver.invoke('bob', 'Buy', {
      id: 'ART-1', expectedSeller: 'alice', expectedPrice: '40', expectedNonce: '1'
    }), /价格已变化/);
    assert.equal(driver.query('GetBlockHeight').height, 3);
    driver.invoke('alice', 'List', { id: 'ART-1', price: '60' });
    assert.throws(() => driver.invoke('bob', 'Buy', {
      id: 'ART-1', expectedSeller: 'alice', expectedPrice: '60', expectedNonce: '1'
    }), /序号已变化/);
    assert.equal(driver.query('GetBalance', { address: 'bob' }).balance, 100);
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'alice');
    driver.invoke('bob', 'Buy', {
      id: 'ART-1', expectedSeller: 'alice', expectedPrice: '60', expectedNonce: '2'
    });
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'bob');
    assert.equal(driver.query('GetBalance', { address: 'bob' }).balance, 40);
  } finally { cleanup(); }
});

test('expired listing is rejected at the next block', () => {
  const { driver, cleanup } = fixture();
  try {
    mint(driver);
    driver.invoke('issuer', 'GrantCredits', { to: 'bob', amount: '100' });
    driver.invoke('alice', 'List', { id: 'ART-1', price: '50', expiryHeight: '4' });
    driver.invoke('issuer', 'GrantCredits', { to: 'issuer', amount: '1' });
    assert.throws(() => driver.invoke('bob', 'Buy', {
      id: 'ART-1', expectedSeller: 'alice', expectedPrice: '50', expectedNonce: '1'
    }), /已过期/);
    assert.equal(driver.query('GetToken', { id: 'ART-1' }).owner, 'alice');
    assert.equal(driver.query('GetBalance', { address: 'bob' }).balance, 100);
  } finally { cleanup(); }
});
