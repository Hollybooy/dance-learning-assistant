/**
 * 纠错回放播放器。
 *
 * 逐帧读取录制好的 JPEG + 骨架数据，播放时把教学视频对应时刻的轮廓
 * 按人体尺度映射到回放人物身上，形成"教学 vs 实际"的叠加对比。
 */

import {
  drawPose,
  drawShadow,
  mapPose,
  mapShadowRect,
  poseAt,
  flipX,
  parseMaskBin,
  createMaskCache,
} from './pose.js';

const PRELOAD_AHEAD = 36;

export class ReplayPlayer {
  constructor({ canvas, seekBar, timeLabel, playButton, getTeachFrames, getTeachMasks }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.seekBar = seekBar;
    this.timeLabel = timeLabel;
    this.playButton = playButton;
    this.getTeachFrames = getTeachFrames;
    this.getTeachMasks = getTeachMasks || null;

    this.session = null;
    this.frames = [];
    this.teachFrames = [];
    this.duration = 0;
    this.playhead = 0;
    this.playing = false;
    this.showTeach = true;
    this.showShadow = true;
    this.images = new Map();
    // 录制帧的人物掩码（顺序与 poses.json 帧一致）与教学掩码缓存
    this.maskFrames = null;
    this.teachMaskFrames = null;
    // 缓存要覆盖整个预取窗口（否则顺序播放时每帧都是新 key，命中率为 0）
    this.maskCache = createMaskCache(600);
    // 上一帧已解码的轮廓：当前帧还没解出来时先沿用，避免阴影忽隐忽现
    this._selfMaskBmp = null;
    this._teachMaskBmp = null;
    this._redrawPending = false;

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
    this.maskFrames = null;
    this.teachMaskFrames = null;
    this._selfMaskBmp = null;
    this._teachMaskBmp = null;

    if (session.video_id) {
      try {
        this.teachFrames = (await this.getTeachFrames(session.video_id)) || [];
      } catch {
        this.teachFrames = [];
      }
      if (this.getTeachMasks) {
        this.teachMaskFrames = await this.getTeachMasks(session.video_id).catch(() => null);
      }
    }

    // 录制侧掩码（可能不存在：老录制）
    if (session.masks_url) {
      try {
        const res = await fetch(session.masks_url);
        if (!res.ok) throw new Error('no masks');
        this.maskFrames = parseMaskBin(await res.arrayBuffer());
      } catch {
        this.maskFrames = null;
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

    // 首帧就绪前先解码开头一段掩码，播放一开始阴影就是完整的
    this._warmMasks(0);
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

    // 优先按录制瞬间的真实播放位置推进；录制时若用了倍速，则按同速推进
    if (s && s.teach_start != null) {
      const rate = s.teach_rate > 0 ? s.teach_rate : 1;
      const target = s.teach_start + t * rate;
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
      // 自己的人物阴影（录制时保存的人物分割掩码）
      if (this.showShadow && this.maskFrames) {
        const maskData = this.maskFrames[entry.i - 1] ?? null;
        const bitmap = maskData
          ? this.maskCache.get(`rec:${entry.i}`, async () => maskData)
          : null;
        if (bitmap) this._selfMaskBmp = bitmap;
        // 当前帧解码未就绪时沿用上一帧轮廓：宁可滞后一帧，也不让阴影忽隐忽现
        const activeMask = bitmap || this._selfMaskBmp;
        if (activeMask) drawShadow(ctx, activeMask, rect, '#00e5a0', 0.35);
        else this._scheduleRedraw();
      }
      drawPose(ctx, entry.pose, rect, {
        color: '#00e5a0',
        lineWidth: 3,
        alpha: 0.8,
        jointAlpha: 0.45,
        shadow: true,
      });
    }

    if (this.showTeach && entry.pose && this.teachFrames.length) {
      const teachFrame = poseAt(this.teachFrames, this._teachTime(entry.t));
      if (teachFrame?.pose) {
        const flippedTeach = flipX(teachFrame.pose);
        // 教学骨架先翻转到镜像视角，再映射到录制画面上，左右方向与实际动作一致
        const mapped = mapPose(flippedTeach, rect, entry.pose, rect);
        if (mapped) {
          // 教学人物阴影：同样翻转后按人体尺度映射
          if (this.showShadow && this.teachMaskFrames && teachFrame.i != null) {
            const teachMask = this.teachMaskFrames[teachFrame.i] ?? null;
            const bitmap = teachMask
              ? this.maskCache.get(`teach:${teachFrame.i}`, async () => teachMask)
              : null;
            if (bitmap) this._teachMaskBmp = bitmap;
            const activeMask = bitmap || this._teachMaskBmp;
            const shadowRect = mapShadowRect(flippedTeach, rect, entry.pose, rect);
            if (activeMask && shadowRect) {
              drawShadow(ctx, activeMask, shadowRect, '#ff5c8a', 0.22, true);
            }
            this._warmTeachMasks(teachFrame.i);
          }
          drawPose(ctx, mapped, rect, {
            color: '#ff5c8a',
            lineWidth: 2.5,
            dashed: true,
            alpha: 0.6,
            jointAlpha: 0.45,
          });
        }
      }
    }

    // 预加载后续帧（画面 + 掩码），保证播放顺滑且阴影不闪
    for (let i = index; i < Math.min(this.frames.length, index + PRELOAD_AHEAD); i += 1) {
      this._image(this.frames[i].i);
    }
    this._warmMasks(index);
  }

  /** 预解码后续录制帧掩码：把"每帧现解"改成"提前解码"，播放时直接命中缓存。 */
  _warmMasks(index) {
    if (!this.maskFrames) return;
    const end = Math.min(this.frames.length, index + PRELOAD_AHEAD);
    for (let i = Math.max(0, index); i < end; i += 1) {
      const frameIndex = this.frames[i]?.i;
      if (!frameIndex) continue;
      const data = this.maskFrames[frameIndex - 1];
      if (data) this.maskCache.get(`rec:${frameIndex}`, async () => data);
    }
  }

  /** 预解码后续教学帧掩码（教学帧率低于回放帧率，预热窗口足够覆盖）。 */
  _warmTeachMasks(startIndex) {
    if (!this.teachMaskFrames || startIndex == null) return;
    const end = Math.min(this.teachMaskFrames.length, startIndex + PRELOAD_AHEAD);
    for (let i = Math.max(0, startIndex); i < end; i += 1) {
      const data = this.teachMaskFrames[i];
      if (data) this.maskCache.get(`teach:${i}`, async () => data);
    }
  }

  /** 暂停状态下首帧掩码还在解码：稍后补画一帧，避免暂停时看不到阴影。 */
  _scheduleRedraw() {
    if (this.playing || this._redrawPending) return;
    this._redrawPending = true;
    setTimeout(() => {
      this._redrawPending = false;
      if (!this.playing && this.session) this._draw();
    }, 120);
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
    // 跳转后旧轮廓不再对应当前画面，清掉并预热新位置，等解码完成再补画
    this._selfMaskBmp = null;
    this._teachMaskBmp = null;
    this._warmMasks(Math.max(0, this._frameIndex(this.playhead)));
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
