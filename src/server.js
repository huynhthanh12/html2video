const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { convertHtmlToVideo } = require('./converter');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (UI + outputs)
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Multer: lưu file upload vào /tmp với tên uuid
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.html'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file .zip hoặc .html'));
  }
});

// Job store đơn giản (in-memory)
const jobs = new Map();

// POST /convert — nhận file, tạo job, chạy bất đồng bộ
app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Chưa có file' });
  }

  const jobId = uuidv4();
  const fps = parseInt(req.body.fps) || 30;
  const duration = parseFloat(req.body.duration) || 10;
  const width = parseInt(req.body.width) || 1280;
  const height = parseInt(req.body.height) || 720;

  // Validate
  if (duration > 120) return res.status(400).json({ error: 'Tối đa 120 giây' });
  if (fps < 10 || fps > 60) return res.status(400).json({ error: 'FPS phải từ 10–60' });

  // Giới hạn resolution trên Render free (512MB RAM)
  const IS_LOW_MEMORY = process.env.LOW_MEMORY === 'true';
  if (IS_LOW_MEMORY && (width > 1280 || height > 720)) {
    return res.status(400).json({
      error: 'Môi trường free tier chỉ hỗ trợ tối đa 1280×720. Giảm resolution để tiếp tục.'
    });
  }

  // Chặn concurrent jobs trên free tier (tránh OOM)
  const runningJobs = [...jobs.values()].filter(j => j.status === 'processing');
  if (IS_LOW_MEMORY && runningJobs.length >= 1) {
    return res.status(429).json({ error: 'Đang có video đang render. Vui lòng đợi xong rồi thử lại.' });
  }

  jobs.set(jobId, { status: 'pending', progress: 0, createdAt: Date.now() });
  res.json({ jobId });

  // Chạy conversion bất đồng bộ
  setImmediate(async () => {
    try {
      jobs.set(jobId, { status: 'processing', progress: 0 });

      const outputDir = path.join(__dirname, '../public/outputs');
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${jobId}.mp4`);

      await convertHtmlToVideo({
        inputFile: req.file.path,
        outputPath,
        fps,
        duration,
        width,
        height,
        onProgress: (pct) => {
          jobs.set(jobId, { status: 'processing', progress: pct });
        }
      });

      jobs.set(jobId, {
        status: 'done',
        progress: 100,
        downloadUrl: `/outputs/${jobId}.mp4`
      });
    } catch (err) {
      console.error('[Job Error]', err.message);
      jobs.set(jobId, { status: 'error', error: err.message });
    } finally {
      // Dọn file upload
      fs.rm(req.file.path, { force: true }, () => {});
      // Dọn thư mục giải nén nếu có
      const extractDir = req.file.path + '_extracted';
      fs.rm(extractDir, { recursive: true, force: true }, () => {});
    }
  });
});

// GET /status/:jobId — kiểm tra tiến độ
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job không tồn tại' });
  res.json(job);
});

// Dọn job cũ mỗi 10 phút
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > TEN_MIN) jobs.delete(id);
  }
}, 60_000);

// Health check (Render dùng để kiểm tra app còn sống không)
app.get('/health', (req, res) => {
  const used = process.memoryUsage();
  res.json({
    status: 'ok',
    memory_mb: Math.round(used.rss / 1024 / 1024),
    uptime_s: Math.round(process.uptime())
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
