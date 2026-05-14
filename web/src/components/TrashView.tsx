import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FileMeta } from '../api';
import PreviewModal from './PreviewModal';

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

interface Props {
  onBack: () => void;
  onRefresh: () => void;
}

export default function TrashView({ onBack, onRefresh }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState<FileMeta | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listTrash();
      setFiles(list);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRestore(id: string) {
    setBusy(true);
    try {
      await api.restoreFile(id);
      await load();
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePermanentDelete(id: string) {
    if (!confirm('Permanently delete this file? This cannot be undone.')) return;
    setBusy(true);
    try {
      await api.permanentlyDeleteFile(id);
      await load();
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEmptyTrash() {
    if (!confirm(`Permanently delete ALL ${files.length} trashed files? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.emptyTrash();
      await load();
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="trash-view">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>🗑️ Trash</h2>
        {files.length > 0 && (
          <button className="btn-link danger" onClick={handleEmptyTrash} disabled={busy}>
            Empty trash ({files.length})
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {files.length === 0 ? (
        <p className="muted">Trash is empty.</p>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Trashed</th>
              <th>Auto-delete</th>
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
                <td>{fmtBytes(f.sizeBytes)}</td>
                <td>{(f as any).trashedAt ? new Date((f as any).trashedAt).toLocaleString() : '—'}</td>
                <td className="muted">
                  {(f as any).trashedAt ? (
                    (() => {
                      const daysLeft = Math.max(0, 30 - Math.floor((Date.now() - new Date((f as any).trashedAt).getTime()) / (1000 * 60 * 60 * 24)));
                      return daysLeft === 0 ? 'Today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
                    })()
                  ) : '—'}
                </td>
                <td className="actions">
                  <button className="btn-link" onClick={() => handleRestore(f.id)} disabled={busy}>
                    Restore
                  </button>
                  <button className="btn-link danger" onClick={() => handlePermanentDelete(f.id)} disabled={busy}>
                    Delete forever
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {previewing && (
        <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />
      )}
    </section>
  );
}
