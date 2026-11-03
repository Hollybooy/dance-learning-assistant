/** 页面主逻辑：视频库、切片轮播、实时骨架对比、练习回放。 */

import { api } from './api.js';
import { fitRect, drawPose, mapPose, poseAt } from './pose.js';
import { LivePoseStream } from './live.js';
import { ReplayPlayer } from './replay.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  video: null,
  segments: [],
  current: 0,
  teachFrames: [],
  teachCache: new Map(),
  livePose: null,
  compare: true,
  speed: 1,
  recording: false,
  currentSessionId: null,
};

const teachVideo = $('teach-video');
const cameraVideo = $('camera-video');
const teachOverlay = $('teach-overlay');
const cameraOverlay = $('camera-overlay');

/* ------------------------------------------------------------------ 通用 */

function setLibraryStatus(text) {
  $('library-status').textContent = text;
}

function setVideoStatus(text) {
  $('video-status').textContent = text;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${name}`);
  });
  if (name === 'learning') ensureLive();
  if (name === 'correct') refreshSessions(!state.currentSessionId);
}

function prepareCanvas(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/* -------------------------------------------------- 聊天历史（学习会话） */

const CHAT_KEY = 'dancemate_chat_sessions';

function loadChatSessions() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveChatSessions(sessions) {
  localStorage.setItem(CHAT_KEY, JSON.stringify(sessions.slice(0, 30)));
}

function renderChatSessions() {
  const list = $('chat-list');
  const sessions = loadChatSessions();
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-hint">暂无学习会话，上传教学视频后自动创建</div>';
    return;
  }
  sessions.forEach((session) => {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.dataset.videoId = session.videoId;
    item.classList.toggle('active', session.videoId === state.video?.id);
    item.innerHTML = `
      <div class="chat-title">${session.title}</div>
      <div class="chat-time">${session.time}</div>
    `;
    item.addEventListener('click', () => openChatSession(session.videoId));
    list.appendChild(item);
  });
}

function upsertChatSession(videoId, title) {
  const sessions = loadChatSessions().filter((s) => s.videoId !== videoId);
  sessions.unshift({
    videoId,
    title,
    time: new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  });
  saveChatSessions(sessions);
  renderChatSessions();
}

async function openChatSession(videoId) {
  try {
    const meta = await api.getVideo(videoId);
    await selectVideo(meta);
    setLibraryStatus(`已切换到会话：${meta.title}`);
  } catch (error) {
    // 视频已被删除 → 清理失效会话
    saveChatSessions(loadChatSessions().filter((s) => s.videoId !== videoId));
    renderChatSessions();
    setLibraryStatus(`该会话的视频已不存在，已清理记录`);
  }
}

$('new-chat-btn').addEventListener('click', () => {
  $('upload-input').click();
});

/* ------------------------------------------------------------ 视频库/轮播 */

async function loadLibrary() {
  renderChatSessions();
  try {
    const { items } = await api.listVideos();
    if (!items.length) {
      setLibraryStatus('视频库为空，先上传一个教学视频吧');
      return;
    }
    setLibraryStatus(`视频库共 ${items.length} 个教学视频，已载入最新一个`);
    await selectVideo(items[0]);
  } catch (error) {
    setLibraryStatus(`后端连接失败：${error.message}`);
  }
}

async function selectVideo(meta) {
  state.video = meta;
  state.segments = meta.segments || [];
  state.current = 0;
  state.teachFrames = [];

  teachVideo.src = api.streamUrl(meta.id);
  teachVideo.load();
  setVideoStatus(`${meta.title} · ${state.segments.length} 个片段`);
  renderCarousels();
  updateSegIndicator();
  upsertChatSession(meta.id, meta.title);

  if (state.teachCache.has(meta.id)) {
    state.teachFrames = state.teachCache.get(meta.id);
  } else if (meta.pose_status === 'ready') {
    await loadTeachPose(meta.id);
  }
}

async function loadTeachPose(videoId) {
  try {
    const pose = await api.getPose(videoId);
    state.teachFrames = pose.frames || [];
    state.teachCache.set(videoId, state.teachFrames);
    $('teach-badge').textContent = `骨架就绪 ${state.teachFrames.length} 帧`;
  } catch (error) {
    $('teach-badge').textContent = '骨架未就绪';
  }
}

async function ensurePose(videoId) {
  for (let i = 0; i < 1200; i += 1) {
    const meta = await api.getVideo(videoId);
    if (meta.pose_status === 'ready') {
      state.video = meta;
      state.segments = meta.segments || [];
      await loadTeachPose(videoId);
      return meta;
    }
    if (meta.pose_status === 'failed') {
      throw new Error(`骨架分析失败：${meta.pose_error || '未知错误'}`);
    }
    const progress = Math.round((meta.pose_progress || 0) * 100);
    setLibraryStatus(`正在分析教学视频骨架 ${progress}%`);
    await sleep(1200);
  }
  throw new Error('骨架分析超时');
}

// 纠错回放页使用回放列表，没有底部轮播，这里只渲染实际存在的轨道
const CAROUSEL_TRACKS = ['select-carousel-track', 'learn-carousel-track'];

function renderCarousels() {
  CAROUSEL_TRACKS.forEach((id) => {
    const track = $(id);
    if (!track) return;
    track.innerHTML = '';
    if (!state.segments.length) {
      track.innerHTML =
        '<div class="carousel-slide placeholder"><span>暂无片段</span></div>';
      return;
    }
    state.segments.forEach((segment) => {
      const slide = document.createElement('div');
      slide.className = 'carousel-slide';
      slide.dataset.index = segment.index;
      slide.innerHTML = `
        ${segment.thumbnail ? `<img class="slide-cover" src="${segment.thumbnail}" alt="" loading="lazy" />` : ''}
        <span class="seg-label">片段 ${segment.index + 1}</span>
        <span class="seg-time">${formatTime(segment.start)} – ${formatTime(segment.end)}</span>
        <span class="seg-duration">${Math.round(segment.duration)}s</span>
      `;
      slide.addEventListener('click', () => {
        state.current = segment.index;
        highlightSlides();
        updateSegIndicator();
        switchTab('learning');
        playSegment(segment.index);
      });
      track.appendChild(slide);
    });
  });
  highlightSlides();
}

function highlightSlides() {
  document.querySelectorAll('.carousel-slide').forEach((slide) => {
    const active = Number(slide.dataset.index) === state.current;
    slide.classList.toggle('active', active);
    // 长视频片段多：当前片段自动滚入可视区（只在水平方向滚动）
    if (active) slide.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  });
}

function updateSegIndicator() {
  const total = state.segments.length;
  $('seg-indicator').textContent = total ? `${state.current + 1} / ${total}` : '-- / --';
}

/* ---- 片段级进度条：只反映当前片段，可点击 / 拖动 ---- */

function updateSegProgress() {
  const segment = state.segments[state.current];
  const fill = $('teach-progress-fill');
  const label = $('seg-time');
  if (!segment) {
    fill.style.width = '0%';
    label.textContent = '-- / --';
    return;
  }
  const t = Math.min(Math.max(teachVideo.currentTime, segment.start), segment.end);
  const span = segment.end - segment.start;
  const ratio = span > 0 ? (t - segment.start) / span : 0;
  fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  label.textContent = `${formatTime(t - segment.start)} / ${formatTime(span)}`;
}

let scrubbing = false;

function seekFromPointer(event) {
  const segment = state.segments[state.current];
  if (!segment) return;
  const rect = $('teach-progress').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  teachVideo.currentTime = segment.start + ratio * (segment.end - segment.start);
  updateSegProgress();
}

$('teach-progress').addEventListener('pointerdown', (event) => {
  scrubbing = true;
  event.currentTarget.setPointerCapture(event.pointerId);
  seekFromPointer(event);
});
$('teach-progress').addEventListener('pointermove', (event) => {
  if (scrubbing) seekFromPointer(event);
});
$('teach-progress').addEventListener('pointerup', () => {
  scrubbing = false;
});
['seeked', 'loadedmetadata'].forEach((type) => {
  teachVideo.addEventListener(type, updateSegProgress);
});

async function playSegment(index) {
  const segment = state.segments[index];
  if (!segment) return;
  state.current = index;
  highlightSlides();
  updateSegIndicator();
  teachVideo.playbackRate = state.speed || 1;

  if (!teachVideo.src && state.video) {
    teachVideo.src = api.streamUrl(state.video.id);
  }
  if (teachVideo.readyState < 1) {
    await new Promise((resolve) => {
      teachVideo.addEventListener('loadedmetadata', resolve, { once: true });
      teachVideo.load();
    });
  }
  teachVideo.currentTime = segment.start;
  updateSegProgress();
  teachVideo.play().catch(() => {});
}

teachVideo.addEventListener('timeupdate', () => {
  const segment = state.segments[state.current];
  if (!segment) return;
  updateSegProgress();
  if (teachVideo.currentTime >= segment.end - 0.02) {
    teachVideo.pause();
    teachVideo.currentTime = Math.min(segment.end, teachVideo.duration || segment.end);
    updateSegProgress();
    // 片段播完自动结束录制
    if (state.recording) live.sendRecordStop();
  }
});

$('prev-seg').addEventListener('click', () => {
  if (state.current > 0) playSegment(state.current - 1);
});
$('next-seg').addEventListener('click', () => {
  if (state.current < state.segments.length - 1) playSegment(state.current + 1);
});
$('next-seg-2').addEventListener('click', () => {
  if (state.current < state.segments.length - 1) playSegment(state.current + 1);
});

/* ---------------------------------------------------------- 上传 / 搜索 */

$('upload-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    setLibraryStatus(`上传中 0% · ${file.name}`);
    const meta = await api.uploadVideo(file, (ratio) => {
      setLibraryStatus(`上传中 ${Math.round(ratio * 100)}% · ${file.name}`);
    });
    await selectVideo(meta);
    setLibraryStatus('上传完成，正在提取教学骨架…');
    const ready = await ensurePose(meta.id);
    renderCarousels();
    setVideoStatus(`${ready.title} · ${ready.segments.length} 个片段`);
    setLibraryStatus(
      `骨架已就绪：${ready.segments.length} 个片段，点击轮播图任意片段开始跟练`
    );
  } catch (error) {
    setLibraryStatus(`上传失败：${error.message}`);
    alert(error.message);
  } finally {
    event.target.value = '';
  }
});

async function runSearch() {
  const query = $('search-input').value.trim();
  const panel = $('search-results');
  panel.innerHTML = '<div class="empty-hint">搜索中…</div>';
  try {
    const { items } = await api.searchVideos(query);
    if (!items.length) {
      panel.innerHTML = '<div class="empty-hint">没有找到匹配的视频，试试上传本地视频</div>';
      return;
    }
    panel.innerHTML = '';
    items.forEach((item) => {
      const row = document.createElement('button');
      row.className = 'search-item';
      row.innerHTML = `<span>${item.title}</span><span class="search-meta">${item.segments?.length || 0} 个片段 · ${formatTime(item.duration)}</span>`;
      row.addEventListener('click', async () => {
        panel.innerHTML = '';
        await selectVideo(item);
        if (item.pose_status !== 'ready') {
          try {
            setLibraryStatus('正在准备骨架数据…');
            await ensurePose(item.id);
          } catch (error) {
            setLibraryStatus(error.message);
          }
        }
        renderCarousels();
        setLibraryStatus(`已选择：${item.title}`);
      });
      panel.appendChild(row);
    });
  } catch (error) {
    panel.innerHTML = `<div class="empty-hint">搜索失败：${error.message}</div>`;
  }
}

$('search-btn').addEventListener('click', runSearch);
$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runSearch();
});

/* ------------------------------------------------------------ 实时跟练 */

const live = new LivePoseStream({
  video: cameraVideo,
  onPose: ({ pose, serverMs, rtt }) => {
    state.livePose = pose;
    $('latency-badge').textContent = `延时 ${Math.round(rtt)}ms · 推理 ${Math.round(serverMs)}ms`;
    $('conn-badge').textContent = '实时链路在线';
  },
  onStatus: (text) => {
    $('latency-badge').textContent = text;
    if (text.includes('已连接')) {
      hideCamError();
      $('conn-badge').textContent = '实时链路在线';
    } else if (text.includes('断开') || text.includes('不可用')) {
      $('conn-badge').textContent = '实时链路中断';
    }
  },
  onRecordState: ({ recording, title, session }) => {
    state.recording = recording;
    const button = $('record-btn');
    button.classList.toggle('recording', recording);
    button.textContent = recording ? '■ 停止录制' : '● 开始录制';
    if (recording) {
      $('replay-status').textContent = `录制中：${title}`;
    } else if (session) {
      $('replay-status').textContent = `已保存：${session.title}`;
      state.currentSessionId = session.id;
      refreshSessions(false);
    }
  },
});

function cameraErrorMessage(error) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return '当前页面环境无法访问摄像头（需要 HTTPS 或 localhost）';
  }
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝：点击地址栏左侧的摄像头/锁图标，将摄像头改为"允许"，然后点下方重试';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未检测到摄像头设备，请确认电脑已连接摄像头（或未被设备管理器禁用）';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用（微信 / 抖音 / 腾讯会议等），关闭后点下方重试';
    case 'OverconstrainedError':
      return '摄像头不支持所请求的分辨率，已尝试降级仍失败';
    default:
      return `摄像头打开失败：${error?.name || '未知错误'}`;
  }
}

function showCamError(message) {
  $('cam-error-title').textContent = '摄像头不可用';
  $('cam-error-hint').textContent = message;
  $('cam-error').hidden = false;
}

function hideCamError() {
  $('cam-error').hidden = true;
}

async function ensureLive() {
  if (live.running) {
    hideCamError();
    return;
  }
  try {
    await live.start();
    hideCamError();
  } catch (error) {
    const message = cameraErrorMessage(error);
    $('latency-badge').textContent = '摄像头不可用';
    $('conn-badge').textContent = '未连接';
    showCamError(message);
    console.warn('camera error:', error);
  }
}

$('cam-retry').addEventListener('click', () => ensureLive());

$('compare-toggle').addEventListener('change', (event) => {
  state.compare = event.target.checked;
});

let countdownActive = false;

$('record-btn').addEventListener('click', async () => {
  if (!state.video) {
    alert('请先在「视频选择」页上传或选择一个教学视频');
    return;
  }
  if (!live.running) {
    // 摄像头还没连上：直接尝试（重新）连接，而不是报"无法录制"
    ensureLive();
    return;
  }
  if (state.recording) {
    live.sendRecordStop();
    return;
  }
  if (countdownActive) return;

  // 开始前倒计时，给用户回到位置的准备时间
  const seconds = Number($('countdown-select').value) || 0;
  if (seconds > 0) {
    countdownActive = true;
    const overlay = $('countdown-overlay');
    const num = $('countdown-num');
    const button = $('record-btn');
    for (let left = seconds; left > 0 && live.running; left -= 1) {
      overlay.hidden = false;
      num.textContent = String(left);
      button.textContent = `${left}s 后开始`;
      await sleep(1000);
    }
    overlay.hidden = true;
    button.textContent = '● 开始录制';
    countdownActive = false;
    if (!live.running || state.recording) return;
  }

  // 录制从当前片段开头同步播放，片段播完自动停止录制
  const segment = state.segments[state.current];
  const startAt = segment ? segment.start : teachVideo.currentTime;
  live.sendRecordStart({
    video_id: state.video.id,
    segment_index: state.current,
    teach_time: Number(startAt.toFixed(3)),
    teach_rate: Number(teachVideo.playbackRate.toFixed(3)),
    title: `${state.video.title} · 片段 ${state.current + 1}`,
  });
  if (segment) {
    teachVideo.currentTime = segment.start;
    updateSegProgress();
    teachVideo.play().catch(() => {});
  }
});

// 教学视频播放速度
$('speed-select').addEventListener('change', (event) => {
  state.speed = Number(event.target.value) || 1;
  teachVideo.playbackRate = state.speed;
});

/* ------------------------------------------------------ 骨架叠加绘制循环 */

function drawTeachOverlay() {
  if (!$('view-learning').classList.contains('active')) return;
  const prepared = prepareCanvas(teachOverlay);
  if (!prepared || !teachVideo.videoWidth) return;
  const { ctx, width, height } = prepared;
  const rect = fitRect(width, height, teachVideo.videoWidth, teachVideo.videoHeight);
  const frame = poseAt(state.teachFrames, teachVideo.currentTime);

  if (frame?.pose) {
    drawPose(ctx, frame.pose, rect, { color: '#ffb020', lineWidth: 3, shadow: true });

    if (state.compare && state.livePose && cameraVideo.videoWidth) {
      const liveRect = { x: 0, y: 0, w: cameraVideo.videoWidth, h: cameraVideo.videoHeight };
      const mapped = mapPose(state.livePose, liveRect, frame.pose, rect);
      if (mapped) {
        drawPose(ctx, mapped, rect, {
          color: '#00e5a0',
          lineWidth: 2,
          dashed: true,
          alpha: 0.7,
        });
      }
    }
  }
}

function drawCameraOverlay() {
  if (!$('view-learning').classList.contains('active')) return;
  const prepared = prepareCanvas(cameraOverlay);
  if (!prepared || !cameraVideo.videoWidth) return;
  const { ctx, width, height } = prepared;
  const rect = fitRect(width, height, cameraVideo.videoWidth, cameraVideo.videoHeight);

  if (state.livePose) {
    drawPose(ctx, state.livePose, rect, { color: '#00e5a0', lineWidth: 3, shadow: true });

    if (state.compare && teachVideo.videoWidth && state.teachFrames.length) {
      const teaching = poseAt(state.teachFrames, teachVideo.currentTime);
      if (teaching?.pose) {
        const teachRect = {
          x: 0,
          y: 0,
          w: teachVideo.videoWidth,
          h: teachVideo.videoHeight,
        };
        const mapped = mapPose(teaching.pose, teachRect, state.livePose, rect);
        if (mapped) {
          drawPose(ctx, mapped, rect, {
            color: '#ff5c8a',
            lineWidth: 2.5,
            dashed: true,
            alpha: 0.9,
          });
        }
      }
    }
  }
}

function overlayLoop() {
  drawTeachOverlay();
  drawCameraOverlay();
  requestAnimationFrame(overlayLoop);
}
requestAnimationFrame(overlayLoop);

/* ------------------------------------------------------------ 纠错回放 */

const player = new ReplayPlayer({
  canvas: $('replay-canvas'),
  seekBar: $('replay-seek'),
  timeLabel: $('replay-time'),
  playButton: $('replay-toggle'),
  getTeachFrames: async (videoId) => {
    if (state.teachCache.has(videoId)) return state.teachCache.get(videoId);
    const pose = await api.getPose(videoId);
    state.teachCache.set(videoId, pose.frames || []);
    return pose.frames || [];
  },
});

$('replay-compare').addEventListener('change', (event) => {
  player.showTeach = event.target.checked;
});

async function refreshSessions(selectFirst = true) {
  const list = $('session-list');
  try {
    const { items } = await api.listSessions();
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="empty-hint">暂无录制，去「跟练学习」页录制一段吧</div>';
      state.currentSessionId = null;
      return;
    }
    items.forEach((session) => {
      const item = document.createElement('div');
      item.className = 'clip-item';
      item.dataset.id = session.id;
      item.innerHTML = `
        <div class="clip-title">${session.title}</div>
        <div class="clip-meta">${formatTime(session.duration)} · ${session.frame_count} 帧</div>
        <button class="clip-delete" title="删除此回放">✕ 删除</button>
      `;
      item.addEventListener('click', () => loadSession(session.id));
      item.querySelector('.clip-delete').addEventListener('click', (event) => {
        event.stopPropagation();
        deleteSession(session.id);
      });
      list.appendChild(item);
    });
    if (selectFirst) {
      const target = state.currentSessionId || items[0].id;
      await loadSession(target);
    } else {
      markActiveSession();
    }
  } catch (error) {
    list.innerHTML = `<div class="empty-hint">读取回放失败：${error.message}</div>`;
  }
}

async function deleteSession(sessionId) {
  if (!confirm('确定删除这条练习回放吗？删除后不可恢复。')) return;
  try {
    await api.deleteSession(sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      player.pause();
      $('replay-status').textContent = '回放已删除';
    }
    refreshSessions(false);
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function markActiveSession() {
  document.querySelectorAll('.clip-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.id === state.currentSessionId);
  });
}

async function loadSession(sessionId) {
  try {
    const session = await api.getSession(sessionId);
    state.currentSessionId = sessionId;
    markActiveSession();
    player.showTeach = $('replay-compare').checked;
    const count = await player.load(session);
    $('replay-status').textContent = `${session.title} · ${count} 帧 · ${formatTime(session.duration)}`;
  } catch (error) {
    $('replay-status').textContent = `回放加载失败：${error.message}`;
  }
}

$('refresh-sessions').addEventListener('click', () => refreshSessions(false));

$('prev-clip').addEventListener('click', () => stepSession(-1));
$('next-clip').addEventListener('click', () => stepSession(1));

function stepSession(direction) {
  const items = [...document.querySelectorAll('.clip-item')];
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => item.dataset.id === state.currentSessionId);
  const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + direction));
  if (nextIndex === currentIndex) return;
  loadSession(items[nextIndex].dataset.id);
}

document.querySelectorAll('.carousel').forEach((carousel) => {
  const track = carousel.querySelector('.carousel-track');
  carousel.querySelectorAll('.carousel-arrow').forEach((button) => {
    button.addEventListener('click', () => {
      // 按可见宽度整页翻动，长视频的几十个片段也能像轮播一样收纳
      const step = Math.max(track.clientWidth * 0.85, 260);
      track.scrollBy({
        left: button.classList.contains('left') ? -step : step,
        behavior: 'smooth',
      });
    });
  });
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.view));
});

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

loadLibrary();
