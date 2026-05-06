export interface Me {
  id: string;
  email: string;
  storageUsed: number;
  storageQuota: number;
  createdAt: string;
}

export interface FileMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* keep raw text */
    }
    throw new ApiError(res.status, message || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const api = {
  register: (email: string, password: string) =>
    request<Me>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),

  login: (email: string, password: string) =>
    request<Me>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<Me>('/api/me'),

  listFiles: () => request<FileMeta[]>('/api/files'),

  uploadFile: async (file: File, onProgress?: (pct: number) => void) => {
    const fd = new FormData();
    fd.append('file', file);
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let msg = xhr.responseText;
          try {
            msg = JSON.parse(xhr.responseText).error ?? msg;
          } catch {
            /* keep raw */
          }
          reject(new ApiError(xhr.status, msg || xhr.statusText));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.send(fd);
    });
  },

  downloadUrl: (id: string) => `/api/files/${id}/download`,

  deleteFile: (id: string) => request<void>(`/api/files/${id}`, { method: 'DELETE' }),
};
