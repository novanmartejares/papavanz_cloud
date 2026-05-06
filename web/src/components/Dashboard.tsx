import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type FileMeta, type Me } from '../api';

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

export default function Dashboard({ me, onMeChange }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([api.listFiles(), api.me()]);
      setFiles(list);
      onMeChange(current);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, [onMeChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleUpload(file: File) {
    setError(null);
    setUploading(true);
    setProgress(0);
    try {
      await api.uploadFile(file, setProgress);
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

  async function handleDelete(id: string) {
    if (!confirm('Delete this file? This cannot be undone.')) return;
    try {
      await api.deleteFile(id);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
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

      <div className="card">
        <div className="row">
          <h2>Your files</h2>
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

        {error && <p className="error">{error}</p>}

        {uploading && (
          <div className="quota-bar small">
            <div className="quota-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {files.length === 0 ? (
          <p className="muted">No files yet. Upload your first backup above.</p>
        ) : (
          <table className="files">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td className="filename">{f.originalName}</td>
                  <td>{fmtBytes(f.sizeBytes)}</td>
                  <td>{new Date(f.createdAt).toLocaleString()}</td>
                  <td className="actions">
                    <a href={api.downloadUrl(f.id)} className="btn-link">
                      Download
                    </a>
                    <button className="btn-link danger" onClick={() => handleDelete(f.id)}>
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
