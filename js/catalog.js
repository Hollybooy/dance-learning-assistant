/**
 * 本地内置课程目录（assets/media 下的随包素材）。
 *
 * 课程素材与后端视频的关联（backendId 指向后端 /api/videos 中的同内容视频）：
 *  - 带 backendId 的课程：跟练时自动改用后端视频流（转码+切片+骨架+掩码齐备），
 *    骨骼对比、人物阴影、重合度全部可用；后端不可用时回退本地静态播放（无骨架）；
 *  - 无 backendId 的课程：纯静态文件，前端直接播放，没有骨架数据。
 *
 * backendId 由 backend/_import_builtin.py 生成：把 assets/media 素材上传到
 * 后端分析后回填到这里。重新导入后需同步更新这些 ID。
 *
 * 切片规则（回退模式）：
 *  - 古风燃脂 第一课：基准视频 using_total.mp4，其余 10 个 using_total-* 按编号顺序作为 10 个切片；
 *  - 其他风格视频：按 7 秒一个切片在前端虚拟分段（不物理切割），封面图作为缩略说明图。
 */

export const MEDIA_BASE = 'assets/media/';
export const SLICE_SECONDS = 7;

export const MASTER_COURSE = {
  id: 'local-gufeng',
  backendId: '39182f8bdb23',
  style: 'chinese',
  label: 'Chinese',
  title: '古风燃脂 第一课',
  desc: '以古风鼓点串联的燃脂组合，10 个切片由慢到快，适合每天跟练一遍。',
  cover: 'gufeng-cover.jpg',
  base: 'using_total.mp4',
  slices: [
    'using_total-1.mp4',
    'using_total-2.mp4',
    'using_total-3.mp4',
    'using_total-4.mp4',
    'using_total-5.mp4',
    'using_total-6.mp4',
    'using_total-7.mp4',
    'using_total-8.mp4',
    'using_total-9.mp4',
    'using_total-10.mp4',
  ],
};

export const STYLE_COURSES = [
  {
    id: 'local-chinese',
    backendId: '332861e6464c',
    style: 'chinese',
    label: 'Chinese',
    title: 'Chinese 身韵基础',
    desc: '提沉、冲靠、含腆，从呼吸开始找到身体的重心与控制。',
    cover: 'chinese-cover.jpg',
    video: 'chinese-back.mp4',
  },
  {
    id: 'local-hiphop',
    backendId: 'c908cee34c9b',
    style: 'hiphop',
    label: 'Hip-Hop',
    title: 'Hip-Hop 律动入门',
    desc: '扎实的 bounce 与 groove，把节拍踩进身体里。',
    cover: 'hiphop-cover.jpg',
    video: 'hiphop-back.mp4',
  },
  {
    id: 'local-ballet',
    backendId: 'bf04e00e7905',
    style: 'ballet',
    label: 'Ballet',
    title: 'Ballet 芭蕾基础',
    desc: '从把杆姿态到小跳，建立干净利落的线条。',
    cover: 'ballet-cover.jpg',
    video: 'ballet-back.mp4',
  },
  {
    id: 'local-swing',
    backendId: 'd168f377992f',
    style: 'swing',
    label: 'Swing',
    title: 'Swing 摇摆舞步',
    desc: '轻快的双人节奏与踢踏重心转换，越跳越上瘾。',
    cover: 'swing-cover.jpg',
    video: 'swing-back.mp4',
  },
  {
    id: 'local-chacha',
    backendId: 'b0673b576fa3',
    style: 'chacha',
    label: 'Cha Cha',
    title: 'Cha Cha 恰恰节拍',
    desc: '四拍三动的经典律动，练出干净的重心转移。',
    cover: 'cha-cha-cover.jpg',
    video: 'cha-cha-back.mp4',
  },
  {
    id: 'local-waltz',
    backendId: '0db4862a64e7',
    style: 'waltz',
    label: 'Waltz',
    title: 'Waltz 华尔兹圆舞',
    desc: '三拍起伏与旋转，找到身体在空间里的流动。',
    cover: 'waltz-cover.jpg',
    video: 'waltz-back.mp4',
  },
];

/** 分类背景素材：选中分类时铺满右侧舞台 */
export const CATEGORY_BACKDROP = {
  chinese: { video: 'chinese-back.mp4', cover: 'chinese-cover.jpg' },
  hiphop: { video: 'hiphop-back.mp4', cover: 'hiphop-cover.jpg' },
  ballet: { video: 'ballet-back.mp4', cover: 'ballet-cover.jpg' },
  swing: { video: 'swing-back.mp4', cover: 'swing-cover.jpg' },
  chacha: { video: 'cha-cha-back.mp4', cover: 'cha-cha-cover.jpg' },
  waltz: { video: 'waltz-back.mp4', cover: 'waltz-cover.jpg' },
};

export function assetUrl(name) {
  if (!name) return '';
  if (/^(?:https?:|data:|blob:)/.test(name)) return name;
  return `${MEDIA_BASE}${name}`;
}

/** 7 秒切片：仅做前端虚拟分段，播放器在同一文件内跳转 */
export function sliceSegments(duration, src, thumbnail, step = SLICE_SECONDS) {
  const total = Number(duration) || 0;
  if (!total) return [];
  const count = Math.max(1, Math.ceil(total / step));
  return Array.from({ length: count }, (_, index) => {
    const start = index * step;
    return {
      index,
      start,
      end: Math.min(total, start + step),
      src,
      thumbnail,
    };
  });
}

/** 转化为与后端 /api/videos 一致的结构，便于复用现有渲染逻辑 */
export function buildLocalCourses() {
  const master = {
    id: MASTER_COURSE.id,
    backendId: MASTER_COURSE.backendId,
    title: MASTER_COURSE.title,
    desc: MASTER_COURSE.desc,
    style: MASTER_COURSE.style,
    label: MASTER_COURSE.label,
    local: true,
    master: true,
    cover: assetUrl(MASTER_COURSE.cover),
    duration: 0,
    pose_status: 'local',
    segments: MASTER_COURSE.slices.map((file, index) => ({
      index,
      start: 0,
      end: 0,
      src: assetUrl(file),
      thumbnail: assetUrl(MASTER_COURSE.cover),
    })),
  };

  const styles = STYLE_COURSES.map((course) => ({
    id: course.id,
    backendId: course.backendId,
    title: course.title,
    desc: course.desc,
    style: course.style,
    label: course.label,
    local: true,
    master: false,
    cover: assetUrl(course.cover),
    video: assetUrl(course.video),
    duration: 0,
    pose_status: 'local',
    segments: [],
  }));

  return [master, ...styles];
}
