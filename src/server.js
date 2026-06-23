const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { convertHtmlToVideo } = require('./converter');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(__dirname, '../tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.html'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file .zip hoặc .html'));
  }
});

// Job store: lưu status + logs realtime
const jobs = new Map();
// SSE clients: jobId -> Set of res objects
const sseClients = new Map();

function pushLog(jobId, message, type = 'info') {
  const job = jobs.get(jobId);
  if (!job) return;
  const entry = { time: new Date().toLocaleTimeString('vi-VN'), message, type };
  job.logs = job.logs || [];
  job.logs.push(entry);
  // Gửi realtime đến tất cả SSE clients đang kết nối
  const clients = sseClients.get(jobId) || new Set();
  for (const client of clients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// GET /logs/:jobId — SSE endpoint để nhận log realtime
app.get('/logs/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);

  // Gửi lại toàn bộ log cũ cho client mới kết nối
  const job = jobs.get(jobId);
  if (job && job.logs) {
    for (const entry of job.logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }

  req.on('close', () => {
    sseClients.get(jobId)?.delete(res);
  });
});

app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chưa có file' });

  const jobId = uuidv4();
  const fps = parseInt(req.body.fps) || 30;
  const duration = parseFloat(req.body.duration) || 10;
  const width = parseInt(req.body.width) || 1280;
  const height = parseInt(req.body.height) || 720;

  if (duration > 120) return res.status(400).json({ error: 'Tối đa 120 giây' });
  if (fps < 10 || fps > 60) return res.status(400).json({ error: 'FPS phải từ 10–60' });

  const IS_LOW_MEMORY = process.env.LOW_MEMORY === 'true';
  if (IS_LOW_MEMORY && (width > 1280 || height > 720)) {
    return res.status(400).json({ error: 'Free tier chỉ hỗ trợ tối đa 1280×720.' });
  }

  const runningJobs = [...jobs.values()].filter(j => j.status === 'processing');
  if (IS_LOW_MEMORY && runningJobs.length >= 1) {
    return res.status(429).json({ error: 'Đang có video đang render. Vui lòng đợi xong rồi thử lại.' });
  }

  jobs.set(jobId, { status: 'pending', progress: 0, logs: [], createdAt: Date.now() });
  res.json({ jobId });

  setImmediate(async () => {
    try {
      jobs.get(jobId).status = 'processing';
      pushLog(jobId, `📁 Nhận file: ${req.file.originalname}`, 'info');
      pushLog(jobId, `⚙️ Cấu hình: ${width}×${height} · ${fps}fps · ${duration}s`, 'info');

      const outputDir = path.join(__dirname, '../public/outputs');
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${jobId}.mp4`);

      const totalFrames = Math.ceil(fps * duration);
      pushLog(jobId, `🌐 Khởi động trình duyệt Chrome...`, 'info');

      await convertHtmlToVideo({
        inputFile: req.file.path,
        outputPath,
        fps,
        duration,
        width,
        height,
        onProgress: (pct, frame) => {
          const job = jobs.get(jobId);
          if (job) { job.status = 'processing'; job.progress = pct; }
          if (frame !== undefined && frame % Math.max(1, Math.floor(totalFrames / 10)) === 0) {
            pushLog(jobId, `🎬 Chụp frame ${frame}/${totalFrames} (${pct}%)`, 'progress');
          }
        },
        onLog: (msg) => pushLog(jobId, msg, 'info')
      });

      pushLog(jobId, `✅ Render hoàn thành!`, 'success');
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: 'done',
        progress: 100,
        downloadUrl: `/outputs/${jobId}.mp4`
      });

      // Gửi event done
      const clients = sseClients.get(jobId) || new Set();
      for (const client of clients) {
        client.write(`data: ${JSON.stringify({ done: true, downloadUrl: `/outputs/${jobId}.mp4` })}\n\n`);
      }

    } catch (err) {
      console.error('[Job Error]', err.message);
      pushLog(jobId, `❌ Lỗi: ${err.message}`, 'error');
      jobs.get(jobId).status = 'error';
      jobs.get(jobId).error = err.message;
      const clients = sseClients.get(jobId) || new Set();
      for (const client of clients) {
        client.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
      fs.rm(req.file.path + '_extracted', { recursive: true, force: true }, () => {});
    }
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại' });
  res.json(job);
});

setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > TEN_MIN) {
      jobs.delete(id);
      sseClients.delete(id);
    }
  }
}, 60_000);

app.get('/health', (req, res) => {
  const used = process.memoryUsage();
  res.json({ status: 'ok', memory_mb: Math.round(used.rss / 1024 / 1024), uptime_s: Math.round(process.uptime()) });
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
