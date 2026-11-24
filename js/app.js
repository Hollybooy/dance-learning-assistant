/**
 * DANCE+ 前端主逻辑
 * 结构：路由 → 视频库 / 课程大厅 / 课程详情 / 跟练舞台 / 历史记录 / 纠错回放 / 关于
 * 与后端约定保持不变：/api/videos、/api/sessions、/api/videos/{id}/pose、/ws/practice
 */

import { api, mediaUrl } from './api.js';
import {
  buildLocalCourses,
  assetUrl,
  sliceSegments,
  CATEGORY_BACKDROP,
  SLICE_SECONDS,
} from './catalog.js';
import {
  fitRect,
  drawPose,
  mapPose,
  poseAt,
  flipX,
  createMaskCache,
  drawShadow,
  mapShadowRect,
  parseMaskBin,
} from './pose.js';
import { LivePoseStream } from './live.js';
import { ReplayPlayer } from './replay.js';

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAV_KEY = 'danceplus_favorites_v1';
const USER_KEY = 'danceplus_user_v1';
const SETTINGS_KEY = 'danceplus_settings_v1';
const PERF_KEY = 'danceplus_perf_hud_v1'; // 性能面板是调试项，单独存，避免沿用旧配置里的 true
const FRIENDS_KEY = 'danceplus_friends_v1';
const PROFILE_STATS_KEY = 'danceplus_profile_stats_v1';
const PLAYBACK_RATES = [0.75, 0.9, 1, 1.25, 1.5];
const ROUTES = ['cover', 'home', 'classes', 'class', 'learning', 'history', 'about', 'correct', 'profile'];
const STAGE_ROUTES = new Set(['learning', 'correct']);
const CATEGORIES = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'hiphop', label: 'Hip-Hop', match: ['hip', 'hop', '街舞', 'urban'] },
  { id: 'chinese', label: 'Chinese', match: ['古风', '中国', '国风', '古典', '民'] },
  { id: 'rumba', label: 'Rumba', match: ['rumba', '伦巴'] },
  { id: 'swing', label: 'Swing', match: ['swing', '摇摆'] },
  { id: 'jazz', label: 'Jazz', match: ['jazz', '爵士'] },
  { id: 'waltz', label: 'Waltz', match: ['waltz', '华尔兹'] },
  { id: 'chacha', label: 'Cha Cha', match: ['cha', '恰恰'] },
  { id: 'kpop', label: 'K-Pop Dance', match: ['kpop', 'k-pop', '韩'] },
  { id: 'ballet', label: 'Ballet', match: ['ballet', '芭蕾'] },
];

const DEFAULT_SETTINGS = {
  speed: 1,
  skeleton: true,
  shadows: true,
  countdown: 3,
  autoplayNext: false,
  dockDelay: 1500,
  voiceTips: true,
  voiceCommands: true,
  showPerf: false,
};

const state = {
  videos: [],
  remoteVideos: [],
  localCourses: buildLocalCourses(),
  video: null,
  segments: [],
  current: 0,
  teachFrames: [],
  teachCache: new Map(),
  livePose: null,
  liveMask: null,
  compare: true,
  skeleton: true,
  shadows: true,
  speed: 1,
  recording: false,
  sessions: [],
  currentSessionId: null,
  category: 'all',
  route: 'cover',
  favs: loadFavs(),
  user: loadUser(),
  settings: loadSettings(),
  friends: loadFriends(),
  demoStats: loadProfileStats(),
  overlayMode: false,
  arcIndex: 0,
  arcTimer: 0,
  dockVisible: false,
};

const teachVideo = $('teach-video');
const cameraVideo = $('camera-video');
const teachOverlay = $('teach-overlay');
const cameraOverlay = $('camera-overlay');
const shell = $('app-shell');
const main = $('app-main');

/* ------------------------------------------------------------------ 基础工具 */

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toast(message, type = 'info') {
  const stack = $('toast-stack');
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' is-error' : ''}`;
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function showLoader(text, percent = 0) {
  $('loader-text').textContent = text;
  $('loader-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('loader').hidden = false;
}

function setLoaderText(text, percent) {
  $('loader-text').textContent = text;
  if (percent != null) $('loader-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function hideLoader() {
  $('loader').hidden = true;
}

function loadFavs() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '{}');
    return { videos: raw.videos || [], sessions: raw.sessions || [] };
  } catch {
    return { videos: [], sessions: [] };
  }
}

function saveFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favs));
}

function toggleFav(kind, id) {
  const list = state.favs[kind];
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else list.push(id);
  saveFavs();
  return index < 0;
}

/* -------------------------------------------------------------- 用户 / 设置 */

function loadUser() {
  const fallback = {
    nickname: 'TUTU',
    bio: '今天也要把动作练对。',
    avatar: '',
    loggedIn: false,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return raw ? { ...fallback, ...raw } : fallback;
  } catch {
    return fallback;
  }
}

function saveUser() {
  localStorage.setItem(USER_KEY, JSON.stringify(state.user));
  renderUserChrome();
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      autoplayNext: false,
      showPerf: localStorage.getItem(PERF_KEY) === '1',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function loadFriends() {
  const seeded = [
    { name: 'Mia', status: '正在练习 Hip-Hop', online: true },
    { name: 'Leo', status: '今天已完成 2 段跟练', online: false },
  ];
  try {
    const raw = JSON.parse(localStorage.getItem(FRIENDS_KEY) || 'null');
    return Array.isArray(raw) && raw.length ? raw : seeded;
  } catch {
    return seeded;
  }
}

function loadProfileStats() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_STATS_KEY) || 'null');
    if (saved && Number.isFinite(saved.total)) return saved;
  } catch {
    /* 重新生成演示数据 */
  }
  const total = Math.floor(25 * 60 + Math.random() * 145 * 60);
  const stats = {
    total,
    master: Math.floor(10 * 60 + Math.random() * Math.min(total - 60, 95 * 60)),
    count: Math.floor(1 + Math.random() * 9),
    favs: Math.floor(Math.random() * 10),
  };
  localStorage.setItem(PROFILE_STATS_KEY, JSON.stringify(stats));
  return stats;
}

function saveFriends() {
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(state.friends));
}

/* ------------------------------------------------------------------ 路由 */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name = '', param = ''] = raw.split('/');
  return { name: ROUTES.includes(name) ? name : 'cover', param };
}

function navigate(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

/* ------------------------------------------------------------- 封面 → 首页 */

/** 进入页停留时长：3 秒后自动进入 Home */
const COVER_AUTOPLAY_MS = 3000;
/** 与 .cover 的 transition / .shell.is-entering 动画时长保持一致 */
const COVER_FADE_MS = 560;

let coverTimer = 0;
/** 记录本次进入页是否已经触发过进场，避免重复调用 */
let coverEntered = false;

function clearCoverAutoEnter() {
  if (coverTimer) window.clearTimeout(coverTimer);
  coverTimer = 0;
}

function scheduleCoverAutoEnter() {
  clearCoverAutoEnter();
  if (coverEntered) return;
  coverTimer = window.setTimeout(() => enterFromCover('#/home'), COVER_AUTOPLAY_MS);
}

/**
 * 从进入页过渡到目标页：封面淡出 + 外壳淡入在同一帧交叉进行。
 * 不依赖 hashchange（内嵌预览等环境下 hash 变化不一定回调），路由与视图直接同步。
 */
function enterFromCover(target = '#/home') {
  clearCoverAutoEnter();

  const cover = $('view-cover');
  if (!cover || coverEntered) return;
  if (parseRoute().name !== 'cover') return;
  coverEntered = true;

  // 1) 先把外壳显示出来，才有交叉过渡而不是硬切
  shell.hidden = false;
  shell.classList.add('is-entering');

  // 2) 封面进入退场态（.is-leaving 自带 display:block，路由摘掉 .is-active 也不会中断）
  cover.classList.add('is-leaving');

  // 3) 同步地址栏与视图
  try {
    if (location.hash !== target) history.replaceState(null, '', target);
  } catch (err) {
    location.hash = target;
  }
  applyRoute();

  // 4) 过渡结束收尾，封面恢复干净状态，下次回到封面仍能重播入场动画
  window.setTimeout(() => {
    cover.classList.remove('is-leaving');
    shell.classList.remove('is-entering');
    coverEntered = false;
  }, COVER_FADE_MS);
}

function markNav(name) {
  const key =
    name === 'class' || name === 'learning' ? 'classes' : name === 'correct' ? 'history' : name;
  $$('.topnav a').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === key);
  });
}

async function applyRoute() {
  const { name, param } = parseRoute();
  const prev = state.route;

  if (name === 'learning' && !state.video) {
    toast('请先选择一个教学视频');
    location.hash = '#/classes';
    return;
  }

  state.route = name;
  if (name !== 'learning') hideCoachTip(); // 离开教学页不再朗读旧提示

  // 进入页：停留 3 秒自动进场；其他页面清掉计时器
  if (name === 'cover') scheduleCoverAutoEnter();
  else clearCoverAutoEnter();

  $$('[data-view]').forEach((view) => view.classList.toggle('is-active', view.dataset.view === name));
  document.body.classList.toggle('is-cover', name === 'cover');
  // 底部搜索停靠区只在首页出现
  document.body.classList.toggle('is-home', name === 'home');
  // 课程页把左侧导航收进 Categories 底部的图标（点开为压在页面上的浮层）
  document.body.classList.toggle('is-classes', name === 'classes');
  syncClassesFoot();
  shell.hidden = name === 'cover';
  shell.classList.toggle('is-immersive', STAGE_ROUTES.has(name));
  main.classList.toggle('is-stage', STAGE_ROUTES.has(name));
  markNav(name);
  syncPerfHud();
  closeRail();
  main.scrollTop = 0;

  if (prev === 'learning' && name !== 'learning' && !state.recording) live.stop();
  if (name !== 'classes') stopArc(prev === 'classes');
  if (name !== 'home') stopRecAuto();
  if (prev === 'learning' && name !== 'learning') {
    exitRecordingLayout();
    setOverlayMode(false);
  }
  if (prev === 'correct' && name !== 'correct') {
    player.pause();
    $('replay-video')?.pause();
    // 离开回放页就把摄像头窗格关掉，别让摄像头一直亮着
    setReplayMode(false);
  }

  if (name === 'home') renderHome();
  if (name === 'classes') {
    if (param) state.category = CATEGORIES.some((item) => item.id === param) ? param : 'all';
    renderCategories();
    renderClassAlbums();
  }
  if (name === 'class') await openRouteClass(param);
  if (name === 'history') await refreshSessions(false);
  if (name === 'correct') {
    // 每次进来都从全屏剧场开始
    setReplayMode(false);
    dismissIdle();
    if (!state.sessions.length) await refreshSessions(true);
    if (param) await loadSession(param);
    else if (state.currentSessionId) await loadSession(state.currentSessionId);
    else if (state.sessions[0]) await loadSession(state.sessions[0].id);
  }
  if (name === 'profile') {
    renderUserChrome();
    renderProfile();
    refreshSessions(false).then(renderProfile);
  }
  if (name === 'learning') {
    ensureLive();
    ensureTeachPoseLoaded();
    renderFilmstrip();
    updateSegIndicator();
    updateSegProgress();
    renderFavorite();
  }
}

/* ------------------------------------------------------------------ 主题 / 侧栏 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('danceplus_theme', theme);
  const icon = theme === 'dark' ? '#i-sun' : '#i-moon';
  [$('theme-toggle'), $('cover-theme')].forEach((button) => {
    const use = button?.querySelector('use');
    if (use) use.setAttribute('href', icon);
  });
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

function openRail() {
  shell.classList.add('is-rail-open');
  $('rail-scrim').hidden = false;
  $('classes-rail-trigger')?.setAttribute('aria-expanded', 'true');
}

function closeRail() {
  shell.classList.remove('is-rail-open');
  $('rail-scrim').hidden = true;
  $('classes-rail-trigger')?.setAttribute('aria-expanded', 'false');
}

/* 课程页把「个人区」从导航搬到分类面板底部：直接移动节点，头像/昵称/状态仍是同一份数据，
   不用在两处同步。窄屏（分类栏变横向条）时留在导航里，跟着抽屉一起出现。 */
function syncClassesFoot() {
  const foot = document.querySelector('.rail__foot');
  const slot = $('classes-profile-slot');
  const rail = $('rail');
  if (!foot || !slot || !rail) return;
  const inClasses = document.body.classList.contains('is-classes') && window.innerWidth > 960;
  const host = inClasses ? slot : rail;
  if (foot.parentElement !== host) host.appendChild(foot);
}

function initRail() {
  $$('[data-rail-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const item = head.closest('.rail-item');
      const open = item.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(open));
      slideRailBody(item, open);
    });
  });
  $$('.rail-item').forEach((item) => item.classList.add('is-open'));
}

/* 折叠体常驻 flex，靠 max-height 过渡开合：展开时先量出真实高度，
   动画结束再把高度交还给 CSS，这样列表之后变长也不会被截断 */
function slideRailBody(item, open) {
  const body = item.querySelector('.rail-item__body');
  if (!body) return;
  clearTimeout(body._railTimer);
  body.style.overflow = 'hidden';
  if (open) {
    body.style.maxHeight = `${body.scrollHeight}px`;
    const settle = () => {
      if (!item.classList.contains('is-open')) return;
      body.style.maxHeight = '';
      body.style.overflow = '';
    };
    body.addEventListener('transitionend', function onEnd(event) {
      if (event.target !== body || event.propertyName !== 'max-height') return;
      body.removeEventListener('transitionend', onEnd);
      settle();
    });
    // 兜底：过渡被中断或系统关闭动效时同样要解绑高度
    body._railTimer = setTimeout(settle, 320);
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`;
    void body.offsetHeight;
    body.style.maxHeight = '0px';
  }
}

/* ------------------------------------------------------------------ 视频库 */

function genreMatch(video, category) {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat || cat.id === 'all') return true;
  if (video.local) return video.style === category;
  const title = `${video.title || ''} ${video.original_name || ''}`.toLowerCase();
  return cat.match.some((keyword) => title.includes(keyword.toLowerCase()));
}

function coverOf(video) {
  if (video.cover) return video.cover;
  const thumb = video.segments?.find((segment) => segment.thumbnail)?.thumbnail;
  return thumb ? mediaUrl(thumb) : '';
}

/** 读取静态视频时长（仅取元数据，不下载完整文件） */
function probeDuration(src) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      probe.removeAttribute('src');
      probe.load();
      resolve(value);
    };
    probe.addEventListener('loadedmetadata', () => done(Number(probe.duration) || 0), { once: true });
    probe.addEventListener('error', () => done(0), { once: true });
    setTimeout(() => done(0), 8000);
    probe.src = src;
  });
}

/** 读取视频真实分辨率（封面缩略图可能被裁切，不能代表原始比例） */
const videoSizeCache = new Map();

function probeVideoSize(src) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    let settled = false;
    const done = (width, height) => {
      if (settled) return;
      settled = true;
      probe.removeAttribute('src');
      probe.load();
      resolve({ width: Number(width) || 0, height: Number(height) || 0 });
    };
    probe.addEventListener(
      'loadedmetadata',
      () => done(probe.videoWidth, probe.videoHeight),
      { once: true }
    );
    probe.addEventListener('error', () => done(0, 0), { once: true });
    setTimeout(() => done(0, 0), 8000);
    probe.src = src;
  });
}

const thumbnailJobs = new Map();

function waitVideoEvent(video, name, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('视频截图超时')), timeout);
    const finish = (error) => {
      clearTimeout(timer);
      video.removeEventListener(name, onReady);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('视频读取失败'));
    video.addEventListener(name, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

/** 从每个真实片段的开头截帧，不再用课程封面代替片段预览。 */
function generateSegmentThumbnails(course) {
  if (!course?.local || !course.segments?.length) return Promise.resolve();
  if (course.segments.every((segment) => segment.thumbnail?.startsWith('data:image/'))) return Promise.resolve();
  if (thumbnailJobs.has(course.id)) return thumbnailJobs.get(course.id);
  const segments = course.segments;
  const job = (async () => {
    const probe = document.createElement('video');
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = 'auto';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    let source = '';
    try {
      for (const segment of segments) {
        if (!segment.src) continue;
        const target = new URL(segment.src, location.href).href;
        if (source !== target) {
          probe.src = target;
          probe.load();
          await waitVideoEvent(probe, 'loadeddata', 8000);
          source = target;
        }
        const start = segment.start || 0;
        const end = segmentEndOf(segment) || probe.duration || start + 0.1;
        probe.currentTime = Math.min(Math.max(0, end - 0.05), start + 0.08);
        await waitVideoEvent(probe, 'seeked', 5000);
        const width = 240;
        const height = Math.max(1, Math.round(width * probe.videoHeight / Math.max(1, probe.videoWidth)));
        canvas.width = width;
        canvas.height = height;
        context.drawImage(probe, 0, 0, width, height);
        segment.thumbnail = canvas.toDataURL('image/jpeg', 0.76);
        if (state.video?.id === course.id) {
          const image = $(`learn-carousel-track`).querySelector(`[data-index="${segment.index}"] img`);
          if (image) image.src = segment.thumbnail;
        }
      }
    } catch (error) {
      console.warn('segment thumbnail:', error.message);
    } finally {
      probe.removeAttribute('src');
      probe.load();
    }
  })();
  thumbnailJobs.set(course.id, job);
  return job;
}

/**
 * 本地课程时长与切片。
 * - 古风燃脂：整片拿它自己的真实时长，10 个切片各自计时；
 *   切片文件的 start/end 仍是"文件内 0~时长"（跟练页就是单独播切片），
 *   另外记一份 masterStart/masterEnd 表示它在整片时间轴上的位置，回放页的分段条用这份。
 * - 其他风格：整段视频按 7 秒虚拟分段。
 */
async function hydrateLocalCourses() {
  await Promise.all(
    state.localCourses.map(async (course) => {
      if (course.master) {
        const [masterSeconds, ...sliceSeconds] = await Promise.all([
          probeDuration(course.video),
          ...course.segments.map((segment) => probeDuration(segment.src)),
        ]);
        const total =
          masterSeconds || course.duration || sliceSeconds.reduce((sum, value) => sum + (value || 0), 0);
        const step = total / Math.max(1, course.segments.length);
        course.segments.forEach((segment, index) => {
          const value = sliceSeconds[index] || segment.seconds || 0;
          segment.start = 0;
          segment.end = value;
          segment.duration = value;
          segment.seconds = value;
          segment.masterStart = Number((index * step).toFixed(3));
          segment.masterEnd = Number(((index + 1) * step).toFixed(3));
        });
        course.duration = total;
      } else {
        const duration = await probeDuration(course.video);
        course.duration = duration;
        course.segments = sliceSegments(duration, course.video, course.cover, SLICE_SECONDS);
      }
    })
  );
  renderHome();
  renderClassAlbums();
  if (state.video?.local) {
    state.segments = state.video.segments;
    renderFilmstrip();
    updateSegProgress();
    renderDetail();
    generateSegmentThumbnails(state.video);
  }
}

function renderCategories() {
  const list = $('category-list');
  list.innerHTML = '';
  CATEGORIES.forEach((category) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cat${category.id === state.category ? ' is-active' : ''}`;
    button.textContent = category.label;
    button.addEventListener('click', () => {
      state.category = category.id;
      $$('.cat').forEach((node) => node.classList.toggle('is-active', node === button));
      renderClassAlbums();
    });
    list.appendChild(button);
  });
}

async function loadLibrary({ silent = false } = {}) {
  let remote = [];
  let libraryLoaded = false;
  try {
    const { items } = await api.listVideos();
    remote = items || [];
    libraryLoaded = true;
  } catch (error) {
    $('library-status').textContent = `离线预览模式：后端未连接（${error.message}），内置课程仍可使用`;
    $('history-list').innerHTML = '<p class="empty-hint">后端未连接，无法读取练习记录</p>';
  }
  // 完整远端列表：内置课程关联（backendId）时从这里取后端数据源
  state.remoteVideos = remote;
  // 视频库里隐藏已被内置课程关联的同内容视频，避免出现两份
  const linked = new Set(state.localCourses.map((course) => course.backendId).filter(Boolean));
  const shown = remote.filter((video) => !linked.has(video.id));
  state.videos = [...state.localCourses, ...shown];
  if (libraryLoaded) {
    $('library-status').textContent = `已载入 ${state.localCourses.length} 个内置课程 · 视频库 ${shown.length} 个上传视频`;
  }
  renderHome();
  renderClassAlbums();
  renderRail();
  if (!state.video && state.videos.length && !silent) {
    /* 保持空白状态，由用户主动选择课程 */
  }
}

/* ----------------------------------------- 首页推荐：分层堆叠轮播（横向 coverflow） */

/**
 * 三层参数，对应设计稿里 5 张卡片的堆叠关系：
 * 中心 100%，相邻 91.9%，外圈 79.1%；x 是相对自身卡宽的百分比位移，o 是透明度。
 */
const REC_LEVELS = [
  { x: 0, s: 1, o: 1 },
  { x: 70.2, s: 0.919, o: 0.8 },
  { x: 121, s: 0.791, o: 0.7 },
];

let recIndex = 0;
let recCards = [];
let recDragMovedAt = 0;
let recTimer = 0;

/** 自动轮播：每 4.6s 转一张；手动点箭头/拖拽后暂停，静置 8s 再恢复 */
const REC_AUTOPLAY_MS = 4600;
const REC_IDLE_RESUME_MS = 8000;

let recResumeTimer = 0;

function stopRecAuto() {
  if (recTimer) window.clearInterval(recTimer);
  recTimer = 0;
}

function startRecAuto() {
  stopRecAuto();
  if (recResumeTimer) window.clearTimeout(recResumeTimer);
  recResumeTimer = 0;
  if (recCards.length < 3) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  recTimer = window.setInterval(() => {
    const home = $('view-home');
    if (!home || !home.classList.contains('is-active')) return;
    moveRec(1);
  }, REC_AUTOPLAY_MS);
}

/**
 * 用户手动翻页后停掉自动轮播并进入冷却。
 * 否则自动轮播会在几下点击之间偷偷多走一张，看上去就是"跳了一页"。
 */
function holdRecAuto() {
  stopRecAuto();
  if (recResumeTimer) window.clearTimeout(recResumeTimer);
  recResumeTimer = window.setTimeout(() => {
    recResumeTimer = 0;
    startRecAuto();
  }, REC_IDLE_RESUME_MS);
}

/** 幕后位置：比最外层再远一档，透明度为 0，用来接住暂时轮空的那张卡 */
const REC_OFFSTAGE_X = 165;
const REC_OFFSTAGE_S = 0.75;

/**
 * 写入一张卡的位置参数。
 * snap 用于跨越式补位（比如从左幕后直接补到右二圈）：先把位移瞬时落定、再单独淡入，
 * 避免 transform 从 -146% 过渡到 +121% 时那张卡横穿舞台。
 */
function setRecCard(card, x, scale, opacity, snap) {
  if (snap) {
    card.style.transition = 'none';
    card.style.setProperty('--x', String(x));
    card.style.setProperty('--s', String(scale));
    card.style.setProperty('--o', '0');
    void card.offsetWidth; // 强制回流，让瞬移立即生效
    card.style.transition = '';
    card.style.setProperty('--o', String(opacity));
    return;
  }
  card.style.setProperty('--x', String(x));
  card.style.setProperty('--s', String(scale));
  card.style.setProperty('--o', String(opacity));
}

/**
 * 排布一列「中心卡 + 两侧堆叠」的卡片。
 * 首页推荐和回放页的片段轮播共用这一套：同一组 REC_LEVELS、同一套无限循环与瞬移补位逻辑，
 * 只是传入的卡片数组和中心索引不同。
 *
 * step 是本次翻页方向：>0 表示往"下一张"，此时轮空的那张卡下次会从右侧补位，
 * 所以它要先停在右侧幕后，才能顺着方向滑进来（否则就只能原地淡入，看着像卡片凭空出现）。
 */
function layoutStack(cards, centerIndex, step = 0, levels = REC_LEVELS) {
  const total = cards.length;
  const entrySide = step >= 0 ? 1 : -1;

  cards.forEach((card, index) => {
    let distance = index - centerIndex;
    if (total >= 3) {
      // 绕半圈就翻到另一侧，做成无限循环；区间取 (-total/2, total/2]，
      // 偶数张卡时多出来的那张永远落在左侧幕后，不会左右横跳
      distance = (((index - centerIndex) % total) + total) % total;
      if (distance >= total / 2) distance -= total;
    }
    const prev = card.dataset.recDist === undefined ? null : Number(card.dataset.recDist);
    const prevX = Number(card.dataset.recX || 0);
    const wasOffstage = card.dataset.recOff === '1';
    const level = levels[Math.abs(distance)];

    card.dataset.recDist = String(distance);
    card.dataset.level = String(Math.abs(distance));
    card.classList.toggle('is-center', distance === 0);

    if (!level) {
      card.classList.add('is-offstage');
      card.style.zIndex = '1';
      card.tabIndex = -1;
      // 刚离开可见区的卡：顺着它离开的方向滑出去并淡掉；
      // 本来就在幕后的卡：悄悄挪到下一次进场的那一侧（不可见，瞬移无感）
      const x = wasOffstage
        ? entrySide * REC_OFFSTAGE_X
        : (Math.sign(prevX) || entrySide) * REC_OFFSTAGE_X;
      setRecCard(card, x, REC_OFFSTAGE_S, 0, prev === null || wasOffstage);
      card.dataset.recX = String(x);
      card.dataset.recOff = '1';
      return;
    }

    card.classList.remove('is-offstage');
    card.style.zIndex = String(20 - Math.abs(distance));
    card.tabIndex = 0;
    const x = distance < 0 ? -level.x : level.x;
    // 只有当一张"看得见"的卡要横跨大半个舞台时才瞬移（例如奇数张卡绕圈时 -2 直接补到 +2）。
    // 幕后的卡走到外侧档位只有 40 多个百分点，正常过渡就是顺滑的滑入。
    const teleport = prev === null || (!wasOffstage && Math.abs(x - prevX) > 180);
    setRecCard(card, x, level.s, level.o, teleport);
    card.dataset.recX = String(x);
    card.dataset.recOff = '0';
  });
}

function layoutRec(step = 0) {
  layoutStack(recCards, recIndex, step);
}

function moveRec(step) {
  const total = recCards.length;
  if (total < 2) return;
  recIndex = (recIndex + step + total) % total;
  layoutRec(step);
}

function renderHome() {
  const track = $('home-carousel-track');
  track.innerHTML = '';
  recCards = [];
  recIndex = 0;
  // 首页只排布非 using_total 系列的素材（内置风格课程 + 后台上传视频）
  const videos = state.videos.filter((video) => !video.master).slice(0, 12);

  $('home-sub').textContent = videos.length
    ? `${videos.length} 个课程可选，选中即可开始跟练`
    : '从教学视频库开始今天的练习';

  if (!videos.length) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'vcard vcard--add';
    empty.innerHTML = `<span><svg><use href="#i-upload"/></svg>上传第一个教学视频</span>`;
    empty.addEventListener('click', pickFile);
    track.appendChild(empty);
    recCards = [empty];
    layoutRec();
    return;
  }

  videos.forEach((video) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'vcard';
    const cover = coverOf(video);
    const count = video.segments?.length || 0;
    card.innerHTML = `
      ${cover ? `<img class="vcard__img" src="${cover}" alt="" loading="lazy" />` : ''}
      <span class="vcard__tint"></span>
      <span class="vcard__tag">${count ? `${count} 片段` : '本地课程'}</span>
      <span class="vcard__play"><svg><use href="#i-right"/></svg></span>
      <span class="vcard__body">
        <b>${escapeHtml(video.title)}</b>
        <small>${
          video.local
            ? `${escapeHtml(video.label || 'Local')}${video.duration ? ` · ${formatTime(video.duration)}` : ''}`
            : `${formatTime(video.duration)} · ${
                video.pose_status === 'ready' ? '骨架就绪' : video.pose_status === 'failed' ? '骨架失败' : '分析中'
              }`
        }</small>
      </span>
    `;
    if (!cover) {
      card.style.background = 'linear-gradient(140deg, #1db56b, #0c6b39)';
    }
    const position = recCards.length;
    recCards.push(card);
    card.addEventListener('click', () => {
      if (Date.now() - recDragMovedAt < 320) return; // 拖拽松手后的误触
      if (position !== recIndex) {
        // 点两侧的卡：先把它转到中间，再点一次才进课程
        recIndex = position;
        layoutRec();
        return;
      }
      openCourse(video.id);
    });
    track.appendChild(card);
  });

  layoutRec();
  startRecAuto();
}

/* ------------------------------------------------------- 课程大厅 / 弧形轮播 */

const DEFAULT_CLASSES_BG =
  'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=bright%20minimal%20dance%20studio%20interior%20with%20wooden%20floor%20and%20large%20mirrors%2C%20soft%20daylight%2C%20empty%20room%2C%20architectural%20photography&image_size=landscape_16_9';

function arcOffset(index) {
  const total = state.localCourses.length;
  const half = Math.floor(total / 2);
  let offset = index - state.arcIndex;
  while (offset < -half) offset += total;
  while (offset > half) offset -= total;
  return offset;
}

function renderArc() {
  const stage = $('arc-stage');
  const dots = $('arc-dots');
  stage.innerHTML = '';
  dots.innerHTML = '';

  state.localCourses.forEach((video, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'arc-card';
    card.dataset.index = String(index);
    const count = video.segments?.length || 0;
    card.innerHTML = `
      <img src="${coverOf(video)}" alt="" loading="lazy" />
      <span class="arc-card__veil"></span>
      <span class="arc-card__body">
        <b>${escapeHtml(video.title)}</b>
        <small>${escapeHtml(video.label || 'Local')}${count ? ` · ${count} 片段` : ''}</small>
      </span>
      <span class="arc-card__go">查看课程</span>
    `;
    card.addEventListener('click', () => {
      if (Date.now() - arcDragMovedAt < 320) return; // 拖拽松手后的误触
      if (arcOffset(index) === 0) openCourse(video.id);
      else {
        state.arcIndex = index;
        updateArc();
      }
    });
    stage.appendChild(card);

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'arc__dot';
    dot.setAttribute('aria-label', `切换到 ${video.title}`);
    dot.addEventListener('click', () => {
      state.arcIndex = index;
      updateArc();
    });
    dots.appendChild(dot);
  });
  updateArc(true); // 首次排布不要过渡：否则卡片会从舞台左上角飞出来
}

const ARC_STEP = 17; // 相邻两档之间的角度（度）
const ARC_MAX = 3; // 最多看到中心两侧各 3 档（共 7 张）
let arcDragMovedAt = 0;
let arcRelayoutTimer = 0;

/**
 * 扇形几何：圆心落在舞台右侧之外，卡片沿左侧圆弧一张张排开。
 * θ = 档位 × 每档角度；卡片中心 = 圆心 + R·(-cosθ, -sinθ)，
 * 越靠外（|θ| 越大）卡片越小、透明度越低——和设计稿 1440×1024 里的坐标一致：
 * 圆心大约在画面右侧再往外 0.3 个画面宽处，半径 ≈ 0.55 个画面高。
 */
function arcMetrics() {
  const stage = $('arc-stage');
  if (!stage) return null;
  const wide = stage.clientWidth || 760;
  const tall = stage.clientHeight || 420;
  const narrow = wide < 620;
  const step = narrow ? 14 : ARC_STEP;
  // 主卡高度按舞台高取，宽高比 301:169（设计稿里那张最大的卡）
  const cardH = Math.round(Math.min(Math.max(tall * (narrow ? 0.17 : 0.2), narrow ? 88 : 112), narrow ? 132 : 188));
  const cardW = Math.round(cardH * (301 / 169));
  // 半径同时受高和宽约束：先用「最外侧那张卡刚好不出上下边」反解一个上限，
  // 再和宽、高的经验值取小——这样视口怎么变，扇形都不会被舞台边缘切掉。
  const maxRad = (ARC_MAX * step * Math.PI) / 180;
  const fitR = (tall / 2 - cardH * 0.62) / Math.sin(maxRad);
  const radius = Math.round(Math.max(170, Math.min(tall * 0.56, wide * 0.9, fitR)));
  // 圆心：让中心卡停在舞台宽度 66% 的位置（扇形整体贴右，左侧留给标题）
  const cx = Math.round(wide * 0.66 + radius);
  const cy = Math.round(tall * 0.52);
  return { wide, tall, step, cardW, cardH, radius, cx, cy };
}

function arcScale(deg) {
  // 角度越大越小；17° ≈ 0.71、34° ≈ 0.55、51° ≈ 0.45
  return 1 / (1 + Math.abs(deg) / 42);
}

function updateArc(fresh) {
  const metrics = arcMetrics();
  const stage = $('arc-stage');
  if (!metrics || !stage) return;
  // 首次排布（或换分类重建卡片后）先关掉过渡，直接落位
  if (fresh) stage.classList.add('is-fresh');
  stage.style.setProperty('--arc-w', `${metrics.cardW}px`);
  stage.style.setProperty('--arc-h', `${metrics.cardH}px`);

  $$('#arc-stage .arc-card').forEach((card) => {
    const index = Number(card.dataset.index);
    const offset = arcOffset(index);
    const abs = Math.abs(offset);
    const deg = offset * metrics.step;
    const theta = (deg * Math.PI) / 180;
    const scale = arcScale(deg);
    // 圆心在右侧，卡片在圆心左边 → x = cx - R·cosθ；θ 为正时在圆心上方 → y = cy - R·sinθ
    const x = metrics.cx - metrics.radius * Math.cos(theta);
    const y = metrics.cy - metrics.radius * Math.sin(theta);

    card.style.setProperty('--tx', `${Math.round(x - metrics.cardW / 2)}px`);
    card.style.setProperty('--ty', `${Math.round(y - metrics.cardH / 2)}px`);
    card.style.setProperty('--rot', `${Math.round(deg)}deg`);
    card.style.setProperty('--s', scale.toFixed(3));
    card.style.zIndex = String(60 - abs);
    card.style.opacity = abs > ARC_MAX ? '0' : '1';
    card.style.pointerEvents = abs > ARC_MAX ? 'none' : 'auto';
    card.classList.toggle('is-active', offset === 0);
  });

  $$('#arc-dots .arc__dot').forEach((dot, index) => {
    dot.classList.toggle('is-active', index === state.arcIndex);
  });
  if ($('arc-counter')) {
    $('arc-counter').textContent = `${String(state.arcIndex + 1).padStart(2, '0')} / ${String(state.localCourses.length).padStart(2, '0')}`;
  }
  if (fresh) {
    void stage.offsetWidth; // 强制回流，让落位先生效
    window.requestAnimationFrame(() => stage.classList.remove('is-fresh'));
  }
}

function moveArc(direction) {
  const total = state.localCourses.length;
  if (!total) return;
  state.arcIndex = (state.arcIndex + direction + total) % total;
  updateArc();
  startArc();
}

function startArc() {
  stopArc();
  state.arcTimer = setInterval(() => {
    if (state.route !== 'classes' || state.category !== 'all') return;
    state.arcIndex = (state.arcIndex + 1) % state.localCourses.length;
    updateArc();
  }, 4600);
}

function stopArc(clear = false) {
  if (state.arcTimer) {
    clearInterval(state.arcTimer);
    state.arcTimer = 0;
  }
  if (clear) state.arcIndex = 0;
}

function applyCategoryBackdrop(category) {
  const bg = $('classes-bg');
  const asset = CATEGORY_BACKDROP[category];
  bg.src = asset ? assetUrl(asset.cover) : DEFAULT_CLASSES_BG;
  bg.classList.toggle('is-cover-bg', !!asset);
}

function renderClassAlbums() {
  const isAll = state.category === 'all';
  const results = state.videos.filter((video) => genreMatch(video, state.category));
  $('class-count').textContent = String(results.length);

  $('class-arc').hidden = !isAll;
  $('class-rail').hidden = isAll;
  applyCategoryBackdrop(state.category);

  if (isAll) {
    renderArc();
    startArc();
    $('classes-title').textContent = '本周精选 7 节课程';
    $('classes-sub').textContent = '扇形轮播每 4.6 秒自动切换；上下拖拽或点两侧卡片可换一张，点中间的卡片查看详情。';
  } else {
    stopArc();
    const list = $('class-albums');
    list.innerHTML = '';
    if (!results.length) {
      list.innerHTML = `<p class="empty-hint">${
        state.videos.length ? '该分类下暂无视频，换个分类看看' : '还没有教学视频，先上传一个吧'
      }</p>`;
    }
    results.forEach((video) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `album${state.video?.id === video.id ? ' is-active' : ''}`;
      button.dataset.id = video.id;
      const cover = coverOf(video);
      const count = video.segments?.length || 0;
      button.innerHTML = `
        <span class="album__cover">${cover ? `<img src="${cover}" alt="" loading="lazy" />` : ''}</span>
        <span class="album__body">
          <b>${escapeHtml(video.title)}</b>
          <small>${formatTime(video.duration)} · ${count ? `${count} 片段` : '本地课程'}</small>
        </span>
        <span class="album__plus"><svg><use href="#i-right"/></svg></span>
      `;
      button.addEventListener('click', () => openCourse(video.id));
      list.appendChild(button);
    });

    const category = CATEGORIES.find((item) => item.id === state.category);
    $('classes-title').textContent = category.label;
    $('classes-sub').textContent = results.length
      ? `共 ${results.length} 个课程，点击右侧卡片查看介绍`
      : '该分类暂无课程，去「All」看看其他风格';
  }
}

async function openCourse(videoId) {
  navigate(`#/class/${videoId}`);
}

async function openRouteClass(videoId) {
  let meta = state.videos.find((video) => video.id === videoId)
    || state.localCourses.find((video) => video.id === videoId);
  if (!meta && videoId) {
    try {
      meta = await api.getVideo(videoId);
    } catch {
      toast('课程不存在或已被删除', 'error');
      location.hash = '#/classes';
      return;
    }
  }
  if (!meta) {
    if (state.video) renderDetail();
    else location.hash = '#/classes';
    return;
  }
  if (state.video?.id !== meta.id) await selectVideo(meta);
  else renderDetail();
}

async function selectVideo(meta) {
  // 内置课程已导入后端（backendId）：改用后端视频流——骨架、掩码与教学画面
  // 时间轴一致，骨骼对比、人物阴影、重合度全部可用。
  // 不能只依赖预加载列表：打开课程可能早于 loadLibrary 完成，此时要主动查询，
  // 否则会退回本地未转码素材（部分编码在浏览器里表现为黑屏）。
  if (meta.local && meta.backendId) {
    let remote = (state.remoteVideos || []).find(
      (video) => video.id === meta.backendId && video.pose_status === 'ready'
    );
    if (!remote) {
      try {
        const fresh = await api.getVideo(meta.backendId);
        if (fresh?.pose_status === 'ready') {
          remote = fresh;
          state.remoteVideos = [
            fresh,
            ...(state.remoteVideos || []).filter((video) => video.id !== fresh.id),
          ];
        }
      } catch {
        // 后端不可用：回退原来的本地静态播放
      }
    }
    if (remote) {
      meta = {
        ...remote,
        title: meta.title,
        desc: meta.desc,
        cover: meta.cover,
        master: meta.master,
        builtin: true,
      };
    }
  }
  state.video = meta;
  state.segments = meta.segments || [];
  state.current = 0;
  state.teachFrames = meta.local ? [] : state.teachCache.get(meta.id) || [];
  lastTeachMask = null;

  teachVideo.pause();
  teachVideo.src = meta.local
    ? state.segments[0]?.src || meta.video || ''
    : api.streamUrl(meta.id);
  teachVideo.load();
  teachVideo.playbackRate = state.speed;

  $('stage-title').textContent = meta.title;
  hideCoachTip(); // 换课程后旧提示不再适用
  regionTipAt.clear();
  setTeachBadge(meta.local ? '本地素材 · 无骨架数据' : '骨架等待中');
  renderFilmstrip();
  renderDetail();
  renderClassAlbums();
  renderRail();
  renderFavorite();
  updateSegIndicator();
  updateSegProgress();

  if (meta.local) {
    generateSegmentThumbnails(meta);
    return;
  }

  if (state.teachFrames.length) {
    setTeachBadge(`骨架就绪 ${state.teachFrames.length} 帧`);
    loadTeachMasks(meta.id);
  } else if (meta.pose_status === 'ready') {
    await loadTeachPose(meta.id);
  } else if (meta.pose_status === 'failed') {
    setTeachBadge('骨架分析失败');
  } else {
    watchPoseUntilReady(meta.id);
  }
}

function setDetailCoverRatio(ratio) {
  const cover = $('detail-cover');
  if (!cover) return;
  if (ratio > 0.2 && ratio < 5) {
    cover.style.setProperty('--media-ratio', ratio.toFixed(4));
    // 竖屏用高度撑满，横屏用宽度撑满，避免任何方向被拉伸
    cover.classList.toggle('is-portrait', ratio < 0.85);
    cover.classList.toggle('is-landscape', ratio >= 0.85);
  } else {
    cover.style.removeProperty('--media-ratio');
    cover.classList.remove('is-portrait', 'is-landscape');
  }
}

function syncDetailRatio() {
  const image = $('detail-cover-img');
  if (!image) return;
  const apply = () => {
    const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 0;
    setDetailCoverRatio(ratio);
  };
  if (image.complete && image.naturalWidth) apply();
  else image.addEventListener('load', apply, { once: true });
}

function syncDetailVideoRatio(meta) {
  if (!meta) return;
  const src = meta.local
    ? state.segments[0]?.src || meta.video || ''
    : api.streamUrl(meta.id);
  if (!src) return;
  const cached = videoSizeCache.get(meta.id);
  if (cached) {
    setDetailCoverRatio(cached.width / cached.height);
    return;
  }
  probeVideoSize(src).then(({ width, height }) => {
    if (!width || !height) return;
    videoSizeCache.set(meta.id, { width, height });
    if (state.video?.id !== meta.id) return;
    setDetailCoverRatio(width / height);
  });
}

function renderDetail() {
  const meta = state.video;
  if (!meta) {
    $('detail-title').textContent = '尚未选择课程';
    return;
  }
  const cover = coverOf(meta);
  const image = $('detail-cover-img');
  if (cover) {
    image.src = cover;
    image.alt = `${meta.title} 封面`;
    image.style.display = '';
  } else {
    image.removeAttribute('src');
    image.alt = '';
    image.style.display = 'none';
  }
  $('detail-cover').style.background = cover
    ? '#dfe8dc'
    : 'linear-gradient(150deg, #1db56b, #0c6b39)';
  syncDetailRatio();
  syncDetailVideoRatio(meta);

  $('detail-title').textContent = meta.title;
  $('detail-meta').textContent = `${formatTime(meta.duration)} · ${state.segments.length} 个片段`;
  $('detail-badge').textContent = meta.local
    ? meta.master
      ? '内置课程'
      : '本地素材'
    : meta.pose_status === 'ready'
      ? '骨架已就绪'
      : meta.pose_status === 'failed'
        ? '骨架失败'
        : '分析中';
  $('detail-desc').textContent = meta.local
    ? `${meta.desc || '内置教学素材。'}${
        meta.master
          ? `课程由 ${state.segments.length} 个切片按编号顺序串起，学习界面可直接逐段跟练。`
          : `视频按 ${SLICE_SECONDS} 秒一个切片分为 ${state.segments.length} 段，封面图作为缩略说明图。`
      }点击「Start now」进入跟练：左侧教学画面，开始录制后右侧切换为摄像头分屏。`
    : `这是一段 ${formatTime(meta.duration)} 的教学视频，${
        meta.pose_status === 'ready' ? '骨架数据已提取完成，' : ''
      }` +
      `系统把视频切成 ${state.segments.length} 个可单独循环的片段。点击「Start now」进入跟练：` +
      '左侧是教学画面，开始录制后右侧切换为摄像头分屏，骨架与人物阴影会实时叠加。';

  const facts = [
    `${state.segments.length} 个片段`,
    meta.local
      ? meta.master
        ? '每片一个文件'
        : `每段 ${SLICE_SECONDS} 秒`
      : `每段 ${Math.round(state.segments[0]?.duration || 0)} 秒`,
    meta.local
      ? '骨架：不适用'
      : meta.pose_status === 'ready'
        ? '骨架：就绪'
        : meta.pose_status === 'failed'
          ? '骨架：失败'
          : '骨架：分析中',
    meta.local ? formatTime(meta.duration) || '本地视频' : formatDate(meta.created_at) || '本地视频',
  ];
  $('detail-facts').innerHTML = facts
    .filter(Boolean)
    .map((text) => `<li>${escapeHtml(text)}</li>`)
    .join('');
}

/* ------------------------------------------------------------------ 片段轮播 */

function renderFilmstrip() {
  const track = $('learn-carousel-track');
  track.innerHTML = '';
  if (!state.segments.length) {
    track.innerHTML = '<p class="film-empty">暂无片段</p>';
    return;
  }
  state.segments.forEach((segment) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'film-card';
    card.dataset.index = String(segment.index);
    const thumb = segment.thumbnail ? mediaUrl(segment.thumbnail) : '';
    const label = state.video?.master
      ? formatTime(segment.duration || segment.end || 0)
      : formatTime(segment.start);
    card.innerHTML = `
      ${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : ''}
      <span>${label}</span>
    `;
    card.addEventListener('click', () => {
      state.current = segment.index;
      highlightFilm();
      updateSegIndicator();
      playSegment(segment.index);
    });
    track.appendChild(card);
  });
  highlightFilm();
}

function highlightFilm() {
  $$('.film-card').forEach((card) => {
    const active = Number(card.dataset.index) === state.current;
    card.classList.toggle('is-active', active);
    if (active && card.parentElement) {
      const track = card.parentElement;
      const left = card.offsetLeft - track.clientWidth / 2 + card.clientWidth / 2;
      track.scrollTo({ left, behavior: 'smooth' });
    }
  });
}

function updateSegIndicator() {
  const total = state.segments.length;
  $('seg-indicator').textContent = total ? `${state.current + 1} / ${total}` : '-- / --';
}

function segmentEndOf(segment) {
  if (!segment) return 0;
  if (segment.end) return segment.end;
  if (segment.src) return teachVideo.duration || 0;
  return 0;
}

function updateSegProgress() {
  const segment = state.segments[state.current];
  const fill = $('teach-progress-fill');
  const dot = $('teach-progress-dot');
  const progress = $('teach-progress');
  const label = $('seg-time');

  if (!segment) {
    fill.style.width = '0%';
    dot.style.left = '0%';
    label.textContent = '-- / --';
    return;
  }
  const start = segment.start || 0;
  const end = segmentEndOf(segment);
  const t = Math.min(Math.max(teachVideo.currentTime || 0, start), end || 0);
  const span = Math.max(0, end - start);
  const ratio = span > 0 ? (t - start) / span : 0;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  fill.style.width = `${percent}%`;
  dot.style.left = `${percent}%`;
  progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  label.textContent = `${formatTime(t - start)} / ${formatTime(span)}`;
  updateTeachPlayButton();
}

function updateTeachPlayButton() {
  const segment = state.segments[state.current];
  const end = segmentEndOf(segment);
  const atEnd = !!segment && end > 0 && teachVideo.currentTime >= end - 0.02;
  $('teach-play-toggle').textContent = !teachVideo.paused && !atEnd ? '❚❚' : '▶';
}

let scrubbing = false;

function seekFromPointer(event) {
  const segment = state.segments[state.current];
  if (!segment) return;
  const end = segmentEndOf(segment);
  if (!end) return;
  const rect = $('teach-progress').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  teachVideo.currentTime = (segment.start || 0) + ratio * (end - (segment.start || 0));
  updateSegProgress();
}

let segmentPlayToken = 0;
let segmentTransition = false;
let segmentEndLocked = false;

async function playSegment(index) {
  const segment = state.segments[index];
  if (!segment) return;
  const token = ++segmentPlayToken;
  segmentTransition = true;
  state.current = index;
  setTeachBadge('');
  highlightFilm();
  updateSegIndicator();
  teachVideo.playbackRate = state.speed || 1;

  try {
    if (segment.src) {
      const target = new URL(segment.src, location.href).href;
      if (teachVideo.src !== target) {
        teachVideo.src = target;
        teachVideo.load();
        await waitVideoEvent(teachVideo, 'loadedmetadata', 8000);
      }
    } else if (!teachVideo.src && state.video) {
      teachVideo.src = api.streamUrl(state.video.id);
      teachVideo.load();
    }

    if (teachVideo.readyState < 1) await waitVideoEvent(teachVideo, 'loadedmetadata', 8000);
    if (token !== segmentPlayToken) return;
    teachVideo.currentTime = segment.start || 0;
    updateSegProgress();
    await teachVideo.play().catch(() => showDock());
  } catch (error) {
    if (token === segmentPlayToken) {
      console.warn('segment playback:', error.message);
      showDock();
    }
  } finally {
    if (token === segmentPlayToken) {
      segmentTransition = false;
      segmentEndLocked = false;
      updateSegProgress();
    }
  }
}

function handleSegmentEnd(fromEnded = false) {
  const segment = state.segments[state.current];
  if (!segment || segmentTransition || segmentEndLocked || scrubbing) return;
  if (!fromEnded && teachVideo.paused) return;
  const end = segmentEndOf(segment);
  if (!fromEnded && (!end || teachVideo.currentTime < end - 0.06)) return;
  segmentEndLocked = true;
  teachVideo.pause();
  updateSegProgress();
  if (state.recording) {
    live.sendRecordStop();
    return;
  }
  if (state.segments.length) {
    // 本段播完停在原地，等用户手动选下一段；保持控制条可见
    showDock();
    clearTimeout(dockHideTimer);
    setTeachBadge('本段结束 · 手动切下一段');
  }
}

/* ------------------------------------------------------------- 骨架与掩码 */

const teachMaskFrames = new Map();
const maskCache = createMaskCache(400);
let lastTeachMask = null;

function setTeachBadge(text) {
  $('teach-badge').textContent = text;
}

function getTeachMask(videoId, frameIndex) {
  const frames = teachMaskFrames.get(videoId);
  if (!frames || frameIndex == null || frameIndex >= frames.length) return null;
  return maskCache.get(`${videoId}:${frameIndex}`, async () => frames[frameIndex]);
}

function warmTeachMasks(videoId, frameIndex, span = 16) {
  const frames = teachMaskFrames.get(videoId);
  if (!frames || frameIndex == null) return;
  const end = Math.min(frames.length, frameIndex + span);
  for (let i = Math.max(0, frameIndex); i < end; i += 1) {
    if (frames[i]) maskCache.get(`${videoId}:${i}`, async () => frames[i]);
  }
}

async function watchPoseUntilReady(videoId) {
  setTeachBadge('骨架分析中…');
  for (let i = 0; i < 1200; i += 1) {
    await sleep(1500);
    if (state.video?.id !== videoId) return;
    let meta;
    try {
      meta = await api.getVideo(videoId);
    } catch {
      continue;
    }
    if (meta.pose_status === 'ready') {
      state.video = meta;
      state.segments = meta.segments || [];
      await loadTeachPose(videoId);
      renderDetail();
      return;
    }
    if (meta.pose_status === 'failed') {
      setTeachBadge('骨架分析失败');
      return;
    }
    setTeachBadge(`骨架分析中 ${Math.round((meta.pose_progress || 0) * 100)}%`);
  }
}

async function ensureTeachPoseLoaded() {
  if (!state.video || state.video.local || state.teachFrames.length) return;
  try {
    const meta = await api.getVideo(state.video.id);
    state.video = meta;
    if (meta.pose_status === 'ready') await loadTeachPose(meta.id);
    else if (meta.pose_status !== 'failed') watchPoseUntilReady(meta.id);
  } catch {
    /* 网络异常时忽略，下次进入再试 */
  }
}

async function getTeachFramesFor(videoId) {
  if (state.teachCache.has(videoId)) return state.teachCache.get(videoId);
  const pose = await api.getPose(videoId);
  const frames = pose.frames || [];
  frames.forEach((frame, index) => {
    frame.i = index;
  });
  state.teachCache.set(videoId, frames);
  return frames;
}

async function loadTeachPose(videoId) {
  try {
    const frames = await getTeachFramesFor(videoId);
    if (state.video?.id === videoId) state.teachFrames = frames;
    setTeachBadge(`骨架就绪 ${frames.length} 帧`);
    loadTeachMasks(videoId);
  } catch {
    setTeachBadge('骨架未就绪');
  }
}

async function loadTeachMasks(videoId, urlOverride = null) {
  if (teachMaskFrames.has(videoId)) return;
  const url = urlOverride ?? (state.video?.id === videoId ? state.video?.masks_url : null);
  if (!url) {
    teachMaskFrames.set(videoId, null);
    return;
  }
  try {
    const res = await fetch(mediaUrl(url));
    if (!res.ok) throw new Error('no masks');
    teachMaskFrames.set(videoId, parseMaskBin(await res.arrayBuffer()));
  } catch {
    teachMaskFrames.set(videoId, null);
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
    const overall = 12 + progress * 0.86;
    setLoaderText(`正在提取教学骨架 ${progress}%`, overall);
    await sleep(1200);
  }
  throw new Error('骨架分析超时');
}

/* ------------------------------------------------------------------ 侧栏列表 */

function renderRail() {
  const learning = $('rail-learning-list');
  learning.innerHTML = '';
  if (!state.videos.length) {
    learning.innerHTML = '<p class="rail-empty">还没有课程，先上传一个教学视频</p>';
  } else {
    state.videos.slice(0, 12).forEach((video) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `rail-row${state.video?.id === video.id ? ' is-active' : ''}`;
      row.innerHTML = `
        <span class="rail-row__title">${escapeHtml(video.title)}</span>
        <span class="rail-row__meta">${video.segments?.length || 0}</span>
      `;
      row.addEventListener('click', () => openCourse(video.id));
      learning.appendChild(row);
    });
  }

  const history = $('rail-history-list');
  history.innerHTML = '';
  if (!state.sessions.length) {
    history.innerHTML = '<p class="rail-empty">暂无练习记录</p>';
  } else {
    state.sessions.slice(0, 12).forEach((session) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `rail-row${state.currentSessionId === session.id ? ' is-active' : ''}`;
      row.innerHTML = `
        <span class="rail-row__title">${escapeHtml(session.title)}</span>
        <span class="rail-row__meta">${formatTime(session.duration)}</span>
      `;
      row.addEventListener('click', () => {
        navigate(`#/correct/${session.id}`);
      });
      history.appendChild(row);
    });
  }

  renderStars();
}

function renderStars() {
  const stars = $('rail-stars-list');
  const videos = state.favs.videos
    .map((id) => state.videos.find((video) => video.id === id))
    .filter(Boolean);
  const sessions = state.favs.sessions
    .map((id) => state.sessions.find((session) => session.id === id))
    .filter(Boolean);

  if (!videos.length && !sessions.length) {
    stars.innerHTML = '<p class="rail-empty">收藏的课程会出现在这里</p>';
    return;
  }
  stars.innerHTML = '';
  videos.forEach((video) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rail-row';
    row.innerHTML = `<span class="rail-row__title">${escapeHtml(video.title)}</span><span class="rail-row__meta">课程</span>`;
    row.addEventListener('click', () => openCourse(video.id));
    stars.appendChild(row);
  });
  sessions.forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rail-row';
    row.innerHTML = `<span class="rail-row__title">${escapeHtml(session.title)}</span><span class="rail-row__meta">回放</span>`;
    row.addEventListener('click', () => navigate(`#/correct/${session.id}`));
    stars.appendChild(row);
  });
}

function renderFavorite() {
  const button = $('favorite-btn');
  const isFav = !!state.video && state.favs.videos.includes(state.video.id);
  button.classList.toggle('is-fav', isFav);
  button.setAttribute('aria-pressed', String(isFav));
  button.setAttribute('aria-label', isFav ? '取消收藏课程' : '收藏课程');

  const replayButton = $('replay-fav');
  const isFavSession = !!state.currentSessionId && state.favs.sessions.includes(state.currentSessionId);
  replayButton.classList.toggle('is-fav', isFavSession);
  replayButton.setAttribute('aria-pressed', String(isFavSession));
}

/* -------------------------------------------------------------- 性能埋点 */

const perf = { teach: 0, live: 0, replay: 0, dropped: 0, serverMs: 0, stages: null };
let teachFpsHandle = 0;
let teachFpsMode = '';

function syncPerfHud() {
  const hud = $('perf-hud');
  if (hud) hud.hidden = !state.settings.showPerf || !STAGE_ROUTES.has(state.route);
}

function startTeachFps() {
  if (teachFpsHandle) return;
  const video = $('teach-video');
  if (video.requestVideoFrameCallback) {
    // requestVideoFrameCallback 统计的是实际送显帧，能区分「视频掉帧」与「屏幕刷新」
    teachFpsMode = 'video';
    const tick = () => {
      perf.teach += 1;
      teachFpsHandle = video.requestVideoFrameCallback(tick);
    };
    teachFpsHandle = video.requestVideoFrameCallback(tick);
  } else {
    teachFpsMode = 'raf';
    const tick = () => {
      perf.teach += 1;
      teachFpsHandle = requestAnimationFrame(tick);
    };
    teachFpsHandle = requestAnimationFrame(tick);
  }
}

function stopTeachFps() {
  if (!teachFpsHandle) return;
  if (teachFpsMode === 'video') $('teach-video')?.cancelVideoFrameCallback?.(teachFpsHandle);
  else cancelAnimationFrame(teachFpsHandle);
  teachFpsHandle = 0;
  teachFpsMode = '';
}

function initPerfHud() {
  window.setInterval(() => {
    if (!state.settings.showPerf || !STAGE_ROUTES.has(state.route)) return;
    $('perf-teach').textContent = `教学 ${perf.teach} fps`;
    $('perf-live').textContent = `接收 ${perf.live} fps · 推理 ${Math.round(perf.serverMs)}ms`;
    const stages = perf.stages;
    $('perf-stage').textContent = stages
      ? `解码 ${stages.decode_ms} · 骨架 ${stages.infer_ms} · 掩码 ${stages.mask_ms} ms`
      : '分阶段耗时 --';
    $('perf-drop').textContent = `丢帧 ${perf.dropped}/s`;
    $('perf-replay').textContent = `回放 ${perf.replay} fps`;
    perf.teach = 0;
    perf.live = 0;
    perf.replay = 0;
    perf.dropped = 0;
  }, 1000);
}

/* ------------------------------------------------------------------ 实时跟练 */

const live = new LivePoseStream({
  video: cameraVideo,
  onPose: ({ pose, mask, serverMs, rtt, stages, dropped }) => {
    perf.live += 1;
    perf.dropped += dropped;
    perf.serverMs = serverMs;
    perf.stages = stages;
    state.livePose = pose;
    state.liveMask = mask ?? null;
    $('latency-badge').textContent = `延时 ${Math.round(rtt)}ms · 推理 ${Math.round(serverMs)}ms`;
    setConn(true, '实时链路在线');
    $('rail-state').textContent = '实时链路在线';
  },
  onStatus: (text) => {
    $('latency-badge').textContent = text;
    if (text.includes('已连接')) {
      hideCamError();
      setConn(true, '实时链路在线');
      $('rail-state').textContent = '实时链路在线';
    } else if (text.includes('断开') || text.includes('不可用')) {
      setConn(false, '实时链路中断');
      $('rail-state').textContent = '离线';
    } else if (text === '已停止') {
      state.livePose = null;
      state.liveMask = null;
      $('latency-badge').textContent = '未开启';
      setConn(false, '未连接');
      $('rail-state').textContent = '离线';
    }
  },
  onRecordState: ({ recording, title, session }) => {
    state.recording = recording;
    const button = $('record-btn');
    button.classList.toggle('is-recording', recording);
    button.querySelector('span').textContent = recording ? '结束录制' : '开始录制';

    if (recording) {
      enterRecordingLayout();
      $('replay-status').textContent = `录制中：${title}`;
      toast('开始录制，跟随教学片段完成动作');
    } else {
      exitRecordingLayout();
      if (session) {
        $('replay-status').textContent = `已保存：${session.title}`;
        state.currentSessionId = session.id;
        toast('练习已保存，正在打开回放');
        refreshSessions(false).then(() => navigate(`#/correct/${session.id}`));
      }
    }
  },
});

function setConn(online, text) {
  const badge = $('conn-badge');
  badge.classList.toggle('is-online', online);
  badge.classList.toggle('is-error', !online && text.includes('中断'));
  badge.querySelector('span').textContent = text;
}

function cameraErrorMessage(error) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return '当前页面环境无法访问摄像头（需要 HTTPS 或 localhost）';
  }
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝：点击地址栏左侧的摄像头图标改为"允许"，然后重试';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未检测到摄像头设备，请确认电脑已连接摄像头';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用（微信 / 抖音 / 腾讯会议等），关闭后重试';
    case 'OverconstrainedError':
      return '摄像头不支持所请求的分辨率';
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
    setConn(false, '未连接');
    showCamError(message);
    console.warn('camera error:', error);
  }
}

/* ------------------------------------------------------------- 骨架叠加绘制 */

function prepareCanvas(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawTeachOverlay() {
  if (!$('view-learning').classList.contains('is-active')) return;
  const prepared = prepareCanvas(teachOverlay);
  if (!prepared || !teachVideo.videoWidth) return;
  const { ctx, width, height } = prepared;
  const rect = fitRect(width, height, teachVideo.videoWidth, teachVideo.videoHeight);
  const frame = poseAt(state.teachFrames, teachVideo.currentTime);

  if (!frame?.pose) return;

  // 教学人物阴影；同时留作重合度计算的基准掩码
  let teachMaskActive = null;
  if (state.shadows && state.video) {
    const maskBitmap = getTeachMask(state.video.id, frame.i);
    if (maskBitmap) lastTeachMask = maskBitmap;
    teachMaskActive = maskBitmap || lastTeachMask;
    if (teachMaskActive) drawShadow(ctx, teachMaskActive, rect, '#ffb020', 0.28);
    warmTeachMasks(state.video.id, frame.i);
  }
  if (state.skeleton) {
    drawPose(ctx, frame.pose, rect, {
      color: '#ffb020',
      lineWidth: 2.5,
      alpha: 0.8,
      jointAlpha: 0.45,
      shadow: true,
    });
  }

  // 你的轮廓（绿）叠加到教学画面 + 重合百分比 + 小教练提示
  if (state.livePose && cameraVideo.videoWidth) {
    const liveRect = { x: 0, y: 0, w: cameraVideo.videoWidth, h: cameraVideo.videoHeight };
    // 摄像头画面是镜像的：先翻回正向视角，再映射到教学帧
    const flippedLive = flipX(state.livePose);

    let liveRectNorm = null;
    if (state.shadows && state.liveMask) {
      const shadowRect = mapShadowRect(flippedLive, liveRect, frame.pose, rect);
      if (shadowRect) {
        drawShadow(ctx, state.liveMask, shadowRect, '#00e5a0', 0.3, true);
        liveRectNorm = {
          x: (shadowRect.x - rect.x) / rect.w,
          y: (shadowRect.y - rect.y) / rect.h,
          w: shadowRect.w / rect.w,
          h: shadowRect.h / rect.h,
        };
      }
    }
    updateOverlapBadge(teachMaskActive, state.liveMask, liveRectNorm, frame.pose);

    if (state.skeleton && state.compare) {
      const mapped = mapPose(flippedLive, liveRect, frame.pose, rect);
      if (mapped) {
        drawPose(ctx, mapped, rect, {
          color: '#00e5a0',
          lineWidth: 2,
          dashed: true,
          alpha: 0.55,
          jointAlpha: 0.45,
        });
      }
    }
  } else {
    updateOverlapBadge(null, null, null);
  }
}

/* ------------------------------------------------- 轮廓重合度（IoU） */

let overlapCanvasEl = null;
let lastOverlapCheck = 0;

/** 教学轮廓 vs 你的轮廓（映射到教学帧后）的交并比，节流更新到角标。 */
function updateOverlapBadge(teachMask, liveMask, liveRectNorm, teachPose) {
  const badge = $('overlap-badge');
  if (!badge) return;
  const now = performance.now();
  if (now - lastOverlapCheck < 120) return;
  lastOverlapCheck = now;

  if (!teachMask || !liveMask || !liveRectNorm) {
    badge.hidden = true; // 双方轮廓齐了才显示，避免一直挂着 "--%"
    hideCoachTip();
    return;
  }
  badge.hidden = false;

  const size = 96;
  if (!overlapCanvasEl) {
    overlapCanvasEl = document.createElement('canvas');
    overlapCanvasEl.width = size;
    overlapCanvasEl.height = size;
  }
  const c = overlapCanvasEl.getContext('2d', { willReadFrequently: true });

  // 教学掩码 alpha
  c.clearRect(0, 0, size, size);
  c.drawImage(teachMask, 0, 0, size, size);
  const teachData = c.getImageData(0, 0, size, size).data;

  // 你的掩码：水平翻转后放到教学帧坐标系中对应的人体区域
  c.clearRect(0, 0, size, size);
  const fx = 1 - liveRectNorm.x - liveRectNorm.w;
  c.save();
  c.translate((fx + liveRectNorm.w) * size, liveRectNorm.y * size);
  c.scale(-1, 1);
  c.drawImage(liveMask, 0, 0, liveRectNorm.w * size, liveRectNorm.h * size);
  c.restore();
  const liveData = c.getImageData(0, 0, size, size).data;

  let inter = 0;
  let union = 0;
  for (let i = 3; i < teachData.length; i += 4) {
    const a = teachData[i] > 128;
    const b = liveData[i] > 128;
    if (a || b) union += 1;
    if (a && b) inter += 1;
  }
  const pct = union ? Math.round((inter / union) * 100) : 0;
  badge.textContent = `重合 ${pct}%`;
  maybeCoachTip(analyzeRegions(teachData, liveData, size, teachPose));
}

/* ------------------------------------------------- 部位提示（小教练） */

// 部位划分：以教学骨架关节点为中心，半径按肩宽缩放，覆盖该肢体的轮廓
const TIP_REGIONS = [
  { key: 'head', name: '头', joints: [0], scale: 1.0 },
  { key: 'larm', name: '左手', joints: [13, 15], scale: 1.25 },
  { key: 'rarm', name: '右手', joints: [14, 16], scale: 1.25 },
  { key: 'hip', name: '腰部', joints: [23, 24], scale: 1.15 },
  { key: 'lleg', name: '左腿', joints: [25, 27], scale: 1.25 },
  { key: 'rleg', name: '右腿', joints: [26, 28], scale: 1.25 },
];
const TIP_MIN_PIXELS = 10; // 区域内像素太少不评估（掩码只有 96×96，避免噪声）
const TIP_MIN_COVER = 0.62; // 你的轮廓覆盖率低于此值才提示
const TIP_COOLDOWN_MS = 5000; // 同一部位提示冷却
const TIP_SHOW_MS = 3400;
const PRAISE_INTERVAL_MS = 12000;
const OFFSET_THRESHOLD = 0.16; // 质心偏移阈值（以肩宽为单位）
const regionTipAt = new Map();
let tipHideTimer = 0;
let lastPraiseAt = 0;

/**
 * 分部位统计「教学轮廓 / 你的轮廓」的覆盖与质心偏移。
 * 返回每部位的覆盖率、面积比、质心差（单位：肩宽）。
 */
function analyzeRegions(teachData, liveData, size, teachPose) {
  if (!teachPose) return [];
  const vis = (p) => p && (p[3] ?? 1) > 0.3;
  let span = 0.16;
  if (vis(teachPose[11]) && vis(teachPose[12])) {
    span =
      Math.hypot(teachPose[11][0] - teachPose[12][0], teachPose[11][1] - teachPose[12][1]) ||
      0.16;
  }

  const centers = TIP_REGIONS.map((region) => {
    const pts = region.joints.map((j) => teachPose[j]).filter(vis);
    if (!pts.length) return null;
    const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
    const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
    const r = span * region.scale * size;
    return { x: x * size, y: y * size, r2: r * r };
  });

  const stats = TIP_REGIONS.map(() => ({ a: 0, b: 0, i: 0, ax: 0, ay: 0, bx: 0, by: 0 }));

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const alphaIndex = (py * size + px) * 4 + 3;
      const inTeach = teachData[alphaIndex] > 128;
      const inLive = liveData[alphaIndex] > 128;
      if (!inTeach && !inLive) continue;

      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < centers.length; k += 1) {
        const c = centers[k];
        if (!c) continue;
        const dx = px + 0.5 - c.x;
        const dy = py + 0.5 - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < c.r2 && d2 < bestDist) {
          bestDist = d2;
          best = k;
        }
      }
      if (best < 0) continue;

      const s = stats[best];
      if (inTeach) {
        s.a += 1;
        s.ax += px;
        s.ay += py;
      }
      if (inLive) {
        s.b += 1;
        s.bx += px;
        s.by += py;
      }
      if (inTeach && inLive) s.i += 1;
    }
  }

  return TIP_REGIONS.map((region, k) => {
    const s = stats[k];
    if (!s.a || !s.b) return { region, a: s.a, b: s.b, cover: 0, dx: 0, dy: 0 };
    return {
      region,
      a: s.a,
      b: s.b,
      cover: s.i / s.a,
      // 质心差：+dy 表示你的部位比阴影更靠下，dx>0 表示更靠画面右侧
      dx: (s.bx / s.b - s.ax / s.a) / (span * size),
      dy: (s.by / s.b - s.ay / s.a) / (span * size),
    };
  });
}

/** 按部位 + 偏移方向生成提示文案（鼓励语气，先肯定再给动作）。 */
function tipTextFor(entry) {
  const { region, cover, dx, dy, a, b } = entry;
  const name = region.name;
  const low = dy > OFFSET_THRESHOLD;
  const high = dy < -OFFSET_THRESHOLD;
  const side = Math.abs(dx) > OFFSET_THRESHOLD ? (dx > 0 ? '往左' : '往右') : '';
  const tooBig = b > a * 1.6;

  if (region.key === 'head') {
    if (low) return '头再向上抬一点，视线跟上老师就更好啦';
    if (high) return '头稍微向下收一点，和老师的轮廓对齐';
    if (side) return `头再${side}一点，马上就重合了`;
    return '头的位置很贴近了，保持住';
  }

  if (region.key === 'hip') {
    if (low) return '腰部再向上提一点，重心跟上老师';
    if (high) return '腰稍微向下沉一点，和老师的姿势对齐';
    if (side) return `腰再${side}带一点，轮廓就贴合了`;
    if (tooBig) return '腰部幅度收一点，别超过阴影';
    return '腰腹位置很稳，继续保持';
  }

  if (region.key.endsWith('leg')) {
    if (low) return `${name}再向上抬一些，幅度跟上老师`;
    if (high) return `${name}稍微向下收一点，注意和老师对齐`;
    if (side) return `${name}再${side}带一点，轮廓就重合了`;
    if (tooBig) return `${name}幅度收一点，别超出阴影`;
    if (cover < 0.4) return `${name}再伸展开一点，跟住老师的幅度`;
    return `${name}再向上抬高一点点就贴合了`;
  }

  // 手臂（用户反馈最容易出现"低于阴影"的部位）
  if (low) return `${name}再向上抬一点点，就快贴合了！`;
  if (high) return `${name}稍微向下放一点，和老师的轮廓对齐`;
  if (side) return `${name}再${side}带一点，轮廓就越贴越近了`;
  if (tooBig) return `${name}幅度收一点，别超出阴影`;
  if (cover < 0.4) return `${name}再伸展开一些，跟上老师的幅度`;
  return `${name}再向上抬高一点点就贴合了`;
}

/* 小教练语音播报：用浏览器自带的 speechSynthesis，不需要后端或联网。
   系统语音列表可能异步加载，voiceschanged 时缓存一次中文声音。 */
let coachVoice = null;
function resolveCoachVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => /^zh[-_]?cn/i.test(voice.lang)) ||
    voices.find((voice) => /^zh/i.test(voice.lang)) ||
    null
  );
}
if ('speechSynthesis' in window && window.speechSynthesis.addEventListener) {
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    coachVoice = resolveCoachVoice();
  });
}

function speakText(text) {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
  const synth = window.speechSynthesis;
  try {
    synth.cancel(); // 新提示打断上一条，避免多条叠加
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.08;
    utterance.pitch = 1;
    const voice = coachVoice || resolveCoachVoice();
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  } catch {
    // 浏览器不支持或尚未获得播放权限时，保留文字提示即可
  }
}

function speakCoachTip(text) {
  if (!state.settings.voiceTips) return;
  speakText(text);
}

function stopCoachVoice() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function showCoachTip(text) {
  const tip = $('coach-tip');
  if (!tip) return;
  tip.textContent = text;
  tip.hidden = false;
  // 强制回流，保证 hidden 移除后过渡动画生效
  void tip.offsetWidth;
  tip.classList.add('is-show');
  speakCoachTip(text);
  clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(() => {
    tip.classList.remove('is-show');
    setTimeout(() => {
      if (!tip.classList.contains('is-show')) tip.hidden = true;
    }, 260);
  }, TIP_SHOW_MS);
}

function hideCoachTip() {
  const tip = $('coach-tip');
  if (!tip) return;
  clearTimeout(tipHideTimer);
  tip.classList.remove('is-show');
  tip.hidden = true;
  stopCoachVoice();
}

/* ---------------------------------------------------------- 语音指令（本地） */

let voiceSocket = null;
let voiceRetryTimer = 0;
let voiceStatus = 'off';
let voiceToastShown = false;

function syncVoiceButton() {
  const button = $('voice-btn');
  if (!button) return;
  const enabled = state.settings.voiceCommands !== false;
  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('is-live', enabled && voiceStatus === 'listening');
  button.title = enabled
    ? voiceStatus === 'listening'
      ? '语音助手：监听中，说「小教练」+ 指令'
      : `语音助手：${voiceStatus}`
    : '语音助手已关闭';
}

function connectVoice() {
  if (!state.settings.voiceCommands) return;
  if (voiceSocket && (voiceSocket.readyState === WebSocket.OPEN || voiceSocket.readyState === WebSocket.CONNECTING)) {
    if (voiceSocket.readyState === WebSocket.OPEN) sendVoiceControl(true);
    return;
  }
  clearTimeout(voiceRetryTimer);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/voice`);
  voiceSocket = socket;

  socket.addEventListener('open', () => {
    sendVoiceControl(true);
    sendVoiceTitles();
    if (!voiceToastShown) {
      voiceToastShown = true;
      toast('语音助手已连接，说「小教练」+ 指令试试');
    }
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleVoiceMessage(message);
  });
  socket.addEventListener('close', () => {
    voiceSocket = null;
    voiceStatus = 'off';
    if (state.settings.voiceCommands) {
      voiceRetryTimer = setTimeout(connectVoice, 2500);
    }
  });
  socket.addEventListener('error', () => {
    voiceStatus = 'error';
  });
}

function sendVoiceControl(enabled) {
  if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
    voiceSocket.send(JSON.stringify({ type: 'set_enabled', value: enabled }));
  }
}

function sendVoiceTitles() {
  if (!voiceSocket || voiceSocket.readyState !== WebSocket.OPEN) return;
  const titles = [...new Set((state.videos || []).map((video) => video.title).filter(Boolean))];
  voiceSocket.send(JSON.stringify({ type: 'sync_titles', titles }));
}

function disableVoice() {
  // 保持连接以便再次开启；后端收到 false 会立即停掉麦克风
  clearTimeout(voiceRetryTimer);
  sendVoiceControl(false);
  voiceStatus = 'paused';
  syncVoiceButton();
}

function handleVoiceMessage(message) {
  if (message.type === 'status') {
    voiceStatus = message.state || 'unknown';
    syncVoiceButton();
    if (voiceStatus === 'error' && message.detail) {
      toast(`语音助手不可用：${message.detail}`);
    }
    return;
  }
  if (message.type === 'reply') {
    if (state.settings.voiceTips && message.text) speakText(message.text);
    return;
  }
  if (message.type === 'asr') {
    console.info(`[语音] ${message.text}（${message.asr_ms}ms）`);
    return;
  }
  if (message.type === 'command') {
    runVoiceCommand(message).catch((error) => console.warn('语音指令执行失败', error));
  }
}

function normalizeVoiceText(text) {
  return String(text || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
}

function voiceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const grams = (text) => {
    const map = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const key = text.slice(i, i + 2);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };
  const left = grams(a);
  const right = grams(b);
  let overlap = 0;
  let total = 0;
  left.forEach((count, key) => {
    total += count;
    overlap += Math.min(count, right.get(key) || 0);
  });
  right.forEach((count) => { total += count; });
  return total ? (overlap * 2) / total : 0;
}

function findVideoByVoice(query) {
  const target = normalizeVoiceText(query);
  if (!target) return null;
  let best = null;
  let bestScore = 0;
  for (const video of state.videos || []) {
    const score = voiceSimilarity(target, normalizeVoiceText(video.title));
    if (score > bestScore) {
      best = video;
      bestScore = score;
    }
  }
  return bestScore >= 0.45 ? best : null;
}

async function runVoiceCommand(message) {
  const action = message.action;

  if (action === 'play_video') {
    let meta =
      (state.videos || []).find((video) => video.id === message.video_id) ||
      (state.remoteVideos || []).find((video) => video.id === message.video_id);
    if (!meta && message.video_id) {
      try {
        meta = await api.getVideo(message.video_id);
      } catch {
        meta = null;
      }
    }
    if (!meta && message.video) meta = findVideoByVoice(message.video);
    if (!meta) {
      toast(`没有找到「${message.video || ''}」`);
      return;
    }
    await selectVideo(meta);
    navigate('#/learning');
    playSegment(0);
    return;
  }

  if (action === 'start_practice') {
    if (!state.video) return;
    navigate('#/learning');
    playSegment(state.current || 0);
    return;
  }

  if (action === 'pause') {
    teachVideo.pause();
    return;
  }

  if (action === 'resume') {
    if (state.route !== 'learning' || !state.video) return;
    const segment = state.segments[state.current];
    if (segment && teachVideo.currentTime >= segmentEndOf(segment) - 0.02) {
      segmentEndLocked = false;
      teachVideo.currentTime = segment.start || 0;
    }
    teachVideo.play().catch(() => {});
    return;
  }

  if (!['next_segment', 'prev_segment', 'restart_segment'].includes(action)) return;
  if (!state.video || !state.segments.length) return;
  if (state.route !== 'learning') navigate('#/learning');
  const total = state.segments.length;
  if (action === 'restart_segment') playSegment(state.current || 0);
  else if (action === 'next_segment') playSegment((state.current + 1) % total);
  else playSegment((state.current - 1 + total) % total);
}

// 调试钩子：便于自动化验证部位判定与文案方向（不参与业务逻辑）
window.__coachTest = { analyzeRegions, tipTextFor, TIP_REGIONS };
window.__voiceTest = {
  handleVoiceMessage,
  runVoiceCommand,
  connectVoice,
  findVideoByVoice,
  get status() { return voiceStatus; },
  get socketState() { return voiceSocket ? voiceSocket.readyState : -1; },
};

/** 挑覆盖最差的部位给一条提示；全部贴合时偶尔鼓励一句。 */
function maybeCoachTip(regions) {
  if (!regions.length) return;
  const now = performance.now();

  const candidates = regions.filter(
    (r) => r.a >= TIP_MIN_PIXELS && r.b >= TIP_MIN_PIXELS && r.cover < TIP_MIN_COVER
  );

  if (!candidates.length) {
    const solid = regions.filter((r) => r.a >= TIP_MIN_PIXELS);
    const good = solid.length >= 3 && solid.every((r) => r.cover >= 0.72);
    if (good && now - lastPraiseAt > PRAISE_INTERVAL_MS) {
      lastPraiseAt = now;
      showCoachTip('这个动作很贴合，保持住！');
    }
    return;
  }

  candidates.sort((x, y) => x.cover - y.cover);
  const worst = candidates[0];
  const last = regionTipAt.get(worst.region.key) || 0;
  if (now - last < TIP_COOLDOWN_MS) return;
  regionTipAt.set(worst.region.key, now);
  showCoachTip(tipTextFor(worst));
}

function drawCameraOverlay() {
  if (!$('view-learning').classList.contains('is-active')) return;
  const prepared = prepareCanvas(cameraOverlay);
  if (!prepared || !cameraVideo.videoWidth) return;
  const { ctx, width, height } = prepared;
  const rect = fitRect(width, height, cameraVideo.videoWidth, cameraVideo.videoHeight);

  if (!state.livePose) return;

  // 摄像头画面只显示骨架：人物阴影集中在教学画面做对比，避免两侧重复
  if (state.skeleton) {
    drawPose(ctx, state.livePose, rect, {
      color: '#00e5a0',
      lineWidth: 2.5,
      alpha: 0.8,
      jointAlpha: 0.45,
      shadow: true,
    });
  }

  if (state.skeleton && state.compare && teachVideo.videoWidth && state.teachFrames.length) {
    const teaching = poseAt(state.teachFrames, teachVideo.currentTime);
    if (!teaching?.pose) return;
    const teachRect = { x: 0, y: 0, w: teachVideo.videoWidth, h: teachVideo.videoHeight };
    const flippedTeach = flipX(teaching.pose);
    const mapped = mapPose(flippedTeach, teachRect, state.livePose, rect);
    if (!mapped) return;

    drawPose(ctx, mapped, rect, {
      color: '#ff5c8a',
      lineWidth: 2.5,
      dashed: true,
      alpha: 0.6,
      jointAlpha: 0.45,
    });
  }
}

function overlayLoop() {
  drawTeachOverlay();
  drawCameraOverlay();
  requestAnimationFrame(overlayLoop);
}

/* --------------------------------------------------------------- 纠错回放 */

const player = new ReplayPlayer({
  canvas: $('replay-canvas'),
  seekBar: $('replay-seek'),
  timeLabel: $('replay-time'),
  playButton: $('replay-toggle'),
  getTeachFrames: getTeachFramesFor,
  onState: (playing) => setPlayIcon(playing),
  onFrame: () => { perf.replay += 1; },
  getTeachMasks: async (videoId) => {
    if (!teachMaskFrames.has(videoId)) {
      let url = state.video?.id === videoId ? state.video?.masks_url : null;
      if (!url) {
        try {
          url = (await api.getVideo(videoId)).masks_url ?? null;
        } catch {
          url = null;
        }
      }
      await loadTeachMasks(videoId, url);
    }
    return teachMaskFrames.get(videoId) ?? null;
  },
});

/* ------------------------------------------------- 回放：整片 / 切片 / 分段条 */

/**
 * 片段轮播的档位参数：和首页同一套结构（中心/相邻/外圈三层 + 位移百分比 + 透明度），
 * 只是回放页的卡片小得多，位移要摊得更开，五张卡才能连贯铺开、不糊成一团。
 */
const STRIP_LEVELS = [
  { x: 0, s: 1, o: 1 },
  { x: 100, s: 0.9, o: 0.92 },
  { x: 172, s: 0.8, o: 0.8 },
];

// 当前回放的切片索引（古风燃脂：10 段），以及分段条上每一块的数据
let replaySegments = [];
let replayBlocks = [];
let replaySeg = 0;
let stripCards = [];
let stripIndex = 0;
let idleTimer = 0;
let replayCameraStream = null;
let replayCamRaf = 0;
let replayCamStartedAt = 0;

/** 播放按钮只换图标，不再在按钮里写"播放/暂停"两个汉字 */
function setPlayIcon(playing) {
  const button = $('replay-toggle');
  if (!button) return;
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
  button.classList.toggle('is-playing', playing);
  button.setAttribute('aria-label', playing ? '暂停' : '播放');
  $('replay-root')?.classList.toggle('is-playing', playing);
  if (playing) dismissIdle();
  else {
    $('replay-root')?.classList.remove('is-idle');
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = 0;
  }
}

/** 播放中鼠标静止一会儿就把控件淡出，把整块画面还给视频；动一下鼠标立刻回来 */
function dismissIdle() {
  const root = $('replay-root');
  if (!root) return;
  root.classList.remove('is-idle');
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = 0;
    if (root.classList.contains('is-playing') && root.classList.contains('is-cinema')) {
      root.classList.add('is-idle');
    }
  }, 2400);
}

function replayDuration() {
  const video = $('replay-video');
  if (activeDemoSession && !video.hidden) {
    return Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : activeDemoSession.duration || 0;
  }
  return player.duration || 0;
}

function replayTime() {
  const video = $('replay-video');
  if (activeDemoSession && !video.hidden) return video.currentTime;
  return player.playhead || 0;
}

/** 跳到某个时间点：有视频就 seek 视频，逐帧回放就 seek 播放器 */
function seekReplay(time, autoplay = true) {
  const video = $('replay-video');
  if (activeDemoSession && !video.hidden) {
    const end = replayDuration() || activeDemoSession.duration;
    video.currentTime = Math.min(Math.max(0, end - 0.08), Math.max(0, time));
    syncDemoReplay();
    if (autoplay) video.play().catch(() => {});
    return;
  }
  if (player.session) {
    player.seek(time);
    if (autoplay) player.play();
  }
}

/* --------------------------------------------------------- 片段轮播（同首页） */

/**
 * 渲染切片卡片。每张卡对应一个切片文件：既拿它当封面帧（#t 定位到 0.6s），
 * 也是点击后要跳转的那一段。排布复用 layoutStack，和首页推荐轮播是同一套代码。
 */
function renderReplayStrip(session) {
  const track = $('correct-filmstrip');
  if (!track) return;
  replaySegments = session?.segments?.length ? session.segments : [];
  track.innerHTML = '';
  stripCards = [];
  stripIndex = 0;
  replaySeg = 0;

  if (!replaySegments.length) {
    track.innerHTML = '<p class="film-empty">这条回放没有切片索引</p>';
    updateSegTag();
    return;
  }

  replaySegments.forEach((segment, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'strip-card';
    card.dataset.seg = String(index);
    // 角标写这段在整片时间轴上的起点（00:00 / 00:12 / 00:25…），
    // 跟左下角的「第 N 段 · 00:00 – 00:12」和分段条对得上；切片自身时长只在跟练页有意义
    const at = segStart(segment);
    card.innerHTML = `
      <video class="strip-card__media" src="${segment.src}#t=0.6" muted playsinline preload="metadata"
        ${segment.thumbnail ? `poster="${segment.thumbnail}"` : ''}></video>
      <span class="strip-card__veil"></span>
      <span class="strip-card__cap"><b>第 ${index + 1} 段</b><small>${formatTime(at)}</small></span>
    `;
    card.addEventListener('click', () => seekReplay(segStart(segment), true));
    track.appendChild(card);
    stripCards.push(card);
  });

  layoutStack(stripCards, stripIndex, 0, STRIP_LEVELS);
  updateSegTag();
  markRibbonActive();
}

function centerStrip(index, step = 0) {
  if (!stripCards.length) return;
  const total = stripCards.length;
  stripIndex = ((index % total) + total) % total;
  replaySeg = stripIndex;
  layoutStack(stripCards, stripIndex, step, STRIP_LEVELS);
  updateSegTag();
  markRibbonActive();
}

function updateSegTag() {
  const tag = $('replay-seg-tag');
  if (!tag) return;
  if (!replaySegments.length) {
    tag.hidden = true;
    return;
  }
  const segment = replaySegments[replaySeg] || replaySegments[0];
  tag.hidden = false;
  tag.textContent = `第 ${replaySeg + 1} 段 / ${replaySegments.length} · ${formatTime(segStart(segment))} – ${formatTime(segEnd(segment))}`;
}

function markRibbonActive() {
  $$('#error-ribbon .ribbon-block').forEach((block) => {
    block.classList.toggle('is-active', Number(block.dataset.seg) === replaySeg);
  });
}

/** 播放位置跨过段边界时，把轮播和分段条一起挪过去 */
function syncReplaySegment(time) {
  if (!replaySegments.length) return;
  updateRibbonHead(time);
  let index = replaySegments.findIndex((seg) => time >= segStart(seg) - 0.001 && time < segEnd(seg));
  if (index < 0) index = time <= 0 ? 0 : replaySegments.length - 1;
  if (index === replaySeg) {
    markRibbonActive();
    return;
  }
  centerStrip(index, index > replaySeg ? 1 : -1);
}

function updateRibbonHead(time) {
  const ribbon = $('error-ribbon');
  const head = $('ribbon-head');
  if (!ribbon || !head) return;
  const duration = replayDuration();
  const ratio = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const pad = 4;
  const usable = Math.max(0, ribbon.clientWidth - pad * 2);
  head.style.left = `${pad + ratio * usable}px`;
}

/* ------------------------------------------------------- 全屏 / 骨骼分屏 */

function setReplayMode(split) {
  const root = $('replay-root');
  if (!root) return;
  root.classList.toggle('is-split', split);
  root.classList.toggle('is-cinema', !split);
  $('replay-cam').hidden = !split;
  $('app-main').classList.toggle('is-flush', !split);
  const button = $('replay-mode');
  button.classList.toggle('is-on', split);
  button.setAttribute('aria-pressed', String(split));
  button.setAttribute('aria-label', split ? '切换为全屏视频' : '切换为骨骼分屏');
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', split ? '#i-expand' : '#i-split');

  if (split) openReplayCam();
  else closeReplayCam();

  // 两种模式的控件高度不一样，收藏按钮要跟着重算位置；片段卡也要按新宽度重排
  requestAnimationFrame(() => {
    syncDockHeight();
    layoutStack(stripCards, stripIndex, 0, STRIP_LEVELS);
    updateRibbonHead(replayTime());
  });
}

function syncDockHeight() {
  const dock = $('replay-dock');
  const root = $('replay-root');
  if (!dock || !root) return;
  root.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
}

/**
 * 分屏右侧的摄像头窗格。
 * 优先复用「跟练」那条实时链路的流（同一台摄像头只开一次），拿不到再自己开一路；
 * 骨架点仍由 live 链路写进 state.livePose，这里只负责画。
 */
async function openReplayCam() {
  const pane = $('replay-cam');
  const video = $('replay-cam-video');
  const note = $('replay-cam-note');
  if (!pane || pane.hidden || !video) return;

  note.hidden = false;
  note.textContent = '正在打开摄像头…';
  $('replay-cam-retry').hidden = true;

  try {
    if (!(live.running && live.stream)) await ensureLive();
    let stream = live.running ? live.stream : null;

    if (!stream) {
      if (!replayCameraStream || !replayCameraStream.active) {
        replayCameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 960 }, height: { ideal: 720 } },
          audio: false,
        });
      }
      stream = replayCameraStream;
    }

    if (video.srcObject !== stream) video.srcObject = stream;
    await video.play().catch(() => {});
    replayCamStartedAt = performance.now();
    if (!replayCamRaf) replayCamRaf = requestAnimationFrame(replayCamLoop);
  } catch (error) {
    note.textContent = cameraErrorMessage(error);
    $('replay-cam-retry').hidden = false;
  }
}

function replayCamLoop() {
  replayCamRaf = requestAnimationFrame(replayCamLoop);
  const pane = $('replay-cam');
  if (!pane || pane.hidden) return;
  const video = $('replay-cam-video');
  const prepared = prepareCanvas($('replay-cam-overlay'));
  if (!prepared || !video.videoWidth) return;
  const { ctx, width, height } = prepared;
  const note = $('replay-cam-note');

  if (!state.livePose) {
    if (performance.now() - replayCamStartedAt > 2200) {
      note.hidden = false;
      note.textContent = live.running
        ? '摄像头已开启 · 骨骼链路未连接（启动后端服务后骨架会自动出现）'
        : '摄像头未开启，点「重试连接」再试一次';
    }
    return;
  }

  note.hidden = true;
  const rect = fitRect(width, height, video.videoWidth, video.videoHeight);
  if (state.shadows && state.liveMask) {
    drawShadow(ctx, state.liveMask, rect, '#00e5a0', 0.3);
  }
  drawPose(ctx, state.livePose, rect, {
    color: '#00e5a0',
    lineWidth: 2.6,
    alpha: 0.85,
    jointAlpha: 0.45,
    shadow: true,
  });
}

function closeReplayCam() {
  if (replayCamRaf) window.cancelAnimationFrame(replayCamRaf);
  replayCamRaf = 0;
  const video = $('replay-cam-video');
  if (video) video.srcObject = null;
  // 自己开的那路流才停掉；复用实时链路的流要留给跟练页面
  if (replayCameraStream && !(live.running && live.stream === replayCameraStream)) {
    replayCameraStream.getTracks().forEach((track) => track.stop());
  }
  replayCameraStream = null;
  // 保留最后一帧骨架会让人以为摄像头还在工作，直接清空
  const canvas = $('replay-cam-overlay');
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function sessionThumb(session) {
  if (session.demo && session.cover) return session.cover;
  if (session.thumbnail_url) return mediaUrl(session.thumbnail_url);
  return mediaUrl(`/media/sessions/${session.id}/frames/00001.jpg`);
}

function buildDemoSessions() {
  const specs = [
    ['local-gufeng', 2, 14, 2, 92],
    ['local-hiphop', 0, 7, 7, 86],
    ['local-chinese', 0, 14, 26, 89],
    ['local-ballet', 0, 7, 49, 81],
    ['local-swing', 0, 14, 74, 94],
  ];
  return specs.map(([courseId, segmentIndex, duration, hoursAgo, score], order) => {
    const course = state.localCourses.find((item) => item.id === courseId) || state.localCourses[0];
    const segment = course?.segments?.[segmentIndex] || course?.segments?.[0];
    // 古风燃脂有完整视频 + 10 个切片：回放走整片，切片作为分段索引用
    const isMaster = Boolean(course?.master && course?.video);
    return {
      id: `local-demo-${order + 1}`,
      demo: true,
      title: `${course?.title || '舞蹈课程'} · 第 ${order + 1} 次练习`,
      video_id: course?.id || '',
      video: isMaster ? course.video : segment?.src || course?.video || '',
      segments: isMaster ? course.segments : [],
      cover: course?.cover || '',
      duration: isMaster ? course.duration || duration : duration,
      frame_count: Math.round((isMaster ? course.duration || duration : duration) * 12),
      score,
      created_at: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
      frames: [],
    };
  });
}

async function refreshSessions(selectFirst = false) {
  let remote = [];
  try {
    const { items } = await api.listSessions();
    remote = items || [];
  } catch {
    /* 离线时仍展示完整、可播放的本地演示记录 */
  }
  state.sessions = [...remote, ...buildDemoSessions()];
  renderHistory();
  renderCorrectFilmstrip();
  renderRail();
  renderFavorite();

  if (selectFirst && state.sessions.length) {
    const exists = state.sessions.some((item) => item.id === state.currentSessionId);
    await loadSession(exists ? state.currentSessionId : state.sessions[0].id);
  } else {
    markActiveSession();
  }
}

function renderHistory() {
  const list = $('history-list');
  $('history-count').textContent = String(state.sessions.length);
  if (!state.sessions.length) {
    list.innerHTML = '<p class="empty-hint">暂无录制，去「跟练学习」页录制一段吧</p>';
  } else {
    list.innerHTML = '';
    state.sessions.forEach((session) => {
      const row = document.createElement('div');
      row.className = `history-row${state.currentSessionId === session.id ? ' is-active' : ''}`;
      row.dataset.id = session.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.innerHTML = `
        <img class="history-row__thumb" src="${sessionThumb(session)}" alt="" loading="lazy" />
        <span class="history-row__body">
          <b>${escapeHtml(session.title)}</b>
          <small>${formatTime(session.duration)} · ${session.frame_count} 帧 · ${formatDate(session.created_at)}</small>
        </span>
        <span class="row-actions">
          <button class="row-btn" type="button" data-action="open" title="回放">
            <svg><use href="#i-right"/></svg>
          </button>
          <button class="row-btn row-btn--danger" type="button" data-action="delete" title="删除">
            <svg><use href="#i-trash"/></svg>
          </button>
        </span>
      `;
      const open = () => navigate(`#/correct/${session.id}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', (event) => {
        event.stopPropagation();
        deleteSession(session.id);
      });
      list.appendChild(row);
    });
  }

  const stars = $('stars-list');
  stars.innerHTML = '';
  if (!state.videos.length) {
    stars.innerHTML = '<p class="empty-hint">还没有课程，先去上传一个教学视频</p>';
  } else {
    const maxSegments = Math.max(...state.videos.map((video) => video.segments?.length || 0), 1);
    state.videos.forEach((video) => {
      const percent = Math.round(((video.segments?.length || 0) / maxSegments) * 100);
      const row = document.createElement('div');
      row.className = 'progress-row';
      row.innerHTML = `
        <div class="progress-row__top">
          <b>${escapeHtml(video.title)}</b>
          <span>${video.segments?.length || 0} 片段 · ${video.pose_status === 'ready' ? '骨架就绪' : '分析中'}</span>
        </div>
        <div class="progress-row__bar"><i style="width:${Math.max(6, percent)}%"></i></div>
      `;
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => openCourse(video.id));
      stars.appendChild(row);
    });
  }
}

function renderCorrectFilmstrip() {
  // 兼容旧调用点：片段轮播跟着「当前回放」走，没有回放时清空
  renderReplayStrip(activeDemoSession);
}

function markActiveSession() {
  $$('.history-row').forEach((row) => {
    row.classList.toggle('is-active', row.dataset.id === state.currentSessionId);
  });
  renderRail();
  renderFavorite();
}

let activeDemoSession = null;

/**
 * 本地演示视频：先整段取回来再喂给 <video>。
 * 原因：预览用的静态服务器不返回 Accept-Ranges，video.seekable 会一直是空区间，
 * 点分段条/拖进度都跳不动；换成内存里的 blob 之后可以随意 seek，也不依赖后端。
 */
const demoVideoCache = new Map();

async function attachDemoVideo(session) {
  const video = $('replay-video');
  const src = session.video;
  if (!src) return;
  if (/^blob:/.test(src)) {
    video.src = src;
    video.load();
    return;
  }
  try {
    let url = demoVideoCache.get(src);
    if (!url) {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      url = URL.createObjectURL(await response.blob());
      demoVideoCache.set(src, url);
    }
    video.src = url;
  } catch {
    // 取不回来就退回原地址，至少还能播放（只是不能拖进度）
    video.src = src;
  }
  video.load();
}

function syncDemoReplay() {
  if (!activeDemoSession) return;
  const video = $('replay-video');
  const actual = Number.isFinite(video.duration) ? video.duration : activeDemoSession.duration;
  // 整片回放以视频真实时长为准，切片时长只在没有视频时兜底
  const duration = Math.max(0, actual || activeDemoSession.duration);
  const ratio = duration ? Math.min(1, video.currentTime / duration) : 0;
  $('replay-seek').value = String(Math.round(ratio * 1000));
  $('replay-time').textContent = `${formatTime(Math.min(video.currentTime, duration))} / ${formatTime(duration)}`;
  setPlayIcon(!video.paused);
  syncReplaySegment(video.currentTime);
  if (duration && video.currentTime >= duration && !video.paused) {
    video.pause();
    video.currentTime = duration;
    setPlayIcon(false);
  }
}

async function loadDemoSession(session) {
  player.pause();
  player.session = null;
  activeDemoSession = session;
  state.currentSessionId = session.id;
  markActiveSession();
  $('replay-canvas').hidden = true;
  const video = $('replay-video');
  video.hidden = false;
  $('replay-toggle').dataset.mode = 'video';
  $('replay-seek').dataset.mode = 'video';
  await attachDemoVideo(session);
  $('replay-status').textContent = `${session.title} · 本地演示回放 · 跟随度 ${session.score}%`;
  // 古风燃脂带 10 个切片：整片当时间轴，切片当分段索引
  renderReplayStrip(session);
  renderErrorRibbon(session);
  setPlayIcon(false);
}

async function loadSession(sessionId) {
  const demo = state.sessions.find((item) => item.id === sessionId && item.demo);
  if (demo) {
    await loadDemoSession(demo);
    return;
  }
  try {
    activeDemoSession = null;
    const video = $('replay-video');
    video.pause();
    video.hidden = true;
    $('replay-canvas').hidden = false;
    delete $('replay-toggle').dataset.mode;
    delete $('replay-seek').dataset.mode;
    const session = await api.getSession(sessionId);
    state.currentSessionId = sessionId;
    markActiveSession();
    player.showTeach = $('replay-compare').checked;
    const count = await player.load(session);
    $('replay-status').textContent = `${session.title} · ${count} 帧 · ${formatTime(session.duration)}`;
    renderReplayStrip(null);
    renderErrorRibbon(session);
    setPlayIcon(player.playing);
  } catch (error) {
    $('replay-status').textContent = `回放加载失败：${error.message}`;
    renderErrorRibbon(null);
  }
}

async function deleteSession(sessionId) {
  if (!confirm('确定删除这条练习回放吗？删除后不可恢复。')) return;
  const demo = state.sessions.find((item) => item.id === sessionId && item.demo);
  if (demo) {
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      activeDemoSession = null;
      $('replay-video').pause();
      $('replay-status').textContent = '演示回放已删除';
    }
    renderHistory();
    renderCorrectFilmstrip();
    renderRail();
      toast('已删除该条演示回放');
    return;
  }
  try {
    await api.deleteSession(sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      player.pause();
      $('replay-status').textContent = '回放已删除';
    }
    state.favs.sessions = state.favs.sessions.filter((id) => id !== sessionId);
    saveFavs();
    await refreshSessions(false);
    toast('已删除该条回放');
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error');
  }
}

function stepSession(direction) {
  if (!state.sessions.length) return;
  const index = state.sessions.findIndex((item) => item.id === state.currentSessionId);
  const next = Math.min(state.sessions.length - 1, Math.max(0, index + direction));
  if (next === index) return;
  navigate(`#/correct/${state.sessions[next].id}`);
}

/* 跟随度：髋部对齐 + 躯干归一化后比较关键点距离，映射到 0~1 */
function poseSimilarity(a, b) {
  const midpoint = (p, q) => (p && q ? { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 } : null);
  const shoulderA = midpoint(a[11], a[12]);
  const hipA = midpoint(a[23], a[24]);
  const shoulderB = midpoint(b[11], b[12]);
  const hipB = midpoint(b[23], b[24]);
  if (!shoulderA || !hipA || !shoulderB || !hipB) return 0;

  const scaleA = Math.hypot(shoulderA.x - hipA.x, shoulderA.y - hipA.y) || 1;
  const scaleB = Math.hypot(shoulderB.x - hipB.x, shoulderB.y - hipB.y) || 1;
  const joints = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  let sum = 0;
  let count = 0;
  joints.forEach((index) => {
    const p = a[index];
    const q = b[index];
    if (!p || !q) return;
    const ax = (p[0] - hipA.x) / scaleA;
    const ay = (p[1] - hipA.y) / scaleA;
    const bx = (q[0] - hipB.x) / scaleB;
    const by = (q[1] - hipB.y) / scaleB;
    sum += Math.hypot(ax - bx, ay - by);
    count += 1;
  });
  if (!count) return 0;
  return Math.max(0, Math.min(1, 1 - sum / count / 1.15));
}

/**
 * 跟随度分段条。
 * 每一块 = 一个切片（古风燃脂的 10 段），块内 6 个小格 = 该段的跟随情况；
 * 点任意一格就跳到那一格对应的时间点，也就是"跳到对应的片段"。
 */
const RIBBON_CELLS = 6;

/** 片段在完整视频时间轴上的起止；没有 masterStart 时退回片段自身的起止 */
const segStart = (segment) => (Number.isFinite(segment?.masterStart) ? segment.masterStart : segment?.start || 0);
const segEnd = (segment) =>
  Number.isFinite(segment?.masterEnd) ? segment.masterEnd : segment?.end || segStart(segment);

function ribbonMarkup(blocks) {
  const body = blocks
    .map((block, index) => {
      const cells = block.cells
        .map((cell) => {
          const cls = cell.bad ? ' is-bad' : cell.idle ? ' is-idle' : '';
          return `<i class="ribbon-cell${cls}" data-t="${cell.t.toFixed(2)}"></i>`;
        })
        .join('');
      return `<span class="ribbon-block" data-seg="${index}" data-start="${block.start.toFixed(2)}">${cells}</span>`;
    })
    .join('');
  return `${body}<span class="ribbon-head" id="ribbon-head"></span>`;
}

async function renderErrorRibbon(session) {
  const ribbon = $('error-ribbon');
  const score = $('match-score');
  replayBlocks = [];
  if (!ribbon) return;

  /* 本地演示回放：有切片就按切片分块，没有切片就按整条时间轴分 24 格 */
  if (session?.demo) {
    const segments = session.segments?.length
      ? session.segments
      : [{ index: 0, start: 0, end: session.duration || 0 }];
    const badEvery = session.score >= 90 ? 16 : 8;

    replayBlocks = segments.map((segment, index) => {
      const from = segStart(segment);
      const span = Math.max(0.4, segEnd(segment) - from);
      const cells = Array.from({ length: RIBBON_CELLS }, (_, cell) => ({
        bad: (index * 5 + cell * 3 + session.id.length) % badEvery === 0,
        t: from + ((cell + 0.5) / RIBBON_CELLS) * span,
      }));
      return { seg: index, start: from, end: segEnd(segment), cells };
    });

    ribbon.innerHTML = ribbonMarkup(replayBlocks);
    score.textContent = `平均跟随度 ${session.score}%`;
    markRibbonActive();
    updateRibbonHead(replayTime());
    return;
  }

  /* 真实录制：没有骨架就没法算跟随度，整条置灰 */
  const BUCKETS = 60;
  const idleBlocks = (label) => {
    replayBlocks = [
      {
        seg: 0,
        start: 0,
        end: session?.duration || 0,
        cells: Array.from({ length: BUCKETS }, (_, index) => ({
          idle: true,
          t: ((session?.duration || 0) * (index + 0.5)) / BUCKETS,
        })),
      },
    ];
    ribbon.innerHTML = ribbonMarkup(replayBlocks);
    score.textContent = label;
    updateRibbonHead(replayTime());
  };

  if (!session?.frames?.length || !session.video_id) {
    idleBlocks('--');
    return;
  }

  let teachFrames = [];
  try {
    teachFrames = await getTeachFramesFor(session.video_id);
  } catch {
    teachFrames = [];
  }
  if (!teachFrames.length) {
    idleBlocks('骨架未就绪');
    return;
  }

  const duration = session.duration || session.frames.at(-1)?.t || 0;
  const start = session.teach_start ?? 0;
  const rate = session.teach_rate || 1;
  let sum = 0;
  let count = 0;

  const cells = Array.from({ length: BUCKETS }, (_, bucket) => {
    const t = (duration * (bucket + 0.5)) / BUCKETS;
    const record = poseAt(session.frames, t);
    const reference = poseAt(teachFrames, start + t * rate);
    let similarity = 0;
    if (record?.pose && reference?.pose) {
      similarity = poseSimilarity(record.pose, reference.pose);
      sum += similarity;
      count += 1;
    }
    return { t, bad: Boolean(similarity) && similarity < 0.55, idle: !similarity };
  });

  replayBlocks = [{ seg: 0, start: 0, end: duration, cells }];
  ribbon.innerHTML = ribbonMarkup(replayBlocks);
  score.textContent = count ? `平均跟随度 ${Math.round((sum / count) * 100)}%` : '--';
  updateRibbonHead(replayTime());
}

/* ------------------------------------------------------------------ 上传 */

function pickFile() {
  const input = $('upload-input');
  input.value = '';
  input.click();
}

async function handleUpload(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) {
    toast('请选择视频文件', 'error');
    return;
  }
  showLoader(`正在上传 ${file.name}`, 2);
  try {
    const meta = await api.uploadVideo(file, (ratio) => {
      setLoaderText(`正在上传 ${Math.round(ratio * 100)}%`, Math.max(2, ratio * 10));
    });
    await selectVideo(meta);
    await loadLibrary({ silent: true });
    setLoaderText('正在提取教学骨架…', 14);
    const ready = await ensurePose(meta.id);
    await loadLibrary({ silent: true });
    hideLoader();
    toast(`《${ready.title}》已就绪，共 ${ready.segments.length} 个片段`);
    navigate(`#/class/${ready.id}`);
  } catch (error) {
    hideLoader();
    const hint = /网络错误|Failed to fetch/i.test(error.message)
      ? '无法连接上传服务。请同时在 backend 目录运行 python run.py（端口 8000），5500 仅负责页面预览。'
      : error.message;
    toast(`上传失败：${hint}`, 'error');
  }
}

/* ------------------------------------------------------------------ 搜索 */

async function runSearch() {
  const query = $('search-input').value.trim();
  const panel = $('search-results');
  if (!query) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = '<p class="empty-hint">搜索中…</p>';
  try {
    const { items } = await api.searchVideos(query);
    if (!items.length) {
      panel.innerHTML = '<p class="empty-hint">没有找到匹配的视频，试试上传本地视频</p>';
      return;
    }
    panel.innerHTML = '';
    items.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-item';
      row.innerHTML = `<b>${escapeHtml(item.title)}</b><span class="search-meta">${
        item.segments?.length || 0
      } 个片段 · ${formatTime(item.duration)}</span>`;
      row.addEventListener('click', async () => {
        panel.innerHTML = '';
        $('search-input').value = '';
        await selectVideo(item);
        navigate(`#/class/${item.id}`);
      });
      panel.appendChild(row);
    });
  } catch (error) {
    panel.innerHTML = `<p class="empty-hint">搜索失败：${escapeHtml(error.message)}</p>`;
  }
}

/* ------------------------------------------------------ 跟练界面：分屏 / 弹窗 / 灵动岛 */

function enterRecordingLayout() {
  $('learn-stage').classList.add('is-recording');
  showDock();
}

function exitRecordingLayout() {
  $('learn-stage').classList.remove('is-recording');
}

async function setOverlayMode(enabled) {
  const stage = $('learn-stage');
  state.overlayMode = !!enabled;
  stage.classList.toggle('is-overlay', state.overlayMode);
  const button = $('island-merge');
  button.classList.toggle('is-armed', state.overlayMode);
  button.setAttribute('aria-pressed', String(state.overlayMode));
  button.setAttribute('aria-label', state.overlayMode ? '退出全屏叠加模式' : '切换全屏摄像头叠加模式');

  if (state.overlayMode) {
    ensureLive();
    showDock();
    if (document.fullscreenElement !== stage && stage.requestFullscreen) {
      try {
        await stage.requestFullscreen();
      } catch {
        toast('已进入全屏叠加布局（浏览器未开放系统全屏权限）');
      }
    }
  } else if (document.fullscreenElement === stage && document.exitFullscreen) {
    try {
      await document.exitFullscreen();
    } catch {
      /* 已退出系统全屏 */
    }
  }
}

let dockHideTimer = 0;
let pointerMoveSince = 0;
let lastPointerAt = 0;

function showDock() {
  const dock = $('stage-dock');
  if (!dock) return;
  state.dockVisible = true;
  dock.classList.add('is-visible');
  scheduleDockHide();
}

function hideDock() {
  const dock = $('stage-dock');
  if (!dock) return;
  state.dockVisible = false;
  dock.classList.remove('is-visible');
}

function scheduleDockHide() {
  clearTimeout(dockHideTimer);
  dockHideTimer = setTimeout(() => {
    if (!$('stage-dock')?.matches(':hover')) hideDock();
  }, 2600);
}

/** 鼠标在界面内持续移动 1.5 秒后，弹出播放控制 */
function bindDockMovement() {
  const stage = $('learn-stage');
  if (!stage) return;
  const delay = Number(state.settings.dockDelay) || 1500;

  stage.addEventListener('pointermove', () => {
    if (state.route !== 'learning') return;
    const now = performance.now();
    if (now - lastPointerAt > 420) pointerMoveSince = now;
    lastPointerAt = now;
    if (now - pointerMoveSince >= delay) {
      showDock();
      pointerMoveSince = now;
    }
  });
  stage.addEventListener('pointerleave', scheduleDockHide);
  stage.addEventListener('pointerdown', () => {
    if (state.route === 'learning') showDock();
  });
}

function syncIsland() {
  const teachBtn = $('island-teach');
  if (!teachBtn) return;
  teachBtn.classList.toggle('is-on', state.compare);
  teachBtn.setAttribute('aria-pressed', String(state.compare));
}

/* -------------------------------------------------------------- 个人主页 */

function initials() {
  return 'TU';
}

function setAvatar(imgEl, initialEl, avatar) {
  if (!imgEl || !initialEl) return;
  if (avatar) {
    imgEl.src = avatar;
    imgEl.hidden = false;
    initialEl.hidden = true;
  } else {
    imgEl.removeAttribute('src');
    imgEl.hidden = true;
    initialEl.hidden = false;
  }
}

function renderUserChrome() {
  const name = state.user.nickname || 'TUTU';
  const avatar = state.user.avatar || '';
  if ($('rail-nickname')) $('rail-nickname').textContent = name;
  if ($('rail-avatar-initial')) $('rail-avatar-initial').textContent = initials(name);
  if ($('profile-chip-initial')) $('profile-chip-initial').textContent = initials(name);
  if ($('profile-avatar-initial')) $('profile-avatar-initial').textContent = initials(name);
  if ($('profile-name')) $('profile-name').textContent = name;
  if ($('profile-bio')) $('profile-bio').textContent = state.user.bio || '今天也要把动作练对。';
  if ($('profile-auth')) $('profile-auth').textContent = state.user.loggedIn ? '登出' : '登录';
  setAvatar($('rail-avatar-img'), $('rail-avatar-initial'), avatar);
  setAvatar($('profile-chip-img'), $('profile-chip-initial'), avatar);
  setAvatar($('profile-avatar-img'), $('profile-avatar-initial'), avatar);
}

function formatDurationLong(seconds) {
  const total = Math.round(Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function profileStats() {
  return state.demoStats;
}

function renderProfileStats() {
  const data = profileStats();
  const cards = [
    { label: '累计学习时长', value: formatDurationLong(data.total), hint: '所有练习回放时长之和' },
    { label: '大师课时长', value: formatDurationLong(data.master), hint: '古风燃脂系列练习累计' },
    { label: '练习视频', value: String(data.count), hint: '录制并保存的回放数量' },
    { label: '收藏', value: String(data.favs), hint: '课程与回放收藏合计' },
  ];
  $('profile-stats').innerHTML = cards
    .map(
      (card) => `
      <article class="stat">
        <small>${card.label}</small>
        <b>${card.value}</b>
        <span>${card.hint}</span>
      </article>`
    )
    .join('');
}

function renderProfileHistory() {
  const box = $('profile-history');
  if (!box) return;
  const items = (state.sessions || []).slice(0, 5);
  if (!items.length) {
    box.innerHTML = '<p class="empty-hint">暂无练习记录，去跟练页录制一段吧</p>';
    return;
  }
  box.innerHTML = '';
  items.forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'profile-record';
    row.innerHTML = `
      <span class="profile-record__time">${formatDate(session.created_at) || '--'}</span>
      <span class="profile-record__body"><b>${escapeHtml(session.title || '练习回放')}</b>
        <small>${formatDurationLong(session.duration)} · ${session.frame_count || session.frames?.length || 0} 帧</small>
      </span>
      <span class="profile-record__go"><svg><use href="#i-right"/></svg></span>
    `;
    row.addEventListener('click', () => navigate(`#/correct/${session.id}`));
    box.appendChild(row);
  });
}

function renderFriends() {
  const count = $('friend-count');
  if (!count) return;
  count.textContent = String(state.friends.length);
  const box = $('friend-list');
  if (!state.friends.length) {
    box.innerHTML = '<p class="empty-hint">还没有好友，先添加一位舞伴吧</p>';
    return;
  }
  box.innerHTML = '';
  state.friends.forEach((friend, index) => {
    const row = document.createElement('div');
    row.className = 'friend';
    row.innerHTML = `
      <span class="friend__avatar">TU</span>
      <span class="friend__body"><b>${escapeHtml(friend.name)}</b>
        <small><i class="friend__dot${friend.online ? ' is-on' : ''}"></i>${escapeHtml(friend.status || '离线')}</small>
      </span>
      <button class="icon-btn icon-btn--quiet friend__del" type="button" aria-label="删除好友">
        <svg><use href="#i-close"/></svg>
      </button>
    `;
    row.querySelector('.friend__del').addEventListener('click', () => {
      state.friends.splice(index, 1);
      saveFriends();
      renderFriends();
      toast('已删除好友');
    });
    box.appendChild(row);
  });
}

function renderSettings() {
  const box = $('settings-list');
  if (!box) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const rows = [
    {
      key: 'speed',
      label: '默认播放倍速',
      type: 'select',
      value: String(state.settings.speed),
      options: PLAYBACK_RATES.map((rate) => [String(rate), `${rate.toFixed(rate === 1 ? 1 : 2).replace(/0$/, '')}x`]),
    },
    { key: 'skeleton', label: '默认显示骨架', type: 'toggle', value: state.settings.skeleton },
    { key: 'shadows', label: '默认显示人物阴影', type: 'toggle', value: state.settings.shadows },
    { key: 'voiceTips', label: '小教练语音提示', type: 'toggle', value: state.settings.voiceTips !== false },
    { key: 'voiceCommands', label: '语音指令（唤醒词：小教练）', type: 'toggle', value: state.settings.voiceCommands !== false },
    { key: 'showPerf', label: '显示性能面板（调试）', type: 'toggle', value: state.settings.showPerf === true },
    {
      key: 'countdown',
      label: '录制倒计时',
      type: 'select',
      value: String(state.settings.countdown),
      options: [
        ['0', '不等待'],
        ['3', '3 秒'],
        ['5', '5 秒'],
        ['10', '10 秒'],
      ],
    },
    { key: 'dark', label: '深色模式', type: 'toggle', value: dark },
  ];

  box.innerHTML = '';
  rows.forEach((row) => {
    const wrap = document.createElement('label');
    wrap.className = 'setting';
    wrap.innerHTML = `<span>${row.label}</span>`;
    if (row.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!row.value;
      input.addEventListener('change', () => applySetting(row.key, input.checked));
      wrap.appendChild(input);
      wrap.insertAdjacentHTML('beforeend', '<i class="switch" aria-hidden="true"></i>');
    } else {
      const select = document.createElement('select');
      select.className = 'mini-select';
      row.options.forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (value === row.value) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', () => applySetting(row.key, select.value));
      wrap.appendChild(select);
    }
    box.appendChild(wrap);
  });
}

function applySetting(key, rawValue) {
  const numeric = ['speed', 'countdown'].includes(key);
  const value = numeric ? Number(rawValue) : rawValue;
  state.settings[key] = value;
  saveSettings();

  if (key === 'speed') {
    state.speed = value;
    teachVideo.playbackRate = value;
    $('speed-select').value = String(value);
  } else if (key === 'skeleton') {
    state.skeleton = value;
    syncVisButtons();
  } else if (key === 'shadows') {
    state.shadows = value;
    syncVisButtons();
  } else if (key === 'voiceTips') {
    syncVisButtons();
    if (!value) stopCoachVoice();
  } else if (key === 'voiceCommands') {
    syncVoiceButton();
    if (value) connectVoice();
    else disableVoice();
  } else if (key === 'showPerf') {
    localStorage.setItem(PERF_KEY, value ? '1' : '0');
    syncPerfHud();
  } else if (key === 'countdown') {
    $('countdown-select').value = String(value);
  } else if (key === 'dark') {
    applyTheme(value ? 'dark' : 'light');
    renderSettings();
  }
}

function renderProfile() {
  if (!$('profile-stats')) return;
  renderUserChrome();
  renderProfileStats();
  renderProfileHistory();
  renderFriends();
  renderSettings();
}

function openProfileModal(mode) {
  const dialog = $('profile-modal');
  if (!dialog) return;
  const isLogin = mode === 'login';
  dialog.dataset.mode = isLogin ? 'login' : 'edit';
  $('profile-modal-title').textContent = isLogin ? '登录账号' : '编辑资料';
  $('profile-modal-hint').textContent = isLogin
    ? '昵称与学习数据保存在本机浏览器，用于展示个人主页。'
    : '昵称、简介与头像仅保存在本机浏览器。';
  $('profile-name-input').value = isLogin ? '' : state.user.nickname;
  $('profile-bio-input').value = isLogin ? '' : state.user.bio || '';
  $('profile-save').textContent = isLogin ? '登录' : '保存';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeProfileModal() {
  const dialog = $('profile-modal');
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/* ------------------------------------------------------------------ 事件绑定 */

function bindEvents() {
  $('enter-app').addEventListener('click', () => enterFromCover('#/home'));
  $$('#cover-thumbs .thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => enterFromCover(thumb.dataset.goto || '#/home'));
  });

  [$('theme-toggle'), $('cover-theme')].forEach((button) => {
    button.addEventListener('click', toggleTheme);
  });

  $('voice-btn').addEventListener('click', () => {
    const next = state.settings.voiceCommands === false;
    applySetting('voiceCommands', next);
    toast(next ? '语音助手已开启，说「小教练」试试' : '语音助手已关闭');
  });

  $('rail-open').addEventListener('click', openRail);
  $('rail-close').addEventListener('click', closeRail);
  $('rail-scrim').addEventListener('click', closeRail);

  // 课程页 Categories 底部的折叠图标：再点一次收起
  $('classes-rail-trigger')?.addEventListener('click', () => {
    if (shell.classList.contains('is-rail-open')) closeRail();
    else openRail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shell.classList.contains('is-rail-open')) closeRail();
  });
  window.addEventListener('resize', () => {
    syncClassesFoot();
  });

  $('home-refresh').addEventListener('click', (event) => {
    // 图标按钮没有文字标签，用一次轻微“翻文件夹”反馈确认点击已生效
    const btn = event.currentTarget;
    btn.classList.remove('is-refreshing');
    void btn.offsetWidth;
    btn.classList.add('is-refreshing');
    window.setTimeout(() => btn.classList.remove('is-refreshing'), 640);
    loadLibrary();
  });
  $('home-upload-btn').addEventListener('click', pickFile);
  $('upload-square').addEventListener('click', pickFile);
  $('class-upload-btn').addEventListener('click', pickFile);
  $('upload-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    handleUpload(file);
  });

  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });
  $('search-input-2').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    $$('#class-albums .album').forEach((album) => {
      album.hidden = !!query && !album.textContent.toLowerCase().includes(query);
    });
  });

  $('detail-back').addEventListener('click', () => navigate('#/classes'));
  $$('[data-arc-dir]').forEach((button) => {
    button.addEventListener('click', () => moveArc(Number(button.dataset.arcDir) || 1));
  });
  $('class-arc').addEventListener('mouseenter', () => stopArc());
  $('class-arc').addEventListener('mouseleave', () => {
    if (state.route === 'classes' && state.category === 'all') startArc();
  });

  // 扇形轮播：拖拽换卡（鼠标和触屏都走 pointer 事件；上下拖、左右拖都认）
  const arcStage = $('arc-stage');
  let arcDragFrom = null;
  arcStage.addEventListener('pointerdown', (event) => {
    stopArc();
    arcDragFrom = { x: event.clientX, y: event.clientY };
  });
  arcStage.addEventListener('pointerup', (event) => {
    if (!arcDragFrom) return;
    const dx = event.clientX - arcDragFrom.x;
    const dy = event.clientY - arcDragFrom.y;
    arcDragFrom = null;
    const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    if (Math.abs(delta) < 40) return;
    arcDragMovedAt = Date.now();
    // 卡片沿弧线上下排开，往上拖 = 下一张；往左拖也当下一张（与首页轮播一致）
    moveArc(delta < 0 ? 1 : -1);
  });
  arcStage.addEventListener('pointerleave', () => {
    arcDragFrom = null;
  });

  $('detail-start').addEventListener('click', () => {
    if (!state.video) {
      navigate('#/classes');
      return;
    }
    navigate('#/learning');
    playSegment(state.current || 0);
  });
  $('learn-back').addEventListener('click', () => {
    if (state.video) navigate(`#/class/${state.video.id}`);
    else navigate('#/classes');
  });

  $('teach-play-toggle').addEventListener('click', () => {
    const segment = state.segments[state.current];
    if (!segment) return;
    if (teachVideo.paused) {
      if (teachVideo.currentTime >= segmentEndOf(segment) - 0.02) {
        segmentEndLocked = false;
        teachVideo.currentTime = segment.start || 0;
        updateSegProgress();
      }
      teachVideo.play().catch(() => {});
    } else {
      teachVideo.pause();
    }
  });
  ['play', 'pause'].forEach((type) => teachVideo.addEventListener(type, updateTeachPlayButton));

  const progress = $('teach-progress');
  progress.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    progress.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  progress.addEventListener('pointermove', (event) => {
    if (scrubbing) seekFromPointer(event);
  });
  progress.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  progress.addEventListener('keydown', (event) => {
    const segment = state.segments[state.current];
    if (!segment) return;
    const start = segment.start || 0;
    const end = segmentEndOf(segment);
    const span = Math.max(1, end - start);
    if (event.key === 'ArrowRight') teachVideo.currentTime = Math.min(end, teachVideo.currentTime + span * 0.05);
    else if (event.key === 'ArrowLeft') teachVideo.currentTime = Math.max(start, teachVideo.currentTime - span * 0.05);
    else return;
    event.preventDefault();
    updateSegProgress();
  });
  ['seeked', 'loadedmetadata'].forEach((type) => teachVideo.addEventListener(type, updateSegProgress));

  teachVideo.addEventListener('timeupdate', () => {
    updateSegProgress();
    handleSegmentEnd();
  });
  teachVideo.addEventListener('ended', () => handleSegmentEnd(true));

  $('prev-seg').addEventListener('click', () => {
    if (state.segments.length) playSegment((state.current - 1 + state.segments.length) % state.segments.length);
  });
  $('next-seg').addEventListener('click', () => {
    if (state.segments.length) playSegment((state.current + 1) % state.segments.length);
  });

  $('speed-select').addEventListener('change', (event) => {
    state.speed = Number(event.target.value) || 1;
    teachVideo.playbackRate = state.speed;
    state.settings.speed = state.speed;
    saveSettings();
  });

  $('compare-toggle').addEventListener('change', (event) => {
    state.compare = event.target.checked;
    syncIsland();
  });
  $('skeleton-toggle').addEventListener('click', () => {
    state.skeleton = !state.skeleton;
    state.settings.skeleton = state.skeleton;
    saveSettings();
    syncVisButtons();
  });
  $('shadow-toggle').addEventListener('click', () => {
    state.shadows = !state.shadows;
    state.settings.shadows = state.shadows;
    saveSettings();
    syncVisButtons();
  });
  $('voice-toggle').addEventListener('click', () => {
    applySetting('voiceTips', !state.settings.voiceTips);
    toast(state.settings.voiceTips ? '已开启语音提示' : '已关闭语音提示');
  });
  $('teach-video').addEventListener('play', startTeachFps);
  $('teach-video').addEventListener('pause', stopTeachFps);
  $('teach-video').addEventListener('ended', stopTeachFps);
  $('countdown-select').addEventListener('change', (event) => {
    state.settings.countdown = Number(event.target.value) || 0;
    saveSettings();
  });

  // 竖版灵动岛：教学骨架开关 + 全屏摄像头叠加
  $('island-teach').addEventListener('click', () => {
    state.compare = !state.compare;
    $('compare-toggle').checked = state.compare;
    syncIsland();
    toast(state.compare ? '已打开对比轮廓' : '已关闭对比轮廓');
  });
  $('island-merge').addEventListener('click', () => setOverlayMode(!state.overlayMode));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.overlayMode) setOverlayMode(false);
  });

  $('cam-retry').addEventListener('click', ensureLive);

  $('favorite-btn').addEventListener('click', () => {
    if (!state.video) return;
    const added = toggleFav('videos', state.video.id);
    renderFavorite();
    renderRail();
    toast(added ? '已收藏该课程' : '已取消收藏');
  });

  $('record-btn').addEventListener('click', async () => {
    if (!state.video) {
      toast('请先选择一个教学视频', 'error');
      return;
    }
    if (state.recording) {
      live.sendRecordStop();
      return;
    }
    if (countdownActive) return;

    // 需求：点击开始录制后立即切换为左右分屏（左教学 / 右摄像头）
    enterRecordingLayout();

    if (!live.running) {
      ensureLive();
      return;
    }

    const seconds = Number($('countdown-select').value) || 0;
    if (seconds > 0) {
      countdownActive = true;
      const overlay = $('countdown-overlay');
      const num = $('countdown-num');
      const label = $('record-btn').querySelector('span');
      for (let left = seconds; left > 0 && live.running; left -= 1) {
        overlay.hidden = false;
        num.textContent = String(left);
        label.textContent = `${left}s 后开始`;
        await sleep(1000);
      }
      overlay.hidden = true;
      label.textContent = state.recording ? '结束录制' : '开始录制';
      countdownActive = false;
      if (!live.running || state.recording) {
        if (!state.recording) exitRecordingLayout();
        return;
      }
    }

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

  $('refresh-sessions').addEventListener('click', () => refreshSessions(false));

  const replayVideo = $('replay-video');
  replayVideo.addEventListener('loadedmetadata', () => {
    if (!activeDemoSession) return;
    replayVideo.currentTime = 0;
    syncDemoReplay();
    replayVideo.play().catch(() => {});
  });
  ['timeupdate', 'play', 'pause', 'ended'].forEach((type) => {
    replayVideo.addEventListener(type, syncDemoReplay);
  });
  $('replay-toggle').addEventListener('click', () => {
    if (activeDemoSession && !replayVideo.hidden) {
      if (replayVideo.paused) {
        const end = replayDuration() || activeDemoSession.duration;
        if (replayVideo.currentTime >= end - 0.05) replayVideo.currentTime = 0;
        replayVideo.play().catch(() => {});
      } else replayVideo.pause();
      syncDemoReplay();
      return;
    }
    // 逐帧回放（真实录制）：播放器自己驱动进度和图标
    player.toggle();
    setPlayIcon(player.playing);
  });
  $('replay-seek').addEventListener('input', (event) => {
    if (!activeDemoSession) return;
    const duration = replayDuration() || activeDemoSession.duration;
    replayVideo.currentTime = (Number(event.target.value) / 1000) * duration;
    syncDemoReplay();
  });

  $('replay-compare').addEventListener('change', (event) => {
    player.showTeach = event.target.checked;
  });
  $('replay-fav').addEventListener('click', () => {
    if (!state.currentSessionId) return;
    const added = toggleFav('sessions', state.currentSessionId);
    renderFavorite();
    renderStars();
    toast(added ? '已收藏该回放' : '已取消收藏');
  });
  $('correct-back').addEventListener('click', () => navigate('#/history'));

  // 分段条：点哪一格就跳到哪一段的对应位置
  $('error-ribbon').addEventListener('click', (event) => {
    const block = event.target.closest('.ribbon-block');
    if (!block) return;
    const cell = event.target.closest('.ribbon-cell');
    const time = Number(cell?.dataset.t ?? block.dataset.start);
    if (!Number.isFinite(time)) return;
    seekReplay(time, true);
    centerStrip(Number(block.dataset.seg) || 0, 0);
    dismissIdle();
  });

  // 片段轮播的左右箭头：逐段切换，视频跟着跳到该段起点
  $$('#correct-carousel .rec-arrow').forEach((button) => {
    button.addEventListener('click', () => {
      if (!replaySegments.length) return;
      const step = Number(button.dataset.dir) || 1;
      const total = replaySegments.length;
      const next = ((stripIndex + step) % total + total) % total;
      seekReplay(segStart(replaySegments[next]), true);
      centerStrip(next, step);
      dismissIdle();
    });
  });

  // 全屏视频 ⇄ 左视频右骨骼 的分屏
  $('replay-mode').addEventListener('click', () => {
    setReplayMode(!$('replay-root').classList.contains('is-split'));
  });
  $('replay-cam-retry').addEventListener('click', openReplayCam);

  // 鼠标一动就把控件叫回来（播放中静止 2.4s 会淡出）
  ['pointermove', 'pointerdown', 'wheel'].forEach((type) => {
    $('replay-main').addEventListener(type, dismissIdle, { passive: true });
  });

  $$('.topnav a[data-scroll="contact"]').forEach((link) => {
    link.addEventListener('click', () => {
      setTimeout(() => $('contact')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    });
  });

  // 个人主页入口：左侧菜单底部 TUTU + 右上角头像
  $('rail-profile').addEventListener('click', () => {
    closeRail();
    navigate('#/profile');
  });
  $('profile-chip').addEventListener('click', () => navigate('#/profile'));
  $('profile-edit').addEventListener('click', () => openProfileModal('edit'));
  $('profile-auth').addEventListener('click', () => {
    if (state.user.loggedIn) {
      state.user.loggedIn = false;
      saveUser();
      renderProfile();
      toast('已退出登录');
    } else {
      openProfileModal('login');
    }
  });
  $('profile-avatar-btn').addEventListener('click', () => $('avatar-input').click());
  $('avatar-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('头像请小于 2MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.user.avatar = String(reader.result);
      saveUser();
      renderProfile();
      toast('头像已更新');
    };
    reader.readAsDataURL(file);
  });
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('profile-name-input').value.trim() || '舞者';
    state.user.nickname = name;
    state.user.bio = $('profile-bio-input').value.trim() || '今天也要把动作练对。';
    if ($('profile-modal').dataset.mode === 'login') state.user.loggedIn = true;
    saveUser();
    closeProfileModal();
    renderProfile();
    toast(state.user.loggedIn ? `欢迎回来，${name}` : '资料已更新');
  });
  $('profile-cancel').addEventListener('click', closeProfileModal);

  $('friend-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('friend-input');
    const name = input.value.trim();
    if (!name) return;
    if (state.friends.some((friend) => friend.name === name)) {
      toast('该好友已在列表中');
      return;
    }
    const statuses = ['在线', '练习中', '离线'];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    state.friends.push({ name, status, online: status !== '离线' });
    input.value = '';
    saveFriends();
    renderFriends();
    toast(`已添加好友 ${name}`);
  });

  // 首页推荐：横向堆叠轮播（箭头翻页 + 左右拖拽）
  // 只要手动翻过页，就先按住自动轮播（冷却 8s），否则自动轮播会在两下点击之间多走一张
  $$('#home-carousel [data-dir]').forEach((button) => {
    button.addEventListener('click', () => {
      holdRecAuto();
      moveRec(Number(button.dataset.dir) || 1);
    });
  });
  const recStage = $('home-carousel-track');
  const recBox = $('home-carousel');
  let recDragFrom = null;
  // 悬停整个轮播（含两侧箭头）都暂停，指针在箭头上时也不能继续自动翻页
  recBox.addEventListener('pointerenter', stopRecAuto);
  recBox.addEventListener('pointerleave', () => {
    if (!recResumeTimer) startRecAuto();
  });
  recStage.addEventListener('pointerdown', (event) => {
    holdRecAuto();
    recDragFrom = { x: event.clientX, y: event.clientY };
  });
  recStage.addEventListener('pointerup', (event) => {
    if (!recDragFrom) return;
    const dx = event.clientX - recDragFrom.x;
    recDragFrom = null;
    // 横向轮播只认左右拖：往左拖 = 下一张
    if (Math.abs(dx) < 40) return;
    recDragMovedAt = Date.now();
    moveRec(dx < 0 ? 1 : -1);
  });
  recStage.addEventListener('pointerleave', () => {
    recDragFrom = null;
  });

  // 轮播 / 胶片条左右翻页
  $$('.filmstrip').forEach((container) => {
    const track = container.querySelector('.filmstrip__track');
    if (!track) return;
    $$('.filmstrip__nav', container).forEach((button) => {
      button.addEventListener('click', () => {
        const direction = Number(button.dataset.dir) || 1;
        const step = Math.max(track.clientWidth * 0.8, 240);
        track.scrollBy({ left: direction * step, behavior: 'smooth' });
      });
    });
  });

  window.addEventListener('hashchange', applyRoute);
  window.addEventListener('resize', () => {
    if (state.route === 'correct') {
      syncDockHeight();
      layoutStack(stripCards, stripIndex, 0, STRIP_LEVELS);
      updateRibbonHead(replayTime());
    }
    updateSegProgress();
    // 扇形的位置和大小都按舞台尺寸算，窗口一变要重算（防抖，拖窗口时别狂排布）
    if (state.route !== 'classes' || state.category !== 'all') return;
    if (arcRelayoutTimer) window.clearTimeout(arcRelayoutTimer);
    arcRelayoutTimer = window.setTimeout(() => {
      arcRelayoutTimer = 0;
      updateArc();
    }, 140);
  });
}

let countdownActive = false;

function syncVisButtons() {
  const skeletonBtn = $('skeleton-toggle');
  skeletonBtn.classList.toggle('is-on', state.skeleton);
  skeletonBtn.setAttribute('aria-pressed', String(state.skeleton));

  const shadowBtn = $('shadow-toggle');
  shadowBtn.classList.toggle('is-on', state.shadows);
  shadowBtn.setAttribute('aria-pressed', String(state.shadows));

  const voiceBtn = $('voice-toggle');
  const voiceOn = state.settings.voiceTips !== false;
  voiceBtn.classList.toggle('is-on', voiceOn);
  voiceBtn.setAttribute('aria-pressed', String(voiceOn));
}

/* ------------------------------------------------------------------ 启动 */

function init() {
  applyTheme(localStorage.getItem('danceplus_theme') || 'light');
  initRail();
  bindEvents();
  bindDockMovement();
  renderCategories();

  // 应用本机保存的个性化设置
  state.speed = PLAYBACK_RATES.includes(Number(state.settings.speed)) ? Number(state.settings.speed) : 1;
  state.settings.speed = state.speed;
  saveSettings();
  state.skeleton = state.settings.skeleton !== false;
  state.shadows = state.settings.shadows !== false;
  $('speed-select').value = String(state.speed);
  $('countdown-select').value = String(state.settings.countdown ?? 3);
  teachVideo.playbackRate = state.speed;

  renderUserChrome();
  syncVisButtons();
  syncIsland();
  renderFilmstrip();
  renderErrorRibbon(null);
  setConn(false, '未连接');
  initPerfHud();
  connectVoice();
  syncVoiceButton();

  applyRoute();
  loadLibrary().then(sendVoiceTitles, sendVoiceTitles);
  hydrateLocalCourses();
  refreshSessions(false);
  requestAnimationFrame(overlayLoop);

  // 兜底：即使路由回调没被触发（内嵌预览等环境），进入页也一定在 3s 后自动进场
  if (parseRoute().name === 'cover') scheduleCoverAutoEnter();
}

window.addEventListener('beforeunload', () => {
  if (state.recording) live.sendRecordStop();
});

init();
