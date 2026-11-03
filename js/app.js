/**
 * DanceMate 前端交互逻辑（后端未接入，全部为本地演示实现）
 * - 视频按固定时间间隔切片（SEGMENT_SECONDS）
 * - 轮播图展示片段
 * - 摄像头实时画面 / 回放（getUserMedia，需 HTTPS 或 localhost）
 */

const SEGMENT_SECONDS = 10; // 固定切片间隔（秒）

const state = {
  segments: [],   // [{ index, start, end }]
  current: 0,     // 当前片段索引
  videoURL: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------- 页面切换 ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $(`view-${tab.dataset.view}`).classList.add('active');

    // 进入学习页时开启摄像头
    if (tab.dataset.view === 'learning') startCamera();
  });
});

/* ---------------- 视频上传 / 搜索 ---------------- */
$('upload-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadVideo(file);
});

$('search-btn').addEventListener('click', () => {
  const q = $('search-input').value.trim();
  if (!q) return;
  // TODO: 后端接入后此处改为调用搜索 API
  alert(`演示模式：搜索“${q}”。后端接入后此处将展示搜索结果。\n您也可以先手动上传本地视频体验切片功能。`);
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('search-btn').click();
});

function loadVideo(file) {
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  state.videoURL = URL.createObjectURL(file);
  const v = $('teach-video');
  v.src = state.videoURL;

  v.addEventListener('loadedmetadata', () => {
    buildSegments(v.duration);
    renderCarousels();
    state.current = 0;
    playSegment(0);
  }, { once: true });
}

/* ---------------- 固定时间间隔切片 ---------------- */
function buildSegments(duration) {
  state.segments = [];
  const total = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
  for (let i = 0; i < total; i++) {
    state.segments.push({
      index: i,
      start: i * SEGMENT_SECONDS,
      end: Math.min((i + 1) * SEGMENT_SECONDS, duration),
    });
  }
}

function playSegment(i) {
  const seg = state.segments[i];
  const v = $('teach-video');
  if (!seg) return;
  v.currentTime = seg.start;
  v.play();
  state.current = i;
  highlightSlides();
}

// 播放超出当前片段时自动暂停（模拟"当前片段"）
$('teach-video').addEventListener('timeupdate', () => {
  const seg = state.segments[state.current];
  const v = $('teach-video');
  if (seg && v.currentTime >= seg.end) {
    v.pause();
    v.currentTime = seg.end;
  }
});

/* ---------------- 片段切换按钮 ---------------- */
$('prev-seg').addEventListener('click', () => {
  if (state.current > 0) playSegment(state.current - 1);
});
$('next-seg').addEventListener('click', () => {
  if (state.current < state.segments.length - 1) playSegment(state.current + 1);
});

/* ---------------- 轮播图渲染 ---------------- */
function renderCarousels() {
  ['select-carousel-track', 'learn-carousel-track', 'correct-carousel-track'].forEach((id) => {
    const track = $(id);
    track.innerHTML = '';
    state.segments.forEach((seg) => {
      const slide = document.createElement('div');
      slide.className = 'carousel-slide';
      slide.dataset.index = seg.index;
      slide.innerHTML = `
        <span class="seg-label">片段 ${seg.index + 1}</span>
        <span>${fmt(seg.start)} – ${fmt(seg.end)}</span>
        <span class="seg-time">${fmt(seg.end - seg.start)}</span>
      `;
      slide.addEventListener('click', () => {
        state.current = seg.index;
        highlightSlides();
        playSegment(seg.index);
        switchTab('learning');
      });
      track.appendChild(slide);
    });
  });
  highlightSlides();
}

function highlightSlides() {
  document.querySelectorAll('.carousel-slide').forEach((s) => {
    s.classList.toggle('active', Number(s.dataset.index) === state.current);
  });
}

function fmt(sec) {
  if (!isFinite(sec)) return '00:00';
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// 轮播图左右箭头：滚动一屏
document.querySelectorAll('.carousel').forEach((c) => {
  const track = c.querySelector('.carousel-track');
  c.querySelectorAll('.carousel-arrow').forEach((btn) => {
    btn.addEventListener('click', () => {
      track.scrollBy({ left: btn.classList.contains('left') ? -260 : 260, behavior: 'smooth' });
    });
  });
});

/* ---------------- 摄像头 ---------------- */
let cameraStream = null;

async function startCamera() {
  if (cameraStream) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    $('camera-video').srcObject = cameraStream;
  } catch (err) {
    console.warn('摄像头访问失败：', err);
    alert('无法访问摄像头，请检查浏览器权限设置。');
  }
}

// 回放页：复用摄像头画面（演示模式，暂不录像）
$('clip-1').addEventListener('click', () => selectClip($('clip-1')));
$('clip-2').addEventListener('click', () => selectClip($('clip-2')));

function selectClip(el) {
  document.querySelectorAll('.clip-item').forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
  // TODO: 后端接入后此处播放对应片段的录像回放
  $('replay-video').srcObject = cameraStream;
}

$('prev-clip').addEventListener('click', () => {
  const items = [...document.querySelectorAll('.clip-item')];
  const i = items.findIndex((c) => c.classList.contains('active'));
  if (i > 0) selectClip(items[i - 1]);
});
$('next-clip').addEventListener('click', () => {
  const items = [...document.querySelectorAll('.clip-item')];
  const i = items.findIndex((c) => c.classList.contains('active'));
  if (i < items.length - 1) selectClip(items[i + 1]);
});

/* ---------------- 聊天历史（演示） ---------------- */
document.querySelectorAll('.chat-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.chat-item').forEach((c) => c.classList.remove('active'));
    item.classList.add('active');
  });
});

function switchTab(name) {
  document.querySelector(`.tab[data-view="${name}"]`).click();
}
