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

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_DURATION_SECONDS = 40;
const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes
const TEMP_ROOT = path.join(os.tmpdir(), 'photo-audio-maker');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

// Stream uploads directly to disk to avoid memory spikes on large iPhone 4K MOVs
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
    fileSize: 250 * 1024 * 1024 // 250 MB max per file
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Probe uploaded video for duration and audio stream presence
function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

// Detect HEIC/HEIF by extension or ISO BMFF magic bytes
function isHeicFile(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.heic' || ext === '.heif') return true;
  if (buffer.length >= 12) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    return ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand);
  }
  return false;
}

// Convert photo (JPEG/PNG/HEIC) into an aspect-ratio-preserved HD frame
async function prepareImageFrame(inputPath, originalName, outputPath) {
  let imageBuffer = await fsp.readFile(inputPath);

  if (isHeicFile(imageBuffer, originalName)) {
    const converted = await heicConvert({
      buffer: imageBuffer,
      format: 'JPEG',
      quality: 0.95
    });
    imageBuffer = Buffer.from(converted);
  }

  // Auto-orient based on iPhone EXIF metadata
  const oriented = await sharp(imageBuffer)
    .rotate()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = oriented.info;

  // Choose standard even HD dimensions matching photo orientation
  let targetW = 1080;
  let targetH = 1920;
  if (width > height) {
    targetW = 1920;
    targetH = 1080;
  } else if (width === height) {
    targetW = 1080;
    targetH = 1080;
  }

  await sharp(oriented.data)
    .resize(targetW, targetH, {
      fit: 'contain',
      background: { r: 16, g: 16, b: 18, alpha: 1 }
    })
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

// Combine static photo frame + extracted audio into an iOS-compatible MP4
function renderVideo(framePath, videoPath, outputPath, durationSec) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(['-loop 1', '-framerate 30'])
      .input(videoPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        `-t ${durationSec.toFixed(3)}`,
        '-c:v libx264',
        '-preset veryfast',
        '-tune stillimage',
        '-profile:v main',
        '-level 4.0',
        '-pix_fmt yuv420p',
        '-r 30',
        '-c:a aac',
        '-b:a 192k',
        '-ar 48000',
        '-ac 2',
        '-movflags +faststart',
        '-shortest'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// Safe file cleanup helper
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
      // 1. Inspect source video
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

      // 2. Prepare photo frame (HEIC conversion + EXIF rotation + aspect-ratio fit)
      await prepareImageFrame(photoFile.path, photoFile.originalname, framePath);

      // 3. Generate H.264 / AAC MP4
      await renderVideo(framePath, videoFile.path, outputPath, finalDuration);

      // 4. Delete original user uploads immediately
      await Promise.all([
        safeUnlink(videoFile.path),
        safeUnlink(photoFile.path),
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

// Serve generated video with full HTTP Range support (required for iOS Safari playback)
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

// Handle Multer errors cleanly
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'That file is too large. Please choose a video under 250 MB.'
    });
  }
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Periodic cleanup of expired generated videos
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