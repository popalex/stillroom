import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, ImageEntry, ObjectRef, Status } from '../shared/protocol';
import { api, fetchObject } from './api';
import { decryptObject, encryptCatalog, type VaultKey } from './crypto/vault';
import { importImage } from './images';
import { Brand, Dialog, ErrorNotice, Icon, message, useTask, type OpenVault } from './App';

function useImage(ref: ObjectRef, vault: VaultKey, enabled = true) {
  const [url, setURL] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let objectURL = '';
    setURL('');
    setError('');
    void (async () => {
      try {
        const data = await fetchObject(ref.id, controller.signal);
        const plain = await decryptObject(vault, ref, data);
        controller.signal.throwIfAborted();
        objectURL = URL.createObjectURL(new Blob([plain], { type: 'image/webp' }));
        plain.fill(0);
        setURL(objectURL);
      } catch (e) {
        if (!controller.signal.aborted) setError(message(e));
      }
    })();
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [ref.id, enabled, vault]);
  return { url: enabled ? url : '', error };
}
function Thumbnail({
  image,
  vault,
  index,
  open,
}: {
  image: ImageEntry;
  vault: VaultKey;
  index: number;
  open: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null),
    [near, setNear] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => setNear(entries[0].isIntersecting), {
      rootMargin: '250px',
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { url, error } = useImage(image.thumbnail, vault, near);
  return (
    <button ref={ref} className="image-card" onClick={open} aria-label={`View ${image.name}`}>
      <div className="image-well">
        {url ? (
          <img src={url} alt="" />
        ) : (
          <span className="image-placeholder">
            {error ? 'Could not load preview' : <Icon name="grid" size={28} />}
          </span>
        )}
      </div>
      <div className="image-caption">
        <span className="image-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="image-name">{image.name}</span>
        <span className="image-category">{image.category || 'Uncategorized'}</span>
      </div>
    </button>
  );
}
const formatBytes = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.round(bytes / 1024)} KiB`;

export function Gallery({
  initial,
  user,
  onLock,
}: {
  initial: OpenVault;
  user: NonNullable<Status['user']>;
  onLock: () => void;
}) {
  const [catalog, setCatalog] = useState(initial.catalog),
    revision = useRef(initial.revision);
  const [category, setCategory] = useState('all'),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false),
    [newCategory, setNewCategory] = useState('');
  const [devices, setDevices] = useState(false),
    [progress, setProgress] = useState(''),
    [dragging, setDragging] = useState(false);
  const task = useTask(),
    fileInput = useRef<HTMLInputElement>(null);
  const admin = user.role === 'admin';
  const images = useMemo(
    () =>
      catalog.images.filter(
        (image) =>
          (category === 'all' ||
            (category === 'uncategorized' ? !image.category : image.category === category)) &&
          image.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [catalog, category, search],
  );
  const selectedIndex = images.findIndex((image) => image.id === selected);
  const save = async (next: Catalog) => {
    const encrypted = await encryptCatalog(initial.vault, next);
    task.signal.throwIfAborted();
    const objects = next.images.flatMap((image) => [
      image.original.id,
      image.thumbnail.id,
      image.preview.id,
    ]);
    const result = await api<{ revision: number }>(
      '/catalog',
      'PUT',
      { revision: revision.current, catalog: encrypted, objects },
      task.signal,
    );
    task.signal.throwIfAborted();
    revision.current = result.revision;
    setCatalog(next);
  };
  const upload = (files: File[]) =>
    void task.run(async (signal) => {
      let next = catalog;
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const setPhase = (phase: string) =>
            setProgress(`${index + 1} / ${files.length} · ${phase} · ${file.name}`);
          setPhase('Preparing');
          const image = await importImage(
            file,
            category === 'all' || category === 'uncategorized' ? '' : category,
            initial.vault,
            signal,
            setPhase,
          );
          signal.throwIfAborted();
          setPhase('Saving to collection');
          next = { ...next, images: [image, ...next.images] };
          await save(next);
        }
      } finally {
        if (!signal.aborted) setProgress('');
        if (fileInput.current) fileInput.current.value = '';
      }
    });
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-section">
          <p className="eyebrow">COLLECTION</p>
          <button
            className={`nav-item ${category === 'all' ? 'active' : ''}`}
            onClick={() => setCategory('all')}
          >
            <Icon name="grid" size={18} />
            All photographs<span>{catalog.images.length}</span>
          </button>
          <button
            className={`nav-item ${category === 'uncategorized' ? 'active' : ''}`}
            onClick={() => setCategory('uncategorized')}
          >
            Uncategorized<span>{catalog.images.filter((i) => !i.category).length}</span>
          </button>
        </div>
        <div className="sidebar-section categories">
          <div className="section-label">
            <p className="eyebrow">CATEGORIES</p>
            {admin && (
              <button
                className="icon-button"
                aria-label="Add category"
                disabled={task.busy}
                onClick={() => setAddingCategory(true)}
              >
                <Icon name="plus" size={17} />
              </button>
            )}
          </div>
          {catalog.categories.map((name) => (
            <button
              key={name}
              className={`nav-item ${category === name ? 'active' : ''}`}
              onClick={() => setCategory(name)}
            >
              <span className="category-dot" />
              {name}
              <span>{catalog.images.filter((i) => i.category === name).length}</span>
            </button>
          ))}
          {!catalog.categories.length && (
            <p className="sidebar-hint">
              {admin ? 'Add categories to organize your photographs.' : 'No categories yet.'}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <span className="device-label">{user.label}</span>
          <span className="muted">{admin ? 'Upload & manage' : 'Viewing access'}</span>
          {admin && (
            <button className="nav-item" onClick={() => setDevices(true)} disabled={task.busy}>
              <Icon name="devices" size={18} />
              Manage devices
            </button>
          )}
          <button className="nav-item" onClick={onLock}>
            <Icon name="lock" size={18} />
            Lock collection
          </button>
        </div>
      </aside>
      <main
        className="collection-main"
        onDragOver={(e) => {
          if (admin && !task.busy) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (admin && !task.busy) upload(Array.from(e.dataTransfer.files));
        }}
      >
        <header className="collection-header">
          <div>
            <p className="eyebrow">PRIVATE IMAGE LIBRARY</p>
            <h1>
              {category === 'all'
                ? 'All photographs'
                : category === 'uncategorized'
                  ? 'Uncategorized'
                  : category}
            </h1>
            <p className="muted">
              {images.length} {images.length === 1 ? 'photograph' : 'photographs'}
              {search ? ' found' : ' in your collection'}
            </p>
          </div>
          <div className="header-actions">
            {admin && (
              <button
                className="mobile-devices icon-button"
                aria-label="Manage devices"
                disabled={task.busy}
                onClick={() => setDevices(true)}
              >
                <Icon name="devices" />
              </button>
            )}
            <button
              className="mobile-lock icon-button"
              aria-label="Lock collection"
              onClick={onLock}
            >
              <Icon name="lock" />
            </button>
            {admin && (
              <button
                className="primary"
                disabled={task.busy}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="plus" size={18} />
                Upload images
              </button>
            )}
          </div>
        </header>
        <div className="collection-toolbar">
          <label className="search-label">
            <span className="sr-only">Search photographs</span>
            <input
              type="search"
              placeholder="Find a photograph…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="private-indicator">
            <span />
            Unlocked on this device
          </span>
        </div>
        <ErrorNotice error={task.error} />
        {progress && (
          <div className="upload-progress" role="status">
            <span className="spinner" />
            {progress}
          </div>
        )}
        {images.length ? (
          <div className="image-grid">
            {images.map((image, index) => (
              <Thumbnail
                key={image.id}
                image={image}
                index={index}
                vault={initial.vault}
                open={() => setSelected(image.id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-sheet" aria-hidden="true">
              <Icon name="grid" size={48} />
            </div>
            <h2>
              {search
                ? 'No photographs found'
                : category === 'all'
                  ? 'Your collection starts here'
                  : 'Nothing in this category yet'}
            </h2>
            <p>
              {search
                ? 'Try a different filename or category.'
                : admin
                  ? 'Drop photographs here, or choose files from this device.'
                  : 'Upload photographs from your upload PC to see them here.'}
            </p>
            {admin && !search && (
              <button
                className="secondary"
                disabled={task.busy}
                onClick={() => fileInput.current?.click()}
              >
                Choose images
              </button>
            )}
            <span className="format-hint">JPEG, PNG, WebP · Up to 25 MiB per image</span>
          </div>
        )}
        <footer className="collection-footer">
          <span>STILLROOM / PERSONAL ARCHIVE</span>
          <span>Images unlock only on your devices.</span>
        </footer>
        <input
          ref={fileInput}
          disabled={task.busy}
          type="file"
          className="sr-only"
          aria-label="Upload image files"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(e) => upload(Array.from(e.target.files || []))}
        />
        {dragging && (
          <div className="drop-overlay">
            <Icon name="plus" size={48} />
            <h2>Drop to add to your collection</h2>
          </div>
        )}
      </main>
      {addingCategory && (
        <Dialog title="Add a category" onClose={() => setAddingCategory(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                const name = newCategory.trim();
                if (!name || ['all', 'uncategorized'].includes(name.toLowerCase()))
                  throw new Error('Choose a different category name.');
                if (catalog.categories.includes(name))
                  throw new Error('That category already exists.');
                await save({ ...catalog, categories: [...catalog.categories, name] });
                setCategory(name);
                setNewCategory('');
                setAddingCategory(false);
              });
            }}
          >
            <label>
              Category name
              <input
                autoFocus
                value={newCategory}
                maxLength={80}
                onChange={(e) => setNewCategory(e.target.value)}
                required
              />
            </label>
            <ErrorNotice error={task.error} />
            <button className="primary wide" disabled={task.busy}>
              Add category
            </button>
          </form>
        </Dialog>
      )}
      {selectedIndex >= 0 && (
        <Viewer
          key={images[selectedIndex].id}
          image={images[selectedIndex]}
          vault={initial.vault}
          categories={catalog.categories}
          admin={admin && !task.busy}
          position={`${selectedIndex + 1} / ${images.length}`}
          onClose={() => setSelected(null)}
          previous={selectedIndex > 0 ? () => setSelected(images[selectedIndex - 1].id) : undefined}
          next={
            selectedIndex < images.length - 1
              ? () => setSelected(images[selectedIndex + 1].id)
              : undefined
          }
          save={async (changes) => {
            await save({
              ...catalog,
              images: catalog.images.map((i) => (i.id === selected ? { ...i, ...changes } : i)),
            });
          }}
          remove={async () => {
            await save({ ...catalog, images: catalog.images.filter((i) => i.id !== selected) });
            setSelected(null);
          }}
        />
      )}
      {devices && <Devices user={user} onClose={() => setDevices(false)} />}
    </div>
  );
}
function Viewer({
  image,
  vault,
  categories,
  admin,
  position,
  onClose,
  previous,
  next,
  save,
  remove,
}: {
  image: ImageEntry;
  vault: VaultKey;
  categories: string[];
  admin: boolean;
  position: string;
  onClose: () => void;
  previous?: () => void;
  next?: () => void;
  save: (changes: Pick<ImageEntry, 'name' | 'category'>) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const { url, error } = useImage(image.preview, vault);
  const [zoom, setZoom] = useState(false),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(image.name),
    [category, setCategory] = useState(image.category);
  const startX = useRef(0),
    task = useTask();
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
      if (event.key === 'ArrowRight') next?.();
      if (event.key === 'ArrowLeft') previous?.();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [previous, next]);
  return (
    <Dialog title={image.name} onClose={onClose} className="viewer-dialog">
      <div
        className={`viewer-image ${zoom ? 'zoomed' : ''}`}
        onTouchStart={(e) => {
          startX.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          if (zoom) return;
          const delta = e.changedTouches[0].clientX - startX.current;
          if (delta > 70) previous?.();
          else if (delta < -70) next?.();
        }}
      >
        {url ? (
          <img src={url} alt={image.name} onDoubleClick={() => setZoom(!zoom)} />
        ) : (
          <p role="status">{error || 'Opening image…'}</p>
        )}
        <button
          className="viewer-prev icon-button"
          aria-label="Previous image"
          onClick={previous}
          disabled={!previous}
        >
          <Icon name="arrow" />
        </button>
        <button
          className="viewer-next icon-button"
          aria-label="Next image"
          onClick={next}
          disabled={!next}
        >
          <Icon name="arrow" />
        </button>
      </div>
      <div className="viewer-toolbar">
        <span>
          {position}{' '}
          <span className="muted">
            · {image.width} × {image.height} · {formatBytes(image.bytes)}
          </span>
        </span>
        <div>
          <button onClick={() => setZoom(!zoom)}>{zoom ? 'Fit image' : 'Zoom preview'}</button>
          <button
            disabled={task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                const ciphertext = await fetchObject(image.original.id, signal);
                const bytes = await decryptObject(vault, image.original, ciphertext);
                signal.throwIfAborted();
                const link = document.createElement('a'),
                  downloadURL = URL.createObjectURL(new Blob([bytes], { type: image.mime }));
                bytes.fill(0);
                link.href = downloadURL;
                link.download = image.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(downloadURL), 1000);
              })
            }
          >
            <Icon name="download" size={17} />
            Download original
          </button>
          {admin && <button onClick={() => setEditing(!editing)}>Edit details</button>}
        </div>
      </div>
      <ErrorNotice error={task.error} />
      {editing && (
        <form
          className="edit-details"
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              await save({ name: name.trim(), category });
              setEditing(false);
            });
          }}
        >
          <label>
            Filename
            <input
              value={name}
              maxLength={512}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={task.busy}>
            Save details
          </button>
          <button
            type="button"
            className="danger"
            disabled={task.busy}
            onClick={() => (confirmDelete ? void task.run(remove) : setConfirmDelete(true))}
          >
            {confirmDelete ? 'Confirm removal' : 'Remove image'}
          </button>
          {confirmDelete && (
            <p className="muted">
              This removes the image from the gallery. Encrypted copies remain on the server and in
              backups until maintenance removes them.
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
function Devices({ user, onClose }: { user: NonNullable<Status['user']>; onClose: () => void }) {
  type Device = { id: string; label: string; role: string; ip: string };
  const [devices, setDevices] = useState<Device[]>([]),
    [ip, setIP] = useState(''),
    [role, setRole] = useState('viewer'),
    [invite, setInvite] = useState('');
  const task = useTask();
  useEffect(() => {
    void task.run(async (signal) =>
      setDevices(await api<Device[]>('/devices', 'GET', undefined, signal)),
    );
  }, []);
  return (
    <Dialog title="Your devices" onClose={onClose}>
      <p className="muted">
        Create a code here, then open this website on the new device. It will need your vault
        passphrase too.
      </p>
      <ul className="device-list">
        {devices.map((device) => (
          <li key={device.id}>
            <div>
              <strong>
                {device.label}
                {device.id === user.id ? ' · this device' : ''}
              </strong>
              <span>
                {device.role === 'admin' ? 'Upload & manage' : 'Viewing access'} · {device.ip}
              </span>
            </div>
            {device.id !== user.id && (
              <button
                className="danger"
                disabled={task.busy}
                onClick={() =>
                  void task.run(async (signal) => {
                    await api(
                      `/devices/${encodeURIComponent(device.id)}`,
                      'DELETE',
                      undefined,
                      signal,
                    );
                    setDevices(devices.filter((d) => d.id !== device.id));
                  })
                }
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void task.run(async (signal) => {
            const result = await api<{ token: string }>(
              '/invitations',
              'POST',
              { ip, role },
              signal,
            );
            setInvite(result.token);
          });
        }}
      >
        <label>
          New device's Tailscale IP
          <input
            value={ip}
            onChange={(e) => setIP(e.target.value)}
            placeholder="100.x.x.x"
            required
            spellCheck={false}
          />
        </label>
        <label>
          Access
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">View images</option>
            <option value="admin">Upload and manage devices</option>
          </select>
        </label>
        <ErrorNotice error={task.error} />
        <button className="primary wide" disabled={task.busy}>
          Create enrollment code
        </button>
      </form>
      {invite && (
        <div className="invite-result">
          <p>Enter this code on the new device within 10 minutes.</p>
          <output className="recovery-secret">{invite}</output>
        </div>
      )}
      <p className="muted small">
        Revoking a passkey ends its sessions. Remove a lost device from Tailscale as well.
      </p>
    </Dialog>
  );
}
