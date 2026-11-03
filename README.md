# DanceMate · 舞蹈学习助手

根据舞蹈学习者提供的教学视频辅助学习：教学视频按固定时间间隔切片，摄像头实时捕捉练习者，
两侧骨架轮廓叠加对比；练习过程可录制，回放时将教学轮廓映射到练习者身上做纠错对比。

```
┌──────────────┐    JPEG 640x480 q0.6    ┌─────────────────┐
│  浏览器摄像头 │ ──────────────────────▶ │  FastAPI 后端    │
│  Canvas 叠加  │ ◀────────────────────── │  MediaPipe Pose │
└──────────────┘   33 个关键点 JSON       └─────────────────┘
        │                                        │
        │ 录制：帧 + 每帧骨架                     │ 教学视频离线骨架
        ▼                                        ▼
   backend/data/sessions/<id>/             backend/data/videos/<id>/pose.json
```

## 快速开始

```powershell
cd dance-learning-assistant\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

浏览器打开 <http://127.0.0.1:8000>（前后端同源，摄像头要求 localhost 或 HTTPS）。

> Python 版本：建议 3.10～3.13。MediaPipe ≥ 0.10.20 / 1.x 已移除 legacy `solutions`，
> 后端会自动切换到 Tasks API，并在首次使用时下载 `pose_landmarker_lite.task`（约 5.5MB）到
> `backend/models/`。若下载缓慢，可手动下载后放入该目录。
>
> 国内网络安装依赖可加镜像：`pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt`
>
> 实测（本机 CPU，640x480 输入）：单帧推理约 16ms，WebSocket 往返约 17ms。
>
> 上传的视频会自动用内置 ffmpeg（imageio-ffmpeg）转码为 **H.264 + AAC + faststart**：
> 微信/手机拍摄的视频常见 HEVC 编码，Chrome 桌面版无法解码（表现为黑屏、进度条不动）。

## 页面说明（对应设计稿）

| 视图 | 设计稿 | 功能 |
|------|--------|------|
| 视频选择 selecting | 图1 | 聊天历史记录、教学视频轮播（按固定间隔切片）、搜索视频库、手动上传 |
| 跟练学习 learning | 图2 | 左：教学片段 + 教学骨架；右：摄像头实时画面 + 实时骨架 + **教学轮廓映射对比**；可录制 |
| 纠错回放 correct | 图3 | 左：练习回放列表（可切换）；右：逐帧回放 + 练习骨架 + **映射到人物身上的教学轮廓** |

## 低延时设计（第二页）

| 措施 | 说明 |
|------|------|
| 单帧在途 | 前端收到上一帧结果后才发下一帧，绝不堆积帧队列 |
| 服务端丢帧 | 新帧到达时若上一帧仍在推理，直接丢弃，链路始终处理最新画面 |
| 推理串行 | 每个 MediaPipe 实例固定单线程执行器，避免实例并发不安全与 CPU 抢占 |
| 轻量模型 | `POSE_MODEL_COMPLEXITY=0`（Lite）；采集 640x480、JPEG q=0.6 |
| 端上绘制 | 服务端只回 33 个关键点（约 2KB），骨架由 Canvas 绘制 |
| 关闭心跳 | 启动参数 `ws_ping_interval=None`，减少控制帧干扰 |

界面右上角会显示 `延时 xx ms · 推理 xx ms`（RTT 为端到端往返）。

## 轮廓对比原理

1. 教学视频上传后，后端用 MediaPipe 按 `TEACH_SAMPLE_FPS`（默认 15）抽帧提取 33 点骨架，存入 `pose.json`；
2. 实时链路的每帧骨架时间戳与教学视频 `currentTime` 对齐，取最近的教学帧；
3. 前端 `js/pose.js` 的 `mapPose()` 做**髋部对齐 + 躯干长度等比缩放**，把教学骨架映射到练习者的身体尺度上；
4. 教学画面叠加练习者轮廓（绿虚线），摄像头画面叠加教学轮廓（粉虚线），直观看出动作差异；
5. 回放页用录制时保存的逐帧骨架，按录制时长与片段时长的比例映射教学时间轴，实现"教学轮廓映射在人物动作回放上"。

## 目录结构

```
dance-learning-assistant/
├── index.html
├── css/style.css
├── js/
│   ├── app.js        # 页面主逻辑
│   ├── api.js        # 后端接口
│   ├── pose.js       # 骨架绘制 + 轮廓映射
│   ├── live.js       # 低延时 WebSocket 实时链路
│   └── replay.js     # 回放播放器
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── deploy/Caddyfile   # 自动 HTTPS + WebSocket 反代
├── backend/
│   ├── run.py
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py            # FastAPI 入口（托管前端）
│   │   ├── config.py
│   │   ├── api/videos.py      # 上传/切片/搜索/Range 播放/骨架分析
│   │   ├── api/sessions.py    # 回放列表与详情
│   │   ├── api/ws_practice.py # 实时骨架 + 录制
│   │   └── services/
│   │       ├── pose_engine.py    # MediaPipe 封装（串行、单帧）
│   │       ├── teach_pose.py     # 教学视频离线骨架提取
│   │       ├── video_store.py    # 视频库
│   │       └── session_store.py  # 录制存储
│   └── data/                  # 运行时数据（git 忽略）
│       ├── videos/<id>/{source.mp4, meta.json, pose.json}
│       └── sessions/<id>/{frames/*.jpg, poses.json, meta.json}
```

## 部署（Docker + Caddy，自动 HTTPS）

前置条件：

1. 一台能运行 Docker 的服务器（Linux，2 核 2G 以上；无 GPU 也能跑，CPU 推理约 20~40ms/帧）。
2. 一个域名，DNS **A 记录指向服务器公网 IP**。
3. 服务器安全组/防火墙放行 **80、443**（80 用于 Let's Encrypt 验证）。

```bash
# 1. 上传代码（或 git clone）
git clone https://github.com/Hollybooy/dance-learning-assistant.git
cd dance-learning-assistant

# 2. 配置域名
cp .env.example .env
vi .env          # DOMAIN=dance.example.com  EMAIL=you@example.com

# 3. 启动（首次会构建镜像并下载模型，约 3~5 分钟）
docker compose up -d --build

# 4. 查看证书 / 日志
docker compose logs -f caddy
docker compose ps
```

启动后访问 `https://<你的域名>`，Caddy 会自动申请并续期 Let's Encrypt 证书（HTTPS 是摄像头可用的前提）。

要点：

- `reverse_proxy` 已设置 `flush_interval -1`，避免实时骨架数据被缓冲；WebSocket 由 Caddy 自动升级，无需额外配置。
- 上传视频与练习回放持久化在宿主机 `./backend/data`，重建容器不丢数据。
- `run.py` 只允许单 worker（MediaPipe 引擎为进程内单例），扩缩容请横向加机器而不是加 worker。
- 中国大陆服务器绑定域名需备案；仅 IP 无法签发 Let's Encrypt 证书。
- 容器默认以 root 运行，数据文件属主为 root；如遇权限问题：`sudo chown -R $USER:$USER backend/data`。

### 临时公网演示（内网穿透，免域名）

```bash
# 本机先启动服务
python backend/run.py

# 另开终端，cloudflared 快速隧道（自带 HTTPS，地址随机且进程退出即失效）
cloudflared tunnel --url http://127.0.0.1:8000
```

适合临时给他人演示，不适合长期使用（地址不固定、带宽有限）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/videos/upload` | 上传教学视频，自动转码 H.264、切片并触发骨架分析 |
| GET | `/api/videos` | 视频库列表 |
| GET | `/api/videos/search?q=` | 按标题搜索 |
| GET | `/api/videos/{id}` | 元数据 + 切片 + 骨架状态 |
| GET | `/api/videos/{id}/stream` | 支持 Range 的视频流（拖动进度条无延迟） |
| POST | `/api/videos/{id}/analyze` | 重新提取教学骨架 |
| GET | `/api/videos/{id}/pose?start=&end=` | 教学骨架帧 |
| GET | `/api/sessions` | 练习回放列表 |
| GET | `/api/sessions/{id}` | 回放元数据 + 逐帧骨架 |
| WS | `/ws/practice` | 实时骨架推流、录制开关 |

WebSocket 协议：

```jsonc
// 客户端 → 服务端
// binary: JPEG 帧
{"type": "record_start", "video_id": "...", "segment_index": 0, "title": "..."}
{"type": "record_stop"}

// 服务端 → 客户端
{"type": "pose", "pose": [[x,y,z,v], ...] | null, "server_ms": 18.2, "dropped": 0}
{"type": "record_started", "session_id": "..."}
{"type": "record_stopped", "session": { /* meta */ }}
```

## 可调参数（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DANCEMATE_SEGMENT_SECONDS` | 10 | 切片间隔 |
| `DANCEMATE_TEACH_FPS` | 15 | 教学骨架采样帧率 |
| `DANCEMATE_RECORD_FPS` | 12 | 回放录制帧率 |
| `DANCEMATE_POSE_COMPLEXITY` | 0 | 0=Lite，1=Full（更准但更慢） |
| `DANCEMATE_MAX_UPLOAD_MB` | 800 | 上传大小上限 |
| `DANCEMATE_DATA_DIR` | `backend/data` | 数据目录 |

## 后续可优化

- [ ] 教学视频搜索接入外部平台（当前搜索的是本地视频库）
- [ ] 使用 GPU / TFLite delegate 进一步降低推理耗时
- [ ] 骨骼角度序列相似度评分（自动指出错误关节）
- [ ] 多机位与多人场景
