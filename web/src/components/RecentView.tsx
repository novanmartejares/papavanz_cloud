import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FileMeta, type FolderMeta } from '../api';
import PreviewModal from './PreviewModal';
import VersionsModal from './VersionsModal';

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

interface Props {
  onBack: () => void;
  onJumpToFolder: (folderId: string | null) => void;
}

export default function RecentView({ onBack, onJumpToFolder }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<FileMeta | null>(null);
  const [versioning, setVersioning] = useState<FileMeta | null>(null);

  const load = useCallback(async () => {
    try {
      const [recent, allFolders] = await Promise.all([api.listFiles(null, { recent: true }), api.listFolders()]);
      setFiles(recent);
      setFolders(allFolders);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRenameFile(id: string, oldName: string) {
    const next = prompt('Rename file', oldName); if (next === null) return;
    const trimmed = next.trim(); if (!trimmed || trimmed === oldName) return;
    try { await api.renameFile(id, trimmed); await load(); }
    catch (err) { if (err instanceof ApiError) setError(err.message); }
  }

  async function handleDelete(id: string) {
    try { await api.deleteFile(id); await load(); }
    catch (err) { if (err instanceof ApiError) setError(err.message); }
  }

  return (
    <section className="starred-view">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>⏱️ Recent Files</h2>
      </div>

      {error && <p className="error">{error}</p>}

      {files.length === 0 ? (
        <p className="muted">No recent files found.</p>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>Name</th>
              <th>Location</th>
              <th>Modified</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="filename">
                  <button className="btn-link file-name" onClick={() => setPreviewing(f)}>
                    {f.originalName}
                  </button>
                </td>
                <td className="muted">
                  <button className="btn-link" onClick={() => onJumpToFolder(f.folderId)}>
                    {pathFor(folders, f.folderId)}
                  </button>
                </td>
                <td>{new Date(f.createdAt).toLocaleString()}</td>
                <td>{fmtBytes(f.sizeBytes)}</td>
                <td className="actions">
                  <button className="btn-link" onClick={() => setPreviewing(f)}>Preview</button>
                  <button className="btn-link" onClick={() => setVersioning(f)}>Versions</button>
                  <button className="btn-link" onClick={() => handleRenameFile(f.id, f.originalName)}>Rename</button>
                  <a href={api.downloadUrl(f.id)} className="btn-link">Download</a>
                  <button className="btn-link danger" onClick={() => handleDelete(f.id)}>Trash</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {previewing && (
        <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />
      )}
      {versioning && (
        <VersionsModal file={versioning} onClose={() => setVersioning(null)} />
      )}
    </section>
  );
}
