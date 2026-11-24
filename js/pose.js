/**
 * 骨架绘制与轮廓映射工具。
 *
 * 后端返回的关键点为归一化坐标 [x, y, z, visibility]（MediaPipe 33 点）。
 * 坐标映射统一在"显示像素空间"完成，自动适配 object-fit: contain 造成的留白。
 */

// 注意：0 号点是「鼻子」。MediaPipe 的 33 点模型没有脖子，
// 旧版直接把 0 连到双肩，画出来就是脸上一个鼻尖点 + 一个三角，
// 看着像"把鼻子当成了骨架关节"。这里改用双肩中点合成的脖子（见 drawPose）。
export const CONNECTIONS = [
  [11, 12],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

// 只画关节圆点；0~10 是面部（鼻/眼/耳/嘴），不参与骨架
const KEY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const MIN_VISIBILITY = 0.3;
// 腿/髋被画面裁掉时，模型仍会给出画面外的坐标（ONNX 版可见度恒为 1），
// 直接连线会甩出几条出画面的长线，看着像"识别坏了"。超出画面太多的点不画。
const FRAME_MARGIN = 0.02;

function onScreen(point) {
  if (!point) return false;
  if ((point[3] ?? 1) < MIN_VISIBILITY) return false;
  return (
    point[0] > -FRAME_MARGIN &&
    point[0] < 1 + FRAME_MARGIN &&
    point[1] > -FRAME_MARGIN &&
    point[1] < 1 + FRAME_MARGIN
  );
}

/** 双肩中点作为脖子：33 点模型里唯一可靠的躯干上端。 */
export function neckPoint(pose) {
  const left = pose[11];
  const right = pose[12];
  if (!onScreen(left) || !onScreen(right)) return null;
  return [
    (left[0] + right[0]) / 2,
    (left[1] + right[1]) / 2,
    (left[2] + right[2]) / 2,
    Math.min(left[3] ?? 1, right[3] ?? 1),
  ];
}

/** 计算 object-fit: contain 时媒体在容器内的实际显示区域。 */
export function fitRect(width, height, mediaWidth, mediaHeight) {
  if (!mediaWidth || !mediaHeight || !width || !height) {
    return { x: 0, y: 0, w: width, h: height };
  }
  const scale = Math.min(width / mediaWidth, height / mediaHeight);
  const w = mediaWidth * scale;
  const h = mediaHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/**
 * 骨架平滑：把「显示用骨架」朝最新一次推理结果做指数插值。
 *
 * 服务端大约 20~25fps 才回一次结果，直接画会一顿一顿；
 * 绘制循环是 60fps，每帧只挪一部分距离，人眼看到的就是连续运动。
 * visibility 直接跟最新的走，避免关节忽明忽暗。
 */
export function smoothPose(previous, next, factor = 0.5) {
  if (!next) return null;
  if (!previous || previous.length !== next.length) {
    return next.map((point) => (point ? [...point] : point));
  }
  const blend = Math.min(0.95, Math.max(0.05, factor));
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i += 1) {
    const from = previous[i];
    const to = next[i];
    if (!to) {
      out[i] = from ? [...from] : to;
    } else if (!from) {
      out[i] = [...to];
    } else {
      out[i] = [
        from[0] + (to[0] - from[0]) * blend,
        from[1] + (to[1] - from[1]) * blend,
        from[2] + (to[2] - from[2]) * blend,
        to[3] ?? from[3],
      ];
    }
  }
  return out;
}

export function drawPose(ctx, pose, rect, options = {}) {
  if (!pose) return;
  const {
    color = '#00e5a0',
    lineWidth = 3,
    alpha = 1,
    jointAlpha = 1,
    dashed = false,
    joints = true,
    shadow = false,
  } = options;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([7, 6]);
  if (shadow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
  }

  const toXY = (p) => [rect.x + p[0] * rect.w, rect.y + p[1] * rect.h];

  for (const [a, b] of CONNECTIONS) {
    const pa = pose[a];
    const pb = pose[b];
    if (!onScreen(pa) || !onScreen(pb)) continue;
    const [ax, ay] = toXY(pa);
    const [bx, by] = toXY(pb);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // 脖子（双肩中点）连到两肩：替代原来"鼻尖连双肩"的三角
  const neck = neckPoint(pose);
  if (neck) {
    const [nx, ny] = toXY(neck);
    for (const shoulder of [11, 12]) {
      const p = pose[shoulder];
      if (!onScreen(p)) continue;
      const [sx, sy] = toXY(p);
      ctx.beginPath();
      ctx.moveTo(nx, ny);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
  }

  if (joints) {
    ctx.setLineDash([]);
    // 关节点的可见度单独控制：阴影为主视觉时，点只做淡辅助
    ctx.globalAlpha = alpha * jointAlpha;
    for (const index of KEY_JOINTS) {
      const p = pose[index];
      if (!onScreen(p)) continue;
      const [x, y] = toXY(p);
      ctx.beginPath();
      ctx.arc(x, y, lineWidth * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
  }
  ctx.restore();
}

/** 人体尺度：髋部中心与肩髋躯干长度（像素）。 */
function metrics(pose, rect) {
  const vis = (p) => p && (p[3] ?? 1) >= MIN_VISIBILITY;
  const pt = (p) => ({ x: rect.x + p[0] * rect.w, y: rect.y + p[1] * rect.h });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const shL = pose[11];
  const shR = pose[12];
  const hipL = pose[23];
  const hipR = pose[24];

  if (vis(shL) && vis(shR) && vis(hipL) && vis(hipR)) {
    const hip = mid(pt(hipL), pt(hipR));
    const shoulder = mid(pt(shL), pt(shR));
    return { hip, shoulder, torso: Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) || 1 };
  }

  // 半身入镜（坐姿/镜头近）时髋部常不可见：降级用肩宽估算躯干长度，
  // 肩部中心作为锚点，保证对比轮廓不因取景而整体消失
  if (vis(shL) && vis(shR)) {
    const a = pt(shL);
    const b = pt(shR);
    const shoulder = mid(a, b);
    const torso = Math.hypot(a.x - b.x, a.y - b.y) * 1.4 || 1;
    return { hip: { x: shoulder.x, y: shoulder.y + torso }, shoulder, torso };
  }

  return null;
}

/**
 * 将 sourcePose 的轮廓映射到 targetPose 的人体尺度上（髋部对齐 + 躯干等比缩放）。
 * 用于把教学视频轮廓叠加到摄像头画面（或回放画面）上做对比。
 */
export function mapPose(sourcePose, sourceRect, targetPose, targetRect) {
  const source = metrics(sourcePose, sourceRect);
  const target = metrics(targetPose, targetRect);
  if (!source || !target) return null;
  const scale = target.torso / source.torso;

  return sourcePose.map((p) => {
    if (!p) return null;
    const px = sourceRect.x + p[0] * sourceRect.w;
    const py = sourceRect.y + p[1] * sourceRect.h;
    const mx = target.hip.x + (px - source.hip.x) * scale;
    const my = target.hip.y + (py - source.hip.y) * scale;
    return [
      (mx - targetRect.x) / targetRect.w,
      (my - targetRect.y) / targetRect.h,
      p[2],
      p[3],
    ];
  });
}

/** 水平翻转骨架（x → 1-x）。
 * 教学视频是正向视角、摄像头是镜像显示：跨视角映射骨架时必须先翻转，
 * 否则映射出的轮廓左右相反（镜像感）。
 */
export function flipX(pose) {
  if (!pose) return pose;
  return pose.map((p) => (p ? [1 - p[0], p[1], p[2], p[3]] : p));
}

/* ------------------------------------------------------------ 人物阴影 */

let shadowCanvasEl = null;

/** 把灰度掩码（0=背景 255=人物）着色并拉伸绘制到 rect。
 * @param maskImage 已解码的掩码 ImageBitmap
 * @param flipXMask 掩码需要水平翻转（教学掩码映射到镜像的摄像头画面时）
 */
export function drawShadow(ctx, maskImage, rect, color, alpha = 0.32, flipXMask = false) {
  if (!maskImage) return;
  const w = maskImage.width;
  const h = maskImage.height;
  if (!shadowCanvasEl) shadowCanvasEl = document.createElement('canvas');
  if (shadowCanvasEl.width !== w || shadowCanvasEl.height !== h) {
    shadowCanvasEl.width = w;
    shadowCanvasEl.height = h;
  }
  const c = shadowCanvasEl.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  if (flipXMask) {
    c.save();
    c.translate(w, 0);
    c.scale(-1, 1);
    c.drawImage(maskImage, 0, 0);
    c.restore();
  } else {
    c.drawImage(maskImage, 0, 0);
  }
  // 剪影染色：保留掩码形状，把颜色"灌"进去
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(shadowCanvasEl, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/** 解码掩码 PNG 为 ImageBitmap。 */
export async function decodeMask(bytes) {
  if (!bytes) return null;
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

/** 解析 masks.bin：每帧 [uint32 LE 长度][PNG 字节]，返回 Uint8Array|null 数组。 */
export function parseMaskBin(buffer) {
  const view = new DataView(buffer);
  const frames = [];
  let offset = 0;
  while (offset + 4 <= buffer.byteLength) {
    const len = view.getUint32(offset, true);
    offset += 4;
    frames.push(len ? new Uint8Array(buffer, offset, len) : null);
    offset += len;
  }
  return frames;
}

/** 掩码位图 LRU 缓存：教学视频几千帧，只保留最近用到的。
 * get() 同步返回已就绪的位图（未命中返回 null 并在后台预热），绘制循环无需 await。
 */
export function createMaskCache(limit = 180) {
  const bitmaps = new Map();
  const inflight = new Map();
  return {
    get(key, loader) {
      const hit = bitmaps.get(key);
      if (hit) return hit;
      if (!inflight.has(key)) {
        inflight.set(
          key,
          (async () => {
            try {
              const bitmap = await decodeMask(await loader());
              if (bitmap) {
                bitmaps.set(key, bitmap);
                if (bitmaps.size > limit) {
                  bitmaps.delete(bitmaps.keys().next().value);
                }
              }
              return bitmap;
            } catch {
              return null;
            } finally {
              inflight.delete(key);
            }
          })()
        );
      }
      return null;
    },
  };
}

/**
 * 教学掩码映射到对比画布的区域（与 mapPose 相同的髋部对齐 + 躯干等比缩放）。
 * 掩码覆盖源画面整帧，因此只需把整帧矩形做同样的仿射变换。
 */
export function mapShadowRect(sourcePose, sourceRect, targetPose, targetRect) {
  const source = metrics(sourcePose, sourceRect);
  const target = metrics(targetPose, targetRect);
  if (!source || !target) return null;
  const scale = target.torso / source.torso;
  return {
    x: target.hip.x + (sourceRect.x - source.hip.x) * scale,
    y: target.hip.y + (sourceRect.y - source.hip.y) * scale,
    w: sourceRect.w * scale,
    h: sourceRect.h * scale,
  };
}

/** 在按时间排序的骨架帧中取最接近 t 的一帧。 */
export function poseAt(frames, t) {
  if (!frames || !frames.length) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const current = frames[lo];
  const prev = lo > 0 ? frames[lo - 1] : null;
  if (prev && Math.abs(prev.t - t) < Math.abs(current.t - t)) return prev;
  return current;
}
