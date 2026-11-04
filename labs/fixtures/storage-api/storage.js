'use strict';
/**
 * Minimal storage clients for the lab workload. They sign real requests with
 * node:crypto (AWS Signature Version 4 for S3, Shared Key for Azure Blob) so
 * the fixture needs no dependencies and builds without network access.
 * Only PUT and GET of one object are implemented: the storage check needs nothing else.
 */
const crypto = require('node:crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function amzDates(now) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

/** Path-style S3 request headers signed with Signature Version 4. */
function signS3({ method, url, body = '', accessKeyId, secretAccessKey, region, now = new Date() }) {
  const { amzDate, date } = amzDates(now);
  const payloadHash = sha256(body);
  const host = url.host;
  const canonicalUri = url.pathname.split('/').map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = ['s3', 'aws4_request'].reduce((key, part) => hmac(key, part), hmac(hmac(`AWS4${secretAccessKey}`, date), region));
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Shared Key authorization for the Blob service. With the emulator's path-style
 * URLs the account name appears twice in the canonicalized resource.
 */
function signBlob({ method, url, headers, account, accountKey }) {
  const header = (name) => headers[name] ?? '';
  const length = header('content-length') === '0' ? '' : header('content-length');
  const msHeaders = Object.keys(headers).filter((name) => name.startsWith('x-ms-')).sort()
    .map((name) => `${name}:${headers[name]}\n`).join('');
  const query = [...url.searchParams.keys()].sort().map((name) => `\n${name.toLowerCase()}:${url.searchParams.get(name)}`).join('');
  const stringToSign = [
    method, header('content-encoding'), header('content-language'), length, header('content-md5'), header('content-type'),
    '', '', '', '', '', header('range'),
  ].join('\n') + '\n' + msHeaders + `/${account}${url.pathname}` + query;
  const signature = crypto.createHmac('sha256', Buffer.from(accountKey, 'base64')).update(stringToSign, 'utf8').digest('base64');
  return `SharedKey ${account}:${signature}`;
}

/** Text of a provider error response, reduced to its code and message. */
function providerError(status, text) {
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${status}`;
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]?.split('\n')[0] ?? 'Request failed';
  return `${code}: ${message}`;
}

async function request(url, init, timeoutMs) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(providerError(response.status, text));
    error.status = response.status;
    throw error;
  }
  return text;
}

function createS3Client({ endpoint, accessKeyId, secretAccessKey, region, timeoutMs = 5000 }) {
  const objectUrl = (namespace, key) => new URL(`${endpoint}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
  return {
    async put(namespace, key, body) {
      const url = objectUrl(namespace, key);
      const headers = { ...signS3({ method: 'PUT', url, body, accessKeyId, secretAccessKey, region }), 'content-type': 'text/plain; charset=utf-8' };
      await request(url, { method: 'PUT', headers, body }, timeoutMs);
    },
    async get(namespace, key) {
      const url = objectUrl(namespace, key);
      return request(url, { method: 'GET', headers: signS3({ method: 'GET', url, accessKeyId, secretAccessKey, region }) }, timeoutMs);
    },
  };
}

function createBlobClient({ endpoint, account, accountKey, apiVersion, timeoutMs = 5000 }) {
  const blobUrl = (namespace, key) => new URL(`${endpoint}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
  const baseHeaders = () => ({ 'x-ms-date': new Date().toUTCString(), 'x-ms-version': apiVersion });
  return {
    async put(namespace, key, body) {
      const url = blobUrl(namespace, key);
      const headers = {
        ...baseHeaders(),
        'x-ms-blob-type': 'BlockBlob',
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      };
      headers.authorization = signBlob({ method: 'PUT', url, headers, account, accountKey });
      await request(url, { method: 'PUT', headers, body }, timeoutMs);
    },
    async get(namespace, key) {
      const url = blobUrl(namespace, key);
      const headers = baseHeaders();
      headers.authorization = signBlob({ method: 'GET', url, headers, account, accountKey });
      return request(url, { method: 'GET', headers }, timeoutMs);
    },
  };
}

/** Configuration comes from the container environment set by the runner. */
function createStorageClient(env) {
  if (env.STORAGE_PROVIDER === 'aws-s3') {
    return createS3Client({
      endpoint: env.STORAGE_ENDPOINT,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
    });
  }
  if (env.STORAGE_PROVIDER === 'azure-blob') {
    return createBlobClient({
      endpoint: env.STORAGE_ENDPOINT,
      account: env.AZURE_STORAGE_ACCOUNT,
      accountKey: env.AZURE_STORAGE_KEY,
      apiVersion: env.AZURE_STORAGE_API_VERSION,
    });
  }
  return null;
}

module.exports = { createStorageClient, signBlob, signS3, sha256 };
