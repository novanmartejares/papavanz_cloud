import { useEffect, useState } from 'react';
import { api, type FileMeta, ApiError } from '../api';

interface Props {
  file: FileMeta;
  onClose: () => void;
}

export default function ShareModal({ file, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [expiresInStr, setExpiresInStr] = useState('');
  const [maxDownloadsStr, setMaxDownloadsStr] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const opts: { password?: string; expiresIn?: number; maxDownloads?: number } = {};
      if (password.trim()) opts.password = password.trim();
      if (expiresInStr.trim()) {
        const h = parseInt(expiresInStr, 10);
        if (!isNaN(h) && h > 0) opts.expiresIn = h;
      }
      if (maxDownloadsStr.trim()) {
        const m = parseInt(maxDownloadsStr, 10);
        if (!isNaN(m) && m > 0) opts.maxDownloads = m;
      }

      const result = await api.createShare(file.id, opts);
      const fullUrl = `${window.location.origin}${result.url}`;
      setShareUrl(fullUrl);
      
      try { await navigator.clipboard.writeText(fullUrl); } catch { /* ignore */ }
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label={`Share ${file.originalName}`}>
        <header className="modal-head">
          <h3 className="modal-title">Share "{file.originalName}"</h3>
          <div className="modal-actions">
            <button className="btn-link" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>

        <div className="modal-body">
          {error && <p className="error" style={{ margin: '0 0 1rem 0' }}>{error}</p>}

          {shareUrl ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <p style={{ marginBottom: '1rem', color: 'var(--primary-color)', fontWeight: 'bold' }}>✅ Share link created and copied to clipboard!</p>
              <input 
                type="text" 
                readOnly 
                value={shareUrl} 
                style={{ width: '100%', padding: '0.5rem', marginBottom: '1rem', background: 'var(--bg-hover)', border: '1px solid var(--border)' }} 
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button className="btn-primary" onClick={onClose}>Done</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>Password (Optional)</label>
                <input 
                  type="password" 
                  value={password} 
                  onChange={(e) => setPassword(e.target.value)} 
                  placeholder="Leave blank for public link" 
                  style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>Expiration (Optional)</label>
                <select 
                  value={expiresInStr} 
                  onChange={(e) => setExpiresInStr(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                >
                  <option value="">Never expire</option>
                  <option value="1">1 Hour</option>
                  <option value="24">1 Day</option>
                  <option value="168">7 Days</option>
                  <option value="720">30 Days</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>Max Downloads (Optional)</label>
                <input 
                  type="number" 
                  min="1" 
                  max="10000"
                  value={maxDownloadsStr} 
                  onChange={(e) => setMaxDownloadsStr(e.target.value)} 
                  placeholder="e.g. 5" 
                  style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn-link" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Generating...' : 'Create Link'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
