import { STORAGE_LIMITS, utf8Bytes } from '../schemas/storage.js';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Provider profiles for the shared storage surface. Each keeps its own
 * terminology, naming rules, approved local endpoint, and error vocabulary;
 * the abstraction covers only the operations the storage missions need.
 */
export const STORAGE_PROVIDER_PROFILES = Object.freeze({
  'aws-s3': Object.freeze({
    id: 'aws-s3',
    label: 'AWS S3',
    service: 'Amazon S3',
    namespaceTerm: 'bucket',
    namespacesTerm: 'buckets',
    objectTerm: 'object',
    objectsTerm: 'objects',
    // The session's emulator alias and port; nothing else is reachable.
    endpoint: 'http://storage:5000',
    region: 'us-east-1',
    // S3 refuses to delete a bucket that still holds objects.
    deletesNonEmptyNamespace: false,
    // DeleteObject on a missing key succeeds (204) in S3.
    missingObjectDeleteSucceeds: true,
    uri: (namespace, key) => (key ? `s3://${namespace}/${key}` : `s3://${namespace}`),
    validateNamespace(name) {
      if (name.length < 3 || name.length > 63) {
        return 'Bucket names must be between 3 and 63 characters long.';
      }
      if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
        return 'Bucket names use lowercase letters, digits, dots, and hyphens, and begin and end with a letter or digit.';
      }
      if (name.includes('..')) {
        return 'Bucket names cannot contain two adjacent periods.';
      }
      if (IPV4.test(name)) {
        return 'Bucket names cannot be formatted as an IP address.';
      }
      if (['xn--', 'sthree-', 'amzn-s3-demo-'].some((prefix) => name.startsWith(prefix))) {
        return 'Bucket names cannot start with a reserved prefix (xn--, sthree-, amzn-s3-demo-).';
      }
      if (['-s3alias', '--ol-s3', '.mrap', '--x-s3'].some((suffix) => name.endsWith(suffix))) {
        return 'Bucket names cannot end with a reserved suffix (-s3alias, --ol-s3, .mrap, --x-s3).';
      }
      return null;
    },
    errors: Object.freeze({
      namespaceMissing: (namespace) => ({ code: 'NO_SUCH_BUCKET', status: 404, message: `NoSuchBucket: The specified bucket does not exist (${namespace}).` }),
      namespaceExists: (namespace) => ({ code: 'BUCKET_ALREADY_OWNED_BY_YOU', status: 409, message: `BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded and you already own it (${namespace}).` }),
      namespaceTaken: (namespace) => ({ code: 'BUCKET_ALREADY_EXISTS', status: 409, message: `BucketAlreadyExists: The requested bucket name is not available (${namespace}).` }),
      namespaceNotEmpty: (namespace) => ({ code: 'BUCKET_NOT_EMPTY', status: 409, message: `BucketNotEmpty: The bucket you tried to delete is not empty (${namespace}).` }),
      objectMissing: (namespace, key) => ({ code: 'NO_SUCH_KEY', status: 404, message: `NoSuchKey: The specified key does not exist (s3://${namespace}/${key}).` }),
      invalidName: (message) => ({ code: 'INVALID_BUCKET_NAME', status: 400, message: `InvalidBucketName: ${message}` }),
    }),
  }),
});

export function getStorageProvider(providerId) {
  const profile = STORAGE_PROVIDER_PROFILES[providerId];
  if (!profile) {
    throw new RangeError(`Unknown storage provider: ${providerId}`);
  }
  return profile;
}

/** Only the provider's session emulator endpoint is approved; checked before any network use. */
export function isApprovedEndpoint(providerId, endpoint) {
  return getStorageProvider(providerId).endpoint === endpoint;
}

export const STORAGE_CHECK_KEY = 'storage-check.txt';

/** Payload the workload writes and must read back unchanged. */
export function storageCheckPayload({ provider, namespace, nonce }) {
  return `devops-playground storage check\nprovider=${provider}\nnamespace=${namespace}\nnonce=${nonce}\n`;
}

export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** First 4 KiB of UTF-8 text, never splitting a character. */
export function contentPreview(text) {
  if (utf8Bytes(text) <= STORAGE_LIMITS.previewBytes) {
    return { preview: text, truncated: false };
  }
  let preview = '';
  let bytes = 0;
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > STORAGE_LIMITS.previewBytes) {
      break;
    }
    preview += character;
    bytes += size;
  }
  return { preview, truncated: true };
}
