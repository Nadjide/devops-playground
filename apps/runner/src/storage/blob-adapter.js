import { createHash } from 'node:crypto';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { getStorageProvider, isApprovedEndpoint, STORAGE_LIMITS } from '@devops-playground/lab-core';
import { DriverFailure } from '../docker/errors.js';

/**
 * Azurite's documented development account. It is public, only works against
 * the emulator, and is never a credential for a real storage account.
 */
export const AZURITE_ACCOUNT = 'devstoreaccount1';
export const AZURITE_ACCOUNT_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
export const OWNER_METADATA = 'devplaygroundowner';
export const LAB_OWNER = 'lab';
export const BLOB_API_VERSION = '2026-06-06';

const profile = getStorageProvider('azure-blob');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const PROVIDER_ERRORS = {
  ContainerNotFound: (namespace) => profile.errors.namespaceMissing(namespace),
  ContainerAlreadyExists: (namespace) => profile.errors.namespaceExists(namespace),
  BlobNotFound: (namespace, key) => profile.errors.objectMissing(namespace, key),
  InvalidResourceName: () => profile.errors.invalidName('The specified resource name contains invalid characters.'),
};

const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'REQUEST_SEND_ERROR'];

/** Translate SDK failures into provider errors or a retryable emulator outage. */
export function translateBlobError(error, { namespace, key } = {}) {
  const provider = PROVIDER_ERRORS[error?.code] ?? PROVIDER_ERRORS[error?.details?.errorCode];
  if (provider) {
    const { code, message } = provider(namespace, key);
    return new DriverFailure(code, message);
  }
  const network = error?.code ?? error?.cause?.code;
  if (NETWORK_CODES.includes(network) || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new DriverFailure('STORAGE_BACKEND_UNAVAILABLE',
      `The session's Azure Blob emulator is not reachable at ${profile.endpoint} (${network ?? 'timeout'}).`, { retryable: true });
  }
  return new DriverFailure('BLOB_REQUEST_FAILED', `Azure Blob request failed: ${String(error?.code ?? error?.name ?? 'error').slice(0, 80)}.`, { retryable: true });
}

/**
 * Blob client bound to the session's Azurite emulator with the explicit
 * development account. The endpoint is checked before a client exists, and no
 * connection string, environment variable, or Azure identity is consulted.
 */
export function createBlobAdapter({ endpoint = profile.endpoint, timeoutMs = 5000, clientFactory = (url, credential, options) => new BlobServiceClient(url, credential, options) } = {}) {
  if (!isApprovedEndpoint('azure-blob', endpoint)) {
    throw new DriverFailure('ENDPOINT_NOT_ALLOWED', `${endpoint} is not the session's Azure Blob emulator.`);
  }
  const credential = new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_ACCOUNT_KEY);
  const service = clientFactory(endpoint, credential, {
    serviceVersion: BLOB_API_VERSION,
    retryOptions: { maxTries: 1, tryTimeoutInMs: timeoutMs },
  });
  const options = () => ({ abortSignal: AbortSignal.timeout(timeoutMs * 2) });

  async function call(work, context) {
    try {
      return await work();
    } catch (error) {
      throw translateBlobError(error, context);
    }
  }

  async function ownerOf(namespace) {
    const properties = await call(() => service.getContainerClient(namespace).getProperties(options()), { namespace });
    return properties.metadata?.[OWNER_METADATA] ?? null;
  }

  async function readObject(namespace, key) {
    const blob = service.getContainerClient(namespace).getBlobClient(key);
    const properties = await call(() => blob.getProperties(options()), { namespace, key });
    const byteLength = properties.contentLength ?? 0;
    if (byteLength > STORAGE_LIMITS.objectBytes) {
      throw new DriverFailure('OBJECT_TOO_LARGE', `${profile.uri(namespace, key)} is larger than 64 KiB and is not read by the lab.`);
    }
    const buffer = byteLength === 0 ? Buffer.alloc(0) : await call(() => blob.downloadToBuffer(0, byteLength, {
      ...options(), conditions: { ifMatch: properties.etag },
    }), { namespace, key });
    if (buffer.length > STORAGE_LIMITS.objectBytes) {
      throw new DriverFailure('OBJECT_TOO_LARGE', `${profile.uri(namespace, key)} is larger than 64 KiB and is not read by the lab.`);
    }
    const content = buffer.toString('utf8');
    return { content, bytes: buffer.length, sha256: sha256(content), updatedAt: (properties.lastModified ?? new Date()).toISOString() };
  }

  return {
    provider: 'azure-blob',
    endpoint,
    client: service,
    async ready() {
      await call(() => service.getProperties(options()));
    },
    async createNamespace(namespace, { owner = LAB_OWNER } = {}) {
      await call(() => service.getContainerClient(namespace).create({ metadata: { [OWNER_METADATA]: owner }, ...options() }), { namespace });
    },
    async deleteNamespace(namespace) {
      await call(() => service.getContainerClient(namespace).delete(options()), { namespace });
    },
    async listNamespaces() {
      const namespaces = [];
      await call(async () => {
        for await (const container of service.listContainers({ includeMetadata: true, ...options() })) {
          namespaces.push({
            name: container.name,
            owned: container.metadata?.[OWNER_METADATA] === LAB_OWNER,
            createdAt: null,
          });
          if (namespaces.length >= STORAGE_LIMITS.namespaces) {
            break;
          }
        }
      });
      return namespaces;
    },
    ownerOf,
    async putObject(namespace, key, content) {
      const body = Buffer.from(content, 'utf8');
      await call(() => service.getContainerClient(namespace).getBlockBlobClient(key)
        .upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' }, ...options() }), { namespace, key });
      return { bytes: body.length, sha256: sha256(content) };
    },
    readObject,
    async listObjects(namespace) {
      const objects = [];
      await call(async () => {
        for await (const blob of service.getContainerClient(namespace).listBlobsFlat(options())) {
          if ((blob.properties.contentLength ?? 0) > STORAGE_LIMITS.objectBytes) {
            continue;
          }
          const { bytes, sha256: digest } = await readObject(namespace, blob.name);
          objects.push({ key: blob.name, bytes, sha256: digest, updatedAt: (blob.properties.lastModified ?? new Date()).toISOString() });
          if (objects.length >= STORAGE_LIMITS.objects) {
            break;
          }
        }
      }, { namespace });
      return objects;
    },
    async deleteObject(namespace, key) {
      await call(() => service.getContainerClient(namespace).getBlobClient(key).delete(options()), { namespace, key });
    },
    async objectExists(namespace, key) {
      return call(() => service.getContainerClient(namespace).getBlobClient(key).exists(options()), { namespace, key });
    },
    destroy() {},
  };
}
