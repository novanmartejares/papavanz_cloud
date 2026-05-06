import { useEffect, useState } from 'react';
import { api, type FileMeta } from '../api';

interface Props {
  file: FileMeta;
  onClose: () => void;
}

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'unsupported';

function kindFor(file: FileMeta): PreviewKind {
  const mime = (file.mimeType ?? '').toLowerCase();
  const ext = file.originalName.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'log', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'yml', 'yaml', 'sh', 'py', 'rb'].includes(ext)) return 'text';
  return 'unsupported';
}

const TEXT_PREVIEW_MAX = 1024 * 1024; // 1 MB cap

export default function PreviewModal({ file, onClose }: Props) {
  const kind = kindFor(file);
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lazy-load text content (don't fetch huge files).
  useEffect(() => {
    if (kind !== 'text') return;
    if (file.sizeBytes > TEXT_PREVIEW_MAX) {
      setTextError(`File too large to preview inline (${(file.sizeBytes / 1024).toFixed(0)} KB). Click Download.`);
      return;
    }
    let cancelled = false;
    setTextLoading(true);
    fetch(api.previewUrl(file.id), { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((err) => {
        if (!cancelled) setTextError(String(err.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id, file.sizeBytes, kind]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label={`Preview: ${file.originalName}`}>
        <header className="modal-head">
          <h3 className="modal-title">{file.originalName}</h3>
          <div className="modal-actions">
            <a className="btn-link" href={api.downloadUrl(file.id)}>
              Download
            </a>
            <button className="btn-link" onClick={onClose} aria-label="Close preview">
              ✕
            </button>
          </div>
        </header>

        <div className="modal-body">
          {kind === 'image' && (
            <img
              className="preview-image"
              src={api.previewUrl(file.id)}
              alt={file.originalName}
            />
          )}
          {kind === 'video' && (
            <video className="preview-video" src={api.previewUrl(file.id)} controls autoPlay />
          )}
          {kind === 'audio' && (
            <audio className="preview-audio" src={api.previewUrl(file.id)} controls autoPlay />
          )}
          {kind === 'pdf' && (
            <iframe
              className="preview-pdf"
              src={api.previewUrl(file.id)}
              title={file.originalName}
            />
          )}
          {kind === 'text' && (
            <>
              {textLoading && <p className="muted">Loading…</p>}
              {textError && <p className="error">{textError}</p>}
              {text !== null && <pre className="preview-text">{text}</pre>}
            </>
          )}
          {kind === 'unsupported' && (
            <div className="preview-fallback">
              <p>
                Preview not available for <code>{file.mimeType ?? 'this file type'}</code>.
              </p>
              <a className="btn-primary" href={api.downloadUrl(file.id)}>
                Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
