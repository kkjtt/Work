const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalName(value) {
  let decoded;
  try { decoded = decodeURIComponent(String(value || '')); }
  catch { throw new HttpError(400, '文件名编码无效'); }
  const name = path.basename(decoded.replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!name || Buffer.byteLength(name, 'utf8') > 180) throw new HttpError(400, '文件名无效或过长');
  return name;
}

function detectMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  const svg = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml\s[^>]*>\s*)?<svg[\s>]/i.test(svg)) {
    if (/<\s*(?:script|foreignObject|iframe|object|embed|!DOCTYPE|!ENTITY)\b/i.test(svg) ||
      /\bon[a-z]+\s*=|javascript\s*:/i.test(svg))
      throw new HttpError(415, 'SVG 包含不允许的活动内容');
    return 'image/svg+xml';
  }
  throw new HttpError(415, '仅支持 PNG、JPEG、WebP 和安全 SVG 图片');
}

async function digestRequest(req, maxBytes = MAX_FILE_BYTES, sink) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, '文件超过 10 MiB 限制');
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, '文件超过 10 MiB 限制');
    hash.update(chunk);
    if (sink) await sink(chunk);
  }
  if (size === 0) throw new HttpError(400, '文件不能为空');
  return { sha256: hash.digest('hex'), size };
}

class FileStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
  }

  filePath(sha256) {
    if (!HASH_PATTERN.test(String(sha256))) throw new HttpError(400, '文件摘要格式无效');
    return path.join(this.directory, sha256);
  }

  async put(req, encodedName) {
    const name = normalName(encodedName);
    const temporary = path.join(this.directory, `.upload-${process.pid}-${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      const result = await digestRequest(req, MAX_FILE_BYTES, async chunk => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error('文件写入失败');
          offset += bytesWritten;
        }
      });
      await handle.sync();
      await handle.close();
      const bytes = await fs.promises.readFile(temporary);
      const mimeType = detectMime(bytes);
      const target = this.filePath(result.sha256);
      if (fs.existsSync(target)) await fs.promises.unlink(temporary);
      else await fs.promises.rename(temporary, target);
      const metadata = { name, size: result.size, mimeType, sha256: result.sha256 };
      try {
        await fs.promises.writeFile(`${target}.json`, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      } catch (err) { if (err.code !== 'EEXIST') throw err; }
      return { ...metadata, mime: mimeType, uri: `/api/files/${result.sha256}`,
        url: `/api/files/${result.sha256}` };
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
      throw err;
    }
  }

  get(sha256) {
    const target = this.filePath(sha256);
    if (!fs.existsSync(target)) throw new HttpError(404, '文件不存在');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(`${target}.json`, 'utf8')); }
    catch { throw new HttpError(500, '文件元数据缺失'); }
    return { ...metadata, path: target, size: fs.statSync(target).size };
  }

  async hashStored(sha256) {
    const file = this.get(sha256);
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file.path)) digest.update(chunk);
    return { file, actualHash: digest.digest('hex') };
  }
}

module.exports = { FileStore, HttpError, MAX_FILE_BYTES, digestRequest, detectMime };
