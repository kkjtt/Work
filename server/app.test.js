const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('uploaded artwork can be minted, queried and independently verified', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nft-http-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const configFile = path.join(temporary, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    mode: 'demo', dataFile: path.join(temporary, 'state.json'),
    uploadDir: path.join(temporary, 'objects'), eventIndexFile: path.join(temporary, 'events.json'),
    reviewFile: path.join(temporary, 'reviews.json'), reviewers: ['issuer'], requireMintReview: true,
    profiles: { issuer: { address: 'issuer', apiKey: 'test-issuer' },
      alice: { address: 'alice', apiKey: 'test-alice' } }
  }));
  process.env.NFT_CONFIG = configFile;
  const { server } = require('./app');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const art = fs.readFileSync(path.join(__dirname, '../web/art.svg'));
  const expectedHash = crypto.createHash('sha256').update(art).digest('hex');

  const unauthorized = await fetch(`${base}/api/files`, { method: 'POST',
    headers: { 'x-actor': 'issuer', 'x-file-name': 'art.svg', 'content-type': 'image/svg+xml' }, body: art });
  assert.equal(unauthorized.status, 401);

  const uploadedResponse = await fetch(`${base}/api/files`, { method: 'POST',
    headers: { 'x-actor': 'issuer', 'x-api-key': 'test-issuer',
      'x-file-name': encodeURIComponent('山海之间.svg'), 'content-type': 'image/svg+xml' }, body: art });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json();
  assert.equal(uploaded.sha256, expectedHash);
  assert.equal(uploaded.mimeType, 'image/svg+xml');
  assert.equal(uploaded.uri, `/api/files/${expectedHash}`);
  const downloaded = await fetch(`${base}${uploaded.uri}`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), art);

  const params = { id: 'ART-EXT-1', to: 'alice',
    metadata: JSON.stringify({ name: '山海之间', image: uploaded.uri }), contentHash: uploaded.sha256 };
  const mintRequest = { actor: 'issuer', method: 'Mint', params };
  const storedFile = path.join(temporary, 'objects', expectedHash);
  fs.writeFileSync(storedFile, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const tamperedMint = await fetch(`${base}/api/actions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-issuer' },
    body: JSON.stringify(mintRequest) });
  assert.equal(tamperedMint.status, 409);
  fs.writeFileSync(storedFile, art);
  const withoutReview = await fetch(`${base}/api/actions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-issuer' },
    body: JSON.stringify(mintRequest) });
  assert.equal(withoutReview.status, 403);
  const submitted = await fetch(`${base}/api/reviews`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-alice' },
    body: JSON.stringify({ actor: 'alice', ...params }) });
  assert.equal(submitted.status, 201);
  const review = await submitted.json();
  assert.equal(review.status, 'pending');
  assert.equal(review.metadata, params.metadata);
  const decided = await fetch(`${base}/api/reviews/${review.reviewId}/decision`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-issuer' },
    body: JSON.stringify({ actor: 'issuer', decision: 'approve', note: '通过' }) });
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).status, 'approved');
  const minted = await fetch(`${base}/api/actions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-issuer' },
    body: JSON.stringify({ ...mintRequest, params: { ...params, reviewId: review.reviewId } }) });
  assert.equal(minted.status, 200, await minted.text());
  const reviewList = await (await fetch(`${base}/api/reviews?status=minted`,
    { headers: { 'x-actor': 'alice', 'x-api-key': 'test-alice' } })).json();
  assert.equal(reviewList.total, 1);
  assert.equal(reviewList.items[0].reviewId, review.reviewId);
  const token = await (await fetch(`${base}/api/tokens/ART-EXT-1`)).json();
  assert.equal(token.contentHash, expectedHash);
  assert.equal(token.metadataHash, crypto.createHash('sha256').update(params.metadata).digest('hex'));
  assert.equal(token.tokenURI, '/api/tokens/ART-EXT-1/metadata');
  const metadataResponse = await fetch(`${base}${token.tokenURI}`);
  const metadataRaw = await metadataResponse.text();
  assert.equal(crypto.createHash('sha256').update(metadataRaw).digest('hex'), token.metadataHash);
  const metadata = JSON.parse(metadataRaw);
  assert.equal(metadata.name, '山海之间');

  const verified = await (await fetch(`${base}/api/tokens/ART-EXT-1/verify`)).json();
  assert.equal(verified.valid, true);
  const changed = Buffer.from(art);
  changed[changed.length - 2] ^= 1;
  const checked = await (await fetch(`${base}/api/tokens/ART-EXT-1/verify`,
    { method: 'POST', body: changed })).json();
  assert.equal(checked.valid, false);

  const search = await (await fetch(`${base}/api/tokens?q=山海&status=active&limit=1`)).json();
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, 'ART-EXT-1');
  const events = await (await fetch(`${base}/api/events?limit=1`)).json();
  assert.equal(events.total, 1);
  assert.equal(events.items[0].action, 'Mint');
  assert.equal(events.source, 'demo-contract-state');
  const height = await (await fetch(`${base}/api/chain-height`)).json();
  assert.equal(height.height, 1);
});

test('file store rejects unsupported and active SVG content', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nft-files-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { detectMime, HttpError } = require('./file-store');
  assert.throws(() => detectMime(Buffer.from('plain text')), HttpError);
  assert.throws(() => detectMime(Buffer.from('<svg><script>alert(1)</script></svg>')), HttpError);
});

test('contract event projection resumes from a durable checkpoint without duplicates', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nft-index-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'events.json');
  const { EventIndex } = require('./event-index');
  const ledger = [
    { tokenId: 'A', action: 'Mint', actor: 'issuer', txId: 'tx-1' },
    { assetId: 'A', action: 'List', actor: 'alice', txId: 'tx-2' }
  ];
  const driver = { async query(method, params) {
    assert.equal(method, 'GetEvents');
    const offset = Number(params.offset);
    const limit = Number(params.limit);
    return { total: ledger.length, items: ledger.slice(offset, offset + limit) };
  } };
  const first = new EventIndex(file, driver, 'demo');
  await first.sync();
  assert.equal(first.query().total, 2);
  assert.equal(first.query().items[0].txId, 'tx-2');
  assert.equal(first.query().items[0].tokenId, 'A');
  ledger.push({ tokenId: 'A', action: 'Buy', actor: 'bob', txId: 'tx-3' });
  const restarted = new EventIndex(file, driver, 'demo');
  await restarted.sync();
  assert.equal(restarted.query().total, 3);
  assert.equal(restarted.query({ action: 'Buy' }).items[0].index, 2);
  await restarted.sync();
  assert.equal(restarted.query().total, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).checkpoint, 3);
  const differentScope = new EventIndex(file, driver, 'demo', 'another-ledger');
  assert.equal(differentScope.query().total, 0);
  await differentScope.sync();
  assert.equal(differentScope.query().total, 3);
  ledger[2] = { tokenId: 'B', action: 'Burn', actor: 'alice', txId: 'tx-new' };
  await differentScope.sync();
  assert.equal(differentScope.query().items[0].txId, 'tx-new');
});
