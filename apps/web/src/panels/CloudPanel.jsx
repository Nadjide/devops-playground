import { useState } from 'react';
import {
  Cloud, Database, FileText, FolderPlus, LoaderCircle, Play, Settings2, Trash2, Upload, X,
} from 'lucide-react';
import { getStorageProvider, labVariants, STORAGE_LIMITS, utf8Bytes } from '@devops-playground/lab-core';
import { useSessionClient, useSessionState } from '../session/SessionContext.jsx';
import { useSessionActions } from '../session/SessionActions.jsx';
import { isActive, latestSucceeded, useOperationDispatch } from '../session/operations.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { IconButton } from '../components/IconButton.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { RecentOperations } from '../components/RecentOperations.jsx';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { formatTime, sourceLabel } from '../components/format.js';

const STORAGE_TYPES = [
  'storage.namespace.create', 'storage.namespace.list', 'storage.namespace.delete',
  'storage.object.put', 'storage.object.list', 'storage.object.get', 'storage.object.delete',
  'storage.configure', 'storage.roundtrip.verify',
];

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const shortHash = (sha256) => `${sha256.slice(0, 12)}…`;

function useLatest(type, match = () => true) {
  const { session } = useSessionState();
  return session.operations.findLast((operation) => operation.type === type &&
    !isActive(operation) && match(operation)) ?? null;
}

function OperationError({ operation }) {
  if (operation?.status !== 'failed') {
    return null;
  }
  return <p className="field-error" role="alert">{operation.error.message}</p>;
}

/**
 * Provider variants of the active mission. Each provider runs in its own
 * session, so switching asks for confirmation and starts a new session.
 */
function ProviderSwitch({ session }) {
  const client = useSessionClient();
  const { requestSessionChange } = useSessionActions();
  const variants = labVariants(session.labId).filter((lab) => client.labs.some((item) => item.id === lab.id));
  if (variants.length < 2) {
    return null;
  }
  return (
    <div className="provider-switch" role="group" aria-label="Storage provider">
      {variants.map((lab) => {
        const active = lab.id === session.labId;
        return (
          <button
            key={lab.id}
            type="button"
            className={`provider-option${active ? ' provider-option-active' : ''}`}
            aria-pressed={active}
            onClick={(event) => {
              if (!active) {
                requestSessionChange({ labId: lab.id }, { returnFocus: event.currentTarget });
              }
            }}
          >
            <Cloud aria-hidden="true" size={14} /> {getStorageProvider(lab.variant.provider).label}
          </button>
        );
      })}
      <span className="small muted">Each provider runs in its own session; switching starts a new one.</span>
    </div>
  );
}

function Identity({ storage, profile }) {
  const client = useSessionClient();
  return (
    <dl className="cloud-identity" aria-label="Storage backend">
      <div><dt>Provider</dt><dd><Cloud aria-hidden="true" size={14} /> {profile.label}</dd></div>
      <div><dt>Backend</dt><dd>{client.mode === 'local' ? `${profile.emulator} emulator (local Docker)` : client.capabilities.backend}</dd></div>
      <div><dt>Endpoint</dt><dd className="mono">{storage.endpoint}</dd></div>
      <div><dt>Source</dt><dd><span className="source-pill">{sourceLabel(client.mode === 'local' ? 'emulator' : 'simulator')}</span></dd></div>
    </dl>
  );
}

function WorkloadStorage({ resource, storage, profile }) {
  const dispatch = useOperationDispatch();
  const { session } = useSessionState();
  const target = resource.desired.storage;
  const [namespace, setNamespace] = useState(target.namespace);
  const [endpoint, setEndpoint] = useState(target.endpoint);
  const pending = session.operations.filter((operation) => isActive(operation) &&
    ['storage.configure', 'storage.roundtrip.verify'].includes(operation.type));
  const configure = useLatest('storage.configure', (operation) => operation.parameters.serviceId === resource.serviceId);
  const check = storage.roundTrips.findLast((item) => item.serviceId === resource.serviceId) ?? null;
  const prefix = `storage-${resource.id}`;

  function onSubmit(event) {
    event.preventDefault();
    dispatch('storage.configure', {
      serviceId: resource.serviceId,
      namespace: namespace.trim(),
      ...(endpoint.trim() !== target.endpoint ? { endpoint: endpoint.trim() } : {}),
    });
  }

  return (
    <section className="cloud-section" aria-labelledby={`${prefix}-title`}>
      <h3 id={`${prefix}-title`} className="section-label">Service storage · {resource.serviceId}</h3>
      <p className="small">
        <span className="muted">{resource.serviceId} writes to</span>{' '}
        <span className="mono">{profile.uri(target.namespace)}</span>{' '}
        <span className="muted">through</span> <span className="mono">{target.endpoint}</span>
      </p>
      <form className="cloud-form" aria-label={`${resource.serviceId} storage configuration`} onSubmit={onSubmit} noValidate>
        <label htmlFor={`${prefix}-namespace`}>{capitalize(profile.namespaceTerm)}</label>
        <input id={`${prefix}-namespace`} type="text" value={namespace} spellCheck={false} autoComplete="off"
          onChange={(event) => setNamespace(event.target.value)} />
        <label htmlFor={`${prefix}-endpoint`}>Endpoint</label>
        <input id={`${prefix}-endpoint`} type="text" value={endpoint} spellCheck={false} autoComplete="off" className="cloud-input-wide"
          onChange={(event) => setEndpoint(event.target.value)} />
        <button type="submit" className="button" disabled={!namespace.trim()}>
          <Settings2 aria-hidden="true" size={14} /> Apply storage configuration
        </button>
        <p className="small muted config-help">
          Only the session emulator endpoint {profile.endpoint} is approved. Applying a change replaces the workload so the process picks it up.
        </p>
        <OperationError operation={configure} />
      </form>
      <div className="cloud-check">
        <button type="button" className="button button-primary" onClick={() => dispatch('storage.roundtrip.verify', { serviceId: resource.serviceId })}>
          <Play aria-hidden="true" size={14} /> Run storage check
        </button>
        <span className="small muted">GET http://{resource.serviceId}:{resource.desired.expectedProbePort}/storage-check: the service writes a payload and reads it back.</span>
      </div>
      {pending.length > 0 ? (
        <p className="pending-note" role="status">
          <LoaderCircle aria-hidden="true" size={14} className="spin" />
          {pending.some((operation) => operation.type === 'storage.configure') ? 'Applying storage configuration…' : 'Running storage check…'}
        </p>
      ) : null}
      {check ? (
        <div className={`cloud-result ${check.ok ? 'cloud-result-ok' : 'cloud-result-failed'}`} aria-label="Latest storage check">
          <StatusBadge value={check.ok ? 'passed' : 'failed'} label={check.ok ? 'round trip passed' : 'round trip failed'} />
          <span className="mono small">{profile.uri(check.namespace, check.key)}</span>
          <span className="small">
            {check.ok
              ? `wrote and read back ${check.bytes} bytes, sha256 ${shortHash(check.observedSha256)}`
              : check.error}
          </span>
          <span className="small muted">{formatTime(check.observedAt)} · {sourceLabel(check.source)} · HTTP {check.statusCode ?? 'none'}</span>
        </div>
      ) : null}
    </section>
  );
}

function CreateNamespace({ profile }) {
  const dispatch = useOperationDispatch();
  const [name, setName] = useState('');
  const create = useLatest('storage.namespace.create');
  return (
    <form
      className="cloud-form"
      aria-label={`Create ${profile.namespaceTerm}`}
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const operation = await dispatch('storage.namespace.create', { namespace: name.trim() });
        if (operation) {
          setName('');
        }
      }}
    >
      <label htmlFor="cloud-new-namespace">New {profile.namespaceTerm}</label>
      <input id="cloud-new-namespace" type="text" value={name} spellCheck={false} autoComplete="off" placeholder="lab-reports"
        onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="button" disabled={!name.trim()}>
        <FolderPlus aria-hidden="true" size={14} /> Create {profile.namespaceTerm}
      </button>
      <OperationError operation={create} />
    </form>
  );
}

function WriteObject({ namespace, profile }) {
  const dispatch = useOperationDispatch();
  const [key, setKey] = useState('notes.txt');
  const [content, setContent] = useState('');
  const put = useLatest('storage.object.put', (operation) => operation.parameters.namespace === namespace);
  const bytes = utf8Bytes(content);
  const tooLarge = bytes > STORAGE_LIMITS.objectBytes;
  return (
    <form
      className="cloud-form cloud-write"
      aria-label={`Write ${profile.objectTerm} to ${namespace}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        dispatch('storage.object.put', { namespace, key: key.trim(), content });
      }}
    >
      <label htmlFor="cloud-object-key">Key</label>
      <input id="cloud-object-key" type="text" value={key} spellCheck={false} autoComplete="off"
        onChange={(event) => setKey(event.target.value)} />
      <label htmlFor="cloud-object-content" className="visually-hidden">Text content</label>
      <textarea id="cloud-object-content" rows={3} value={content} placeholder="Text content (UTF-8, up to 64 KiB)"
        aria-invalid={tooLarge || undefined} onChange={(event) => setContent(event.target.value)} />
      <button type="submit" className="button" disabled={!key.trim() || tooLarge}>
        <Upload aria-hidden="true" size={14} /> Write {profile.objectTerm}
      </button>
      <span className={`small ${tooLarge ? 'field-error' : 'muted'}`}>{bytes} of {STORAGE_LIMITS.objectBytes} bytes</span>
      <OperationError operation={put} />
    </form>
  );
}

function ReadResult({ namespace, profile, onClose }) {
  const get = useLatest('storage.object.get', (operation) => operation.parameters.namespace === namespace);
  if (!get) {
    return null;
  }
  if (get.status !== 'succeeded') {
    return <OperationError operation={get} />;
  }
  const { result } = get;
  return (
    <section className="inspect" aria-label={`Content of ${result.key}`}>
      <header className="inspect-head">
        <h3><FileText aria-hidden="true" size={14} /> {profile.uri(result.namespace, result.key)}</h3>
        <span className="muted small">read {formatTime(get.finishedAt)} · {result.bytes} bytes · sha256 {shortHash(result.sha256)}</span>
        <IconButton icon={X} label="Close object content" onClick={() => onClose(get.id)} />
      </header>
      <pre className="json-preview cloud-content">{result.content}</pre>
      {result.truncated ? <p className="small muted">Preview of the first 4 KiB.</p> : null}
    </section>
  );
}

function NamespaceObjects({ storage, namespace, profile }) {
  const dispatch = useOperationDispatch();
  const [closed, setClosed] = useState(null);
  const latestRead = useLatest('storage.object.get', (operation) => operation.parameters.namespace === namespace.name);
  const objects = storage.objects.filter((object) => object.namespace === namespace.name);
  return (
    <section className="cloud-section" aria-label={`${capitalize(profile.objectsTerm)} in ${namespace.name}`}>
      <h3 className="section-label">{capitalize(profile.objectsTerm)} in {namespace.name}</h3>
      {objects.length === 0 ? <p className="small muted">This {profile.namespaceTerm} is empty.</p> : (
        <ul className="cloud-list" aria-label={`${capitalize(profile.objectsTerm)} in ${namespace.name}`}>
          {objects.map((object) => (
            <li key={object.key} className="cloud-row">
              <FileText aria-hidden="true" size={16} />
              <span className="mono cloud-name">{object.key}</span>
              <span className="small muted">{object.bytes} B · {object.writer} · {formatTime(object.updatedAt)} · {sourceLabel(object.source)}</span>
              <span className="cloud-row-actions">
                <IconButton icon={FileText} label={`Read ${object.key}`} onClick={() => {
                  setClosed(null);
                  dispatch('storage.object.get', { namespace: namespace.name, key: object.key });
                }} />
                <IconButton icon={Trash2} tone="danger" label={`Delete ${object.key}`}
                  unavailableReason={namespace.owned ? null : `not owned by this lab`}
                  onClick={() => dispatch('storage.object.delete', { namespace: namespace.name, key: object.key })} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {namespace.owned ? <WriteObject key={namespace.name} namespace={namespace.name} profile={profile} /> : (
        <p className="small muted">Owned by another team: you can list and read it, but this lab cannot change it.</p>
      )}
      {latestRead && closed !== latestRead.id ? <ReadResult namespace={namespace.name} profile={profile} onClose={setClosed} /> : null}
    </section>
  );
}

export function CloudPanel() {
  const { session } = useSessionState();
  const dispatch = useOperationDispatch();
  const [selected, setSelected] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const storage = session?.storage;

  if (!storage) {
    return (
      <EmptyState icon={Cloud} title="This lab has no cloud storage">
        Choose a storage mission, such as “Provision storage for a service”, to use the Cloud panel.
      </EmptyState>
    );
  }

  const profile = getStorageProvider(storage.provider);
  const workloads = session.resources.filter((resource) => resource.desired.storage);
  const configured = workloads[0]?.desired.storage.namespace;
  const current = storage.namespaces.find((namespace) => namespace.name === selected) ??
    storage.namespaces.find((namespace) => namespace.name === configured) ?? storage.namespaces[0] ?? null;
  const deletion = latestSucceeded(session.operations, 'storage.namespace.delete');
  const failedDelete = session.operations.findLast((operation) => operation.type === 'storage.namespace.delete' && !isActive(operation));

  return (
    <div className="cloud-panel">
      <ProviderSwitch session={session} />
      <Identity storage={storage} profile={profile} />
      {workloads.map((resource) => (
        <WorkloadStorage
          key={`${resource.id}:${resource.desired.storage.namespace}:${resource.desired.storage.endpoint}`}
          resource={resource}
          storage={storage}
          profile={profile}
        />
      ))}
      <section className="cloud-section" aria-labelledby="cloud-namespaces-title">
        <h3 id="cloud-namespaces-title" className="section-label">{capitalize(profile.namespacesTerm)} · {storage.namespaces.length} of {STORAGE_LIMITS.namespaces}</h3>
        <ul className="cloud-list" aria-label={capitalize(profile.namespacesTerm)}>
          {storage.namespaces.map((namespace) => {
            const count = storage.objects.filter((object) => object.namespace === namespace.name).length;
            return (
              <li key={namespace.name} className={`cloud-row${namespace.name === current?.name ? ' cloud-row-selected' : ''}`}>
                <Database aria-hidden="true" size={16} />
                <button type="button" className="link-button mono cloud-name" aria-pressed={namespace.name === current?.name}
                  onClick={() => setSelected(namespace.name)}>
                  {namespace.name}
                </button>
                <StatusBadge value={namespace.owned ? 'ready' : 'unknown'} label={namespace.owned ? 'owned by lab' : 'not owned'} />
                <span className="small muted">{count} {count === 1 ? profile.objectTerm : profile.objectsTerm} · {sourceLabel(namespace.source)}</span>
                <span className="cloud-row-actions">
                  <IconButton icon={Trash2} tone="danger" label={`Delete ${profile.namespaceTerm} ${namespace.name}`}
                    unavailableReason={namespace.owned ? null : 'not owned by this lab'}
                    onClick={(event) => setConfirming({ name: namespace.name, returnFocus: event.currentTarget })} />
                </span>
              </li>
            );
          })}
        </ul>
        {storage.namespaces.length === 0 ? <p className="small muted">No {profile.namespacesTerm} yet.</p> : null}
        <CreateNamespace profile={profile} />
        {failedDelete?.status === 'failed' && failedDelete.id !== deletion?.id ? <OperationError operation={failedDelete} /> : null}
      </section>
      {current ? <NamespaceObjects storage={storage} namespace={current} profile={profile} /> : null}
      <RecentOperations types={STORAGE_TYPES} label="Recent storage operations" />
      {confirming ? (
        <ConfirmDialog
          title={`Delete the ${profile.namespaceTerm} ${confirming.name}?`}
          confirmLabel={`Delete ${profile.namespaceTerm}`}
          returnFocus={confirming.returnFocus}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const { name } = confirming;
            setConfirming(null);
            dispatch('storage.namespace.delete', { namespace: name });
          }}
        >
          <p>
            {profile.deletesNonEmptyNamespace
              ? `Every ${profile.objectTerm} in ${confirming.name} is deleted with it.`
              : `${profile.label} refuses to delete a ${profile.namespaceTerm} that still holds ${profile.objectsTerm}; delete them first.`}
            {' '}Only {profile.namespacesTerm} owned by this lab can be deleted.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
