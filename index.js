const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const activeStreams = new Map();

const UPLOAD_DIR = '/app/uploads';
const THUMB_DIR = '/app/thumbs';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, req.session.userId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4','.mov','.avi','.mkv','.webm','.gif','.jpg','.jpeg','.png','.webp','.mp3','.wav','.aac','.ogg','.flac','.m4a'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ==================== DB SETUP ====================

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    username TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    stream_slots INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS streams (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'My Stream',
    stream_key TEXT,
    file_path TEXT,
    file_name TEXT,
    thumb_path TEXT,
    video_volume INTEGER NOT NULL DEFAULT 100,
    video_muted BOOLEAN NOT NULL DEFAULT false,
    audio_tracks JSONB NOT NULL DEFAULT '[]',
    audio_volume INTEGER NOT NULL DEFAULT 100,
    audio_muted BOOLEAN NOT NULL DEFAULT false,
    resolution TEXT NOT NULL DEFAULT '1080p',
    status TEXT NOT NULL DEFAULT 'stopped',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).catch(console.error);

pool.query(`
  ALTER TABLE streams ADD COLUMN IF NOT EXISTS thumb_path TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
`).catch(console.error);

const PLANS = {
  starter: { name: 'Starter', price: 2,  slots: 1, priceId: process.env.STRIPE_PRICE_STARTER || '', maxResolution: '720p', imageOnly: true },
  pro:     { name: 'Pro',     price: 5,  slots: 1, priceId: process.env.STRIPE_PRICE_PRO || '',     maxResolution: '1080p', imageOnly: false },
  creator: { name: 'Creator', price: 12, slots: 3, priceId: process.env.STRIPE_PRICE_CREATOR || '', maxResolution: '1080p', imageOnly: false },
  studio:  { name: 'Studio',  price: 20, slots: 6, priceId: process.env.STRIPE_PRICE_STUDIO || '', maxResolution: '1080p', imageOnly: false },
  demo:    { name: 'Demo',    price: 0,  slots: 6, priceId: '', maxResolution: '1080p', imageOnly: false },
};

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}
function requireAuthApi(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/thumbs/:file', (req, res) => {
  const p = path.join(THUMB_DIR, path.basename(req.params.file));
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

async function generateThumb(filePath, streamId) {
  const thumbFile = 'thumb_' + streamId + '_' + Date.now() + '.jpg';
  const thumbPath = path.join(THUMB_DIR, thumbFile);
  return new Promise((resolve) => {
    const args = ['-i', filePath, '-ss', '0', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black', '-vframes', '1', '-y', thumbPath];
    const proc = spawn('ffmpeg', args);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(thumbPath)) resolve('/thumbs/' + thumbFile);
      else resolve(null);
    });
  });
}

// ==================== FFMPEG ====================

function buildFFmpegArgs(stream) {
  const width  = stream.resolution === '1080p' ? 1920 : 1280;
  const height = stream.resolution === '1080p' ? 1080 : 720;
  const bitrate = stream.resolution === '1080p' ? '4000k' : '2500k';
  const bufsize = stream.resolution === '1080p' ? '8000k' : '5000k';
  const ext = path.extname(stream.file_path || '').toLowerCase();
  const isImage = ['.jpg','.jpeg','.png','.webp'].includes(ext);
  const isGif   = ext === '.gif';
  const tracks  = Array.isArray(stream.audio_tracks)
    ? stream.audio_tracks.filter(t => t.path && fs.existsSync(t.path))
    : [];
  const hasAudioTracks = tracks.length > 0;
  const videoVol = stream.video_muted ? 0 : (stream.video_volume || 100) / 100;
  const audioVol = stream.audio_muted ? 0 : (stream.audio_volume || 100) / 100;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`;
  const rtmp = `rtmp://a.rtmp.youtube.com/live2/${stream.stream_key}`;
  const args = [];

  // ── Video / Image input ──────────────────────────────────────────────────
  if (isImage) {
    args.push('-thread_queue_size', '512', '-re', '-loop', '1', '-framerate', '30', '-i', stream.file_path);
  } else if (isGif) {
    args.push('-thread_queue_size', '512', '-re', '-ignore_loop', '0', '-stream_loop', '-1', '-i', stream.file_path);
  } else {
    args.push('-thread_queue_size', '512', '-re', '-stream_loop', '-1', '-i', stream.file_path);
  }

  // ── Audio track inputs ───────────────────────────────────────────────────
  for (const t of tracks) {
    args.push('-thread_queue_size', '512', '-stream_loop', '-1', '-i', t.path);
  }

  // ── Video encoding ───────────────────────────────────────────────────────
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-level', '4.2',
    '-threads', '0',
    '-r', '30',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', bufsize,
    '-pix_fmt', 'yuv420p',
    '-vf', vf,
    '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-max_muxing_queue_size', '1024'
  );

  // ── Audio mixing ─────────────────────────────────────────────────────────
  const videoHasAudio = !['.jpg','.jpeg','.png','.webp','.gif'].includes(ext) && !stream.video_muted;

  if (hasAudioTracks && videoHasAudio) {
    let fc = '';
    const trackCount = tracks.length;
    for (let i = 0; i < trackCount; i++) {
      fc += `[${i+1}:a]volume=${audioVol}[at${i}];`;
    }
    const concatIns = tracks.map((_,i) => `[at${i}]`).join('');
    fc += `${concatIns}concat=n=${trackCount}:v=0:a=1[aconcat];`;
    fc += `[aconcat]aloop=loop=-1:size=2147483647[aloop];`;
    fc += `[0:a]aloop=loop=-1:size=2147483647,volume=${videoVol}[va];`;
    fc += `[va][aloop]amix=inputs=2:duration=longest:dropout_transition=0[aout]`;
    args.push('-filter_complex', fc, '-map', '0:v', '-map', '[aout]');
  } else if (hasAudioTracks && !videoHasAudio) {
    let fc = '';
    const trackCount = tracks.length;
    for (let i = 0; i < trackCount; i++) {
      fc += `[${i+1}:a]volume=${audioVol}[at${i}];`;
    }
    const concatIns = tracks.map((_,i) => `[at${i}]`).join('');
    fc += `${concatIns}concat=n=${trackCount}:v=0:a=1[aconcat];`;
    fc += `[aconcat]aloop=loop=-1:size=2147483647[aout]`;
    args.push('-filter_complex', fc, '-map', '0:v', '-map', '[aout]');
  } else if (!hasAudioTracks && videoHasAudio) {
    args.push('-map', '0:v', '-map', '0:a', '-af', `volume=${videoVol},aresample=async=1000`);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-map', '0:v', '-map', isImage||isGif ? '1:a' : '0:a');
  }

  // ── Output / RTMP ────────────────────────────────────────────────────────
  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    '-rtmp_buffer', '0',
    '-rtmp_live', 'live',
    rtmp
  );

  return args;
}

function startFFmpeg(streamId, streamData) {
  if (!streamData.file_path || !fs.existsSync(streamData.file_path)) return;
  if (!streamData.stream_key) return;

  function spawnNew() {
    const args = buildFFmpegArgs(streamData);
    const proc = spawn('ffmpeg', args);
    const entry = { proc, restarting: false, streamData: { ...streamData } };
    activeStreams.set(streamId, entry);
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const current = activeStreams.get(streamId);
      if (current && !current.restarting) {
        setTimeout(() => {
          const cur = activeStreams.get(streamId);
          if (cur && !cur.restarting) startFFmpeg(streamId, cur.streamData);
        }, 3000);
      }
    });
  }

  const existing = activeStreams.get(streamId);
  if (existing) {
    existing.restarting = true;
    existing.proc.once('close', () => {
      setTimeout(spawnNew, 1500);
    });
    try { existing.proc.kill('SIGKILL'); } catch(e) {}
  } else {
    spawnNew();
  }
}

// ==================== SHARED NAV HELPERS ====================

const NAV_CSS = `
nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(10,10,10,0.97);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,0.08);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;}
.nav-logo{font-size:20px;font-weight:800;letter-spacing:-0.5px;text-decoration:none;color:#fff;}
.nav-logo .g{color:#aaff00;}
.nav-links{display:flex;align-items:center;gap:8px;}
.nav-links a{font-size:13px;font-weight:700;letter-spacing:0.05em;color:#aaa;background:#1a1a1a;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:7px 14px;transition:all 0.15s;text-transform:uppercase;text-decoration:none;}
.nav-links a:hover{color:#aaff00;border-color:rgba(170,255,0,0.3);}
.nav-auth{display:flex;align-items:center;gap:10px;}
.nav-login{font-size:14px;color:#888;transition:color 0.15s;text-decoration:none;}
.nav-login:hover{color:#fff;}
.nav-btn{background:#aaff00;color:#000;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:700;transition:opacity 0.15s;text-decoration:none;}
.nav-btn:hover{opacity:0.85;color:#000;}
.nav-streams-btn{background:rgba(170,255,0,0.1);color:#aaff00;border:1px solid rgba(170,255,0,0.25);padding:7px 16px;border-radius:8px;font-size:13px;font-weight:700;transition:all 0.15s;text-decoration:none;}
.nav-streams-btn:hover{background:rgba(170,255,0,0.2);border-color:rgba(170,255,0,0.5);}
.nav-user{font-size:14px;color:#ccc;font-weight:600;}
.nav-logout{font-size:13px;color:#555;transition:color 0.15s;text-decoration:none;}
.nav-logout:hover{color:#f87171;}
@media(max-width:600px){.nav-links{display:none;}}
`;

// ==================== LANDING ====================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>StreamForCheap — 24/7 YouTube Streaming from $2/month</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a0a;--surface:#111;--surface2:#1a1a1a;--border:rgba(255,255,255,0.08);--text:#fff;--muted:#888;--accent:#aaff00;--accent-dim:rgba(170,255,0,0.1);--accent-dim2:rgba(170,255,0,0.05);}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden;}
a{text-decoration:none;color:inherit;}
${NAV_CSS}
.hero{padding:140px 2rem 100px;text-align:center;max-width:900px;margin:0 auto;}
.hero-badge{display:inline-flex;align-items:center;gap:8px;background:var(--accent-dim);border:1px solid rgba(170,255,0,0.2);border-radius:99px;padding:6px 16px;font-size:13px;color:var(--accent);font-weight:600;margin-bottom:2rem;}
.hero h1{font-size:clamp(36px,6vw,72px);font-weight:900;line-height:1.05;letter-spacing:-2px;margin-bottom:1.5rem;}
.hero h1 span{color:var(--accent);}
.hero p{font-size:18px;color:var(--muted);line-height:1.7;max-width:600px;margin:0 auto 2.5rem;}
.hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.btn-primary{background:var(--accent);color:#000;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:800;transition:opacity 0.15s;cursor:pointer;border:none;}
.btn-primary:hover{opacity:0.85;}
.btn-secondary{background:var(--surface2);color:var(--text);padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;border:1px solid var(--border);transition:border-color 0.15s;cursor:pointer;}
.btn-secondary:hover{border-color:var(--accent);}
.hero-note{font-size:13px;color:var(--muted);margin-top:1rem;}
.stats{display:flex;justify-content:center;gap:3rem;padding:3rem 2rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border);flex-wrap:wrap;}
.stat{text-align:center;}
.stat-num{font-size:36px;font-weight:900;color:var(--accent);letter-spacing:-1px;}
.stat-label{font-size:13px;color:var(--muted);margin-top:4px;}
section{padding:80px 2rem;max-width:1100px;margin:0 auto;}
.section-label{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:12px;}
.section-title{font-size:clamp(28px,4vw,44px);font-weight:800;letter-spacing:-1px;margin-bottom:16px;}
.section-sub{font-size:16px;color:var(--muted);line-height:1.7;max-width:560px;}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px;margin-top:3rem;}
.step{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem;}
.step-num{width:40px;height:40px;border-radius:10px;background:var(--accent-dim);border:1px solid rgba(170,255,0,0.2);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:var(--accent);margin-bottom:1rem;}
.step h3{font-size:16px;font-weight:700;margin-bottom:8px;}
.step p{font-size:14px;color:var(--muted);line-height:1.6;}
.comparison{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-top:3rem;}
.comparison-header{display:grid;grid-template-columns:2fr 1fr 1fr;padding:1rem 1.5rem;background:var(--surface2);border-bottom:1px solid var(--border);font-size:14px;font-weight:700;}
.comparison-header .ours{color:var(--accent);}
.comparison-row{display:grid;grid-template-columns:2fr 1fr 1fr;padding:1rem 1.5rem;border-bottom:1px solid var(--border);font-size:14px;align-items:center;}
.comparison-row:last-child{border-bottom:none;}
.comparison-row .feature{color:var(--muted);}
.comparison-row .ours{color:var(--accent);font-weight:700;}
.comparison-row .theirs{color:#555;}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;margin-top:3rem;}
.pricing-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:2rem;position:relative;transition:border-color 0.15s;}
.pricing-card:hover{border-color:rgba(170,255,0,0.3);}
.pricing-card.featured{border-color:var(--accent);background:var(--accent-dim2);}
.pricing-badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#000;font-size:11px;font-weight:800;padding:4px 14px;border-radius:99px;white-space:nowrap;}
.plan-name{font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;}
.plan-price{font-size:48px;font-weight:900;letter-spacing:-2px;color:var(--text);margin-bottom:4px;}
.plan-price span{font-size:18px;font-weight:400;color:var(--muted);}
.plan-streams{font-size:14px;color:var(--muted);margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border);}
.plan-streams strong{color:var(--accent);}
.plan-features{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:1.5rem;}
.plan-features li{font-size:14px;color:#aaa;display:flex;align-items:center;gap:8px;}
.plan-features li::before{content:'✓';color:var(--accent);font-weight:700;flex-shrink:0;}
.plan-btn{width:100%;padding:12px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;border:none;transition:opacity 0.15s;text-align:center;display:block;}
.plan-btn-primary{background:var(--accent);color:#000;}
.plan-btn-primary:hover{opacity:0.85;}
.plan-btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border);}
.plan-btn-secondary:hover{border-color:var(--accent);}
.faq{margin-top:3rem;display:flex;flex-direction:column;gap:12px;}
.faq-item{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.faq-q{padding:1.25rem 1.5rem;font-size:15px;font-weight:600;cursor:pointer;display:flex;justify-content:space-between;align-items:center;}
.faq-q:hover{color:var(--accent);}
.faq-arrow{color:var(--muted);transition:transform 0.2s;font-size:12px;}
.faq-item.open .faq-arrow{transform:rotate(180deg);}
.faq-a{padding:0 1.5rem;max-height:0;overflow:hidden;transition:max-height 0.3s,padding 0.3s;font-size:14px;color:var(--muted);line-height:1.7;}
.faq-item.open .faq-a{max-height:200px;padding:0 1.5rem 1.25rem;}
footer{border-top:1px solid var(--border);padding:3rem 2rem;text-align:center;}
.footer-logo{font-size:20px;font-weight:800;margin-bottom:1rem;}
.footer-logo .g{color:var(--accent);}
.footer-links{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap;margin-bottom:1.5rem;}
.footer-links a{font-size:13px;color:var(--muted);transition:color 0.15s;}
.footer-links a:hover{color:var(--text);}
.footer-copy{font-size:12px;color:#444;}
</style>
</head>
<body>
<nav>
  <a href="/" class="nav-logo">stream<span class="g">forcheap</span></a>
  <div class="nav-links">
    <a href="#how">HOW IT WORKS</a>
    <a href="#pricing">PRICING</a>
    <a href="#faq">FAQ</a>
  </div>
  <div class="nav-auth" id="nav-auth">
    <a href="/login" class="nav-login">Log in</a>
    <a href="/register" class="nav-btn">Get started</a>
  </div>
</nav>
<div class="hero">
  <div class="hero-badge">🟢 Streams running 24/7</div>
  <h1>24/7 YouTube Streaming<br>from <span>$2/month</span></h1>
  <p>Upload your video, enter your stream key, and we stream it to YouTube forever. No PC needed. No technical knowledge required.</p>
  <div class="hero-btns">
    <button class="btn-primary" onclick="document.getElementById('pricing').scrollIntoView({behavior:'smooth'})">Start streaming — from $2/mo</button>
    <button class="btn-secondary" onclick="document.getElementById('how').scrollIntoView({behavior:'smooth'})">See how it works</button>
  </div>
  <div class="hero-note">Cancel anytime · No hidden fees</div>
</div>
<div class="stats">
  <div class="stat"><div class="stat-num">$2</div><div class="stat-label">starting per month</div></div>
  <div class="stat"><div class="stat-num">24/7</div><div class="stat-label">always streaming</div></div>
  <div class="stat"><div class="stat-num">1080p</div><div class="stat-label">full HD quality</div></div>
  <div class="stat"><div class="stat-num">10x</div><div class="stat-label">cheaper than competitors</div></div>
</div>
<section id="how">
  <div class="section-label">How it works</div>
  <div class="section-title">Up and running in 3 minutes</div>
  <p class="section-sub">No technical knowledge needed. If you can upload a file, you can set up a 24/7 stream.</p>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><h3>Create your account</h3><p>Sign up and choose your plan. Cancel anytime.</p></div>
    <div class="step"><div class="step-num">2</div><h3>Upload your content</h3><p>Upload any image, GIF, or video file. Add separate audio tracks too.</p></div>
    <div class="step"><div class="step-num">3</div><h3>Add your stream key</h3><p>Paste your YouTube stream key from YouTube Studio → Go Live → Stream.</p></div>
    <div class="step"><div class="step-num">4</div><h3>Hit start</h3><p>Your stream goes live instantly and runs 24/7. Turn off your PC — we handle everything.</p></div>
  </div>
</section>
<section>
  <div class="section-label">Comparison</div>
  <div class="section-title">Why pay more?</div>
  <p class="section-sub">We do exactly what the expensive tools do, for a fraction of the price.</p>
  <div class="comparison">
    <div class="comparison-header"><div>Feature</div><div class="ours">StreamForCheap</div><div>Competitors</div></div>
    <div class="comparison-row"><div class="feature">Price per stream</div><div class="ours">from $2/month</div><div class="theirs">$24–49/month</div></div>
    <div class="comparison-row"><div class="feature">24/7 streaming</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">1080p quality</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Image, GIF &amp; video support</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Auto-restart on crash</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Separate audio tracks</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗ extra cost</div></div>
    <div class="comparison-row"><div class="feature">Real-time volume control</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗</div></div>
    <div class="comparison-row"><div class="feature">No watermark</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗ paid plans only</div></div>
  </div>
</section>
<section id="pricing">
  <div class="section-label">Pricing</div>
  <div class="section-title">Simple, honest pricing</div>
  <p class="section-sub">No hidden fees. No per-platform charges. No watermarks. Cancel anytime.</p>
  <div class="pricing-grid">
    <div class="pricing-card">
      <div class="plan-name">Starter</div>
      <div class="plan-price">$2<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — static image only</div>
      <ul class="plan-features"><li>720p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('starter')">Get started</button>
    </div>
    <div class="pricing-card featured">
      <div class="pricing-badge">MOST POPULAR</div>
      <div class="plan-name">Pro</div>
      <div class="plan-price">$5<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-primary" onclick="choosePlan('pro')">Get started</button>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Creator</div>
      <div class="plan-price">$12<span>/mo</span></div>
      <div class="plan-streams"><strong>3 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('creator')">Get started</button>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Studio</div>
      <div class="plan-price">$20<span>/mo</span></div>
      <div class="plan-streams"><strong>6 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('studio')">Get started</button>
    </div>
  </div>
</section>
<section id="faq">
  <div class="section-label">FAQ</div>
  <div class="section-title">Got questions?</div>
  <div class="faq">
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Do I need to keep my computer on? <span class="faq-arrow">▼</span></div><div class="faq-a">No. Once you start your stream it runs on our servers 24/7. You can turn off your PC completely.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">What file types are supported? <span class="faq-arrow">▼</span></div><div class="faq-a">Images (JPG, PNG, WebP), GIFs, videos (MP4, MOV, AVI, MKV, WebM), and audio (MP3, WAV, AAC, OGG, FLAC).</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Where do I find my YouTube stream key? <span class="faq-arrow">▼</span></div><div class="faq-a">Go to YouTube Studio → Go Live → Stream. Keep it private — anyone with it can stream to your channel.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">What happens if the stream crashes? <span class="faq-arrow">▼</span></div><div class="faq-a">Our system automatically detects crashes and restarts your stream within seconds.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Can I use separate audio tracks? <span class="faq-arrow">▼</span></div><div class="faq-a">Yes. Upload multiple audio files and they play one after another in a loop. Control video and audio volume independently.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Can I cancel anytime? <span class="faq-arrow">▼</span></div><div class="faq-a">Yes. Cancel anytime from your dashboard. No contracts, no cancellation fees. Your streams stop at the end of the billing period.</div></div>
  </div>
</section>
<footer>
  <div class="footer-logo">stream<span class="g">forcheap</span></div>
  <div class="footer-links"><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a><a href="/login">Login</a><a href="/register">Sign up</a></div>
  <div class="footer-copy">© 2026 StreamForCheap. The cheapest 24/7 streaming service on the internet.</div>
</footer>
<script>
fetch('/api/me').then(r=>r.json()).then(data=>{
  if(data.userId){
    const name = data.username || data.email || 'Account';
    document.getElementById('nav-auth').innerHTML=
      '<span class="nav-user">👤 '+name+'</span>'+
      '<a href="/dashboard" class="nav-streams-btn">📡 My Streams</a>'+
      '<a href="/logout" class="nav-logout">Log out</a>';
  }
});
function choosePlan(plan) {
  fetch('/api/me').then(r => r.json()).then(data => {
    if (data.userId) {
      window.location.href = '/checkout?plan=' + plan;
    } else {
      window.location.href = '/register?plan=' + plan;
    }
  }).catch(() => {
    window.location.href = '/register?plan=' + plan;
  });
}
</script>
</body>
</html>`);
});

// ==================== AUTH ====================

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ userId: null });
  pool.query('SELECT id, username, email FROM users WHERE id=$1', [req.session.userId])
    .then(r => {
      if (!r.rows[0]) return res.json({ userId: null });
      const u = r.rows[0];
      res.json({ userId: u.id, username: u.username || u.email.split('@')[0], email: u.email });
    })
    .catch(() => res.json({ userId: null }));
});

app.get('/register', (req, res) => {
  const plan = req.query.plan || 'pro';
  if (req.session.userId) return res.redirect('/checkout?plan=' + plan);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sign Up — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;}
.card{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:440px;width:100%;}
.logo{font-size:20px;font-weight:800;margin-bottom:2rem;text-align:center;}.logo .g{color:#aaff00;}
h1{font-size:24px;font-weight:800;margin-bottom:8px;}.sub{color:#666;font-size:14px;margin-bottom:2rem;}
.plan-banner{background:rgba(170,255,0,0.08);border:1px solid rgba(170,255,0,0.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;}
.plan-banner .pname{font-size:15px;font-weight:700;color:#aaff00;}
.plan-banner .pprice{font-size:13px;color:#888;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
.btn{width:100%;padding:13px;background:#aaff00;color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:8px;}
.btn:hover{opacity:0.85;}.btn:disabled{opacity:0.5;cursor:not-allowed;}
.link{text-align:center;font-size:13px;color:#666;margin-top:1.5rem;}.link a{color:#aaff00;}
.error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><a href="/" style="text-decoration:none;color:inherit;">stream<span class="g">forcheap</span></a></div>
  <h1>Create account</h1>
  <p class="sub">You're signing up for the ${plan.charAt(0).toUpperCase()+plan.slice(1)} plan</p>
  <div class="plan-banner">
    <span class="pname">${plan.charAt(0).toUpperCase()+plan.slice(1)} Plan</span>
    <span class="pprice">$${PLANS[plan]?.price || 5}/month · cancel anytime</span>
  </div>
  <div class="error" id="error"></div>
  <div class="field"><label>Your name</label><input type="text" id="username" placeholder="e.g. Alex"/></div>
  <div class="field"><label>Email address</label><input type="email" id="email" placeholder="you@example.com"/></div>
  <div class="field"><label>Password</label><input type="password" id="password" placeholder="Min 8 characters"/></div>
  <div class="field"><label>Confirm password</label><input type="password" id="password2" placeholder="Repeat password"/></div>
  <button class="btn" id="btn" onclick="register()">Continue to payment →</button>
  <div class="link">Already have an account? <a href="/login?plan=${plan}">Log in</a></div>
</div>
<script>
async function register(){
  const username=document.getElementById('username').value.trim();
  const email=document.getElementById('email').value.trim();
  const pw=document.getElementById('password').value;
  const pw2=document.getElementById('password2').value;
  const err=document.getElementById('error');const btn=document.getElementById('btn');
  err.style.display='none';
  if(!username){err.textContent='Please enter your name';err.style.display='block';return;}
  if(!email||!pw){err.textContent='Please fill in all fields';err.style.display='block';return;}
  if(pw.length<8){err.textContent='Password must be at least 8 characters';err.style.display='block';return;}
  if(pw!==pw2){err.textContent='Passwords do not match';err.style.display='block';return;}
  btn.disabled=true;btn.textContent='Creating account...';
  try{
    const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,email,password:pw,plan:'${plan}'})});
    const data=await res.json();
    if(data.error){err.textContent=data.error;err.style.display='block';btn.disabled=false;btn.textContent='Continue to payment →';return;}
    window.location.href='/checkout?plan=${plan}';
  }catch(e){err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='Continue to payment →';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')register();});
</script>
</body>
</html>`);
});

app.get('/login', (req, res) => {
  const plan = req.query.plan || '';
  if (req.session.userId) return res.redirect(plan ? '/checkout?plan='+plan : '/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Log In — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;}
.card{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:420px;width:100%;}
.logo{font-size:20px;font-weight:800;margin-bottom:2rem;text-align:center;}.logo .g{color:#aaff00;}
h1{font-size:24px;font-weight:800;margin-bottom:8px;}.sub{color:#666;font-size:14px;margin-bottom:2rem;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
.btn{width:100%;padding:13px;background:#aaff00;color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:8px;}
.btn:hover{opacity:0.85;}.btn:disabled{opacity:0.5;cursor:not-allowed;}
.link{text-align:center;font-size:13px;color:#666;margin-top:1.5rem;}.link a{color:#aaff00;}
.error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><a href="/" style="text-decoration:none;color:inherit;">stream<span class="g">forcheap</span></a></div>
  <h1>Welcome back</h1>
  <p class="sub">Log in to ${plan ? 'continue to checkout' : 'manage your streams'}</p>
  <div class="error" id="error"></div>
  <div class="field"><label>Email address</label><input type="email" id="email" placeholder="you@example.com"/></div>
  <div class="field"><label>Password</label><input type="password" id="password" placeholder="Your password"/></div>
  <button class="btn" id="btn" onclick="login()">Log in</button>
  <div class="link">Don't have an account? <a href="/register${plan?'?plan='+plan:''}">Sign up</a></div>
</div>
<script>
const redirectPlan='${plan}';
async function login(){
  const email=document.getElementById('email').value.trim();
  const pw=document.getElementById('password').value;
  const err=document.getElementById('error');const btn=document.getElementById('btn');
  err.style.display='none';
  if(!email||!pw){err.textContent='Please fill in all fields';err.style.display='block';return;}
  btn.disabled=true;btn.textContent='Logging in...';
  try{
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw})});
    const data=await res.json();
    if(data.error){err.textContent=data.error;err.style.display='block';btn.disabled=false;btn.textContent='Log in';return;}
    if(redirectPlan){window.location.href='/checkout?plan='+redirectPlan;}
    else{window.location.href='/dashboard';}
  }catch(e){err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='Log in';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script>
</body>
</html>`);
});

// ==================== DEMO TIER (REMOVE BEFORE LAUNCH) ====================

app.get('/demo-activate', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET plan=$1, stream_slots=$2, subscription_status=$3 WHERE id=$4',
      ['demo', 6, 'active', req.session.userId]
    );
    res.redirect('/dashboard?welcome=1');
  } catch (e) {
    res.status(500).send('Demo activation failed: ' + e.message);
  }
});

// ==================== CHECKOUT ====================

app.get('/checkout', requireAuth, async (req, res) => {
  const plan = req.query.plan || 'pro';
  const planData = PLANS[plan];
  if (!planData) return res.redirect('/');
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Checkout — StreamForCheap</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;padding:2rem 2rem 4rem;}
.back-bar{max-width:860px;margin:0 auto 1.5rem;}
.back-arrow{display:inline-flex;align-items:center;gap:8px;color:#aaa;font-size:14px;font-weight:600;text-decoration:none;background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 18px;transition:all 0.15s;}
.back-arrow:hover{color:#aaff00;border-color:rgba(170,255,0,0.3);background:#161616;}
.back-arrow .arrow{font-size:18px;line-height:1;}
.checkout-wrap{display:grid;grid-template-columns:1fr 1fr;gap:2rem;max-width:860px;margin:0 auto;width:100%;}
.order-summary{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2rem;}
.order-summary h2{font-size:12px;font-weight:800;margin-bottom:1.5rem;color:#888;text-transform:uppercase;letter-spacing:0.1em;}
.plan-box{background:#1a1a1a;border:1px solid rgba(170,255,0,0.2);border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;}
.plan-box .pname{font-size:22px;font-weight:800;margin-bottom:4px;}
.plan-box .pdesc{font-size:14px;color:#888;margin-bottom:1rem;}
.plan-box .price-row{display:flex;align-items:baseline;gap:6px;}
.plan-box .price{font-size:42px;font-weight:900;color:#aaff00;}
.plan-box .per{font-size:16px;color:#888;}
.features{list-style:none;display:flex;flex-direction:column;gap:8px;}
.features li{font-size:14px;color:#aaa;display:flex;align-items:center;gap:8px;}
.features li::before{content:'✓';color:#aaff00;font-weight:700;}
.divider{border:none;border-top:1px solid rgba(255,255,255,0.08);margin:1.5rem 0;}
.total-row{display:flex;justify-content:space-between;align-items:center;font-size:16px;}
.total-row strong{font-size:20px;color:#aaff00;}
.payment-form{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2rem;}
.payment-form h2{font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:1.5rem;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
#card-element{background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:14px;}
#card-errors{color:#f87171;font-size:13px;margin-top:8px;display:none;}
.pay-btn{width:100%;padding:15px;background:#aaff00;color:#000;font-size:16px;font-weight:800;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:16px;}
.pay-btn:hover{opacity:0.85;}.pay-btn:disabled{opacity:0.5;cursor:not-allowed;}
.secure-note{display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px;font-weight:600;color:#888;margin-top:14px;}
.secure-note .lock{font-size:18px;}
@media(max-width:700px){.checkout-wrap{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="back-bar">
  <a href="/#pricing" class="back-arrow">
    <span class="arrow">←</span> Back to pricing
  </a>
</div>
<div class="checkout-wrap">
  <div class="order-summary">
    <h2>Order Summary</h2>
    <div class="plan-box">
      <div class="pname">${planData.name} Plan</div>
      <div class="pdesc">${planData.slots} stream${planData.slots>1?'s':''} · 24/7 · Cancel anytime</div>
      <div class="price-row">
        <span class="price">$${planData.price}</span>
        <span class="per">/month</span>
      </div>
    </div>
    <ul class="features">
      <li>24/7 YouTube streaming</li>
      <li>${plan==='starter'?'720p quality':'1080p quality'}</li>
      <li>Separate audio tracks</li>
      <li>Auto-restart on crash</li>
      <li>No watermark</li>
      <li>Cancel anytime</li>
    </ul>
    <div class="divider"></div>
    <div class="total-row">
      <span>Total per month</span>
      <strong>$${planData.price}/mo</strong>
    </div>
  </div>
  <div class="payment-form">
    <h2>Payment Details</h2>
    <div class="field">
      <label>Email</label>
      <input type="text" value="${user.email}" disabled style="opacity:0.6;"/>
    </div>
    <div class="field">
      <label>Card details</label>
      <div id="card-element"></div>
      <div id="card-errors"></div>
    </div>
    <button class="pay-btn" id="pay-btn" onclick="handlePayment()">Subscribe — $${planData.price}/month</button>
    <div class="secure-note"><span class="lock">🔒</span> Secured by Stripe &nbsp;·&nbsp; Cancel anytime</div>
  </div>
</div>
<script>
const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY}');
const elements = stripe.elements();
const card = elements.create('card', {
  style: {
    base: { color: '#fff', fontFamily: '-apple-system, sans-serif', fontSize: '15px', '::placeholder': { color: '#555' } },
    invalid: { color: '#f87171' }
  }
});
card.mount('#card-element');
card.on('change', e => {
  const err = document.getElementById('card-errors');
  if(e.error){err.textContent=e.error.message;err.style.display='block';}
  else{err.style.display='none';}
});
async function handlePayment(){
  const btn = document.getElementById('pay-btn');
  btn.disabled = true; btn.textContent = 'Processing...';
  try {
    const intentRes = await fetch('/api/create-subscription', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ plan: '${plan}' })
    });
    const intentData = await intentRes.json();
    if(intentData.error){ throw new Error(intentData.error); }
    const result = await stripe.confirmCardPayment(intentData.clientSecret, {
      payment_method: { card }
    });
    if(result.error){ throw new Error(result.error.message); }
    window.location.href = '/dashboard?welcome=1';
  } catch(e) {
    const err = document.getElementById('card-errors');
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Subscribe — $${planData.price}/month';
  }
}
</script>
</body>
</html>`);
});

// ==================== DASHBOARD ====================

app.get('/dashboard', requireAuth, async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
  const streams = (await pool.query('SELECT * FROM streams WHERE user_id=$1 ORDER BY created_at DESC', [req.session.userId])).rows;
  const planSlots = { starter:1, pro:1, creator:3, studio:6, demo:6 };
  const maxSlots = planSlots[user.plan] || 0;
  const liveMap = {};
  streams.forEach(s => { liveMap[s.id] = activeStreams.has(s.id); });
  const welcome = req.query.welcome === '1';
  const hasActivePlan = user.subscription_status === 'active' || user.plan !== 'free';
  const displayName = user.username || user.email.split('@')[0];
  const planData = PLANS[user.plan] || PLANS.pro;
  const isStarterPlan = user.plan === 'starter';

  const streamsForClient = streams.reduce((a,s)=>{
    a[s.id] = { ...s, audio_tracks: Array.isArray(s.audio_tracks) ? s.audio_tracks : [] };
    return a;
  },{});

  function safeJson(obj) {
    return JSON.stringify(obj)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/'/g, '\\u0027');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dashboard — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a0a;--surface:#111;--surface2:#1a1a1a;--border:rgba(255,255,255,0.08);--accent:#aaff00;--muted:#888;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:#fff;min-height:100vh;}
a{text-decoration:none;color:inherit;}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100;}
.logo{font-size:18px;font-weight:800;text-decoration:none;color:#fff;}.logo .g{color:var(--accent);}
.topbar-left{display:flex;align-items:center;gap:16px;}
.home-link{font-size:13px;color:#555;display:flex;align-items:center;gap:4px;transition:color 0.15s;text-decoration:none;}
.home-link:hover{color:#aaa;}
.topbar-right{display:flex;align-items:center;gap:12px;}
.plan-badge{background:rgba(170,255,0,0.1);border:1px solid rgba(170,255,0,0.2);color:var(--accent);font-size:12px;font-weight:700;padding:4px 12px;border-radius:99px;text-transform:uppercase;}
.plan-badge.demo{background:rgba(255,170,0,0.1);border-color:rgba(255,170,0,0.3);color:#ffaa00;}
.user-name{font-size:14px;color:#ccc;font-weight:600;}
.logout{font-size:13px;color:var(--muted);text-decoration:none;}.logout:hover{color:#f87171;}
.main{max-width:900px;margin:0 auto;padding:84px 1rem 4rem;}
.welcome-banner{background:rgba(170,255,0,0.08);border:1px solid rgba(170,255,0,0.2);border-radius:12px;padding:1rem 1.5rem;margin-bottom:1.5rem;font-size:15px;color:var(--accent);display:${welcome?'block':'none'};}
.demo-banner{background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.25);border-radius:12px;padding:0.75rem 1.25rem;margin-bottom:1.5rem;font-size:13px;color:#ffaa00;display:${user.plan==='demo'?'flex':'none'};align-items:center;gap:8px;}
.page-title{font-size:26px;font-weight:800;margin-bottom:4px;letter-spacing:-0.5px;}
.page-sub{font-size:14px;color:var(--muted);margin-bottom:2rem;}
.upgrade-banner{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:2rem;text-align:center;margin-bottom:1.5rem;}
.upgrade-banner h3{font-size:18px;font-weight:700;margin-bottom:8px;}
.upgrade-banner p{font-size:14px;color:var(--muted);margin-bottom:1.5rem;}
.upgrade-btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.streams-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.streams-header h2{font-size:16px;font-weight:700;}
.slots-info{font-size:13px;color:var(--muted);font-weight:400;}
.add-btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;transition:opacity 0.15s;}
.add-btn:hover{opacity:0.85;}.add-btn:disabled{opacity:0.4;cursor:not-allowed;}
.stream-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem;margin-bottom:12px;}
.stream-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:10px;}
.stream-name{font-size:17px;font-weight:700;}
.stream-status{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;}
.status-dot{width:8px;height:8px;border-radius:50%;}
.status-live{color:var(--accent);}.status-live .status-dot{background:var(--accent);animation:pulse 1.5s infinite;}
.status-stopped{color:var(--muted);}.status-stopped .status-dot{background:#444;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.stream-body{display:flex;gap:16px;margin-bottom:1rem;align-items:flex-start;flex-wrap:wrap;}
.stream-thumb{width:120px;height:68px;border-radius:8px;object-fit:cover;background:#000;flex-shrink:0;border:1px solid #222;}
.stream-thumb-placeholder{width:120px;height:68px;border-radius:8px;background:#1a1a1a;border:1px solid #222;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;}
.stream-info{display:flex;flex-direction:column;gap:6px;flex:1;}
.stream-info-item{font-size:13px;color:var(--muted);}
.stream-info-item strong{color:#ccc;}
.stream-actions{display:flex;gap:8px;flex-wrap:wrap;}
.btn-start{background:var(--accent);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:opacity 0.15s;}
.btn-start:hover:not(:disabled){opacity:0.85;}.btn-start:disabled{opacity:0.4;cursor:not-allowed;}
.btn-stop{background:rgba(248,113,113,0.1);color:#f87171;border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;}
.btn-stop:hover{background:rgba(248,113,113,0.2);}
.btn-restart{background:rgba(170,255,0,0.08);color:#aaff00;border:1px solid rgba(170,255,0,0.25);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.15s;}
.btn-restart:hover{background:rgba(170,255,0,0.15);border-color:rgba(170,255,0,0.5);}
.btn-restart:disabled{opacity:0.4;cursor:not-allowed;}
.btn-edit{background:var(--surface2);color:#aaa;border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;}
.btn-edit:hover{border-color:var(--accent);color:var(--accent);}
.btn-delete{background:transparent;color:#555;border:1px solid #222;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;transition:all 0.15s;}
.btn-delete:hover{color:#f87171;border-color:#f87171;}
.restart-hint{font-size:11px;color:#555;margin-top:6px;}
.empty-state{text-align:center;padding:4rem 2rem;background:var(--surface);border:1px dashed #222;border-radius:14px;}
.empty-icon{font-size:48px;margin-bottom:1rem;}
.empty-state h3{font-size:18px;font-weight:700;margin-bottom:8px;}
.empty-state p{font-size:14px;color:var(--muted);margin-bottom:1.5rem;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:200;display:none;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto;}
.modal-overlay.open{display:flex;}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:2rem;max-width:540px;width:100%;margin:auto;}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;}
.modal-header h2{font-size:20px;font-weight:800;}
.modal-close{background:none;border:none;color:#555;font-size:22px;cursor:pointer;}.modal-close:hover{color:#fff;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:var(--muted);display:block;margin-bottom:6px;}
.field input,.field select{width:100%;padding:11px 14px;background:var(--surface2);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:14px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus,.field select:focus{border-color:var(--accent);}
.field select option{background:#1a1a1a;}
.field-note{font-size:11px;color:#555;margin-top:5px;line-height:1.5;}
.section-divider{border:none;border-top:1px solid var(--border);margin:20px 0;}
.section-heading{font-size:13px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;}
.preview-wrap{position:relative;width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#000;border:1px solid #222;margin-bottom:10px;cursor:pointer;}
.preview-wrap img{width:100%;height:100%;object-fit:cover;}
.preview-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);opacity:0;transition:opacity 0.15s;}
.preview-wrap:hover .preview-overlay{opacity:1;}
.preview-overlay-text{color:#fff;font-size:14px;font-weight:600;}
.preview-overlay-icon{font-size:28px;margin-bottom:6px;}
.preview-empty{width:100%;aspect-ratio:16/9;border-radius:10px;border:1.5px dashed #2a2a2a;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all 0.15s;margin-bottom:10px;background:transparent;}
.preview-empty:hover{border-color:var(--accent);background:rgba(170,255,0,0.03);}
.preview-empty-icon{font-size:32px;color:var(--accent);margin-bottom:8px;}
.preview-empty-text{font-size:13px;color:#555;}
.volume-row{display:flex;align-items:center;gap:12px;margin-top:10px;}
.volume-row label{font-size:12px;color:var(--muted);width:90px;flex-shrink:0;}
.volume-row input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:99px;background:#2a2a2a;outline:none;cursor:pointer;}
.volume-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;}
.vol-val{font-size:13px;font-weight:700;color:var(--accent);width:38px;text-align:right;flex-shrink:0;}
.mute-btn{padding:5px 12px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid #333;background:transparent;color:#666;transition:all 0.15s;flex-shrink:0;}
.mute-btn.muted{background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3);color:#f87171;}
.mute-btn:hover{border-color:var(--accent);color:var(--accent);}
.audio-tracks-list{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;}
.audio-track-item{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid #222;border-radius:8px;padding:8px 12px;}
.audio-track-item.is-saved{border-color:rgba(170,255,0,0.15);}
.track-order-btns{display:flex;flex-direction:column;gap:2px;}
.track-order-btn{background:none;border:none;color:#555;cursor:pointer;font-size:10px;line-height:1;padding:1px 4px;transition:color 0.1s;}
.track-order-btn:hover:not(:disabled){color:var(--accent);}
.track-order-btn:disabled{opacity:0.2;cursor:default;}
.track-name-text{flex:1;font-size:13px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.track-saved-badge{font-size:10px;color:#aaff00;background:rgba(170,255,0,0.08);border:1px solid rgba(170,255,0,0.2);border-radius:4px;padding:1px 6px;flex-shrink:0;}
.track-dur-text{font-size:12px;color:#555;flex-shrink:0;}
.track-remove-btn{background:none;border:none;color:#444;cursor:pointer;font-size:16px;padding:0 2px;transition:color 0.1s;}
.track-remove-btn:hover{color:#f87171;}
.add-audio-row{position:relative;width:100%;}
.add-audio-btn{width:100%;padding:10px;background:transparent;border:1.5px dashed #2a2a2a;border-radius:8px;color:#555;font-size:13px;cursor:pointer;transition:all 0.15s;}
.add-audio-btn:hover{border-color:var(--accent);color:var(--accent);}
.progress-wrap{margin-top:12px;display:none;}
.progress-track{height:4px;background:#222;border-radius:99px;overflow:hidden;}
.progress-fill{height:100%;background:var(--accent);border-radius:99px;width:0%;transition:width 0.3s;}
.progress-label{font-size:12px;color:var(--muted);margin-top:6px;}
.error-box{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:10px;display:none;}
.modal-btn{width:100%;padding:13px;background:var(--accent);color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:12px;}
.modal-btn:hover{opacity:0.85;}.modal-btn:disabled{opacity:0.4;cursor:not-allowed;}
.save-note{font-size:12px;color:#555;text-align:center;margin-top:8px;}
.live-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--accent);background:rgba(170,255,0,0.1);border:1px solid rgba(170,255,0,0.2);border-radius:99px;padding:2px 8px;margin-left:8px;vertical-align:middle;}
.plan-limit-note{font-size:11px;color:#ffaa00;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.2);border-radius:6px;padding:6px 10px;margin-top:8px;}
.confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:300;display:none;align-items:center;justify-content:center;padding:1rem;}
.confirm-overlay.open{display:flex;}
.confirm-box{background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:1.5rem;max-width:360px;width:100%;text-align:center;}
.confirm-box h3{font-size:17px;font-weight:700;margin-bottom:8px;}
.confirm-box p{font-size:14px;color:#888;margin-bottom:1.5rem;line-height:1.5;}
.confirm-btns{display:flex;gap:10px;}
.confirm-yes{flex:1;padding:10px;background:#f87171;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;}
.confirm-yes:hover{background:#ef4444;}
.confirm-no{flex:1;padding:10px;background:#1a1a1a;color:#aaa;border:1px solid #333;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;}
.confirm-no:hover{border-color:#555;color:#fff;}
</style>
</head>
<body>

<script type="application/json" id="__live_map__">${safeJson(liveMap)}</script>
<script type="application/json" id="__all_streams__">${safeJson(streamsForClient)}</script>
<script type="application/json" id="__plan_data__">${safeJson({ isStarterPlan })}</script>

<input type="file" id="hidden-video-input" style="display:none;" accept="${isStarterPlan ? '.jpg,.jpeg,.png,.webp' : '.mp4,.mov,.avi,.mkv,.webm,.gif,.jpg,.jpeg,.png,.webp'}" />
<input type="file" id="hidden-audio-input" style="display:none;" accept=".mp3,.wav,.aac,.ogg,.flac,.m4a" multiple />

<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-box">
    <h3>Remove this track?</h3>
    <p id="confirm-track-name">Are you sure you want to remove this audio track?</p>
    <div class="confirm-btns">
      <button class="confirm-no" onclick="closeConfirm()">Cancel</button>
      <button class="confirm-yes" onclick="confirmRemove()">Yes, remove</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="stream-modal">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modal-title">Add stream</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="field"><label>Stream name</label><input type="text" id="stream-name" placeholder="My Lofi Stream"/></div>
    <div class="field">
      <label>YouTube Stream Key</label>
      <input type="password" id="stream-key" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx"/>
      <div class="field-note">YouTube Studio → Go Live → Stream. Keep it private.</div>
    </div>
    <div class="field">
      <label>Resolution</label>
      <select id="stream-res">
        <option value="720p">720p</option>
        ${!isStarterPlan ? '<option value="1080p" selected>1080p</option>' : ''}
      </select>
      ${isStarterPlan ? '<div class="plan-limit-note">⚡ Starter plan is limited to 720p. <a href="/#pricing" style="color:#aaff00;">Upgrade to Pro</a> for 1080p.</div>' : ''}
    </div>
    <hr class="section-divider"/>
    <div class="section-heading">🎬 Video / Image</div>
    ${isStarterPlan ? '<div class="plan-limit-note" style="margin-bottom:12px;">⚡ Starter plan supports static images only (JPG, PNG, WebP). <a href="/#pricing" style="color:#aaff00;">Upgrade to Pro</a> for GIF &amp; video.</div>' : ''}
    <div id="preview-container"></div>
    <div class="volume-row">
      <label>Video volume</label>
      <input type="range" id="video-vol" min="0" max="100" value="100" oninput="onVolChange('video')"/>
      <span class="vol-val" id="video-vol-val">100%</span>
      <button class="mute-btn" id="video-mute-btn" onclick="toggleMute('video')">Mute</button>
    </div>
    <hr class="section-divider"/>
    <div class="section-heading">🎵 Audio Tracks <span style="font-size:11px;color:#555;font-weight:400;text-transform:none;letter-spacing:0;">(play sequentially, loop forever)</span></div>
    <div class="audio-tracks-list" id="audio-tracks-list"></div>
    <div class="add-audio-row">
      <button class="add-audio-btn" id="add-audio-btn">+ Add audio track</button>
    </div>
    <div class="volume-row" style="margin-top:12px;">
      <label>Audio volume</label>
      <input type="range" id="audio-vol" min="0" max="100" value="100" oninput="onVolChange('audio')"/>
      <span class="vol-val" id="audio-vol-val">100%</span>
      <button class="mute-btn" id="audio-mute-btn" onclick="toggleMute('audio')">Mute</button>
    </div>
    <div class="progress-wrap" id="upload-progress">
      <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label" id="progress-label">Uploading...</div>
    </div>
    <div class="error-box" id="modal-error"></div>
    <button class="modal-btn" id="save-btn" onclick="saveStream()">Save stream</button>
    <div class="save-note" id="save-note"></div>
  </div>
</div>

<div class="topbar">
  <div class="topbar-left">
    <a href="/" class="logo">stream<span class="g">forcheap</span></a>
    <a href="/" class="home-link">← Home</a>
  </div>
  <div class="topbar-right">
    <span class="user-name">👤 ${displayName}</span>
    <span class="plan-badge ${user.plan === 'demo' ? 'demo' : ''}">${user.plan === 'demo' ? '🧪 DEMO' : user.plan}</span>
    <a href="/logout" class="logout">Log out</a>
  </div>
</div>

<div class="main">
  ${welcome?`<div class="welcome-banner">🎉 Welcome, ${displayName}! Your subscription is active. Add your first stream below to get started.</div>`:''}
  <div class="demo-banner">🧪 Demo mode active — Studio tier unlocked for free. Remove before launch.</div>
  <div class="page-title">Your Streams</div>
  <div class="page-sub">${user.email} · ${user.plan} plan</div>

  ${!hasActivePlan?`
  <div class="upgrade-banner">
    <h3>No active subscription</h3>
    <p>Choose a plan to start streaming 24/7 to YouTube.</p>
    <a href="/#pricing" class="upgrade-btn">View plans →</a>
  </div>
  `:`
  <div class="streams-header">
    <h2>Streams <span class="slots-info">(${streams.length}/${maxSlots} slots used)</span></h2>
    <button class="add-btn" ${streams.length>=maxSlots?'disabled':''} onclick="openModal()">+ Add stream</button>
  </div>
  <div id="streams-list">
    ${streams.length===0?`
    <div class="empty-state">
      <div class="empty-icon">📡</div>
      <h3>No streams yet</h3>
      <p>Add your first stream to get started. It only takes a minute.</p>
      <button class="add-btn" onclick="openModal()">+ Add your first stream</button>
    </div>`:streams.map(s=>{
      const isLive = activeStreams.has(s.id);
      const tracks = Array.isArray(s.audio_tracks) ? s.audio_tracks : [];
      const thumbHtml = s.thumb_path
        ? `<img class="stream-thumb" src="${s.thumb_path}" alt="thumb"/>`
        : `<div class="stream-thumb-placeholder">📡</div>`;
      return `<div class="stream-card" id="stream-${s.id}">
        <div class="stream-top">
          <div class="stream-name">${s.name}</div>
          <div class="stream-status ${isLive?'status-live':'status-stopped'}">
            <div class="status-dot"></div>${isLive?'🔴 LIVE':'Stopped'}
          </div>
        </div>
        <div class="stream-body">
          ${thumbHtml}
          <div class="stream-info">
            <div class="stream-info-item"><strong>File:</strong> ${s.file_name||'No file uploaded'}</div>
            <div class="stream-info-item"><strong>Audio tracks:</strong> ${tracks.length}</div>
            <div class="stream-info-item"><strong>Resolution:</strong> ${s.resolution}</div>
            <div class="stream-info-item"><strong>Stream key:</strong> ${s.stream_key?'••••••••':'Not set'}</div>
          </div>
        </div>
        <div class="stream-actions">
          ${!isLive?`<button class="btn-start" onclick="startStream(${s.id})" ${!s.file_path||!s.stream_key?'disabled':''}>${!s.file_path||!s.stream_key?'⚠ Missing file or key':'▶ Start stream'}</button>`:''}
          ${isLive?`<button class="btn-stop" onclick="stopStream(${s.id})">⬛ Stop stream</button>`:''}
          ${isLive?`<button class="btn-restart" id="restart-btn-${s.id}" onclick="restartStream(${s.id})">↺ Restart</button>`:''}
          <button class="btn-edit" onclick="editStream(${s.id})">✏️ Edit</button>
          <button class="btn-delete" onclick="deleteStream(${s.id})">🗑 Delete</button>
        </div>
        ${isLive?`<div class="restart-hint">Stream acting up or didn't update? Hit ↺ Restart to fix it.</div>`:''}
      </div>`;
    }).join('')}
  </div>
  `}
</div>

<script>
var liveMap = JSON.parse(document.getElementById('__live_map__').textContent);
var allStreams = JSON.parse(document.getElementById('__all_streams__').textContent);
var planData = JSON.parse(document.getElementById('__plan_data__').textContent);
var isStarterPlan = planData.isStarterPlan;

var editingStreamId = null;
var selectedVideoFile = null;
var savedTracks = [];
var removedSavedIndices = [];
var newAudioFiles = [];
var newAudioDurations = [];
var videoMuted = false;
var audioMuted = false;
var volDebounce = null;
var pendingRemoveIndex = null;
var pendingRemoveType = null;

document.getElementById('hidden-video-input').addEventListener('change', function(e) {
  handleVideoSelect(e);
});
document.getElementById('hidden-audio-input').addEventListener('change', function(e) {
  handleAudioAdd(e);
});
document.getElementById('add-audio-btn').addEventListener('click', function() {
  document.getElementById('hidden-audio-input').click();
});

function setPreviewEmpty() {
  var pc = document.getElementById('preview-container');
  pc.innerHTML = '';
  var div = document.createElement('div');
  div.className = 'preview-empty';
  var label = isStarterPlan
    ? 'Click to upload image (JPG, PNG, WebP)'
    : 'Click to upload video, image, or GIF';
  var sublabel = isStarterPlan
    ? 'Static images only on Starter plan'
    : 'MP4, MOV, GIF, JPG, PNG — up to 20GB';
  div.innerHTML = '<span class="preview-empty-icon">🎬</span><span class="preview-empty-text">' + label + '</span><span style="font-size:11px;color:#444;margin-top:4px;">' + sublabel + '</span>';
  div.addEventListener('click', function() {
    document.getElementById('hidden-video-input').click();
  });
  pc.appendChild(div);
}

function setPreviewImage(src, name) {
  var pc = document.getElementById('preview-container');
  pc.innerHTML = '';
  var wrap = document.createElement('div');
  wrap.className = 'preview-wrap';
  wrap.innerHTML = (src ? '<img src="' + src + '" alt="preview"/>' : '') +
    '<div class="preview-overlay">' +
    '<div class="preview-overlay-icon">🔄</div>' +
    '<div class="preview-overlay-text">Click to change</div>' +
    '<div style="font-size:11px;color:#ccc;margin-top:4px;">' + (name || '') + '</div>' +
    '</div>';
  wrap.addEventListener('click', function() {
    document.getElementById('hidden-video-input').click();
  });
  pc.appendChild(wrap);
}

function openModal() {
  editingStreamId = null;
  selectedVideoFile = null;
  savedTracks = [];
  removedSavedIndices = [];
  newAudioFiles = [];
  newAudioDurations = [];
  videoMuted = false;
  audioMuted = false;
  document.getElementById('modal-title').textContent = 'Add stream';
  document.getElementById('stream-name').value = '';
  document.getElementById('stream-key').value = '';
  document.getElementById('stream-res').value = isStarterPlan ? '720p' : '1080p';
  document.getElementById('video-vol').value = 100;
  document.getElementById('video-vol-val').textContent = '100%';
  document.getElementById('audio-vol').value = 100;
  document.getElementById('audio-vol-val').textContent = '100%';
  document.getElementById('video-mute-btn').className = 'mute-btn';
  document.getElementById('audio-mute-btn').className = 'mute-btn';
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'none';
  document.getElementById('save-btn').disabled = false;
  document.getElementById('save-btn').textContent = 'Save stream';
  document.getElementById('save-note').textContent = '';
  setPreviewEmpty();
  renderAudioTracks();
  document.getElementById('stream-modal').classList.add('open');
}

function editStream(id) {
  editingStreamId = id;
  var s = allStreams[id];
  if (!s) { console.error('Stream not found:', id); return; }
  savedTracks = Array.isArray(s.audio_tracks) ? s.audio_tracks.slice() : [];
  removedSavedIndices = [];
  newAudioFiles = [];
  newAudioDurations = [];
  selectedVideoFile = null;
  videoMuted = s.video_muted || false;
  audioMuted = s.audio_muted || false;
  var isLive = liveMap[id] || false;
  document.getElementById('modal-title').innerHTML = 'Edit stream' + (isLive ? ' <span class="live-tag">● LIVE</span>' : '');
  document.getElementById('stream-name').value = s.name || '';
  document.getElementById('stream-key').value = s.stream_key || '';
  document.getElementById('stream-res').value = isStarterPlan ? '720p' : (s.resolution || '1080p');
  document.getElementById('video-vol').value = s.video_volume || 100;
  document.getElementById('video-vol-val').textContent = (s.video_volume || 100) + '%';
  document.getElementById('audio-vol').value = s.audio_volume || 100;
  document.getElementById('audio-vol-val').textContent = (s.audio_volume || 100) + '%';
  document.getElementById('video-mute-btn').className = 'mute-btn' + (videoMuted ? ' muted' : '');
  document.getElementById('audio-mute-btn').className = 'mute-btn' + (audioMuted ? ' muted' : '');
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'none';
  document.getElementById('save-btn').disabled = false;
  document.getElementById('save-btn').textContent = 'Save changes';
  document.getElementById('save-note').textContent = isLive ? 'Stream will restart briefly when you save' : '';
  if (s.thumb_path) { setPreviewImage(s.thumb_path, s.file_name || ''); } else { setPreviewEmpty(); }
  renderAudioTracks();
  document.getElementById('stream-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('stream-modal').classList.remove('open');
}

function handleVideoSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  if (isStarterPlan && !['jpg','jpeg','png','webp'].includes(ext)) {
    alert('Starter plan only supports static images (JPG, PNG, WebP). Upgrade to Pro for GIF and video support.');
    e.target.value = '';
    return;
  }
  selectedVideoFile = file;
  if (['jpg','jpeg','png','webp'].includes(ext)) {
    setPreviewImage(URL.createObjectURL(file), file.name);
  } else {
    var v = document.createElement('video');
    v.src = URL.createObjectURL(file);
    v.muted = true;
    v.currentTime = 0.5;
    v.onloadeddata = function() {
      var c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      c.getContext('2d').drawImage(v, 0, 0, 320, 180);
      setPreviewImage(c.toDataURL('image/jpeg'), file.name);
    };
    v.onerror = function() { setPreviewImage('', file.name); };
  }
  e.target.value = '';
}

function getAudioDuration(file) {
  return new Promise(function(resolve) {
    var a = new Audio();
    a.onloadedmetadata = function() { resolve(a.duration || 0); };
    a.onerror = function() { resolve(0); };
    a.src = URL.createObjectURL(file);
  });
}

async function handleAudioAdd(e) {
  var files = Array.from(e.target.files);
  for (var i = 0; i < files.length; i++) {
    var d = await getAudioDuration(files[i]);
    newAudioFiles.push(files[i]);
    newAudioDurations.push(d);
  }
  renderAudioTracks();
  e.target.value = '';
}

function askRemoveSaved(i) {
  pendingRemoveIndex = i;
  pendingRemoveType = 'saved';
  document.getElementById('confirm-track-name').textContent =
    'Remove "' + (savedTracks[i] && savedTracks[i].name ? savedTracks[i].name : 'this track') + '" from the stream?';
  document.getElementById('confirm-overlay').classList.add('open');
}

function askRemoveNew(i) {
  pendingRemoveIndex = i;
  pendingRemoveType = 'new';
  document.getElementById('confirm-track-name').textContent =
    'Remove "' + (newAudioFiles[i] ? newAudioFiles[i].name : 'this track') + '"?';
  document.getElementById('confirm-overlay').classList.add('open');
}

function closeConfirm() {
  pendingRemoveIndex = null;
  pendingRemoveType = null;
  document.getElementById('confirm-overlay').classList.remove('open');
}

function confirmRemove() {
  if (pendingRemoveType === 'saved' && pendingRemoveIndex !== null) {
    removedSavedIndices.push(pendingRemoveIndex);
    savedTracks.splice(pendingRemoveIndex, 1);
  } else if (pendingRemoveType === 'new' && pendingRemoveIndex !== null) {
    newAudioFiles.splice(pendingRemoveIndex, 1);
    newAudioDurations.splice(pendingRemoveIndex, 1);
  }
  closeConfirm();
  renderAudioTracks();
}

function renderAudioTracks() {
  var list = document.getElementById('audio-tracks-list');
  list.innerHTML = '';
  savedTracks.forEach(function(t, i) {
    var div = document.createElement('div');
    div.className = 'audio-track-item is-saved';
    div.innerHTML =
      '<div class="track-order-btns">' +
      '<button class="track-order-btn" disabled>▲</button>' +
      '<button class="track-order-btn" disabled>▼</button>' +
      '</div>' +
      '<span class="track-name-text">' + (t.name || 'Track ' + (i + 1)) + '</span>' +
      '<span class="track-saved-badge">saved</span>';
    var rmBtn = document.createElement('button');
    rmBtn.className = 'track-remove-btn';
    rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', (function(idx) { return function() { askRemoveSaved(idx); }; })(i));
    div.appendChild(rmBtn);
    list.appendChild(div);
  });
  newAudioFiles.forEach(function(f, i) {
    var m = Math.floor(newAudioDurations[i] / 60);
    var s = Math.floor(newAudioDurations[i] % 60);
    var div = document.createElement('div');
    div.className = 'audio-track-item';
    var upBtn = document.createElement('button');
    upBtn.className = 'track-order-btn';
    upBtn.textContent = '▲';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', (function(idx) { return function() { moveNewTrack(idx, -1); }; })(i));
    var downBtn = document.createElement('button');
    downBtn.className = 'track-order-btn';
    downBtn.textContent = '▼';
    downBtn.disabled = i === newAudioFiles.length - 1;
    downBtn.addEventListener('click', (function(idx) { return function() { moveNewTrack(idx, 1); }; })(i));
    var orderDiv = document.createElement('div');
    orderDiv.className = 'track-order-btns';
    orderDiv.appendChild(upBtn);
    orderDiv.appendChild(downBtn);
    div.appendChild(orderDiv);
    var nameSpan = document.createElement('span');
    nameSpan.className = 'track-name-text';
    nameSpan.textContent = f.name;
    div.appendChild(nameSpan);
    var durSpan = document.createElement('span');
    durSpan.className = 'track-dur-text';
    durSpan.textContent = m + ':' + String(s).padStart(2, '0');
    div.appendChild(durSpan);
    var rmBtn = document.createElement('button');
    rmBtn.className = 'track-remove-btn';
    rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', (function(idx) { return function() { askRemoveNew(idx); }; })(i));
    div.appendChild(rmBtn);
    list.appendChild(div);
  });
}

function moveNewTrack(i, dir) {
  var ni = i + dir;
  if (ni < 0 || ni >= newAudioFiles.length) return;
  var tmpF = newAudioFiles[i]; newAudioFiles[i] = newAudioFiles[ni]; newAudioFiles[ni] = tmpF;
  var tmpD = newAudioDurations[i]; newAudioDurations[i] = newAudioDurations[ni]; newAudioDurations[ni] = tmpD;
  renderAudioTracks();
}

function onVolChange(type) {
  var val = parseInt(document.getElementById(type + '-vol').value);
  document.getElementById(type + '-vol-val').textContent = val + '%';
  if (type === 'video' && videoMuted && val > 0) { videoMuted = false; document.getElementById('video-mute-btn').className = 'mute-btn'; }
  if (type === 'audio' && audioMuted && val > 0) { audioMuted = false; document.getElementById('audio-mute-btn').className = 'mute-btn'; }
  if (editingStreamId && liveMap[editingStreamId]) {
    clearTimeout(volDebounce);
    volDebounce = setTimeout(async function() {
      await saveMetaNow();
      await fetch('/api/streams/' + editingStreamId + '/restart', { method: 'POST' });
    }, 500);
  }
}

function toggleMute(type) {
  if (type === 'video') {
    videoMuted = !videoMuted;
    document.getElementById('video-mute-btn').className = 'mute-btn' + (videoMuted ? ' muted' : '');
    document.getElementById('video-vol').value = videoMuted ? 0 : 100;
    document.getElementById('video-vol-val').textContent = videoMuted ? '0%' : '100%';
  } else {
    audioMuted = !audioMuted;
    document.getElementById('audio-mute-btn').className = 'mute-btn' + (audioMuted ? ' muted' : '');
    document.getElementById('audio-vol').value = audioMuted ? 0 : 100;
    document.getElementById('audio-vol-val').textContent = audioMuted ? '0%' : '100%';
  }
  if (editingStreamId && liveMap[editingStreamId]) {
    clearTimeout(volDebounce);
    volDebounce = setTimeout(async function() {
      await saveMetaNow();
      await fetch('/api/streams/' + editingStreamId + '/restart', { method: 'POST' });
    }, 500);
  }
}

async function saveMetaNow() {
  if (!editingStreamId) return;
  await fetch('/api/streams/' + editingStreamId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('stream-name').value.trim(),
      streamKey: document.getElementById('stream-key').value.trim(),
      resolution: document.getElementById('stream-res').value,
      videoVolume: parseInt(document.getElementById('video-vol').value),
      videoMuted: videoMuted,
      audioVolume: parseInt(document.getElementById('audio-vol').value),
      audioMuted: audioMuted
    })
  });
}

async function saveStream() {
  var name = document.getElementById('stream-name').value.trim();
  var key = document.getElementById('stream-key').value.trim();
  var res = document.getElementById('stream-res').value;
  var videoVol = parseInt(document.getElementById('video-vol').value);
  var audioVol = parseInt(document.getElementById('audio-vol').value);
  var errEl = document.getElementById('modal-error');
  var saveBtn = document.getElementById('save-btn');

  if (!name) { errEl.textContent = 'Please enter a stream name'; errEl.style.display = 'block'; return; }
  if (isStarterPlan && res === '1080p') { errEl.textContent = 'Starter plan is limited to 720p.'; errEl.style.display = 'block'; return; }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  errEl.style.display = 'none';

  var payload = { name: name, streamKey: key, resolution: res, videoVolume: videoVol, videoMuted: videoMuted, audioVolume: audioVol, audioMuted: audioMuted };

  try {
    if (editingStreamId) {
      var r = await fetch('/api/streams/' + editingStreamId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await r.json();
      if (data.error) throw new Error(data.error);

      if (removedSavedIndices.length > 0) {
        saveBtn.textContent = 'Removing tracks...';
        await fetch('/api/streams/' + editingStreamId + '/remove-audio-tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ indices: removedSavedIndices })
        });
      }

      if (selectedVideoFile) {
        saveBtn.textContent = 'Uploading video...';
        var fd = new FormData();
        fd.append('file', selectedVideoFile);
        var vr = await fetch('/api/streams/' + editingStreamId + '/upload-video', { method: 'POST', body: fd });
        var vdata = await vr.json();
        if (vdata.error) throw new Error(vdata.error);
      }

      for (var i = 0; i < newAudioFiles.length; i++) {
        saveBtn.textContent = 'Uploading audio ' + (i + 1) + '/' + newAudioFiles.length + '...';
        var afd = new FormData();
        afd.append('file', newAudioFiles[i]);
        var ar = await fetch('/api/streams/' + editingStreamId + '/upload-audio', { method: 'POST', body: afd });
        var adata = await ar.json();
        if (adata.error) throw new Error(adata.error);
      }

      if (liveMap[editingStreamId]) {
        saveBtn.textContent = 'Restarting stream...';
        await fetch('/api/streams/' + editingStreamId + '/restart', { method: 'POST' });
      }

      closeModal();
      location.reload();

    } else {
      var cr = await fetch('/api/streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var cdata = await cr.json();
      if (cdata.error) throw new Error(cdata.error);

      var sid = cdata.id;
      document.getElementById('upload-progress').style.display = 'block';

      if (selectedVideoFile) {
        saveBtn.textContent = 'Uploading video...';
        await uploadXHR('/api/streams/' + sid + '/upload-video', selectedVideoFile);
      }
      for (var j = 0; j < newAudioFiles.length; j++) {
        saveBtn.textContent = 'Uploading audio ' + (j + 1) + '/' + newAudioFiles.length + '...';
        await uploadXHR('/api/streams/' + sid + '/upload-audio', newAudioFiles[j]);
      }

      closeModal();
      location.reload();
    }
  } catch (e) {
    errEl.textContent = e.message || 'Something went wrong. Please try again.';
    errEl.style.display = 'block';
    saveBtn.disabled = false;
    saveBtn.textContent = editingStreamId ? 'Save changes' : 'Save stream';
  }
}

function uploadXHR(url, file) {
  return new Promise(function(resolve, reject) {
    var fd = new FormData();
    fd.append('file', file);
    var xhr = new XMLHttpRequest();
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var p = Math.round(e.loaded / e.total * 100);
        document.getElementById('progress-fill').style.width = p + '%';
        document.getElementById('progress-label').textContent = 'Uploading ' + p + '%...';
      }
    };
    xhr.onload = function() {
      try {
        var data = JSON.parse(xhr.responseText);
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      } catch(e) { resolve({}); }
    };
    xhr.onerror = function() { reject(new Error('Upload failed. Please check your connection.')); };
    xhr.open('POST', url);
    xhr.send(fd);
  });
}

async function startStream(id) {
  var btn = document.querySelector('#stream-' + id + ' .btn-start');
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  try {
    var res = await fetch('/api/streams/' + id + '/start', { method: 'POST' });
    var data = await res.json();
    if (data.error) { alert(data.error); location.reload(); return; }
    location.reload();
  } catch(e) { alert('Failed to start stream.'); location.reload(); }
}

async function stopStream(id) {
  await fetch('/api/streams/' + id + '/stop', { method: 'POST' });
  location.reload();
}

async function restartStream(id) {
  var btn = document.getElementById('restart-btn-' + id);
  if (btn) { btn.textContent = '⏳ Restarting...'; btn.disabled = true; }
  await fetch('/api/streams/' + id + '/restart', { method: 'POST' });
  setTimeout(() => location.reload(), 2000);
}

async function deleteStream(id) {
  if (!confirm('Delete this stream? This cannot be undone.')) return;
  await fetch('/api/streams/' + id, { method: 'DELETE' });
  location.reload();
}
</script>
</body>
</html>`);
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ==================== API ====================

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, plan, username } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email,password,username,plan,stream_slots) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [email.toLowerCase().trim(), hashed, username||null, 'free', 0]
    );
    req.session.userId = result.rows[0].id;
    res.json({ success: true });
  } catch (e) { console.error('Register error:', e); res.status(500).json({ error: 'Registration failed. Please try again.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ success: true });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: 'Login failed. Please try again.' }); }
});

app.post('/api/create-subscription', requireAuthApi, async (req, res) => {
  try {
    const { plan } = req.body;
    const planData = PLANS[plan];
    if (!planData) return res.status(400).json({ error: 'Invalid plan' });
    if (!planData.priceId) return res.status(400).json({ error: 'Plan not configured yet. Please contact support.' });
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, user.id]);
    }
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: planData.priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
    const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
    await pool.query('UPDATE users SET stripe_subscription_id=$1 WHERE id=$2', [subscription.id, user.id]);
    res.json({ clientSecret, subscriptionId: subscription.id });
  } catch (e) { console.error('Subscription error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (e) {
    try { event = JSON.parse(req.body); } catch(e2) { return res.status(400).send('Webhook error'); }
  }
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = Object.entries(PLANS).find(([,p]) => p.priceId === priceId)?.[0] || 'pro';
      const planSlots = { starter:1, pro:1, creator:3, studio:6, demo:6 };
      await pool.query(
        'UPDATE users SET plan=$1, stream_slots=$2, subscription_status=$3 WHERE stripe_subscription_id=$4',
        [plan, planSlots[plan]||1, 'active', subscriptionId]
      );
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await pool.query(
      'UPDATE users SET plan=$1, stream_slots=$2, subscription_status=$3 WHERE stripe_subscription_id=$4',
      ['free', 0, 'cancelled', subscription.id]
    );
  }
  res.json({ received: true });
});

app.post('/api/streams', requireAuthApi, async (req, res) => {
  try {
    const { name, streamKey, resolution, videoVolume, videoMuted, audioVolume, audioMuted } = req.body;
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
    const planData = PLANS[user.plan] || PLANS.pro;
    const count = parseInt((await pool.query('SELECT COUNT(*) FROM streams WHERE user_id=$1', [req.session.userId])).rows[0].count);
    if (count >= user.stream_slots) return res.status(400).json({ error: 'Stream slot limit reached. Upgrade your plan.' });
    const safeResolution = planData.maxResolution === '720p' ? '720p' : (resolution || '1080p');
    const result = await pool.query(
      'INSERT INTO streams (user_id,name,stream_key,resolution,video_volume,video_muted,audio_volume,audio_muted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.session.userId, name||'My Stream', streamKey||null, safeResolution, videoVolume||100, videoMuted||false, audioVolume||100, audioMuted||false]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/streams/:id', requireAuthApi, async (req, res) => {
  try {
    const { name, streamKey, resolution, videoVolume, videoMuted, audioVolume, audioMuted } = req.body;
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
    const planData = PLANS[user.plan] || PLANS.pro;
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const safeResolution = planData.maxResolution === '720p' ? '720p' : (resolution || '1080p');
    await pool.query(
      'UPDATE streams SET name=$1,stream_key=$2,resolution=$3,video_volume=$4,video_muted=$5,audio_volume=$6,audio_muted=$7 WHERE id=$8',
      [name, streamKey||null, safeResolution, videoVolume||100, videoMuted||false, audioVolume||100, audioMuted||false, req.params.id]
    );
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) {
      const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0];
      active.streamData = { ...active.streamData, ...updated };
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/upload-video', requireAuthApi, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
    const planData = PLANS[user.plan] || PLANS.pro;
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (planData.imageOnly && !['.jpg','.jpeg','.png','.webp'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Starter plan only supports static images. Upgrade to Pro for GIF and video.' });
    }
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (stream.file_path && fs.existsSync(stream.file_path)) { try { fs.unlinkSync(stream.file_path); } catch(e) {} }
    if (stream.thumb_path) { const tp = path.join(THUMB_DIR, path.basename(stream.thumb_path)); if (fs.existsSync(tp)) { try { fs.unlinkSync(tp); } catch(e) {} } }
    const thumbPath = await generateThumb(req.file.path, req.params.id);
    await pool.query('UPDATE streams SET file_path=$1,file_name=$2,thumb_path=$3 WHERE id=$4', [req.file.path, req.file.originalname, thumbPath, req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) { const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0]; active.streamData = { ...active.streamData, ...updated }; }
    res.json({ success: true, thumb_path: thumbPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/upload-audio', requireAuthApi, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks : [];
    tracks.push({ path: req.file.path, name: req.file.originalname });
    await pool.query('UPDATE streams SET audio_tracks=$1 WHERE id=$2', [JSON.stringify(tracks), req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) { const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0]; active.streamData = { ...active.streamData, ...updated }; }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/remove-audio-tracks', requireAuthApi, async (req, res) => {
  try {
    const { indices } = req.body;
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    let tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks : [];
    const sorted = [...indices].sort((a,b) => b - a);
    for (const i of sorted) {
      if (i >= 0 && i < tracks.length) {
        const t = tracks[i];
        if (t.path && fs.existsSync(t.path)) { try { fs.unlinkSync(t.path); } catch(e) {} }
        tracks.splice(i, 1);
      }
    }
    await pool.query('UPDATE streams SET audio_tracks=$1 WHERE id=$2', [JSON.stringify(tracks), req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) {
      const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0];
      active.streamData = { ...active.streamData, ...updated };
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/start', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.file_path || !fs.existsSync(stream.file_path)) return res.status(400).json({ error: 'No video/image file uploaded' });
    if (!stream.stream_key) return res.status(400).json({ error: 'No stream key set' });
    startFFmpeg(stream.id, stream);
    await pool.query('UPDATE streams SET status=$1 WHERE id=$2', ['live', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/stop', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const entry = activeStreams.get(stream.id);
    if (entry) { entry.restarting = true; try { entry.proc.kill('SIGKILL'); } catch(e) {} activeStreams.delete(stream.id); }
    await pool.query('UPDATE streams SET status=$1 WHERE id=$2', ['stopped', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/restart', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!activeStreams.has(stream.id)) return res.json({ success: false });
    startFFmpeg(stream.id, stream);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/streams/:id', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const entry = activeStreams.get(stream.id);
    if (entry) { entry.restarting = true; try { entry.proc.kill('SIGKILL'); } catch(e) {} activeStreams.delete(stream.id); }
    if (stream.file_path && fs.existsSync(stream.file_path)) { try { fs.unlinkSync(stream.file_path); } catch(e) {} }
    if (stream.thumb_path) { const tp = path.join(THUMB_DIR, path.basename(stream.thumb_path)); if (fs.existsSync(tp)) { try { fs.unlinkSync(tp); } catch(e) {} } }
    const tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks : [];
    for (const t of tracks) { if (t.path && fs.existsSync(t.path)) { try { fs.unlinkSync(t.path); } catch(e) {} } }
    await pool.query('DELETE FROM streams WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamForCheap running on port ' + PORT));
