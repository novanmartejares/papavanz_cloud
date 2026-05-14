import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Props {
  token: string;
}

export default function PublicSharePage({ token }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);

  useEffect(() => {
    api.getPublicShare(token)
      .then(setFileInfo)
      .catch(err => {
        if (err instanceof ApiError && err.status === 401) {
          // Requires password, handled later if we get initial unauth object
          setFileInfo({ hasPassword: true, requiresPassword: true });
        } else {
          setError(err.message || String(err));
        }
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (fileInfo && !fileInfo.requiresPassword && fileInfo.fileMimeType?.startsWith('text/') && fileInfo.fileSizeBytes < 1024 * 1024) {
      // Lazy load text preview
      fetch(api.downloadPublicShareUrl(token, true))
        .then(res => res.text())
        .then(setTextPreview)
        .catch(console.error);
    }
  }, [fileInfo, token]);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const info = await api.getPublicShare(token, password);
      // Re-save with the correct password passed down to download urls
      setFileInfo({ ...info, passwordProvided: password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function getDownloadUrl(inline = false) {
    let url = api.downloadPublicShareUrl(token, inline);
    if (fileInfo?.passwordProvided) {
      url += `&pw=${encodeURIComponent(fileInfo.passwordProvided)}`;
    }
    return url;
  }

  if (loading) {
    return <div className="landing-page"><main style={{ padding: '4rem', textAlign: 'center' }}>Loading shared file...</main></div>;
  }

  return (
    <div className="landing-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="landing-header">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/logo.png" alt="Papavanz Cloud Logo" style={{ height: '32px', width: 'auto', borderRadius: '6px' }} />
          <span>papavanz_cloud</span>
        </div>
        <a href="/" className="btn-hero secondary" style={{ padding: '8px 24px', fontSize: '14px' }}>Go to my Cloud</a>
      </header>

      <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem' }}>
        <div className="card" style={{ maxWidth: '600px', width: '100%', padding: '2rem', textAlign: 'center' }}>
          {error && !fileInfo?.requiresPassword ? (
            <div>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
              <h2 style={{ marginBottom: '1rem' }}>Link Unavailable</h2>
              <p className="error">{error}</p>
            </div>
          ) : fileInfo?.requiresPassword ? (
            <form onSubmit={handleUnlock}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
              <h2 style={{ marginBottom: '1rem' }}>Password Protected</h2>
              <p style={{ marginBottom: '1.5rem', color: 'var(--muted)' }}>This shared file is protected by a password.</p>
              {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}
              <input 
                type="password" 
                value={password} 
                onChange={e => setPassword(e.target.value)} 
                placeholder="Enter password..." 
                style={{ width: '100%', padding: '0.75rem', marginBottom: '1rem', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg)' }}
              />
              <button className="btn-primary" type="submit" disabled={submitting} style={{ width: '100%', padding: '0.75rem' }}>
                {submitting ? 'Unlocking...' : 'Unlock File'}
              </button>
            </form>
          ) : (
            <div>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>📄</div>
              <h2 style={{ marginBottom: '0.5rem', wordBreak: 'break-all' }}>{fileInfo.fileName}</h2>
              <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
                {(fileInfo.fileSizeBytes / 1024 / 1024).toFixed(2)} MB • {fileInfo.fileMimeType || 'Unknown Type'}
              </p>

              {fileInfo.fileMimeType?.startsWith('image/') && (
                <div style={{ marginBottom: '2rem', background: 'var(--bg-hover)', borderRadius: '8px', overflow: 'hidden' }}>
                  <img src={getDownloadUrl(true)} alt={fileInfo.fileName} style={{ maxWidth: '100%', maxHeight: '400px', objectFit: 'contain' }} />
                </div>
              )}
              {fileInfo.fileMimeType?.startsWith('video/') && (
                <div style={{ marginBottom: '2rem', background: 'var(--bg-hover)', borderRadius: '8px', overflow: 'hidden' }}>
                  <video src={getDownloadUrl(true)} controls style={{ maxWidth: '100%', maxHeight: '400px' }} />
                </div>
              )}
              {fileInfo.fileMimeType?.startsWith('audio/') && (
                <div style={{ marginBottom: '2rem' }}>
                  <audio src={getDownloadUrl(true)} controls style={{ width: '100%' }} />
                </div>
              )}
              {textPreview !== null && (
                <div style={{ marginBottom: '2rem', textAlign: 'left', background: 'var(--bg-hover)', borderRadius: '8px', overflow: 'hidden', padding: '1rem' }}>
                  <pre style={{ margin: 0, overflowX: 'auto', maxHeight: '400px' }}>{textPreview}</pre>
                </div>
              )}

              <a href={getDownloadUrl(false)} className="btn-primary" style={{ display: 'inline-block', padding: '0.75rem 2rem', fontSize: '1.1rem' }}>
                ⬇️ Download File
              </a>
            </div>
          )}
        </div>
      </main>

      <footer className="landing-footer" style={{ marginTop: 'auto' }}>
        <p>© {new Date().getFullYear()} Papavanz Cloud. All rights reserved.</p>
      </footer>
    </div>
  );
}
