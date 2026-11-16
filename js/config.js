/**
 * 运行时配置：区分两种运行方式。
 *
 *  1. 后端同源托管（默认）：index.html 由 FastAPI 挂在 8000 端口，相对路径即可。
 *  2. 独立开发服务器（dev.py，5500 端口）：dev.py 会注入
 *     window.__DANCEMATE_API__ = "http://127.0.0.1:8000"，前端所有请求指向后端。
 */

const RAW_BASE = String(window.__DANCEMATE_API__ || '')
  .trim()
  .replace(/\/+$/, '');

export const API_BASE = RAW_BASE;

/** 后端接口地址 */
export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** 后端返回的 /media/... 绝对路径，在开发服务器下要补上后端地址。 */
export function mediaUrl(path) {
  if (!path) return '';
  if (/^(?:https?:|blob:|data:)/.test(path)) return path;
  return `${API_BASE}${path}`;
}

/** WebSocket 地址（/ws/practice） */
export function wsUrl(path) {
  if (API_BASE) {
    const base = new URL(API_BASE, location.href);
    const proto = base.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${base.host}${path}`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}
