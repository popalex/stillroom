import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  sortOrderSchema,
  type Catalog,
  type ImageEntry,
  type ObjectRef,
  type Status,
  type Preferences,
  type SortOrder,
} from '../shared/protocol';
import { api, fetchObject, uploadObject } from './api';
import { decryptObject, encryptCatalog, encryptObject, type VaultKey } from './crypto/vault';
import { importImage, renderThumbnail, THUMBNAIL_EDGE } from './images';
import { sortImages } from './sorting';
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

function categoryName(value: string, categories: string[]) {
  const name = value.trim();
  if (!name || name.length > 80 || ['all', 'uncategorized'].includes(name.toLowerCase()))
    throw new Error('Choose a different category name.');
  if (categories.includes(name)) throw new Error('That category already exists.');
  return name;
}

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
  const [deletingCategory, setDeletingCategory] = useState<string | null>(null);
  const [devices, setDevices] = useState(false),
    [progress, setProgress] = useState(''),
    [share, setShare] = useState(0),
    [dragging, setDragging] = useState(false);
  const task = useTask(),
    fileInput = useRef<HTMLInputElement>(null);
  const admin = user.role === 'admin';
  const [sortOrder, setSortOrder] = useState<SortOrder>('date-desc');
  const [sortLoaded, setSortLoaded] = useState(false);
  const [sortLoadError, setSortLoadError] = useState('');
  const sortTask = useTask();
  useEffect(() => {
    const controller = new AbortController();
    void api<Preferences>('/preferences', 'GET', undefined, controller.signal)
      .then((preferences) => {
        if (!controller.signal.aborted) setSortOrder(preferences.sortOrder);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setSortLoadError(`Could not load the saved sort order. ${message(error)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSortLoaded(true);
      });
    return () => controller.abort();
  }, [user.id]);
  const [pendingDeletions, setPendingDeletions] = useState(0);
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    const check = () =>
      api<{ pending: number }>('/deletions', 'GET', undefined, controller.signal)
        .then((result) => setPendingDeletions(result.pending))
        .catch(() => {});
    void check();
    const timer = pendingDeletions > 0 ? setInterval(() => void check(), 30_000) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [admin, pendingDeletions]);
  const images = useMemo(
    () =>
      sortImages(
        catalog.images.filter(
          (image) =>
            (category === 'all' ||
              (category === 'uncategorized' ? !image.category : image.category === category)) &&
            image.name.toLowerCase().includes(search.toLowerCase()),
        ),
        sortOrder,
      ),
    [catalog, category, search, sortOrder],
  );
  const selectedIndex = images.findIndex((image) => image.id === selected);
  // The deletion dialog doubles as the one for uncategorized images, which is not
  // a category and so cannot collide with a real name.
  const deletingLoose = deletingCategory === 'uncategorized';
  const categoryImages = catalog.images.filter((image) =>
    deletingLoose ? !image.category : image.category === deletingCategory,
  );
  const save = async (next: Catalog, deleteObjects?: string[]) => {
    const encrypted = await encryptCatalog(initial.vault, next);
    task.signal.throwIfAborted();
    const objects = next.images.flatMap((image) => [
      image.original.id,
      image.thumbnail.id,
      image.preview.id,
    ]);
    const result = await api<{ revision: number; pending?: number }>(
      '/catalog',
      'PUT',
      { revision: revision.current, catalog: encrypted, objects, deleteObjects },
      task.signal,
    );
    task.signal.throwIfAborted();
    revision.current = result.revision;
    setCatalog(next);
    if (result.pending !== undefined) setPendingDeletions(result.pending);
  };
  const soft = catalog.images.filter((image) => (image.thumbEdge ?? 0) < THUMBNAIL_EDGE);
  // Images stored before THUMBNAIL_EDGE grew keep their smaller thumbnail until
  // it is rebuilt here, from the preview rather than the original.
  const sharpen = () =>
    void task.run(async (signal) => {
      let next = catalog;
      try {
        for (let index = 0; index < soft.length; index++) {
          const image = soft[index];
          setProgress(`${index + 1} / ${soft.length} · Rebuilding thumbnail · ${image.name}`);
          setShare(index / soft.length);
          const preview = await decryptObject(
            initial.vault,
            image.preview,
            await fetchObject(image.preview.id, signal),
          );
          signal.throwIfAborted();
          let thumbnail: Uint8Array | undefined;
          try {
            thumbnail = await renderThumbnail(preview);
          } finally {
            preview.fill(0);
          }
          const encrypted = await encryptObject(initial.vault, 'thumbnail', thumbnail);
          thumbnail.fill(0);
          signal.throwIfAborted();
          await uploadObject(encrypted.ref.id, encrypted.data, signal);
          encrypted.data.fill(0);
          const replaced = image.thumbnail.id;
          next = {
            ...next,
            images: next.images.map((entry) =>
              entry.id === image.id
                ? { ...entry, thumbnail: encrypted.ref, thumbEdge: THUMBNAIL_EDGE }
                : entry,
            ),
          };
          await save(next, [replaced]);
          setShare((index + 1) / soft.length);
        }
      } finally {
        if (!signal.aborted) {
          setProgress('');
          setShare(0);
        }
      }
    });
  const upload = (files: File[]) =>
    void task.run(async (signal) => {
      let next = catalog;
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const setPhase = (phase: string, done = 0) => {
            setProgress(`${index + 1} / ${files.length} · ${phase} · ${file.name}`);
            setShare((index + done) / files.length);
          };
          setPhase('Preparing');
          const image = await importImage(
            file,
            category === 'all' || category === 'uncategorized' ? '' : category,
            initial.vault,
            signal,
            setPhase,
          );
          signal.throwIfAborted();
          setPhase('Saving to collection', 0.95);
          next = { ...next, images: [image, ...next.images] };
          await save(next);
        }
      } finally {
        if (!signal.aborted) {
          setProgress('');
          setShare(0);
        }
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
            {admin &&
              (catalog.categories.includes(category) ||
                (category === 'uncategorized' &&
                  catalog.images.some((image) => !image.category))) && (
                <button
                  className="primary destructive"
                  disabled={task.busy}
                  onClick={() => {
                    task.setError('');
                    setDeletingCategory(category);
                  }}
                >
                  {category === 'uncategorized' ? 'Delete uncategorized' : 'Delete category'}
                </button>
              )}
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
          <label className="sort-label">
            Sort by
            <select
              value={sortOrder}
              disabled={!sortLoaded || sortTask.busy}
              aria-busy={sortTask.busy}
              onChange={(event) => {
                const next = sortOrderSchema.parse(event.currentTarget.value);
                void sortTask.run(async (signal) => {
                  const previous = sortOrder;
                  setSortOrder(next);
                  setSortLoadError('');
                  try {
                    await api<Preferences>('/preferences', 'PUT', { sortOrder: next }, signal);
                  } catch (error) {
                    if (!signal.aborted) setSortOrder(previous);
                    throw new Error(`Could not save the sort order. ${message(error)}`);
                  }
                });
              }}
            >
              <option value="date-desc">Date added: newest first</option>
              <option value="date-asc">Date added: oldest first</option>
              <option value="name-asc">Filename: A to Z</option>
              <option value="name-desc">Filename: Z to A</option>
            </select>
          </label>
          <span className="private-indicator">
            <span />
            Unlocked on this device
          </span>
        </div>
        <ErrorNotice error={task.error} />
        <ErrorNotice error={sortLoadError || sortTask.error} />
        {pendingDeletions > 0 && (
          <p role="alert">
            Removed from the gallery, but {pendingDeletions} encrypted files still need deletion.
            The server retries every 30 seconds. Check storage permissions if this message persists.
          </p>
        )}
        {admin && soft.length > 0 && !task.busy && (
          <div className="upload-progress">
            <span>
              {soft.length} {soft.length === 1 ? 'thumbnail was' : 'thumbnails were'} made at a
              lower resolution and look soft on this screen.
            </span>
            <button onClick={sharpen}>Rebuild thumbnails</button>
          </div>
        )}
        {progress && (
          <div className="upload-progress">
            <span className="spinner" />
            <span role="status">{progress}</span>
            <span
              className="progress-track"
              role="progressbar"
              aria-label="Progress"
              aria-valuenow={Math.round(share * 100)}
            >
              <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
            </span>
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
      {deletingCategory !== null && (
        <Dialog
          title={deletingLoose ? 'Delete uncategorized images' : 'Delete category'}
          onClose={() => !task.busy && setDeletingCategory(null)}
        >
          <p>
            {deletingLoose ? (
              <>
                Permanently delete all {categoryImages.length} uncategorized{' '}
                {categoryImages.length === 1 ? 'image' : 'images'}?
              </>
            ) : (
              <>
                Permanently delete "{deletingCategory}" and all {categoryImages.length}{' '}
                {categoryImages.length === 1 ? 'image' : 'images'} in it?
              </>
            )}
          </p>
          <p className="muted">
            This includes images hidden by search. Originals, previews, and thumbnails will be
            deleted from this server. You cannot undo this. Separate backups and downloaded copies
            are not deleted.
          </p>
          <ErrorNotice error={task.error} />
          <div className="dialog-actions">
            <button disabled={task.busy} onClick={() => setDeletingCategory(null)}>
              Cancel
            </button>
            <button
              className="primary destructive"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  const objects = categoryImages.flatMap((image) => [
                    image.original.id,
                    image.thumbnail.id,
                    image.preview.id,
                  ]);
                  await save(
                    {
                      ...catalog,
                      categories: deletingLoose
                        ? catalog.categories
                        : catalog.categories.filter((name) => name !== deletingCategory),
                      images: catalog.images.filter((image) =>
                        deletingLoose ? image.category : image.category !== deletingCategory,
                      ),
                    },
                    objects.length ? objects : undefined,
                  );
                  setSelected(null);
                  setCategory('all');
                  setSearch('');
                  setDeletingCategory(null);
                })
              }
            >
              {task.busy
                ? 'Deleting…'
                : deletingLoose
                  ? 'Permanently delete images'
                  : 'Permanently delete category'}
            </button>
          </div>
        </Dialog>
      )}
      {addingCategory && (
        <Dialog title="Add a category" onClose={() => setAddingCategory(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                const name = categoryName(newCategory, catalog.categories);
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
          admin={admin}
          busy={task.busy}
          position={`${selectedIndex + 1} / ${images.length}`}
          onClose={() => setSelected(null)}
          previous={selectedIndex > 0 ? () => setSelected(images[selectedIndex - 1].id) : undefined}
          next={
            selectedIndex < images.length - 1
              ? () => setSelected(images[selectedIndex + 1].id)
              : undefined
          }
          save={async (changes, newCategory) => {
            await save({
              ...catalog,
              categories: newCategory
                ? [...catalog.categories, categoryName(newCategory, catalog.categories)]
                : catalog.categories,
              images: catalog.images.map((i) => (i.id === selected ? { ...i, ...changes } : i)),
            });
          }}
          remove={async () => {
            const image = images[selectedIndex];
            await save({ ...catalog, images: catalog.images.filter((i) => i.id !== selected) }, [
              image.original.id,
              image.thumbnail.id,
              image.preview.id,
            ]);
            setSelected(null);
          }}
        />
      )}
      {devices && <Devices user={user} onClose={() => setDevices(false)} />}
    </div>
  );
}
const MAX_ZOOM = 8;
type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
// Pointer-driven zoom: wheel and pinch zoom around the cursor, drag pans, double
// click toggles. `x` and `y` are the image's offset from the centre of the frame.
function useZoom(imageID: string, swipe: (direction: -1 | 1) => void) {
  const frame = useRef<HTMLDivElement>(null),
    picture = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(FIT),
    [smooth, setSmooth] = useState(false),
    [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    spread = useRef(0),
    gesture = useRef({ x: 0, at: 0, moved: false, tapped: 0, toggled: 0 });
  const hold = (next: View): View => {
    const scale = Math.min(Math.max(next.scale, 1), MAX_ZOOM),
      box = frame.current,
      img = picture.current;
    if (!box || !img || scale === 1) return { scale, x: 0, y: 0 };
    const roomX = Math.max(0, (img.clientWidth * scale - box.clientWidth) / 2),
      roomY = Math.max(0, (img.clientHeight * scale - box.clientHeight) / 2);
    return {
      scale,
      x: Math.min(Math.max(next.x, -roomX), roomX),
      y: Math.min(Math.max(next.y, -roomY), roomY),
    };
  };
  const zoom = (
    target: number | ((scale: number) => number),
    at: { x: number; y: number } = { x: 0, y: 0 },
    animate = false,
  ) => {
    setSmooth(animate);
    setView((current) => {
      const wanted = typeof target === 'function' ? target(current.scale) : target,
        scale = Math.min(Math.max(wanted, 1), MAX_ZOOM),
        ratio = scale / current.scale;
      return hold({
        scale,
        x: at.x - ratio * (at.x - current.x),
        y: at.y - ratio * (at.y - current.y),
      });
    });
  };
  const pointAt = (point: { clientX: number; clientY: number }) => {
    const box = frame.current!.getBoundingClientRect();
    return {
      x: point.clientX - box.left - box.width / 2,
      y: point.clientY - box.top - box.height / 2,
    };
  };
  const toggle = (at: { x: number; y: number }) =>
    view.scale > 1 ? zoom(1, at, true) : zoom(2.5, at, true);
  const middle = () => {
    const [a, b] = [...pointers.current.values()];
    const box = frame.current!.getBoundingClientRect();
    return {
      x: (a.x + b.x) / 2 - box.left - box.width / 2,
      y: (a.y + b.y) / 2 - box.top - box.height / 2,
      apart: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };
  useEffect(() => {
    setSmooth(false);
    setView(FIT);
  }, [imageID]);
  useEffect(() => {
    const box = frame.current;
    if (!box) return;
    // A rotated phone or a resized window changes how much room the image has to pan.
    const observer = new ResizeObserver(() => setView((current) => hold(current)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const box = frame.current;
    if (!box) return;
    // React listens for wheel passively, so preventDefault needs our own listener.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom((scale) => scale * Math.exp(-event.deltaY * 0.002), pointAt(event));
    };
    box.addEventListener('wheel', wheel, { passive: false });
    return () => box.removeEventListener('wheel', wheel);
  }, []);
  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      if ((event.target as HTMLElement).closest('button')) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) spread.current = middle().apart;
      if (pointers.current.size !== 1) return;
      gesture.current = { ...gesture.current, x: event.clientX, at: Date.now(), moved: false };
      if (view.scale > 1) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const last = pointers.current.get(event.pointerId);
      if (!last) return;
      const moved = { x: event.clientX - last.x, y: event.clientY - last.y };
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (Math.abs(moved.x) > 2 || Math.abs(moved.y) > 2) gesture.current.moved = true;
      if (pointers.current.size === 2) {
        const { x, y, apart } = middle(),
          factor = spread.current > 0 ? apart / spread.current : 1;
        spread.current = apart;
        if (factor !== 1) zoom((scale) => scale * factor, { x, y });
        return;
      }
      if (pointers.current.size === 1 && view.scale > 1) {
        setSmooth(false);
        setView((current) => hold({ ...current, x: current.x + moved.x, y: current.y + moved.y }));
      }
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = pointers.current.get(event.pointerId);
      const alone = pointers.current.size === 1;
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) spread.current = 0;
      setPanning(false);
      if (!start || !alone || event.pointerType === 'mouse') return;
      const { x, at, moved, tapped } = gesture.current,
        travelled = event.clientX - x;
      if (view.scale === 1 && moved && Math.abs(travelled) > 70)
        return swipe(travelled > 0 ? -1 : 1);
      if (moved) return;
      const now = Date.now();
      gesture.current.tapped = now;
      if (now - tapped < 320 && now - at < 320) {
        gesture.current.toggled = now;
        toggle(pointAt(event));
      }
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) spread.current = 0;
      setPanning(false);
    },
    // A double tap also reaches us as a synthesised dblclick, which would undo the toggle.
    onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (Date.now() - gesture.current.toggled < 400) return;
      toggle(pointAt(event));
    },
  };
  return { frame, picture, view, smooth, panning, zoom, handlers };
}
function Viewer({
  image,
  vault,
  categories,
  admin,
  busy,
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
  busy: boolean;
  position: string;
  onClose: () => void;
  previous?: () => void;
  next?: () => void;
  save: (changes: Pick<ImageEntry, 'name' | 'category'>, newCategory?: string) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const { url, error } = useImage(image.preview, vault);
  const { frame, picture, view, smooth, panning, zoom, handlers } = useZoom(
    image.id,
    (direction) => (direction < 0 ? previous?.() : next?.()),
  );
  const [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(image.name),
    [category, setCategory] = useState(image.category);
  const [creatingCategory, setCreatingCategory] = useState(false),
    [newCategory, setNewCategory] = useState('');
  const task = useTask();
  const detailsRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!editing) return;
    detailsRef.current?.focus({ preventScroll: true });
    detailsRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [editing, confirmDelete]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
      if (event.key === 'ArrowRight') next?.();
      if (event.key === 'ArrowLeft') previous?.();
      if (event.key === '+' || event.key === '=')
        zoom((scale) => scale * 1.5, { x: 0, y: 0 }, true);
      if (event.key === '-') zoom((scale) => scale / 1.5, { x: 0, y: 0 }, true);
      if (event.key === '0') zoom(1, { x: 0, y: 0 }, true);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [previous, next, zoom]);
  return (
    <Dialog title={image.name} onClose={onClose} className="viewer-dialog">
      <div
        ref={frame}
        className={`viewer-image${view.scale > 1 ? ' zoomed' : ''}${panning ? ' panning' : ''}${
          smooth ? ' smooth' : ''
        }`}
        {...handlers}
      >
        {url ? (
          <img
            ref={picture}
            src={url}
            alt={image.name}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
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
          <span className="zoom-controls">
            <button
              className="icon-button"
              aria-label="Zoom out"
              disabled={view.scale === 1}
              onClick={() => zoom((scale) => scale / 1.5, { x: 0, y: 0 }, true)}
            >
              <Icon name="out" size={18} />
            </button>
            <button
              className="zoom-level text-button"
              aria-label="Fit image to the window"
              disabled={view.scale === 1}
              onClick={() => zoom(1, { x: 0, y: 0 }, true)}
            >
              {view.scale === 1 ? 'Fit' : `${Math.round(view.scale * 100)}%`}
            </button>
            <button
              className="icon-button"
              aria-label="Zoom in"
              disabled={view.scale === MAX_ZOOM}
              onClick={() => zoom((scale) => scale * 1.5, { x: 0, y: 0 }, true)}
            >
              <Icon name="in" size={18} />
            </button>
          </span>
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
          {admin && (
            <span className="image-admin-actions">
              <button
                aria-expanded={editing}
                disabled={busy}
                aria-controls="image-details"
                onClick={() => setEditing(!editing)}
              >
                Edit details
              </button>
              <button
                className="danger"
                disabled={busy || task.busy}
                onClick={() => {
                  setEditing(true);
                  setConfirmDelete(true);
                }}
              >
                Delete
              </button>
            </span>
          )}
        </div>
      </div>
      {!editing && <ErrorNotice error={task.error} />}
      {editing && (
        <form
          ref={detailsRef}
          id="image-details"
          className="edit-details"
          aria-label="Image details"
          tabIndex={-1}
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              const addedCategory = creatingCategory
                ? categoryName(newCategory, categories)
                : undefined;
              await save({ name: name.trim(), category: addedCategory ?? category }, addedCategory);
              if (addedCategory) setCategory(addedCategory);
              setCreatingCategory(false);
              setNewCategory('');
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
          <div className="category-field">
            {creatingCategory ? (
              <label>
                New category name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Uncategorized</option>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              disabled={task.busy}
              onClick={() => {
                task.setError('');
                setCreatingCategory(!creatingCategory);
              }}
            >
              {creatingCategory ? 'Use existing category' : 'New category'}
            </button>
          </div>
          <button className="primary" disabled={busy || task.busy}>
            Save details
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || task.busy}
            onClick={() => (confirmDelete ? void task.run(remove) : setConfirmDelete(true))}
          >
            {confirmDelete ? 'Confirm permanent deletion' : 'Permanently delete'}
          </button>
          <div className="details-error">
            <ErrorNotice error={task.error} />
          </div>
          {confirmDelete && (
            <div className="delete-confirmation">
              <p>
                This permanently deletes the original, preview, and thumbnail from this server. You
                cannot undo it. Separate backups and downloaded copies are not deleted.
              </p>
              <button type="button" disabled={task.busy} onClick={() => setConfirmDelete(false)}>
                Cancel deletion
              </button>
            </div>
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
