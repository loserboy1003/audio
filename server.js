const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

// Keep sharp's internal memory cache minimal for 512 MB containers
sharp.cache(false);
sharp.concurrency(1);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_DURATION_SECONDS = 40;
const JOB_TTL_MS = 15 * 60 * 1000;
const TEMP_ROOT = path.join(os.tmpdir(), 'photo-audio-maker');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.jobId) {
      req.jobId = crypto.randomUUID();
      req.jobDir = path.join(TEMP_ROOT, req.jobId);
      fs.mkdirSync(req.jobDir, { recursive: true });
    }
    cb(null, req.jobDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, `${file.fieldname}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 150 * 1024 * 1024 // 150 MB max per file
  }
});

app.use(express.static(path.join(__dirname, 'public')));

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

function isHeicFile(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.heic' || ext === '.heif') return true;
  if (buffer.length >= 12) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    return ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand);
  }
  return false;
}

async function prepareImageFrame(inputPath, originalName, outputPath) {
  let imageBuffer = await fsp.readFile(inputPath);

  if (isHeicFile(imageBuffer, originalName)) {
    const converted = await heicConvert({
      buffer: imageBuffer,
      format: 'JPEG',
      quality: 0.9
    });
    imageBuffer = Buffer.from(converted);
  }

  // Auto-orient based on iPhone EXIF metadata
  const oriented = await sharp(imageBuffer)
    .rotate()
    .toBuffer({ resolveWithObject: true });

  imageBuffer = null; // Free raw buffer immediately

  const { width, height } = oriented.info;

  // 720p HD dimensions keep FFmpeg RAM usage well under 120 MB on 512 MB instances
  let targetW = 720;
  let targetH = 1280;
  if (width > height) {
    targetW = 1280;
    targetH = 720;
  } else if (width === height) {
    targetW = 720;
    targetH = 720;
  }

  await sharp(oriented.data)
    .resize(targetW, targetH, {
      fit: 'contain',
      background: { r: 16, g: 16, b: 18, alpha: 1 }
    })
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

function renderVideo(framePath, videoPath, outputPath, durationSec) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(['-loop 1', '-framerate 24'])
      .input(videoPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        `-t ${durationSec.toFixed(3)}`,
        '-threads 1',
        '-c:v libx264',
        '-preset ultrafast',
        '-tune stillimage',
        '-profile:v main',
        '-level 4.0',
        '-pix_fmt yuv420p',
        '-r 24',
        '-c:a aac',
        '-b:a 160k',
        '-ar 44100',
        '-ac 2',
        '-movflags +faststart',
        '-shortest'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore if already removed
  }
}

app.post(
  '/api/create-video',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'photo', maxCount: 1 }
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const photoFile = req.files?.photo?.[0];
    const jobDir = req.jobDir;
    const jobId = req.jobId;

    if (!videoFile || !photoFile) {
      if (jobDir) await fsp.rm(jobDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Please select both a video and a photo.' });
    }

    const framePath = path.join(jobDir, 'frame.jpg');
    const outputPath = path.join(jobDir, 'output.mp4');

    try {
      const metadata = await probeMedia(videoFile.path);
      const audioStream = (metadata.streams || []).find((s) => s.codec_type === 'audio');

      if (!audioStream) {
        await fsp.rm(jobDir, { recursive: true, force: true });
        return res.status(400).json({
          error: 'The selected video has no sound. Please choose a video with audio.'
        });
      }

      const rawDuration = Number(audioStream.duration) || Number(metadata.format?.duration);
      if (!rawDuration || Number.isNaN(rawDuration) || rawDuration <= 0.1) {
        await fsp.rm(jobDir, { recursive: true, force: true });
        return res.status(400).json({
          error: 'Could not read the length of this video. Please try another file.'
        });
      }

      const finalDuration = Math.min(rawDuration, MAX_DURATION_SECONDS);
      const wasTrimmed = rawDuration > MAX_DURATION_SECONDS;

      await prepareImageFrame(photoFile.path, photoFile.originalname, framePath);
      await safeUnlink(photoFile.path); // Free disk/tmpfs space before FFmpeg runs

      await renderVideo(framePath, videoFile.path, outputPath, finalDuration);

      await Promise.all([
        safeUnlink(videoFile.path),
        safeUnlink(framePath)
      ]);

      return res.json({
        jobId,
        videoUrl: `/api/video/${jobId}`,
        duration: Math.round(finalDuration),
        wasTrimmed
      });
    } catch (err) {
      console.error('Video processing error:', err);
      if (jobDir) await fsp.rm(jobDir, { recursive: true, force: true });
      return res.status(500).json({
        error: 'We could not process those files. Please check the formats and try again.'
      });
    }
  }
);

app.get('/api/video/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: 'Invalid video ID.' });
  }

  const outputPath = path.join(TEMP_ROOT, jobId, 'output.mp4');
  try {
    await fsp.access(outputPath);
  } catch {
    return res.status(404).json({ error: 'This video has expired. Please create it again.' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="photo-audio-video.mp4"');
  }
  return res.sendFile(outputPath);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'That file is too large. Please choose a video under 150 MB.'
    });
  }
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

setInterval(async () => {
  try {
    const entries = await fsp.readdir(TEMP_ROOT);
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        const dirPath = path.join(TEMP_ROOT, entry);
        const stat = await fsp.stat(dirPath);
        if (now - stat.mtimeMs > JOB_TTL_MS) {
          await fsp.rm(dirPath, { recursive: true, force: true });
        }
      })
    );
  } catch {
    // Ignore transient cleanup errors
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Photo + Audio Maker running at http://localhost:${PORT}`);
});
