import { useEffect, useState } from 'react';
import { api, type FileMeta, type FileVersion } from '../api';

interface Props {
  file: FileMeta;
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export default function VersionsModal({ file, onClose }: Props) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api.listVersions(file.id)
      .then(setVersions)
      .catch(err => setError(String(err.message ?? err)))
      .finally(() => setLoading(false));
  }, [file.id]);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label={`Version History: ${file.originalName}`}>
        <header className="modal-head">
          <h3 className="modal-title">Version History: {file.originalName}</h3>
          <div className="modal-actions">
            <button className="btn-link" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>
        <div className="modal-body" style={{ padding: 0 }}>
          <div className="version-list" style={{ padding: '1rem' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>Current Version</h4>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', background: 'var(--bg-hover)', padding: '0.5rem 1rem', borderRadius: '4px' }}>
              <div>
                <div>{new Date(file.createdAt).toLocaleString()}</div>
                <div className="muted" style={{ fontSize: '13px' }}>{fmtBytes(file.sizeBytes)}</div>
              </div>
              <a className="btn-primary" style={{ padding: '4px 12px', fontSize: '13px', textDecoration: 'none' }} href={api.downloadUrl(file.id)}>Download</a>
            </div>

            <h4 style={{ margin: '0 0 0.5rem 0', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>Previous Versions</h4>
            {loading ? <p className="muted">Loading versions...</p> : null}
            {error ? <p className="error">{error}</p> : null}
            {!loading && versions.length === 0 ? <p className="muted">No previous versions.</p> : null}
            {!loading && versions.map(v => (
              <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div>{new Date(v.createdAt).toLocaleString()}</div>
                  <div className="muted" style={{ fontSize: '13px' }}>{fmtBytes(v.sizeBytes)}</div>
                </div>
                <a className="btn-link" style={{ fontSize: '13px' }} href={api.downloadVersionUrl(file.id, v.id)}>Download</a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
