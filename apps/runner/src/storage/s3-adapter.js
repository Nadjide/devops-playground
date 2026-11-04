import { createHash } from 'node:crypto';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetBucketTaggingCommand, GetObjectCommand,
  ListBucketsCommand, ListObjectsV2Command, PutBucketTaggingCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getStorageProvider, isApprovedEndpoint, STORAGE_LIMITS } from '@devops-playground/lab-core';
import { DriverFailure } from '../docker/errors.js';

/** Fixed test-only values; Moto accepts them and no real account recognizes them. */
export const S3_TEST_CREDENTIALS = Object.freeze({ accessKeyId: 'testing', secretAccessKey: 'testing' });
export const S3_REGION = 'us-east-1';
export const OWNER_TAG = 'devops-playground-owner';
export const LAB_OWNER = 'lab';

const profile = getStorageProvider('aws-s3');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const PROVIDER_ERRORS = {
  NoSuchBucket: (namespace) => profile.errors.namespaceMissing(namespace),
  BucketAlreadyOwnedByYou: (namespace) => profile.errors.namespaceExists(namespace),
  BucketAlreadyExists: (namespace) => profile.errors.namespaceTaken(namespace),
  BucketNotEmpty: (namespace) => profile.errors.namespaceNotEmpty(namespace),
  NoSuchKey: (namespace, key) => profile.errors.objectMissing(namespace, key),
  InvalidBucketName: () => profile.errors.invalidName('The specified bucket is not valid.'),
};

const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'];

/** Translate SDK failures into provider errors or a retryable emulator outage. */
export function translateS3Error(error, { namespace, key } = {}) {
  const provider = PROVIDER_ERRORS[error?.name];
  if (provider) {
    const { code, message } = provider(namespace, key);
    return new DriverFailure(code, message);
  }
  const network = error?.code ?? error?.cause?.code;
  if (NETWORK_CODES.includes(network) || error?.name === 'TimeoutError' || error?.name === 'RequestTimeout') {
    return new DriverFailure('STORAGE_BACKEND_UNAVAILABLE',
      `The session's S3 emulator is not reachable at ${profile.endpoint} (${network ?? 'timeout'}).`, { retryable: true });
  }
  return new DriverFailure('S3_REQUEST_FAILED', `S3 request failed: ${String(error?.name ?? 'error').slice(0, 80)}.`, { retryable: true });
}

/**
 * S3 client bound to the session emulator. The endpoint is checked before any
 * client exists, and credentials, region, and path-style addressing are explicit,
 * so environment variables, profiles, and instance metadata are never consulted.
 */
export function createS3Adapter({ endpoint = profile.endpoint, timeoutMs = 5000, clientFactory = (config) => new S3Client(config) } = {}) {
  if (!isApprovedEndpoint('aws-s3', endpoint)) {
    throw new DriverFailure('ENDPOINT_NOT_ALLOWED', `${endpoint} is not the session's S3 emulator.`);
  }
  const client = clientFactory({
    endpoint,
    region: S3_REGION,
    forcePathStyle: true,
    // A fresh object: the SDK annotates credentials with their source.
    credentials: { ...S3_TEST_CREDENTIALS },
    maxAttempts: 1,
    followRegionRedirects: false,
    requestHandler: { requestTimeout: timeoutMs, connectionTimeout: timeoutMs },
  });

  async function send(command, context) {
    try {
      return await client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs * 2) });
    } catch (error) {
      throw translateS3Error(error, context);
    }
  }

  async function ownerOf(namespace) {
    try {
      const { TagSet = [] } = await client.send(new GetBucketTaggingCommand({ Bucket: namespace }));
      return TagSet.find((tag) => tag.Key === OWNER_TAG)?.Value ?? null;
    } catch (error) {
      if (error?.name === 'NoSuchTagSet' || error?.name === 'NoSuchTagSetError') {
        return null;
      }
      throw translateS3Error(error, { namespace });
    }
  }

  async function readObject(namespace, key) {
    const response = await send(new GetObjectCommand({ Bucket: namespace, Key: key }), { namespace, key });
    if ((response.ContentLength ?? 0) > STORAGE_LIMITS.objectBytes) {
      throw new DriverFailure('OBJECT_TOO_LARGE', `${profile.uri(namespace, key)} is larger than 64 KiB and is not read by the lab.`);
    }
    const content = await response.Body.transformToString('utf-8');
    return { content, bytes: Buffer.byteLength(content), sha256: sha256(content), updatedAt: (response.LastModified ?? new Date()).toISOString() };
  }

  return {
    provider: 'aws-s3',
    endpoint,
    client,
    async ready() {
      await send(new ListBucketsCommand({}));
    },
    async createNamespace(namespace, { owner = LAB_OWNER } = {}) {
      await send(new CreateBucketCommand({ Bucket: namespace }), { namespace });
      await send(new PutBucketTaggingCommand({ Bucket: namespace, Tagging: { TagSet: [{ Key: OWNER_TAG, Value: owner }] } }), { namespace });
    },
    async deleteNamespace(namespace) {
      await send(new DeleteBucketCommand({ Bucket: namespace }), { namespace });
    },
    /** Namespaces with ownership read back from their tags. */
    async listNamespaces() {
      const { Buckets = [] } = await send(new ListBucketsCommand({}));
      const namespaces = [];
      for (const bucket of Buckets.slice(0, STORAGE_LIMITS.namespaces)) {
        namespaces.push({
          name: bucket.Name,
          owned: (await ownerOf(bucket.Name)) === LAB_OWNER,
          createdAt: bucket.CreationDate ? bucket.CreationDate.toISOString() : null,
        });
      }
      return namespaces;
    },
    ownerOf,
    async putObject(namespace, key, content) {
      await send(new PutObjectCommand({ Bucket: namespace, Key: key, Body: content, ContentType: 'text/plain; charset=utf-8' }), { namespace, key });
      return { bytes: Buffer.byteLength(content), sha256: sha256(content) };
    },
    readObject,
    /** Object metadata with digests computed from the stored content. */
    async listObjects(namespace) {
      const { Contents = [] } = await send(new ListObjectsV2Command({ Bucket: namespace, MaxKeys: STORAGE_LIMITS.objects }), { namespace });
      const objects = [];
      for (const item of Contents) {
        if ((item.Size ?? 0) > STORAGE_LIMITS.objectBytes) {
          continue;
        }
        const { bytes, sha256: digest } = await readObject(namespace, item.Key);
        objects.push({ key: item.Key, bytes, sha256: digest, updatedAt: (item.LastModified ?? new Date()).toISOString() });
      }
      return objects;
    },
    async deleteObject(namespace, key) {
      await send(new DeleteObjectCommand({ Bucket: namespace, Key: key }), { namespace, key });
    },
    async objectExists(namespace, key) {
      const { Contents = [] } = await send(new ListObjectsV2Command({ Bucket: namespace, Prefix: key, MaxKeys: 5 }), { namespace });
      return Contents.some((item) => item.Key === key);
    },
    destroy() {
      client.destroy();
    },
  };
}
