import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { Catalog, Envelope, Packet, Status } from '../shared/protocol';
import { api } from './api';
import {
  createVault,
  decryptCatalog,
  encryptCatalog,
  recoverVault,
  unlockVault,
  type VaultKey,
} from './crypto/vault';
import { Gallery } from './Gallery';

export type OpenVault = { vault: VaultKey; catalog: Catalog; revision: number };
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';
export function Icon({
  name,
  size = 20,
}: {
  name: 'lock' | 'plus' | 'grid' | 'close' | 'arrow' | 'download' | 'devices';
  size?: number;
}) {
  const paths = {
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    devices: (
      <>
        <rect x="2" y="3" width="15" height="12" rx="2" />
        <path d="M6 20h7M9 15v5" />
        <rect x="16" y="9" width="6" height="12" rx="1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="grid" />
      </span>
      <span>
        stillroom<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef(new AbortController());
  const pending = useRef(false);
  useEffect(() => () => controller.current.abort(), []);
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || controller.current.signal.aborted) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await task(controller.current.signal);
    } catch (e) {
      if (!controller.current.signal.aborted) setError(message(e));
    } finally {
      pending.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  };
  return { busy, error, setError, run, signal: controller.current.signal };
}
export function Dialog({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null),
    [opened, setOpened] = useState<OpenVault | null>(null),
    [error, setError] = useState('');
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<Status>('/status'));
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  const lock = useCallback(() => {
    setOpened(null);
    setStatus((s) => (s ? { ...s, user: null } : s));
    void api('/auth/logout', 'POST').catch(() => {});
  }, []);
  useEffect(() => {
    if (!status?.user) return;
    let lastAction = Date.now();
    const activity = () => {
      lastAction = Date.now();
    };
    const check = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastAction > 5 * 60_000) lock();
    };
    for (const name of ['pointerdown', 'keydown', 'touchstart'])
      window.addEventListener(name, activity, { passive: true });
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 10_000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      for (const name of ['pointerdown', 'keydown', 'touchstart'])
        window.removeEventListener(name, activity);
    };
  }, [status?.user, lock]);
  if (opened && status?.user) return <Gallery initial={opened} user={status.user} onLock={lock} />;
  return (
    <div className="gate-layout">
      <aside className="gate-intro">
        <Brand />
        <div className="intro-copy">
          <p className="eyebrow">YOUR PRIVATE COLLECTION</p>
          <h1>
            A quiet place
            <br />
            for your photographs.
          </h1>
          <p>
            Upload here. Browse on your other devices.
            <br />
            Keep the collection in your hands.
          </p>
        </div>
        <div className="contact-sheet" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <span>{String(i + 1).padStart(2, '0')}</span>
            </div>
          ))}
        </div>
        <p className="intro-footer">
          <Icon name="lock" size={15} /> Private access · Encrypted collection
        </p>
      </aside>
      <main className="gate-main">
        <div className="mobile-brand">
          <Brand />
        </div>
        <div className="gate-form">
          {error ? (
            <>
              <ErrorNotice error={error} />
              <button
                onClick={() => {
                  setError('');
                  void loadStatus();
                }}
              >
                Retry connection
              </button>
            </>
          ) : !status ? (
            <p role="status">Opening Stillroom…</p>
          ) : !status.user ? (
            <AuthGate registered={status.registered} onReady={loadStatus} />
          ) : (
            <VaultGate status={status} onOpen={setOpened} onLock={lock} />
          )}
        </div>
        <p className="gate-footnote">Your collection stays locked until you unlock it.</p>
      </main>
    </div>
  );
}
function AuthGate({ registered, onReady }: { registered: boolean; onReady: () => Promise<void> }) {
  const [enroll, setEnroll] = useState(!registered),
    [code, setCode] = useState(''),
    [label, setLabel] = useState('');
  const task = useTask();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void task.run(async (signal) => {
      if (enroll) {
        const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
          '/auth/register/options',
          'POST',
          { token: code.trim(), label: label.trim() },
          signal,
        );
        const response = await startRegistration({ optionsJSON });
        signal.throwIfAborted();
        await api('/auth/register/verify', 'POST', response, signal);
      } else {
        const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
          '/auth/login/options',
          'POST',
          {},
          signal,
        );
        const response = await startAuthentication({ optionsJSON });
        signal.throwIfAborted();
        await api('/auth/login/verify', 'POST', response, signal);
      }
      signal.throwIfAborted();
      await onReady();
    });
  };
  return (
    <>
      <span className="step-label">{enroll ? 'DEVICE SETUP' : 'WELCOME BACK'}</span>
      <h2>{enroll ? 'Add this device' : 'Open your collection'}</h2>
      <p className="muted">
        {enroll
          ? registered
            ? 'Enter the enrollment code from your upload device, then create a passkey.'
            : 'Use the setup code from the server to register your first passkey.'
          : 'Sign in with your passkey, then unlock your images.'}
      </p>
      <form onSubmit={submit}>
        {enroll && (
          <>
            <label>
              Device name
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                maxLength={80}
                placeholder="My upload PC"
                autoComplete="off"
              />
            </label>
            <label>
              Enrollment code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                className="mono"
              />
            </label>
          </>
        )}
        <ErrorNotice error={task.error} />
        <button className="primary wide" disabled={task.busy}>
          {task.busy
            ? 'Waiting for your passkey…'
            : enroll
              ? 'Create passkey'
              : 'Sign in with passkey'}
          <Icon name="arrow" size={17} />
        </button>
      </form>
      {registered && (
        <button
          className="text-button"
          disabled={task.busy}
          onClick={() => {
            setEnroll(!enroll);
            task.setError('');
          }}
        >
          {enroll ? 'Already enrolled? Sign in' : 'Set up a new device'}
        </button>
      )}
    </>
  );
}
function VaultGate({
  status,
  onOpen,
  onLock,
}: {
  status: Status;
  onOpen: (v: OpenVault) => void;
  onLock: () => void;
}) {
  const task = useTask();
  const [passphrase, setPassphrase] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false),
    [recoverySecret, setRecoverySecret] = useState('');
  const [created, setCreated] = useState<Awaited<ReturnType<typeof createVault>> | null>(null),
    [saved, setSaved] = useState(false);
  const create = !status.vaultExists;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void task.run(async (signal) => {
      if (create) {
        if (passphrase !== confirmation) throw new Error('The passphrases do not match.');
        const result = await createVault(passphrase);
        signal.throwIfAborted();
        setPassphrase('');
        setConfirmation('');
        setCreated(result);
      } else {
        const data = await api<{ envelope: Envelope; catalog: Packet; revision: number }>(
          '/vault',
          'GET',
          undefined,
          signal,
        );
        let vault: VaultKey;
        if (recoveryMode) {
          if (passphrase !== confirmation) throw new Error('The passphrases do not match.');
          const result = await recoverVault(data.envelope, recoverySecret, passphrase);
          signal.throwIfAborted();
          const updated = await api<{ revision: number }>(
            '/vault/envelope',
            'PUT',
            { envelope: result.envelope, revision: data.revision },
            signal,
          );
          vault = result.vault;
          data.revision = updated.revision;
        } else vault = await unlockVault(data.envelope, passphrase);
        signal.throwIfAborted();
        const catalog = await decryptCatalog(vault, data.catalog);
        signal.throwIfAborted();
        setPassphrase('');
        setRecoverySecret('');
        onOpen({ vault, catalog, revision: data.revision });
      }
    });
  };
  if (create && status.user?.role !== 'admin')
    return (
      <>
        <h2>Your vault is not ready yet</h2>
        <p>Create the collection on your upload PC first.</p>
        <button onClick={onLock}>Sign out</button>
      </>
    );
  if (created)
    return (
      <>
        <span className="step-label">KEEP THIS OFFLINE</span>
        <h2>Save your recovery secret</h2>
        <p className="muted">
          This can recover your images if you forget the vault passphrase. Store it separately from
          the server and backups.
        </p>
        <output className="recovery-secret">{created.recovery}</output>
        <label className="checkbox">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I
          saved the recovery secret somewhere safe.
        </label>
        <ErrorNotice error={task.error} />
        <button
          className="primary wide"
          disabled={!saved || task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              const catalog: Catalog = { v: 1, categories: [], images: [] };
              const encrypted = await encryptCatalog(created.vault, catalog);
              signal.throwIfAborted();
              const { revision } = await api<{ revision: number }>(
                '/vault',
                'POST',
                { envelope: created.envelope, catalog: encrypted },
                signal,
              );
              signal.throwIfAborted();
              onOpen({ vault: created.vault, catalog, revision });
            })
          }
        >
          {task.busy ? 'Creating your vault…' : 'Open the empty collection'}
        </button>
      </>
    );
  return (
    <>
      <span className="step-label">{status.user?.label}</span>
      <h2>
        {create
          ? 'Create your image vault'
          : recoveryMode
            ? 'Recover your vault'
            : 'Unlock your images'}
      </h2>
      <p className="muted">
        {create
          ? 'Choose a long passphrase to unlock your collection on each device.'
          : recoveryMode
            ? 'Use your offline recovery secret to set a new vault passphrase.'
            : 'Enter your vault passphrase. It stays on this device.'}
      </p>
      <form onSubmit={submit}>
        {recoveryMode && (
          <label>
            Recovery secret
            <input
              value={recoverySecret}
              onChange={(e) => setRecoverySecret(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <label>
          {recoveryMode ? 'New vault passphrase' : 'Vault passphrase'}
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
            minLength={create || recoveryMode ? 20 : undefined}
            autoComplete={create || recoveryMode ? 'new-password' : 'current-password'}
            autoFocus
          />
        </label>
        {(create || recoveryMode) && (
          <label>
            Confirm passphrase
            <input
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
        )}
        <ErrorNotice error={task.error} />
        <button className="primary wide" disabled={task.busy}>
          {task.busy
            ? 'Unlocking…'
            : create
              ? 'Create encrypted vault'
              : recoveryMode
                ? 'Recover and unlock'
                : 'Unlock collection'}
          <Icon name="lock" size={17} />
        </button>
      </form>
      {!create && status.user?.role === 'admin' && (
        <button
          className="text-button"
          disabled={task.busy}
          onClick={() => {
            setRecoveryMode(!recoveryMode);
            setPassphrase('');
            setConfirmation('');
            task.setError('');
          }}
        >
          {recoveryMode ? 'Use my passphrase' : 'Use a recovery secret'}
        </button>
      )}
      <button className="text-button" onClick={onLock}>
        Sign out
      </button>
    </>
  );
}
