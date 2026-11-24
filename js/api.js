/** 后端接口封装。默认同源（后端托管前端），开发服务器下自动指向后端地址。 */

import { apiUrl, mediaUrl } from './config.js';

async function parse(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  listVideos: () => fetch(apiUrl('/api/videos')).then(parse),

  getVideo: (id) => fetch(apiUrl(`/api/videos/${id}`)).then(parse),

  searchVideos: (q) =>
    fetch(apiUrl(`/api/videos/search?q=${encodeURIComponent(q)}`)).then(parse),

  analyzeVideo: (id) =>
    fetch(apiUrl(`/api/videos/${id}/analyze`), { method: 'POST' }).then(parse),

  getPose: (id, start, end) => {
    const params = new URLSearchParams();
    if (start != null) params.set('start', start);
    if (end != null) params.set('end', end);
    const qs = params.toString();
    return fetch(apiUrl(`/api/videos/${id}/pose${qs ? `?${qs}` : ''}`)).then(parse);
  },

  streamUrl: (id) => apiUrl(`/api/videos/${id}/stream`),

  deleteVideo: (id) =>
    fetch(apiUrl(`/api/videos/${id}`), { method: 'DELETE' }).then(parse),

  listSessions: () => fetch(apiUrl('/api/sessions')).then(parse),

  getSession: (id) => fetch(apiUrl(`/api/sessions/${id}`)).then(parse),

  deleteSession: (id) =>
    fetch(apiUrl(`/api/sessions/${id}`), { method: 'DELETE' }).then(parse),

  /** 带进度的上传（XHR 便于展示进度）。 */
  uploadVideo(file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('/api/videos/upload'));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('响应解析失败'));
          }
        } else {
          let message = `上传失败（${xhr.status}）`;
          try {
            const body = JSON.parse(xhr.responseText);
            message = body.detail || message;
          } catch {
            /* ignore */
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误，上传中断'));
      xhr.send(form);
    });
  },
};

/** 后端返回的媒体路径统一过一遍 mediaUrl，兼容独立开发服务器。 */
export { mediaUrl };
