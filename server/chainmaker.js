const fs = require('node:fs');
const path = require('node:path');

// This adapter uses the official ChainMaker Node SDK's documented
// invokeUserContract/queryContract APIs for DOCKER_GO contracts.
function createChainMaker(config) {
  const sdkPath = path.resolve(config.sdkPath);
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const { Sdk } = require(sdkPath);
  // The published v2.0.0 SDK sets this process-wide value at import time.
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
  const clients = {};
  for (const [alias, profile] of Object.entries(config.profiles)) {
    const nodeConfig = config.nodes.map(n => ({
      nodeAddr: n.nodeAddr,
      tlsEnable: n.tlsEnable !== false,
      options: n.tlsEnable === false ? undefined : {
        pem: fs.readFileSync(n.ca),
        clientKey: fs.readFileSync(profile.tlsKey),
        clientCert: fs.readFileSync(profile.tlsCert),
        hostName: n.hostName || 'chainmaker.org'
      }
    }));
    clients[alias] = new Sdk(config.chainId, profile.orgId,
      profile.signKey, profile.signCert, nodeConfig, config.timeoutMs || 30000);
  }

  const unpack = (value) => {
    const r = value?.contractResult || value;
    if (!r || typeof r !== 'object') throw Error('链上未返回合约结果');
    if (r.code && r.code !== 0) throw Error(r.message || `合约失败: ${r.code}`);
    let bytes = r.result;
    if (bytes == null) throw Error('链上结果为空');
    if (typeof bytes === 'string') bytes = Buffer.from(bytes, 'base64');
    else bytes = Buffer.from(bytes);
    return JSON.parse(bytes.toString('utf8'));
  };
  const ensureSuccess = (res) => {
    if (res?.code !== 0) throw Error(res?.message || '长安链交易失败');
    if (res?.contractResult === 'error') throw Error('等待长安链交易确认超时');
    if (res?.contractResult && res.contractResult.code !== 0)
      throw Error(res.contractResult.message || '合约执行失败');
    return res;
  };

  async function queryContract(method, params = {}) {
    const sdk = clients[Object.keys(clients)[0]];
    const res = await sdk.callUserContract.queryContract({
      contractName: config.contractName, method, params
    });
    ensureSuccess(res);
    return unpack(res);
  }

  async function searchTokens(params) {
    const all = [];
    let cursor = 0;
    for (;;) {
      const page = await queryContract('ListTokens', { offset: String(cursor), limit: '100' });
      if (!Array.isArray(page.items) || !page.items.length) break;
      all.push(...page.items);
      cursor += page.items.length;
      if (cursor >= Number(page.total)) break;
    }
    const term = String(params.search || params.q || '').trim().toLowerCase();
    const status = String(params.status || 'all');
    const owner = String(params.owner || '');
    const matches = all.filter(token => {
      let meta = {}; try { meta = JSON.parse(token.metadata); } catch {}
      const found = !term || [token.id, token.owner, meta.name, meta.author, meta.orgName]
        .some(value => String(value || '').toLowerCase().includes(term));
      const matchStatus = status === 'all' ||
        (status === 'listed' && token.listed && !token.burned) ||
        (status === 'active' && !token.burned) ||
        (status === 'burned' && token.burned) ||
        (status === 'mine' && token.owner === owner && !token.burned);
      return found && matchStatus && (!owner || status === 'mine' || token.owner === owner);
    });
    const offset = Math.max(0, Number(params.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    return { total: matches.length, items: matches.slice(offset, offset + limit) };
  }

  return {
    async query(method, params = {}) {
      if (method === 'SearchTokens') return searchTokens(params);
      return queryContract(method, params);
    },
    async invoke(actor, method, params = {}) {
      const sdk = clients[actor];
      if (!sdk) throw Error('未知账户');
      const res = await sdk.callUserContract.invokeUserContract({
        contractName: config.contractName, method, params, withSyncResult: true
      });
      ensureSuccess(res);
      return { data: unpack(res), txId: res.txId };
    }
  };
}

module.exports = { createChainMaker };
