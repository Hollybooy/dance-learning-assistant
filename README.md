# DanceMate · 舞蹈学习助手

根据舞蹈学习者提供的教学视频辅助学习：教学视频按固定时间间隔切片，摄像头实时捕捉练习者，
两侧骨架轮廓叠加对比；练习过程可录制，回放时将教学轮廓映射到练习者身上做纠错对比。

```
┌──────────────┐  JPEG 长边 480 q0.55   ┌─────────────────┐
│  浏览器摄像头 │ ──────────────────────▶ │  FastAPI 后端    │
│  Canvas 叠加  │ ◀────────────────────── │  MediaPipe Pose │
└──────────────┘  33 关键点 + 人物掩码     └─────────────────┘
        │                                        │
        │ 录制：帧 + 骨架 + 掩码                  │ 教学视频离线骨架 + 掩码
        ▼                                        ▼
   backend/data/sessions/<id>/             backend/data/videos/<id>/
   {frames/*.jpg, poses.json, masks.bin}   {pose.json, masks.bin}
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

> **Windows 一键启动**：双击项目根目录的 `start.bat`，会自动启动后端并打开浏览器。
> 电脑重启后服务不会自动启动，重新双击即可；如需开机自启，把 `start.bat` 的快捷方式
> 放到 `shell:startup` 目录（Win+R 输入 `shell:startup`）。

> Python 版本：建议 3.10～3.13。MediaPipe ≥ 0.10.20 / 1.x 已移除 legacy `solutions`，
> 后端会自动切换到 Tasks API，并在首次使用时下载 `pose_landmarker_lite.task`（约 5.5MB）到
> `backend/models/`。若下载缓慢，可手动下载后放入该目录。
>
> 国内网络安装依赖可加镜像：`pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt`
>
> 模型下载默认走「镜像直连 → 官方直连 → 镜像/官方 + 本机代理」（见 `backend/app/services/net_download.py`）：
> `python download_onnx_models.py` 拉 ONNX 模型（GitHub 镜像）、`python download_whisper_model.py`
> 拉语音模型（hf-mirror）。代理默认探测 `127.0.0.1:7890`，需要时用 `DANCEMATE_PROXY` 指定，
> 想强制纯直连可设 `DANCEMATE_NO_PROXY=1`。依赖统一用清华源直连安装，通常比走代理更快。
>
> 实测（本机 GTX 1650 Ti，ONNX + DirectML，长边 480 输入）：端到端 p50 约 12ms、p95 约 25ms；同配置纯 CPU 为 p50 20ms / p95 47ms。WebSocket 往返约 17ms。
>
> 上传的视频会自动用内置 ffmpeg（imageio-ffmpeg）转码为 **H.264 + AAC + faststart**：
> 微信/手机拍摄的视频常见 HEVC 编码，Chrome 桌面版无法解码（表现为黑屏、进度条不动）。

## 前端开发预览（改完自动刷新）

只改 HTML / CSS / JS 时，不必重启后端，用仓库自带的标准库开发服务器即可：

```powershell
python backend\run.py          # 终端 1：后端（8000），提供 /api、/media、/ws
python dev.py --port 5500      # 终端 2：前端预览（5500），保存文件后浏览器自动刷新
```

打开 <http://127.0.0.1:5500>。`dev.py` 会以 no-store 方式托管静态文件、监听 `.html/.css/.js`
变更并通过 SSE 触发刷新，同时自动把 `/api`、`/media`、`/ws` 代理地址注入为
`window.__DANCEMATE_API__`（可通过 `--api http://127.0.0.1:8001` 改后端端口）。

- 局域网协作预览：`python dev.py --host 0.0.0.0`，队友访问打印出的内网地址即可看界面。
- 摄像头仅在本机 `127.0.0.1` / `localhost`（安全上下文）可用，局域网 http 访问只能看界面。
- 直接部署 / 交付时不需要 `dev.py`：后端同源托管 `index.html`，前端零构建步骤。

## 分享给他人

仓库地址（已公开）：<https://github.com/Hollybooy/dance-learning-assistant>

| 需求 | 做法 |
|------|------|
| 给源码（最常见） | 直接发仓库链接；对方 `git clone`，或在页面点 **Code → Download ZIP** |
| 邀请一起开发 | 仓库 **Settings → Collaborators → Add people**，对方接受邀请后获得写权限 |
| 冻结一个可交付版本 | **Releases → Draft a new release** 打 tag，GitHub 自动生成源码 zip / tar.gz |
| 临时在线演示 | 本机启动后 `cloudflared tunnel --url http://127.0.0.1:8000`，把临时 HTTPS 地址发给对方 |
| 长期在线 | 按下文「部署」章节用 Docker + Caddy 上服务器 |

对方拿到代码后的运行方式：

```powershell
git clone https://github.com/Hollybooy/dance-learning-assistant.git
cd dance-learning-assistant
.\start.bat                 # Windows 一键启动
# 或手动：
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

首次运行会自动下载约 5.5MB 的 `pose_landmarker_lite.task` 到 `backend/models/`。上传的教学视频与录制数据都存放在 `backend/data/`，已被 git 忽略，不会随仓库分发。

## 页面说明

前端是单页应用，hash 路由，无构建步骤：

| 路由 | 页面 | 功能 |
|------|------|------|
| `#/cover` | 封面 | 主视觉轮播、进入 App、切换主题 |
| `#/home` | 首页 | 推荐课程、最近练习、继续跟练 |
| `#/classes` | 课程大厅 | 舞种分类、弧形轮播、搜索视频库、手动上传教学视频 |
| `#/class/:id` | 课程详情 | 课程介绍、切片胶片条、收藏、开始跟练 |
| `#/learning` | 跟练舞台 | 左：教学片段 + 教学骨架/阴影 + **你的人物轮廓映射 + 重合度**；右：摄像头小窗实时骨架 + **教学轮廓映射对比**；可录制（倒计时 / 倍速 / 片段切换） |
| `#/history` | 练习记录 | 回放列表（可切换、删除）、学习进度 |
| `#/correct/:id` | 纠错回放 | 逐帧回放 + 练习骨架 + **映射到人物身上的教学轮廓** + 跟随度曲线 |
| `#/about` `#/profile` | 关于 / 个人中心 | 项目说明；头像、学习记录、好友、设置（本地存储，不涉后端） |

## 低延时设计（第二页）

| 措施 | 说明 |
|------|------|
| 2 帧在途 | 前端最多同时有 2 帧未回包，吞吐不再被单次往返卡死，端到端延时仍只有一帧左右 |
| 服务端丢帧 | 新帧到达时若上一帧仍在推理，直接丢弃，链路始终处理最新画面 |
| 推理串行 | 每个 MediaPipe 实例固定单线程执行器，避免实例并发不安全与 CPU 抢占 |
| 推理后端 | 默认 `POSE_BACKEND=onnx` + `ORT_PROVIDER=dml`，用 GPU 跑；没有 DML/CUDA 时自动回退 CPU。想要 MediaPipe 的时序跟踪可设 `mediapipe` |
| 轻量模型 | `POSE_MODEL_COMPLEXITY=0`（Lite）；采集保持摄像头原始比例、长边压到 480，JPEG q=0.55 |
| 阴影复用 | 默认 `MASK_BACKEND=blazepose`：人物掩码直接取姿态模型的分割输出，不再多跑一路 YOLO |
| 端上绘制 | 服务端只回 33 个关键点 + 96×96 掩码，骨架与阴影由 Canvas 绘制 |
| 关闭心跳 | 启动参数 `ws_ping_interval=None`，减少控制帧干扰 |

界面右上角会显示 `延时 xx ms · 推理 xx ms`（RTT 为端到端往返）。

## 人物阴影与显示开关

轮廓来自 **MediaPipe 自带的人物分割**——与骨架**同一次推理**输出，不需要 SAM3 / YOLO 等额外模型（实测仅增加约 6.5ms）。

| 元素 | 颜色 | 说明 |
|------|------|------|
| 教学画面 | 橙色 | 老师的人物剪影 + 骨架参考 |
| 摄像头画面 | 绿色 | 你自己的人物剪影 + 骨架 |
| 对比轮廓 | 粉色 | 教学人物剪影与骨架，翻转后映射到你的身体尺度 |

跟练页操作条上的「骨架」「阴影」两个 chip 可独立开关：关掉骨架后阴影成为主视觉，关掉阴影后回到纯骨架模式。

操作条上还有一个「自动播放」/「手动播放」按钮（默认自动，设置里也有「教程自动连播」开关）：
自动时本段播完会停 0.9 秒、自动进入下一段，到最后一段提示「全部片段已完成」；手动时停在原地，
等你自己点下一段。录制期间不会自动跳段。
骨架线透明度 0.8、关节点 0.45，避免抢走阴影的视觉焦点。竖版灵动岛另有两个开关：
「教学骨架」控制教学画面上的橙色叠加，「FULL」把摄像头画面改为全屏叠加模式。

教学画面左下角的 `重合 xx%` 是**教学剪影与你剪影的 IoU 重合度**：你的掩码先做水平翻转、
再按髋部对齐 + 躯干缩放映射到教学帧坐标系，然后在 96×96 网格上算交并比，
所以它反映的是"两个人身体占位有多接近"，不是动作对错评分。

## 轮廓对比原理

1. 教学视频上传后，后端用 MediaPipe 按 `TEACH_SAMPLE_FPS`（默认 15）抽帧提取 33 点骨架，存入 `pose.json`；
2. 实时链路的每帧骨架时间戳与教学视频 `currentTime` 对齐，取最近的教学帧；
3. 前端 `js/pose.js` 的 `mapPose()` 做**髋部对齐 + 躯干长度等比缩放**，把教学骨架映射到练习者的身体尺度上；
4. 教学画面叠加练习者轮廓（绿虚线 + 绿色剪影），摄像头画面叠加教学轮廓（粉虚线 + 粉色剪影），直观看出动作差异；
5. 两边剪影落在同一坐标系后，按 96×96 栅格算 IoU，实时显示重合百分比；
6. 回放页用录制时保存的逐帧骨架，按录制时长与片段时长的比例映射教学时间轴，实现"教学轮廓映射在人物动作回放上"。

## 语音指令（可选，需麦克风）

页面打开后前端连 `/ws/voice`，后端才开始录音（关掉页面即停，不后台常驻）。链路是：
能量 VAD 切句 → faster-whisper（CPU int8）识别中文 → 必须含唤醒词「小教练」→
固定指令走规则解析，播放某个课程这类模糊意图交给 Ollama 上的 Qwen2.5-1.5B 输出 JSON。

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip install -r requirements-voice.txt   # faster-whisper + sounddevice
.\.venv\Scripts\python.exe download_whisper_model.py                  # 默认 whisper-base，走 hf-mirror
```

Ollama 与模型不走 pip：

```powershell
ollama pull qwen2.5:1.5b-instruct
```

> **国内下载实测**：Ollama 官方 registry 直连约 285–328 KB/s，走 7890 代理只有 14 KB/s（慢 20 倍以上），
> 986MB 直连约 50 分钟。更快的是 ModelScope：同一个 Qwen2.5-1.5B q4_k_m GGUF 直连 **8.8 MB/s**，
> 1.04GB 约 2 分钟下完，写个 `FROM ./qwen2.5-1.5b-instruct-q4_k_m.gguf` 的 Modelfile，
> 再 `ollama create qwen2.5:1.5b-instruct -f Modelfile` 即可（模板/系统提示可从 registry 同 tag 的
> `application/vnd.ollama.image.template` / `...system` 层取）。

可用指令：

| 类别 | 说法示例 |
|---|---|
| 播放控制 | 暂停、继续播放、上一片段、下一片段、重播本段、从头重新播放、开始跟练、播放〈课程名〉 |
| 播放模式 | 自动播放 / 手动播放 / 切换播放模式 |
| 画面 | 显示骨架、隐藏骨架、显示阴影、隐藏阴影（「把骨架隐藏」这类语序也认） |
| 速度 | 快一点、慢一点、恢复原速 |
| 录制 | 开始录制、结束录制 |
| 状态 | 现在进度怎么样、第几段了、多少分 |
| 其他 | 收藏这个课程、安静一点（关播报）、可以说话了、你会什么 |

完整口令表（含同义说法、主动播报时机、排错步骤）见 [`docs/小教练口令合集.md`](docs/小教练口令合集.md)。

小教练的声音在「设置 → 小教练音色」里选：默认自动挑最自然的中文音（优先 Edge 的 Natural 在线音，
其次晓晓/晓伊/云希，再次婷婷/美佳/Google 中文，Huihui 这类机械音只在没有别的可选时才用），
另有语速三档。切换音色会立刻念一句试听。用 Chrome 时系统只暴露老式中文音，想听更自然的声音建议用 Edge 打开。
`/api/voice/status` 会返回 `disabled / paused / loading / listening / error` 之一；
没麦克风、没装依赖或 Ollama 没启动都不影响跟练：前端静默降级，意图解析自动回退规则 + 标题模糊匹配。

## 目录结构

```
dance-learning-assistant/
├── index.html
├── css/style.css
├── js/
│   ├── app.js        # 页面主逻辑（路由 / 课程 / 跟练 / 回放 / 个人中心）
│   ├── api.js        # 后端接口
│   ├── config.js     # API base 注入（同源 或 dev.py 代理）
│   ├── catalog.js    # 内置课程目录 + 前端虚拟切片
│   ├── pose.js       # 骨架绘制 + 轮廓映射 + IoU 用的掩码工具
│   ├── live.js       # 低延时 WebSocket 实时链路
│   └── replay.js     # 回放播放器
├── assets/media/     # 内置课程视频、封面、首屏配图（离线可用）
├── dev.py            # 前端开发服务器（自动刷新 + /api 代理）
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
│   │   ├── api/voice.py       # 语音状态 + 指令推送（/ws/voice）
│   │   └── services/
│   │       ├── pose_engine.py    # MediaPipe 封装（串行、单帧）
│   │       ├── teach_pose.py     # 教学视频离线骨架提取
│   │       ├── video_store.py    # 视频库
│   │       └── session_store.py  # 录制存储
│   └── data/                  # 运行时数据（git 忽略）
│       ├── videos/<id>/{source.mp4, meta.json, pose.json, masks.bin}
│       └── sessions/<id>/{frames/*.jpg, poses.json, masks.bin, meta.json}
├── DEVLOG.md / DEVLOG.txt      # 开发日志（技术栈 / Bug 复盘 / 优化 / 时间线）
```

> `masks.bin` 为人物分割掩码：每帧 `uint32(LE) 长度 + PNG 字节`，与 `pose.json` 帧一一对应。

## 内置课程与演示数据

`assets/media/` 里的内置课程（古风燃脂 10 个切片 + 6 个舞种）是随包的静态素材，
由 `js/catalog.js` 声明，**不经过后端**：前端直接播放，因此没有教学骨架与人物掩码，
骨架 / 轮廓对比 / 重合度只对「课程大厅 → 上传视频」进来的课程生效。

「练习回放」里的演示记录由 `js/app.js` 的 `buildDemoSessions()` 生成，默认关闭
（`SHOW_DEMO_SESSIONS = false`）：它们没有真实录制文件、分数是写死的，
打开后会带「演示」角标。真实录制来自跟练页的录制按钮，保存在 `backend/data/sessions/`。

首屏与关于页的配图是本地静态图（`assets/media/hero-*.jpg`），不依赖任何外链图床。

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
| `DANCEMATE_SEGMENT_SECONDS` | 7 | 切片间隔 |
| `DANCEMATE_TEACH_FPS` | 15 | 教学骨架采样帧率 |
| `DANCEMATE_RECORD_FPS` | 24 | 回放录制帧率（实际约 20fps，受机器负载与网络影响）|
| `DANCEMATE_POSE_COMPLEXITY` | 0 | 0=Lite，1=Full（更准但更慢） |
| `DANCEMATE_MAX_UPLOAD_MB` | 800 | 上传大小上限 |
| `DANCEMATE_DATA_DIR` | `backend/data` | 数据目录 |
| `DANCEMATE_VOICE` | 1 | 0 关闭语音助手 |
| `DANCEMATE_WAKE_WORD` | 小教练 | 唤醒词 |
| `DANCEMATE_WHISPER_MODEL` | whisper-base | 模型目录名，可换 whisper-small |
| `DANCEMATE_WHISPER_COMPUTE` | int8 | CTranslate2 计算类型 |
| `DANCEMATE_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `DANCEMATE_OLLAMA_MODEL` | qwen2.5:1.5b-instruct | 意图解析模型 |
| `DANCEMATE_PROXY` | 自动探测 `127.0.0.1:7890` | 模型下载代理（仅镜像/官方源都慢时使用）|
| `DANCEMATE_HF_ENDPOINT` | `https://hf-mirror.com` | HuggingFace 镜像 |
| `DANCEMATE_NO_PROXY` | — | 设为 1 只直连，不做代理回退 |

## 后续可优化

- [ ] 教学视频搜索接入外部平台（当前搜索的是本地视频库）
- [ ] 使用 GPU / TFLite delegate 进一步降低推理耗时
- [ ] 骨骼角度序列相似度评分（自动指出错误关节）
- [ ] 多机位与多人场景
