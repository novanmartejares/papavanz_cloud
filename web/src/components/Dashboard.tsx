import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type FileMeta,
  type FolderMeta,
  type Me,
} from '../api';

interface Props {
  me: Me;
  onMeChange: (me: Me) => void;
}

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

export default function Dashboard({ me, onMeChange }: Props) {
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragActive, setDragActive] = useState(false);
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

  async function handleUpload(file: File) {
    setError(null);
    setUploading(true);
    setProgress(0);
    try {
      await api.uploadFile(file, currentFolderId, setProgress);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 413
            ? `Storage full — this file would exceed your ${fmtBytes(me.storageQuota)} quota.`
            : err.message,
        );
      } else {
        setError('Upload failed');
      }
    } finally {
      setUploading(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = '';
    }
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
      // If we just deleted the current folder, walk back to its parent (or root).
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

  // Drag-and-drop from OS / desktop into the upload zone.
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  }

  const subfolders = useMemo(
    () => folders.filter((f) => f.parentId === currentFolderId),
    [folders, currentFolderId],
  );
  const breadcrumb = useMemo(
    () => breadcrumbFor(folders, currentFolderId),
    [folders, currentFolderId],
  );

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
              disabled={currentFolderId === null}
            >
              Home
            </button>
            {breadcrumb.map((f) => (
              <span key={f.id} className="crumb">
                <span className="crumb-sep">/</span>
                <button
                  className="btn-link"
                  onClick={() => setCurrentFolderId(f.id)}
                  disabled={f.id === currentFolderId}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="actions-row">
            <button
              type="button"
              className="btn-link"
              onClick={() => setCreatingFolder(true)}
            >
              + New folder
            </button>
            <label className="btn-primary">
              <input
                ref={inputRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
              />
              {uploading ? `Uploading… ${progress.toFixed(0)}%` : 'Upload'}
            </label>
          </div>
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

        {uploading && (
          <div className="quota-bar small">
            <div className="quota-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {dragActive && (
          <p className="muted drop-hint">Drop to upload into this folder</p>
        )}

        {subfolders.length === 0 && files.length === 0 ? (
          <p className="muted">
            This folder is empty. Drag a file here, click Upload, or create a subfolder.
          </p>
        ) : (
          <table className="files">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subfolders.map((f) => (
                <tr key={f.id} className="folder-row">
                  <td className="filename">
                    <button className="btn-link folder-name" onClick={() => setCurrentFolderId(f.id)}>
                      <span aria-hidden>📁</span> {f.name}
                    </button>
                  </td>
                  <td className="muted">—</td>
                  <td>{new Date(f.createdAt).toLocaleString()}</td>
                  <td className="actions">
                    <button className="btn-link" onClick={() => handleRenameFolder(f.id, f.name)}>
                      Rename
                    </button>
                    <button
                      className="btn-link danger"
                      onClick={() => handleDeleteFolder(f.id, f.name)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {files.map((f) => (
                <tr key={f.id}>
                  <td className="filename">{f.originalName}</td>
                  <td>{fmtBytes(f.sizeBytes)}</td>
                  <td>{new Date(f.createdAt).toLocaleString()}</td>
                  <td className="actions">
                    <a href={api.downloadUrl(f.id)} className="btn-link">
                      Download
                    </a>
                    <button className="btn-link" onClick={() => handleMoveFile(f.id)}>
                      Move
                    </button>
                    <button className="btn-link danger" onClick={() => handleDeleteFile(f.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function pathFor(folders: FolderMeta[], id: string): string {
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
