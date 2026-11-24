/**
 * 实时跟练链路：摄像头 → JPEG 帧 → WebSocket → 服务端骨架 → 回包。
 *
 * 低延时设计：
 *  - 端上只保留少量帧在途：收到回包才释放名额，绝不堆积；
 *  - 采集长边压到 480、JPEG q=0.55（姿态模型输入只有 256x256，再大都是浪费编码时间）；
 *  - 抓帧保持摄像头原始比例、不做裁切：后端的归一化坐标直接对应整幅视频，
 *    前端用 fitRect 画骨架/阴影不会左右拉伸错位，也不会把人裁出画面；
 *  - 不做固定间隔节流，靠「在途名额 + 服务端丢帧回执」自然控流；
 *  - 骨架绘制留在前端（逐帧插值到 60fps），服务端只回 33 个关键点。
 */

import { wsUrl } from './config.js';

// 摄像头请求分辨率：只要够 480 长边重采样即可，过高只是徒增采集/编码耗时
const CAPTURE_IDEAL_WIDTH = 640;
const CAPTURE_IDEAL_HEIGHT = 480;
// 发送前把长边压到 480：姿态模型输入只有 256x256，再大都是浪费
const CAPTURE_LONG_SIDE = 480;
const JPEG_QUALITY = 0.55;
const ACK_TIMEOUT_MS = 600;
const RECONNECT_DELAY_MS = 800;
// 在途帧数：1 帧会被「编码 16ms + 往返 16ms」串行卡住（实测 17fps）；
// 2 帧能把吞吐顶到 21~23fps，多余的帧由服务端丢帧回执吸收（skip 不耗推理）。
const MAX_IN_FLIGHT = 2;
// 说明：不做固定间隔节流。抓帧本身要 15~20ms，再叠加间隔会把帧率压到 17fps 左右；
// 反而让在途名额（2 帧）+ 服务端丢帧回执来控流，实测骨架刷新能到 20~25fps。

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
    this._inFlight = 0;
    this._slotWaiters = [];
    // 每帧的发送时刻，按顺序记录：服务端一帧一回，回包时取最早的一条算真实 RTT
    this._sendTimes = [];
    this._lastSendAt = 0;
    this._latestMask = null; // 最近解码的人物掩码 ImageBitmap
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { alpha: false });
    this._loopRunning = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._resetSlots();
    this.onStatus?.('正在请求摄像头…');

    try {
      this.stream = await this._openWithFallback();
    } catch (error) {
      this.running = false;
      this.onStatus?.('摄像头不可用');
      throw error;
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
    this._resetSlots();
    this._closeSocket();
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
    this.onStatus?.('已停止');
  }

  /** 带兜底的摄像头打开：默认设备失败时，逐个尝试其余摄像头。 */
  async _openWithFallback() {
    try {
      return await this._openStream();
    } catch (error) {
      // 只有"设备本身打不开"类错误才值得换设备重试；权限拒绝直接抛出
      const retryable = ['NotReadableError', 'TrackStartError', 'AbortError', 'NotFoundError'];
      if (!retryable.includes(error?.name)) throw error;

      let devices = [];
      try {
        devices = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'videoinput'
        );
      } catch {
        /* 枚举失败则维持原错误 */
      }
      if (devices.length <= 1) throw error;

      let lastError = error;
      for (const device of devices) {
        this.onStatus?.(`正在尝试摄像头：${device.label || '未命名设备'}`);
        try {
          return await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: device.deviceId },
              width: { ideal: CAPTURE_IDEAL_WIDTH },
              height: { ideal: CAPTURE_IDEAL_HEIGHT },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: false,
          });
        } catch (deviceError) {
          lastError = deviceError;
        }
      }
      throw lastError;
    }
  }

  async _openStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CAPTURE_IDEAL_WIDTH },
          height: { ideal: CAPTURE_IDEAL_HEIGHT },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
    } catch (error) {
      // 分辨率/帧率约束不被支持时，降级为"任意摄像头"再试一次
      if (error?.name === 'OverconstrainedError') {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw error;
    }
  }

  _connect() {
    const ws = new WebSocket(wsUrl('/ws/practice'));
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

  /**
   * 回包到达：取对应那一帧的发送时刻算真实往返（含服务端推理）。
   * 服务端收到新帧发现上一帧还在推理时会立刻回 skip，所以 skip 可能先于
   * 上一帧的 pose 到达：pose 配最早的一帧，skip 配最新的一帧。
   */
  _takeRtt(forSkip = false) {
    if (!this._sendTimes.length) return 0;
    const sentAt = forSkip ? this._sendTimes.pop() : this._sendTimes.shift();
    return sentAt ? performance.now() - sentAt : 0;
  }

  _handle(message) {
    if (message.type === 'pose') {
      const rtt = this._takeRtt();
      // 掩码异步解码：骨架先走不阻塞显示，位图就位后下一帧起用于绘制阴影
      if (message.mask) {
        const binary = atob(message.mask);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          .then((bitmap) => {
            this._latestMask = bitmap;
          })
          .catch(() => {});
      } else {
        this._latestMask = null;
      }
      this.onPose?.({
        pose: message.pose,
        mask: this._latestMask ?? null,
        serverMs: message.server_ms ?? 0,
        stages: message.stages ?? null,
        rtt,
        dropped: message.dropped ?? 0,
      });
      this._releaseSlot();
    } else if (message.type === 'skip') {
      // 服务端丢帧（上一帧还在推理）也会回执，收到就释放名额，避免等 ACK 超时才复位
      this.skipped = (this.skipped || 0) + 1;
      this._takeRtt(true); // 这一帧没有结果，但仍要出队，保证后续 RTT 对齐
      this._releaseSlot();
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

  /** 占用一个在途名额；满员时等待回包释放 */
  _acquireSlot() {
    if (this._inFlight < MAX_IN_FLIGHT) {
      this._inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._slotWaiters.push(resolve);
    }).then(() => {
      this._inFlight += 1;
    });
  }

  _releaseSlot() {
    this._inFlight = Math.max(0, this._inFlight - 1);
    const waiters = this._slotWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  /** 长时间收不到回包（服务端卡住/网络抖动）时复位名额，避免链路停摆 */
  _resetSlots() {
    this._inFlight = 0;
    this._sendTimes.length = 0; // 丢弃失配的发送时刻，否则 RTT 会一直错位
    const waiters = this._slotWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
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
      if (this._inFlight > 0 && performance.now() - this._lastSendAt > ACK_TIMEOUT_MS + 400) {
        this._resetSlots();
      }

      await this._acquireSlot();
      if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._releaseSlot();
        await sleep(60);
        continue;
      }

      const blob = await this._grab();
      if (!blob) {
        this._releaseSlot();
        await sleep(20);
        continue;
      }

      this.sentAt = performance.now();
      this._lastSendAt = this.sentAt;
      try {
        this.ws.send(blob);
        this._sendTimes.push(this.sentAt);
      } catch {
        this._releaseSlot();
        await sleep(100);
        continue;
      }
    }
  }

  _grab() {
    const video = this.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return Promise.resolve(null);

    // 保持整幅画面（不裁切）：长边压到 480，短边按摄像头比例算。
    // 这样归一化坐标 == 视频坐标，前端 fitRect 映射时骨架不会横向拉伸。
    const scale = Math.min(1, CAPTURE_LONG_SIDE / Math.max(vw, vh));
    const cw = Math.max(2, Math.round(vw * scale));
    const ch = Math.max(2, Math.round(vh * scale));
    if (this._canvas.width !== cw || this._canvas.height !== ch) {
      this._canvas.width = cw;
      this._canvas.height = ch;
    }

    this._ctx.drawImage(video, 0, 0, cw, ch);

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
