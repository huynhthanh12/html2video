const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');

/**
 * Chuyển file HTML/ZIP thành video MP4
 *
 * @param {object} opts
 * @param {string} opts.inputFile   - Đường dẫn đến file .html hoặc .zip
 * @param {string} opts.outputPath  - Nơi lưu file MP4
 * @param {number} opts.fps         - Frames per second (10–60)
 * @param {number} opts.duration    - Thời lượng video (giây)
 * @param {number} opts.width       - Chiều rộng viewport
 * @param {number} opts.height      - Chiều cao viewport
 * @param {function} opts.onProgress - Callback(percent: number)
 */
async function convertHtmlToVideo({
  inputFile,
  outputPath,
  fps = 30,
  duration = 10,
  width = 1280,
  height = 720,
  onProgress = () => {}
}) {
  const totalFrames = Math.ceil(fps * duration);
  const msPerFrame = 1000 / fps;

  // 1. Chuẩn bị HTML file URL
  const htmlPath = await prepareHtml(inputFile);
  const fileUrl = `file://${htmlPath}`;

  // 2. Khởi động Puppeteer (headless Chrome)
  // Các flag được tối ưu để tiết kiệm RAM tối đa trên Render free (512MB)
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',        // dùng /tmp thay vì /dev/shm (quan trọng trên Docker)
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      // --- Tối ưu RAM ---
      '--disable-extensions',           // tắt mọi extension
      '--disable-background-networking',// tắt network ngầm
      '--disable-sync',                 // tắt sync Chrome account
      '--disable-translate',
      '--disable-plugins',
      '--disable-default-apps',
      '--no-first-run',
      '--no-zygote',                    // tiết kiệm ~50MB (tắt zygote process)
      '--single-process',               // QUAN TRỌNG: gộp renderer vào 1 process, tiết kiệm ~80MB
                                        // Lưu ý: --single-process có thể crash trên HTML rất phức tạp
      `--js-flags=--max-old-space-size=200`, // giới hạn V8 heap của Chrome
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 3. Load trang, chờ animation sẵn sàng
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30_000 });
  await sleep(500); // buffer nhỏ để animation khởi tạo xong

  // 4. Inject fake timer để đồng bộ hóa thời gian
  // (tùy chọn nâng cao — mặc định dùng real-time capture)
  await page.evaluate(() => {
    // Giữ trang ở trạng thái đầu, không scroll
    document.body.style.overflow = 'hidden';
  });

  // 5. Tạo pipe stream từ frames vào FFmpeg
  const frameStream = new PassThrough();

  // 6. Khởi động FFmpeg trước, đọc từ pipe
  const ffmpegPromise = new Promise((resolve, reject) => {
    ffmpeg(frameStream)
      .inputFormat('image2pipe')
      .inputFPS(fps)
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',    // tương thích rộng (iOS, QuickTime...)
        '-preset fast',
        '-crf 23',             // quality: 18=cao, 28=thấp
        '-movflags +faststart' // cho phép stream trước khi tải xong
      ])
      .size(`${width}x${height}`)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // 7. Capture từng frame và pipe vào FFmpeg
  for (let i = 0; i < totalFrames; i++) {
    // Di chuyển thời gian animation
    const currentTimeMs = i * msPerFrame;
    await page.evaluate((ms) => {
      // Nếu HTML có hàm seekTo thì gọi, không thì bỏ qua
      if (typeof window.__seekTo === 'function') window.__seekTo(ms);
    }, currentTimeMs);

    // Chụp screenshot dạng PNG buffer
    const frameBuffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height }
    });

    frameStream.write(frameBuffer);

    // Cập nhật progress mỗi 5%
    const pct = Math.round((i / totalFrames) * 100);
    if (i % Math.max(1, Math.floor(totalFrames / 20)) === 0) {
      onProgress(pct);
    }
  }

  frameStream.end();
  await browser.close();
  await ffmpegPromise;

  onProgress(100);

  // Dọn file tạm
  cleanupExtracted(inputFile);
}

/**
 * Nếu input là ZIP → giải nén, trả về đường dẫn file HTML chính
 * Nếu là HTML → trả về thẳng
 */
async function prepareHtml(inputFile) {
  const ext = path.extname(inputFile).toLowerCase();

  if (ext === '.html') return path.resolve(inputFile);

  if (ext === '.zip') {
    const extractDir = inputFile + '_extracted';
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(inputFile);
    zip.extractAllTo(extractDir, true);

    // Tìm file HTML chính (ưu tiên index.html)
    const files = walkDir(extractDir);
    const htmlFiles = files.filter(f => f.endsWith('.html'));

    if (htmlFiles.length === 0) throw new Error('Không tìm thấy file .html trong ZIP');

    const main = htmlFiles.find(f => path.basename(f) === 'index.html') || htmlFiles[0];
    return path.resolve(main);
  }

  throw new Error('Định dạng không hỗ trợ. Dùng .html hoặc .zip');
}

function walkDir(dir) {
  const results = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function cleanupExtracted(inputFile) {
  const extractDir = inputFile + '_extracted';
  fs.rm(extractDir, { recursive: true, force: true }, () => {});
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { convertHtmlToVideo };
