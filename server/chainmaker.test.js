const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChainMaker } = require('./chainmaker');

test('real-chain adapter filters paged contract tokens without changing chain responses', async () => {
  const sdkPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sdk-stub-'));
  try {
    fs.writeFileSync(path.join(sdkPath, 'index.js'), `
      class Sdk {
        constructor() {
          this.callUserContract = {
            queryContract: async ({ method, params }) => {
              let data;
              if (method === 'ListTokens') {
                const tokens = [
                  { id: 'A', owner: 'alice', listed: true, burned: false, metadata: '{"name":"山海之间"}' },
                  { id: 'B', owner: 'bob', listed: false, burned: true, metadata: '{"name":"旧作"}' }
                ];
                data = { total: tokens.length, items: tokens.slice(Number(params.offset), Number(params.offset) + Number(params.limit)) };
              } else if (method === 'GetBlockHeight') data = { height: 42 };
              else data = { total: 0, items: [] };
              return { code: 0, contractResult: { code: 0, result: Buffer.from(JSON.stringify(data)) } };
            }
          };
        }
      }
      module.exports = { Sdk };
    `);
    const driver = createChainMaker({ sdkPath, chainId: 'chain1', contractName: 'nft_market',
      nodes: [{ nodeAddr: '127.0.0.1:12301', tlsEnable: false }],
      profiles: { issuer: { orgId: 'org1', signKey: 'key', signCert: 'cert' } } });
    const listed = await driver.query('SearchTokens', { search: '山海', status: 'listed' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, 'A');
    const burned = await driver.query('SearchTokens', { status: 'burned' });
    assert.equal(burned.total, 1);
    assert.equal(burned.items[0].id, 'B');
    assert.deepEqual(await driver.query('GetBlockHeight'), { height: 42 });
  } finally {
    fs.rmSync(sdkPath, { recursive: true, force: true });
  }
});
