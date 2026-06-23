# HTML → Video Converter

Chuyển file HTML animation thành video MP4 dùng Puppeteer + FFmpeg.

## Chạy local

```bash
# Yêu cầu: Node.js 18+, FFmpeg cài sẵn trên máy
npm install
npm run dev
# Mở http://localhost:3000
```

## Deploy lên Railway

1. Push code lên GitHub
2. Vào https://railway.app → New Project → Deploy from GitHub repo
3. Railway tự detect Dockerfile và build
4. Sau khi deploy xong → Settings → Generate Domain
5. Truy cập domain được cấp

## Deploy lên Render

1. Push code lên GitHub
2. Vào https://render.com → New → Web Service
3. Chọn repo → Runtime: Docker
4. Environment: để mặc định
5. Deploy

## Cấu trúc project

```
html2video/
├── src/
│   ├── server.js      # Express server + job queue
│   └── converter.js   # Puppeteer + FFmpeg logic
├── public/
│   ├── index.html     # Giao diện web
│   └── outputs/       # File MP4 xuất ra (tạm thời)
├── tmp/               # File upload tạm
├── Dockerfile
└── package.json
```

## Lưu ý khi deploy

- **RAM**: Mỗi job cần ~500MB–1GB RAM (Chrome + FFmpeg). Chọn plan có ít nhất 1GB.
- **CPU**: Render sẽ chậm trên free tier. Nên dùng paid plan hoặc Railway Hobby ($5/tháng).
- **Storage**: File MP4 lưu tạm trong container. Nếu cần lưu lâu dài, tích hợp thêm S3/Cloudflare R2.
- **Timeout**: Railway/Render free tier có thể timeout sau 30s. Video dài cần plan trả phí.

## Nâng cấp thêm (tùy chọn)

- Thêm S3 để lưu video lâu dài
- Thêm rate limiting (express-rate-limit)
- Thêm queue thực sự (BullMQ + Redis) để xử lý nhiều job song song
- Thêm xác thực người dùng nếu deploy public
