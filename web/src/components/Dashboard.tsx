import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type FileMeta,
  type FolderMeta,
  type Me,
} from '../api';
import PreviewModal from './PreviewModal';

interface Props {
  me: Me;
  onMeChange: (me: Me) => void;
}

type ViewMode = 'list' | 'grid';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

// Build the breadcrumb chain (root → ... → current) from a flat folder list.
function breadcrumbFor(folders: FolderMeta[], currentId: string | null): FolderMeta[] {
  if (!currentId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: FolderMeta[] = [];
  let cursor: string | null = currentId;
  while (cursor) {
    const f = byId.get(cursor);
    if (!f) break;
    chain.unshift(f);
    cursor = f.parentId;
  }
  return chain;
}

function pathFor(folders: FolderMeta[], id: string | null): string {
  if (!id) return '/';
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cursor: string | null = id;
  while (cursor) {
    const f = byId.get(cursor);
    if (!f) break;
    parts.unshift(f.name);
    cursor = f.parentId;
  }
  return '/' + parts.join('/');
}

function isImage(file: FileMeta): boolean {
  const mime = (file.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const ext = file.originalName.toLowerCase().split('.').pop() ?? '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext);
}

interface UploadProgress {
  total: number;
  done: number;
  currentName: string;
  currentPct: number;
}

export default function Dashboard({ me, onMeChange }: Props) {
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewMode>('list');
  const [previewing, setPreviewing] = useState<FileMeta | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [searchResults, setSearchResults] = useState<FileMeta[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [folderList, fileList, current] = await Promise.all([
        api.listFolders(),
        api.listFiles(currentFolderId),
        api.me(),
      ]);
      setFolders(folderList);
      setFiles(fileList);
      onMeChange(current);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, [currentFolderId, onMeChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reset selection when navigating between folders.
  useEffect(() => {
    setSelectedFileIds(new Set());
    setSelectedFolderIds(new Set());
  }, [currentFolderId]);

  // Debounced search: 250 ms after the last keystroke fire the API call.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (!trimmed) {
      setActiveSearch('');
      setSearchResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await api.listFiles(null, { q: trimmed });
        setActiveSearch(trimmed);
        setSearchResults(res);
      } catch (err) {
        if (err instanceof ApiError) setError(err.message);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  async function handleUploadMany(fileList: File[]) {
    if (fileList.length === 0) return;
    setError(null);
    const total = fileList.length;
    let done = 0;
    let lastError: ApiError | null = null;
    for (const file of fileList) {
      setUploadProgress({ total, done, currentName: file.name, currentPct: 0 });
      try {
        await api.uploadFile(file, currentFolderId, (pct) =>
          setUploadProgress({ total, done, currentName: file.name, currentPct: pct }),
        );
      } catch (err) {
        if (err instanceof ApiError) {
          lastError = err;
          if (err.status === 413) break;
        }
      }
      done++;
    }
    setUploadProgress(null);
    if (inputRef.current) inputRef.current.value = '';
    if (lastError) {
      setError(
        lastError.status === 413
          ? `Storage full — uploads stopped at ${done}/${total}.`
          : `Upload error: ${lastError.message} (${done}/${total} succeeded)`,
      );
    }
    await refresh();
  }

  async function handleDeleteFile(id: string) {
    if (!confirm('Delete this file? This cannot be undone.')) return;
    try {
      await api.deleteFile(id);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api.createFolder(name, currentFolderId);
      setNewFolderName('');
      setCreatingFolder(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleDeleteFolder(id: string, name: string) {
    if (
      !confirm(
        `Delete folder "${name}" and all its contents? This cannot be undone.`,
      )
    )
      return;
    try {
      await api.deleteFolder(id);
      if (id === currentFolderId) {
        const current = folders.find((f) => f.id === id);
        setCurrentFolderId(current?.parentId ?? null);
      }
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleRenameFolder(id: string, oldName: string) {
    const next = prompt('Rename folder', oldName);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await api.renameFolder(id, trimmed);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleMoveFile(id: string) {
    const choices = [
      { id: null as string | null, label: '/ (root)' },
      ...folders.map((f) => ({ id: f.id, label: pathFor(folders, f.id) })),
    ].filter((c) => c.id !== currentFolderId);

    const message =
      'Move to which folder?\n\n' +
      choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    const raw = prompt(message, '1');
    if (raw === null) return;
    const idx = parseInt(raw, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) return;
    try {
      await api.moveFile(id, choices[idx].id);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const list = Array.from(e.dataTransfer.files ?? []);
    if (list.length > 0) handleUploadMany(list);
  }

  function toggleFile(id: string) {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFolder(id: string) {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedFileIds(new Set());
    setSelectedFolderIds(new Set());
  }

  const subfolders = useMemo(
    () => folders.filter((f) => f.parentId === currentFolderId),
    [folders, currentFolderId],
  );
  const breadcrumb = useMemo(
    () => breadcrumbFor(folders, currentFolderId),
    [folders, currentFolderId],
  );
  const inSearchMode = activeSearch.length > 0;

  const allChecked =
    !inSearchMode &&
    subfolders.length + files.length > 0 &&
    subfolders.every((f) => selectedFolderIds.has(f.id)) &&
    files.every((f) => selectedFileIds.has(f.id));
  const someChecked = selectedFileIds.size + selectedFolderIds.size > 0;

  function toggleAll() {
    if (allChecked) {
      clearSelection();
    } else {
      setSelectedFolderIds(new Set(subfolders.map((f) => f.id)));
      setSelectedFileIds(new Set(files.map((f) => f.id)));
    }
  }

  async function handleBulkDelete() {
    const fileCount = selectedFileIds.size;
    const folderCount = selectedFolderIds.size;
    if (fileCount + folderCount === 0) return;
    const parts = [];
    if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
    if (folderCount)
      parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'} (with contents)`);
    if (!confirm(`Delete ${parts.join(' and ')}? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await api.bulkDelete([...selectedFileIds], [...selectedFolderIds]);
      clearSelection();
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkDownload() {
    if (selectedFileIds.size + selectedFolderIds.size === 0) return;
    setBusy(true);
    try {
      await api.bulkDownload([...selectedFileIds], [...selectedFolderIds]);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function jumpToFolder(folderId: string | null) {
    setSearchInput('');
    setCurrentFolderId(folderId);
  }

  const pct = Math.min(100, (me.storageUsed / me.storageQuota) * 100);
  const overWarn = pct >= 90;

  return (
    <section className="dashboard">
      <div className="card">
        <h2>Storage</h2>
        <div className="quota">
          <div className="quota-bar">
            <div
              className={`quota-fill ${overWarn ? 'warn' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="muted">
            {fmtBytes(me.storageUsed)} of {fmtBytes(me.storageQuota)} used ({pct.toFixed(1)}%)
          </p>
        </div>
      </div>

      <div
        className={`card ${dragActive ? 'drag-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="row">
          <nav className="breadcrumb">
            <button
              className="btn-link"
              onClick={() => setCurrentFolderId(null)}
              disabled={currentFolderId === null && !inSearchMode}
            >
              Home
            </button>
            {breadcrumb.map((f) => (
              <span key={f.id} className="crumb">
                <span className="crumb-sep">/</span>
                <button
                  className="btn-link"
                  onClick={() => setCurrentFolderId(f.id)}
                  disabled={f.id === currentFolderId && !inSearchMode}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="actions-row">
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                className={`btn-link ${view === 'list' ? 'active' : ''}`}
                onClick={() => setView('list')}
                aria-pressed={view === 'list'}
                title="List view"
              >
                ☰
              </button>
              <button
                type="button"
                className={`btn-link ${view === 'grid' ? 'active' : ''}`}
                onClick={() => setView('grid')}
                aria-pressed={view === 'grid'}
                title="Gallery view"
              >
                ▦
              </button>
            </div>
            <button
              type="button"
              className="btn-link"
              onClick={() => setCreatingFolder(true)}
              disabled={inSearchMode}
            >
              + New folder
            </button>
            <label className="btn-primary">
              <input
                ref={inputRef}
                type="file"
                hidden
                multiple
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  if (list.length > 0) handleUploadMany(list);
                }}
              />
              {uploadProgress
                ? `Uploading ${uploadProgress.done + 1}/${uploadProgress.total}…`
                : 'Upload'}
            </label>
          </div>
        </div>

        <div className="search-row">
          <input
            type="search"
            className="search-input"
            placeholder="Search files by name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {inSearchMode && (
            <button className="btn-link" onClick={() => setSearchInput('')}>
              Clear search
            </button>
          )}
        </div>

        {creatingFolder && (
          <form className="inline-form" onSubmit={handleCreateFolder}>
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit">Create</button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setCreatingFolder(false);
                setNewFolderName('');
              }}
            >
              Cancel
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}

        {uploadProgress && (
          <div className="upload-progress">
            <p className="muted small">
              {uploadProgress.currentName} — {uploadProgress.currentPct.toFixed(0)}%
            </p>
            <div className="quota-bar small">
              <div
                className="quota-fill"
                style={{ width: `${uploadProgress.currentPct}%` }}
              />
            </div>
          </div>
        )}

        {dragActive && (
          <p className="muted drop-hint">Drop to upload into this folder</p>
        )}

        {someChecked && !inSearchMode && (
          <div className="selection-bar">
            <span>
              {selectedFileIds.size + selectedFolderIds.size} selected
              {selectedFolderIds.size > 0 && ' (folders include their contents)'}
            </span>
            <div className="selection-actions">
              <button
                type="button"
                className="btn-link"
                onClick={handleBulkDownload}
                disabled={busy}
              >
                Download zip
              </button>
              <button
                type="button"
                className="btn-link danger"
                onClick={handleBulkDelete}
                disabled={busy}
              >
                Delete
              </button>
              <button type="button" className="btn-link" onClick={clearSelection}>
                Clear
              </button>
            </div>
          </div>
        )}

        {inSearchMode ? (
          <SearchResults
            results={searchResults}
            folders={folders}
            query={activeSearch}
            onJump={jumpToFolder}
            onPreview={setPreviewing}
            onDelete={async (id) => {
              await handleDeleteFile(id);
              const next = await api.listFiles(null, { q: activeSearch });
              setSearchResults(next);
            }}
          />
        ) : view === 'list' ? (
          <ListView
            subfolders={subfolders}
            files={files}
            allChecked={allChecked}
            someChecked={someChecked}
            selectedFileIds={selectedFileIds}
            selectedFolderIds={selectedFolderIds}
            onToggleAll={toggleAll}
            onToggleFolder={toggleFolder}
            onToggleFile={toggleFile}
            onOpenFolder={(id) => setCurrentFolderId(id)}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onPreview={setPreviewing}
            onMoveFile={handleMoveFile}
            onDeleteFile={handleDeleteFile}
          />
        ) : (
          <GridView
            subfolders={subfolders}
            files={files}
            selectedFileIds={selectedFileIds}
            selectedFolderIds={selectedFolderIds}
            onToggleFolder={toggleFolder}
            onToggleFile={toggleFile}
            onOpenFolder={(id) => setCurrentFolderId(id)}
            onPreview={setPreviewing}
          />
        )}
      </div>

      {previewing && (
        <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />
      )}
    </section>
  );
}

// --- subviews ---------------------------------------------------------------

interface ListViewProps {
  subfolders: FolderMeta[];
  files: FileMeta[];
  allChecked: boolean;
  someChecked: boolean;
  selectedFileIds: Set<string>;
  selectedFolderIds: Set<string>;
  onToggleAll: () => void;
  onToggleFolder: (id: string) => void;
  onToggleFile: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string, name: string) => void;
  onPreview: (file: FileMeta) => void;
  onMoveFile: (id: string) => void;
  onDeleteFile: (id: string) => void;
}

function ListView(p: ListViewProps) {
  if (p.subfolders.length === 0 && p.files.length === 0) {
    return (
      <p className="muted">
        This folder is empty. Drag files here, click Upload, or create a subfolder.
      </p>
    );
  }
  return (
    <table className="files">
      <thead>
        <tr>
          <th className="checkbox-col">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={p.allChecked}
              ref={(el) => {
                if (el) el.indeterminate = !p.allChecked && p.someChecked;
              }}
              onChange={p.onToggleAll}
            />
          </th>
          <th>Name</th>
          <th>Size</th>
          <th>Modified</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {p.subfolders.map((f) => (
          <tr key={f.id} className="folder-row">
            <td className="checkbox-col">
              <input
                type="checkbox"
                aria-label={`Select folder ${f.name}`}
                checked={p.selectedFolderIds.has(f.id)}
                onChange={() => p.onToggleFolder(f.id)}
              />
            </td>
            <td className="filename">
              <button className="btn-link folder-name" onClick={() => p.onOpenFolder(f.id)}>
                <span aria-hidden>📁</span> {f.name}
              </button>
            </td>
            <td className="muted">—</td>
            <td>{new Date(f.createdAt).toLocaleString()}</td>
            <td className="actions">
              <button className="btn-link" onClick={() => p.onRenameFolder(f.id, f.name)}>
                Rename
              </button>
              <button
                className="btn-link danger"
                onClick={() => p.onDeleteFolder(f.id, f.name)}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
        {p.files.map((f) => (
          <tr key={f.id}>
            <td className="checkbox-col">
              <input
                type="checkbox"
                aria-label={`Select file ${f.originalName}`}
                checked={p.selectedFileIds.has(f.id)}
                onChange={() => p.onToggleFile(f.id)}
              />
            </td>
            <td className="filename">
              <button className="btn-link file-name" onClick={() => p.onPreview(f)}>
                {f.originalName}
              </button>
            </td>
            <td>{fmtBytes(f.sizeBytes)}</td>
            <td>{new Date(f.createdAt).toLocaleString()}</td>
            <td className="actions">
              <button className="btn-link" onClick={() => p.onPreview(f)}>
                Preview
              </button>
              <a href={api.downloadUrl(f.id)} className="btn-link">
                Download
              </a>
              <button className="btn-link" onClick={() => p.onMoveFile(f.id)}>
                Move
              </button>
              <button className="btn-link danger" onClick={() => p.onDeleteFile(f.id)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface GridViewProps {
  subfolders: FolderMeta[];
  files: FileMeta[];
  selectedFileIds: Set<string>;
  selectedFolderIds: Set<string>;
  onToggleFolder: (id: string) => void;
  onToggleFile: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onPreview: (file: FileMeta) => void;
}

function GridView(p: GridViewProps) {
  if (p.subfolders.length === 0 && p.files.length === 0) {
    return (
      <p className="muted">
        This folder is empty. Drag files here, click Upload, or create a subfolder.
      </p>
    );
  }
  return (
    <div className="grid">
      {p.subfolders.map((f) => (
        <div
          key={f.id}
          className={`tile folder-tile ${p.selectedFolderIds.has(f.id) ? 'selected' : ''}`}
        >
          <input
            type="checkbox"
            className="tile-check"
            aria-label={`Select folder ${f.name}`}
            checked={p.selectedFolderIds.has(f.id)}
            onChange={() => p.onToggleFolder(f.id)}
          />
          <button className="tile-body" onClick={() => p.onOpenFolder(f.id)}>
            <div className="tile-icon" aria-hidden>📁</div>
            <div className="tile-name">{f.name}</div>
          </button>
        </div>
      ))}
      {p.files.map((f) => (
        <div
          key={f.id}
          className={`tile ${p.selectedFileIds.has(f.id) ? 'selected' : ''}`}
        >
          <input
            type="checkbox"
            className="tile-check"
            aria-label={`Select file ${f.originalName}`}
            checked={p.selectedFileIds.has(f.id)}
            onChange={() => p.onToggleFile(f.id)}
          />
          <button className="tile-body" onClick={() => p.onPreview(f)}>
            {isImage(f) ? (
              <img className="tile-thumb" src={api.previewUrl(f.id)} alt={f.originalName} loading="lazy" />
            ) : (
              <div className="tile-icon" aria-hidden>📄</div>
            )}
            <div className="tile-name" title={f.originalName}>
              {f.originalName}
            </div>
            <div className="tile-meta">{fmtBytes(f.sizeBytes)}</div>
          </button>
        </div>
      ))}
    </div>
  );
}

interface SearchResultsProps {
  results: FileMeta[];
  folders: FolderMeta[];
  query: string;
  onJump: (id: string | null) => void;
  onPreview: (file: FileMeta) => void;
  onDelete: (id: string) => void;
}

function SearchResults(p: SearchResultsProps) {
  if (p.results.length === 0) {
    return <p className="muted">No matches for &ldquo;{p.query}&rdquo;.</p>;
  }
  return (
    <table className="files">
      <thead>
        <tr>
          <th>Name</th>
          <th>Location</th>
          <th>Size</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {p.results.map((f) => (
          <tr key={f.id}>
            <td className="filename">
              <button className="btn-link file-name" onClick={() => p.onPreview(f)}>
                {f.originalName}
              </button>
            </td>
            <td className="muted">
              <button className="btn-link" onClick={() => p.onJump(f.folderId)}>
                {pathFor(p.folders, f.folderId)}
              </button>
            </td>
            <td>{fmtBytes(f.sizeBytes)}</td>
            <td className="actions">
              <button className="btn-link" onClick={() => p.onPreview(f)}>
                Preview
              </button>
              <a href={api.downloadUrl(f.id)} className="btn-link">
                Download
              </a>
              <button className="btn-link danger" onClick={() => p.onDelete(f.id)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
