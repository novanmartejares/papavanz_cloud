import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ShareLinkMeta } from '../api';

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
}

export default function SharesView({ onBack }: Props) {
  const [links, setLinks] = useState<ShareLinkMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listShares();
      setLinks(list);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this share link? Anyone with the link will no longer be able to download.')) return;
    setBusy(true);
    try {
      await api.deleteShare(id);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(link: ShareLinkMeta) {
    const fullUrl = `${window.location.origin}${link.url}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(link.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      prompt('Copy this link:', fullUrl);
    }
  }

  return (
    <section className="shares-view">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>🔗 Shared Links</h2>
      </div>

      {error && <p className="error">{error}</p>}

      {links.length === 0 ? (
        <p className="muted">No shared links. Share a file from the file list to create one.</p>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Protection</th>
              <th>Downloads</th>
              <th>Expires</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.map((l) => {
              const expired = l.expiresAt && new Date(l.expiresAt) < new Date();
              const maxedOut = l.maxDownloads !== null && l.downloadCount >= l.maxDownloads;
              return (
                <tr key={l.id} className={expired || maxedOut ? 'disabled-row' : ''}>
                  <td className="filename">{l.fileName}</td>
                  <td>{fmtBytes(l.fileSizeBytes)}</td>
                  <td>{l.hasPassword ? '🔒 Password' : '🌐 Public'}</td>
                  <td>{l.downloadCount}{l.maxDownloads !== null ? ` / ${l.maxDownloads}` : ''}</td>
                  <td className={expired ? 'danger-text' : ''}>
                    {l.expiresAt
                      ? expired
                        ? 'Expired'
                        : new Date(l.expiresAt).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td>{new Date(l.createdAt).toLocaleDateString()}</td>
                  <td className="actions">
                    <button className="btn-link" onClick={() => handleCopy(l)}>
                      {copied === l.id ? '✓ Copied!' : 'Copy link'}
                    </button>
                    <button className="btn-link danger" onClick={() => handleRevoke(l.id)} disabled={busy}>
                      Revoke
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
