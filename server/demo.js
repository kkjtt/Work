const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createDemo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { admin: 'issuer', tokens: {}, order: [], balances: {}, operators: {}, history: {}, audit: [], height: 0 };
  state.audit ||= [];
  state.height ||= 0;
  let activeTxId = '';
  let activeActor = '';
  let activeHeight = 0;
  let activeTimestamp = '';

  const required = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw Error(`${name} 必填`);
    return value.trim();
  };
  const account = (value) => {
    const v = required(value, '地址');
    if (v.length > 128 || /[\/\s]/.test(v)) throw Error('账户地址无效');
    return v;
  };
  const amount = (value) => {
    if (!/^[1-9]\d*$/.test(String(value))) throw Error('请输入正整数');
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw Error('积分超出安全范围');
    return n;
  };
  const getToken = (id) => {
    const token = state.tokens[id];
    if (!token) throw Error('资产不存在');
    return token;
  };
  const live = (id) => {
    const token = getToken(id);
    if (token.burned) throw Error('资产已销毁');
    return token;
  };
  const event = (id, action, from = '', to = '', price = 0, details = {}) => {
    const token = id ? state.tokens[id] : undefined;
    const item = { tokenId: id, assetId: id, action, actor: activeActor, from, to, price,
      txId: activeTxId, eventIndex: 0, blockHeight: activeHeight, timestamp: activeTimestamp,
      orderNonce: token?.orderNonce || 0, expiryHeight: token?.expiryHeight || 0, ...details };
    state.audit.push(item);
    if (id) (state.history[id] ||= []).push(item);
    return activeTxId;
  };
  const record = event;
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const optionalHash = (value, name) => {
    if (value == null || value === '') return '';
    const text = String(value).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(text)) throw Error(`${name} 必须是 SHA-256 十六进制`);
    return text;
  };
  const authorized = (t, actor) =>
    actor === t.owner || actor === t.approved || !!state.operators[t.owner]?.[actor];

  function query(method, params = {}) {
    const id = params.id;
    switch (method) {
      case 'GetAdmin': return state.admin;
      case 'GetBlockHeight': return { height: state.height };
      case 'GetToken': return structuredClone(getToken(id));
      case 'ListTokens': {
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
        return { total: state.order.length, items: state.order.slice(offset, offset + limit).map(i => structuredClone(state.tokens[i])) };
      }
      case 'GetHistory': {
        getToken(id);
        const items = state.history[id] || [];
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
        return { total: items.length, items: structuredClone(items.slice(offset, offset + limit)) };
      }
      case 'GetBalance': {
        const address = account(params.address);
        return { address, balance: state.balances[address] || 0 };
      }
      case 'GetOperator': {
        const owner = account(params.owner);
        const operator = account(params.operator);
        return { owner, operator, approved: !!state.operators[owner]?.[operator] };
      }
      case 'GetEvents': {
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
        const items = state.audit.filter(item =>
          (!params.id || item.tokenId === params.id) &&
          (!params.actor || item.actor === params.actor) &&
          (!params.action || item.action === params.action));
        return { total: items.length, items: structuredClone(items.slice(offset, offset + limit)) };
      }
      case 'SearchTokens': {
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
        const term = String(params.search || params.q || '').trim().toLowerCase();
        const status = String(params.status || 'all');
        const owner = String(params.owner || '');
        const items = state.order.map(key => state.tokens[key]).filter(token => {
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
        return { total: items.length, items: structuredClone(items.slice(offset, offset + limit)) };
      }
      default: throw Error('未知查询方法');
    }
  }

  function invoke(actor, method, p = {}) {
    const before = structuredClone(state);
    const txId = crypto.randomBytes(16).toString('hex');
    activeTxId = txId;
    activeActor = actor;
    activeHeight = state.height + 1;
    activeTimestamp = new Date().toISOString();
    state.height = activeHeight;
    let result;
    try {
      let t, to, price;
      switch (method) {
        case 'Mint': {
          if (actor !== state.admin) throw Error('仅发行方可铸造');
          const id = required(p.id, '资产 ID');
          to = account(p.to);
          if (id.includes('/') || id.length > 128 || state.tokens[id]) throw Error('资产 ID 无效或已使用');
          const metadataRaw = required(p.metadata, '元数据');
          const metadata = JSON.parse(metadataRaw);
          if (!metadata.name || !metadata.image) throw Error('元数据需要 name 和 image');
          const hash = required(p.contentHash, '内容哈希').toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('内容哈希必须是 SHA-256 十六进制');
          const calculatedMetadataHash = digest(metadataRaw);
          const suppliedMetadataHash = optionalHash(p.metadataHash, '元数据哈希');
          if (suppliedMetadataHash && suppliedMetadataHash !== calculatedMetadataHash)
            throw Error('元数据哈希与元数据内容不一致');
          const tokenURI = String(p.tokenURI || '');
          if (tokenURI.length > 2048) throw Error('元数据 URI 过长');
          const licenseHash = optionalHash(p.licenseHash, '许可哈希');
          t = { id, owner: to, creator: actor, metadata: metadataRaw, contentHash: hash,
            metadataHash: calculatedMetadataHash, tokenURI, licenseHash,
            approved: '', burned: false, listed: false, price: 0, orderNonce: 0, expiryHeight: 0 };
          state.tokens[id] = t; state.order.push(id); record(id, 'Mint', '', to); result = t; break;
        }
        case 'Approve':
          t = live(p.id);
          if (actor !== t.owner || p.spender === actor) throw Error('仅所有者可授权其他账户');
          t.approved = p.spender ? account(p.spender) : ''; record(t.id, 'Approve', t.owner, t.approved); result = t; break;
        case 'SetApprovalForAll': {
          const operator = account(p.operator);
          if (operator === actor || !['0', '1'].includes(String(p.approved))) throw Error('授权参数无效');
          (state.operators[actor] ||= {})[operator] = String(p.approved) === '1';
          event('', 'SetApprovalForAll', actor, operator, 0, { approved: String(p.approved) === '1' });
          result = { owner: actor, operator, approved: String(p.approved) }; break;
        }
        case 'Transfer':
          t = live(p.id); to = account(p.to);
          if (to === t.owner || !authorized(t, actor)) throw Error('转移无效或未授权');
          record(t.id, 'Transfer', t.owner, to);
          t.owner = to; t.approved = ''; t.listed = false; t.price = 0; t.expiryHeight = 0;
          result = t; break;
        case 'Burn':
          t = live(p.id);
          if (!authorized(t, actor)) throw Error('未授权销毁');
          t.burned = true; t.approved = ''; t.listed = false; t.price = 0; t.expiryHeight = 0;
          record(t.id, 'Burn', t.owner); result = t; break;
        case 'List':
          t = live(p.id);
          if (actor !== t.owner) throw Error('仅所有者可挂牌');
          price = amount(p.price); t.listed = true; t.price = price;
          if (p.expiryHeight != null && p.expiryHeight !== '') {
            const expiry = String(p.expiryHeight) === '0' ? 0 : amount(p.expiryHeight);
            if (expiry !== 0 && expiry < activeHeight) throw Error('到期区块高度不能小于当前高度');
            t.expiryHeight = expiry;
          } else t.expiryHeight = 0;
          t.orderNonce = (t.orderNonce || 0) + 1;
          record(t.id, 'List', actor, '', price); result = t; break;
        case 'CancelListing':
          t = live(p.id);
          if (actor !== t.owner || !t.listed) throw Error('仅卖方可撤单');
          t.listed = false; t.price = 0; t.expiryHeight = 0;
          record(t.id, 'CancelListing', actor); result = t; break;
        case 'Buy':
          t = live(p.id);
          if (!t.listed || actor === t.owner) throw Error('资产不可购买');
          if (t.expiryHeight && activeHeight > t.expiryHeight) throw Error('报价已过期');
          if (p.expectedSeller && p.expectedSeller !== t.owner) throw Error('卖方已变化');
          if (p.expectedPrice && String(p.expectedPrice) !== String(t.price)) throw Error('挂牌价格已变化');
          if (p.expectedNonce && String(p.expectedNonce) !== String(t.orderNonce || 0)) throw Error('挂牌序号已变化');
          price = t.price;
          if ((state.balances[actor] || 0) < price) throw Error('积分余额不足');
          if (!Number.isSafeInteger((state.balances[t.owner] || 0) + price)) throw Error('卖方余额溢出');
          state.balances[actor] -= price;
          state.balances[t.owner] = (state.balances[t.owner] || 0) + price;
          record(t.id, 'Buy', t.owner, actor, price);
          t.owner = actor; t.approved = ''; t.listed = false; t.price = 0; t.expiryHeight = 0;
          result = t; break;
        case 'GrantCredits':
          if (actor !== state.admin) throw Error('仅发行方可发放测试积分');
          to = account(p.to); price = amount(p.amount);
          if (!Number.isSafeInteger((state.balances[to] || 0) + price)) throw Error('余额溢出');
          state.balances[to] = (state.balances[to] || 0) + price;
          event('', 'GrantCredits', actor, to, 0, { amount: price });
          result = { address: to, balance: state.balances[to] }; break;
        default: throw Error('未知交易方法');
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
      return { data: structuredClone(result), txId, blockHeight: activeHeight, timestamp: activeTimestamp };
    } catch (err) {
      state = before;
      throw err;
    } finally { activeTxId = ''; activeActor = ''; activeHeight = 0; activeTimestamp = ''; }
  }

  return { query, invoke };
}

module.exports = { createDemo };
