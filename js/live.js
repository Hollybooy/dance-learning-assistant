/**
 * 实时跟练链路：摄像头 → JPEG 帧 → WebSocket → 服务端骨架 → 回包。
 *
 * 低延时设计：
 *  - 端上只保留一帧在途：收到上一帧结果后才发下一帧，绝不堆积；
 *  - 采集分辨率 640x480、JPEG q=0.6，单帧约 30~50KB；
 *  - 骨架绘制留在前端，服务端只回 33 个关键点。
 */

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;
const JPEG_QUALITY = 0.6;
const ACK_TIMEOUT_MS = 600;
const RECONNECT_DELAY_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LivePoseStream {
  constructor({ video, onPose, onStatus, onRecordState }) {
    this.video = video;
    this.onPose = onPose;
    this.onStatus = onStatus;
    this.onRecordState = onRecordState;

    this.stream = null;
    this.ws = null;
    this.running = false;
    this.recording = false;
    this.sentAt = 0;
    this._ack = null;
    this._canvas = document.createElement('canvas');
    this._canvas.width = CAPTURE_WIDTH;
    this._canvas.height = CAPTURE_HEIGHT;
    this._ctx = this._canvas.getContext('2d', { alpha: false });
    this._loopRunning = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.onStatus?.('正在请求摄像头…');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
    } catch (error) {
      // 分辨率/帧率约束不被支持时，降级为"任意摄像头"再试一次
      if (error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError') {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (fallbackError) {
          this.running = false;
          this.onStatus?.('摄像头不可用');
          throw fallbackError;
        }
      } else {
        this.running = false;
        this.onStatus?.('摄像头不可用');
        throw error;
      }
    }

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this._connect();
    if (!this._loopRunning) {
      this._loopRunning = true;
      this._loop();
    }
  }

  stop() {
    this.running = false;
    this._closeSocket();
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
    this.onStatus?.('已停止');
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/practice`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.onStatus?.('实时骨架已连接');

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handle(message);
    };

    ws.onclose = () => {
      if (!this.running) return;
      this.onStatus?.('连接断开，重连中…');
      setTimeout(() => {
        if (this.running) this._connect();
      }, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      /* onclose 里统一处理重连 */
    };
  }

  _closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  _handle(message) {
    if (message.type === 'pose') {
      const rtt = this.sentAt ? performance.now() - this.sentAt : 0;
      this.onPose?.({
        pose: message.pose,
        serverMs: message.server_ms ?? 0,
        rtt,
        dropped: message.dropped ?? 0,
      });
      this._ack?.();
      this._ack = null;
    } else if (message.type === 'ready') {
      this.onStatus?.(`实时骨架已连接 · 录制 ${message.record_fps}fps`);
    } else if (message.type === 'record_started') {
      this.recording = true;
      this.onRecordState?.({ recording: true, sessionId: message.session_id, title: message.title });
    } else if (message.type === 'record_stopped') {
      this.recording = false;
      this.onRecordState?.({ recording: false, session: message.session });
    } else if (message.type === 'error') {
      this.onStatus?.(message.message);
    }
  }

  async _loop() {
    while (this._loopRunning) {
      if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await sleep(60);
        continue;
      }
      if (this.video.readyState < 2 || !this.video.videoWidth) {
        await sleep(60);
        continue;
      }

      const blob = await this._grab();
      if (!blob) {
        await sleep(20);
        continue;
      }

      const ack = new Promise((resolve) => {
        this._ack = resolve;
      });
      this.sentAt = performance.now();
      try {
        this.ws.send(blob);
      } catch {
        this._ack = null;
        await sleep(100);
        continue;
      }
      await Promise.race([ack, sleep(ACK_TIMEOUT_MS)]);
    }
  }

  _grab() {
    const video = this.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return Promise.resolve(null);

    // 等比居中裁剪，保证送入模型的画面不变形
    const scale = Math.max(CAPTURE_WIDTH / vw, CAPTURE_HEIGHT / vh);
    const sw = CAPTURE_WIDTH / scale;
    const sh = CAPTURE_HEIGHT / scale;
    this._ctx.drawImage(
      video,
      (vw - sw) / 2,
      (vh - sh) / 2,
      sw,
      sh,
      0,
      0,
      CAPTURE_WIDTH,
      CAPTURE_HEIGHT
    );

    return new Promise((resolve) => {
      this._canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
    });
  }

  sendRecordStart(meta) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onStatus?.('实时链路未连接，无法录制');
      return;
    }
    this.ws.send(JSON.stringify({ type: 'record_start', ...meta }));
  }

  sendRecordStop() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'record_stop' }));
  }
}
