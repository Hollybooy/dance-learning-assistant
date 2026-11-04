/**
 * 骨架绘制与轮廓映射工具。
 *
 * 后端返回的关键点为归一化坐标 [x, y, z, visibility]（MediaPipe 33 点）。
 * 坐标映射统一在"显示像素空间"完成，自动适配 object-fit: contain 造成的留白。
 */

export const CONNECTIONS = [
  [0, 11], [0, 12], [11, 12],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const MIN_VISIBILITY = 0.3;

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

export function drawPose(ctx, pose, rect, options = {}) {
  if (!pose) return;
  const {
    color = '#00e5a0',
    lineWidth = 3,
    alpha = 1,
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

  for (const [a, b] of CONNECTIONS) {
    const pa = pose[a];
    const pb = pose[b];
    if (!pa || !pb) continue;
    if ((pa[3] ?? 1) < MIN_VISIBILITY || (pb[3] ?? 1) < MIN_VISIBILITY) continue;
    ctx.beginPath();
    ctx.moveTo(rect.x + pa[0] * rect.w, rect.y + pa[1] * rect.h);
    ctx.lineTo(rect.x + pb[0] * rect.w, rect.y + pb[1] * rect.h);
    ctx.stroke();
  }

  if (joints) {
    ctx.setLineDash([]);
    for (const index of KEY_JOINTS) {
      const p = pose[index];
      if (!p || (p[3] ?? 1) < MIN_VISIBILITY) continue;
      ctx.beginPath();
      ctx.arc(rect.x + p[0] * rect.w, rect.y + p[1] * rect.h, lineWidth * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
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
