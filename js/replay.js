/**
 * 纠错回放播放器。
 *
 * 逐帧读取录制好的 JPEG + 骨架数据，播放时把教学视频对应时刻的轮廓
 * 按人体尺度映射到回放人物身上，形成"教学 vs 实际"的叠加对比。
 */

import { drawPose, mapPose, poseAt } from './pose.js';

const PRELOAD_AHEAD = 36;

export class ReplayPlayer {
  constructor({ canvas, seekBar, timeLabel, playButton, getTeachFrames }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.seekBar = seekBar;
    this.timeLabel = timeLabel;
    this.playButton = playButton;
    this.getTeachFrames = getTeachFrames;

    this.session = null;
    this.frames = [];
    this.teachFrames = [];
    this.duration = 0;
    this.playhead = 0;
    this.playing = false;
    this.showTeach = true;
    this.images = new Map();

    if (!canvas.width || !canvas.height) {
      canvas.width = 640;
      canvas.height = 480;
    }

    this._lastTick = 0;
    this._tick = this._tick.bind(this);

    seekBar.addEventListener('input', () => {
      if (!this.session) return;
      const ratio = Number(seekBar.value) / 1000;
      this.seek(ratio * this.duration);
    });
    playButton.addEventListener('click', () => this.toggle());
  }

  async load(session) {
    this.pause();
    this.session = session;
    this.frames = session.frames || [];
    this.duration = session.duration || this.frames.at(-1)?.t || 0;
    this.playhead = 0;
    this.images.clear();
    this.teachFrames = [];

    if (session.video_id) {
      try {
        this.teachFrames = (await this.getTeachFrames(session.video_id)) || [];
      } catch {
        this.teachFrames = [];
      }
    }

    const first = this._image(this.frames[0]?.i ?? 1);
    await new Promise((resolve) => {
      if (first.complete) return resolve();
      first.onload = resolve;
      first.onerror = resolve;
    });

    if (first.naturalWidth) {
      this.canvas.width = first.naturalWidth;
      this.canvas.height = first.naturalHeight;
    }

    this._draw();
    this._syncBar();
    return this.frames.length;
  }

  _image(index) {
    if (!index) return new Image();
    let image = this.images.get(index);
    if (!image) {
      image = new Image();
      image.decoding = 'async';
      image.src = `/media/sessions/${this.session.id}/frames/${String(index).padStart(5, '0')}.jpg`;
      this.images.set(index, image);
    }
    return image;
  }

  _frameIndex(t) {
    const frames = this.frames;
    if (!frames.length) return -1;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _teachTime(t) {
    const s = this.session;
    const lastT = this.teachFrames.at(-1)?.t ?? 0;

    // 优先按录制瞬间的真实播放位置 1:1 推进，帧率抖动也能对齐
    if (s && s.teach_start != null) {
      const target = s.teach_start + t;
      const limit = s.segment_end ?? lastT;
      return Math.min(target, limit);
    }

    const ratio = this.duration > 0 ? Math.min(1, Math.max(0, t / this.duration)) : 0;
    if (s && s.segment_start != null && s.segment_end != null) {
      return s.segment_start + ratio * (s.segment_end - s.segment_start);
    }
    return ratio * lastT;
  }

  _draw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#070a0d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!this.session || !this.frames.length) return;

    const index = this._frameIndex(this.playhead);
    const entry = this.frames[Math.max(0, index)];
    if (!entry) return;

    const image = this._image(entry.i);
    if (image.complete && image.naturalWidth) {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }

    const rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    if (entry.pose) {
      drawPose(ctx, entry.pose, rect, { color: '#00e5a0', lineWidth: 4, shadow: true });
    }

    if (this.showTeach && entry.pose && this.teachFrames.length) {
      const teachFrame = poseAt(this.teachFrames, this._teachTime(entry.t));
      if (teachFrame?.pose) {
        const mapped = mapPose(teachFrame.pose, rect, entry.pose, rect);
        if (mapped) {
          drawPose(ctx, mapped, rect, {
            color: '#ff5c8a',
            lineWidth: 3,
            dashed: true,
            alpha: 0.95,
          });
        }
      }
    }

    // 预加载后续帧，保证播放顺滑
    for (let i = index; i < Math.min(this.frames.length, index + PRELOAD_AHEAD); i += 1) {
      this._image(this.frames[i].i);
    }
  }

  _syncBar() {
    const ratio = this.duration > 0 ? this.playhead / this.duration : 0;
    this.seekBar.value = String(Math.round(ratio * 1000));
    this.timeLabel.textContent = `${formatTime(this.playhead)} / ${formatTime(this.duration)}`;
    this.playButton.textContent = this.playing ? '暂停' : '播放';
  }

  play() {
    if (!this.session || !this.frames.length || this.playing) return;
    if (this.playhead >= this.duration) this.playhead = 0;
    this.playing = true;
    this._lastTick = performance.now();
    this._syncBar();
    requestAnimationFrame(this._tick);
  }

  pause() {
    this.playing = false;
    if (this.session) this._syncBar();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t) {
    this.playhead = Math.min(this.duration, Math.max(0, t));
    this._draw();
    this._syncBar();
  }

  _tick(now) {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this._lastTick) / 1000);
    this._lastTick = now;
    this.playhead = Math.min(this.duration, this.playhead + dt);
    this._draw();
    this._syncBar();

    if (this.playhead >= this.duration) {
      this.playing = false;
      this._syncBar();
      return;
    }
    requestAnimationFrame(this._tick);
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}
