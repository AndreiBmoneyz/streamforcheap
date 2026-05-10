const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Active streams map: userId -> { proc, streamKey }
const activeStreams = new Map();

// Upload directory
const UPLOAD_DIR = '/app/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, req.session.userId + '_' + Date.now() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20GB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.gif', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not supported'));
  }
});

// DB setup
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'starter',
    stream_slots INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS streams (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL DEFAULT 'My Stream',
    stream_key TEXT,
    file_path TEXT,
    file_name TEXT,
    resolution TEXT NOT NULL DEFAULT '1080p',
    status TEXT NOT NULL DEFAULT 'stopped',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).catch(console.error);

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// ==================== ROUTES ====================

// Landing page
app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>StreamForCheap — 24/7 YouTube Streaming for $5/month</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0a;
    --surface: #111111;
    --surface2: #1a1a1a;
    --border: rgba(255,255,255,0.08);
    --text: #ffffff;
    --muted: #888;
    --accent: #aaff00;
    --accent-dim: rgba(170,255,0,0.1);
    --accent-dim2: rgba(170,255,0,0.05);
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); overflow-x: hidden; }
  a { text-decoration: none; color: inherit; }

  /* NAV */
  nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; background: rgba(10,10,10,0.95); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); padding: 0 2rem; height: 64px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
  .nav-logo span { color: var(--accent); }
  .nav-links { display: flex; align-items: center; gap: 2rem; }
  .nav-links a { font-size: 14px; color: var(--muted); transition: color 0.15s; }
  .nav-links a:hover { color: var(--text); }
  .nav-btn { background: var(--accent); color: #000; padding: 8px 20px; border-radius: 8px; font-size: 14px; font-weight: 700; transition: opacity 0.15s; }
  .nav-btn:hover { opacity: 0.85; color: #000; }

  /* HERO */
  .hero { padding: 140px 2rem 100px; text-align: center; max-width: 900px; margin: 0 auto; }
  .hero-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--accent-dim); border: 1px solid rgba(170,255,0,0.2); border-radius: 99px; padding: 6px 16px; font-size: 13px; color: var(--accent); font-weight: 600; margin-bottom: 2rem; }
  .hero h1 { font-size: clamp(36px, 6vw, 72px); font-weight: 900; line-height: 1.05; letter-spacing: -2px; margin-bottom: 1.5rem; }
  .hero h1 span { color: var(--accent); }
  .hero p { font-size: 18px; color: var(--muted); line-height: 1.7; max-width: 600px; margin: 0 auto 2.5rem; }
  .hero-btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn-primary { background: var(--accent); color: #000; padding: 14px 32px; border-radius: 10px; font-size: 16px; font-weight: 800; transition: opacity 0.15s; }
  .btn-primary:hover { opacity: 0.85; color: #000; }
  .btn-secondary { background: var(--surface2); color: var(--text); padding: 14px 32px; border-radius: 10px; font-size: 16px; font-weight: 600; border: 1px solid var(--border); transition: border-color 0.15s; }
  .btn-secondary:hover { border-color: var(--accent); }
  .hero-note { font-size: 13px; color: var(--muted); margin-top: 1rem; }

  /* STATS */
  .stats { display: flex; justify-content: center; gap: 3rem; padding: 3rem 2rem; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-num { font-size: 36px; font-weight: 900; color: var(--accent); letter-spacing: -1px; }
  .stat-label { font-size: 13px; color: var(--muted); margin-top: 4px; }

  /* SECTIONS */
  section { padding: 80px 2rem; max-width: 1100px; margin: 0 auto; }
  .section-label { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; }
  .section-title { font-size: clamp(28px, 4vw, 44px); font-weight: 800; letter-spacing: -1px; margin-bottom: 16px; }
  .section-sub { font-size: 16px; color: var(--muted); line-height: 1.7; max-width: 560px; }

  /* HOW IT WORKS */
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; margin-top: 3rem; }
  .step { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.5rem; }
  .step-num { width: 40px; height: 40px; border-radius: 10px; background: var(--accent-dim); border: 1px solid rgba(170,255,0,0.2); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; color: var(--accent); margin-bottom: 1rem; }
  .step h3 { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
  .step p { font-size: 14px; color: var(--muted); line-height: 1.6; }

  /* COMPARISON */
  .comparison { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; margin-top: 3rem; }
  .comparison-header { display: grid; grid-template-columns: 2fr 1fr 1fr; padding: 1rem 1.5rem; background: var(--surface2); border-bottom: 1px solid var(--border); font-size: 14px; font-weight: 700; }
  .comparison-header .ours { color: var(--accent); }
  .comparison-row { display: grid; grid-template-columns: 2fr 1fr 1fr; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); font-size: 14px; align-items: center; }
  .comparison-row:last-child { border-bottom: none; }
  .comparison-row .feature { color: var(--muted); }
  .comparison-row .ours { color: var(--accent); font-weight: 700; }
  .comparison-row .theirs { color: #555; }
  .check { color: var(--accent); }
  .cross { color: #f87171; }

  /* PRICING */
  .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-top: 3rem; }
  .pricing-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 2rem; position: relative; transition: border-color 0.15s; }
  .pricing-card:hover { border-color: rgba(170,255,0,0.3); }
  .pricing-card.featured { border-color: var(--accent); background: var(--accent-dim2); }
  .pricing-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: var(--accent); color: #000; font-size: 11px; font-weight: 800; padding: 4px 14px; border-radius: 99px; white-space: nowrap; }
  .plan-name { font-size: 14px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .plan-price { font-size: 48px; font-weight: 900; letter-spacing: -2px; color: var(--text); margin-bottom: 4px; }
  .plan-price span { font-size: 18px; font-weight: 400; color: var(--muted); }
  .plan-streams { font-size: 14px; color: var(--muted); margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
  .plan-streams strong { color: var(--accent); font-size: 16px; }
  .plan-features { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-bottom: 1.5rem; }
  .plan-features li { font-size: 14px; color: #aaa; display: flex; align-items: center; gap: 8px; }
  .plan-features li::before { content: '✓'; color: var(--accent); font-weight: 700; flex-shrink: 0; }
  .plan-btn { width: 100%; padding: 12px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; border: none; transition: opacity 0.15s; }
  .plan-btn-primary { background: var(--accent); color: #000; }
  .plan-btn-primary:hover { opacity: 0.85; }
  .plan-btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .plan-btn-secondary:hover { border-color: var(--accent); }

  /* FAQ */
  .faq { margin-top: 3rem; display: flex; flex-direction: column; gap: 12px; }
  .faq-item { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .faq-q { padding: 1.25rem 1.5rem; font-size: 15px; font-weight: 600; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
  .faq-q:hover { color: var(--accent); }
  .faq-arrow { color: var(--muted); transition: transform 0.2s; font-size: 12px; }
  .faq-item.open .faq-arrow { transform: rotate(180deg); }
  .faq-a { padding: 0 1.5rem; max-height: 0; overflow: hidden; transition: max-height 0.3s, padding 0.3s; font-size: 14px; color: var(--muted); line-height: 1.7; }
  .faq-item.open .faq-a { max-height: 200px; padding: 0 1.5rem 1.25rem; }

  /* FOOTER */
  footer { border-top: 1px solid var(--border); padding: 3rem 2rem; text-align: center; }
  .footer-logo { font-size: 20px; font-weight: 800; margin-bottom: 1rem; }
  .footer-logo span { color: var(--accent); }
  .footer-links { display: flex; gap: 2rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .footer-links a { font-size: 13px; color: var(--muted); transition: color 0.15s; }
  .footer-links a:hover { color: var(--text); }
  .footer-copy { font-size: 12px; color: #444; }

  @media (max-width: 600px) {
    .nav-links { display: none; }
    .comparison-header, .comparison-row { grid-template-columns: 1.5fr 1fr 1fr; font-size: 12px; padding: 0.75rem 1rem; }
  }
</style>
</head>
<body>

<nav>
  <div class="nav-logo">stream<span>forcheap</span></div>
  <div class="nav-links">
    <a href="#how">How it works</a>
    <a href="#pricing">Pricing</a>
    <a href="#faq">FAQ</a>
  </div>
  <div style="display:flex;gap:10px;align-items:center;">
    <a href="/login" style="font-size:14px;color:var(--muted);">Log in</a>
    <a href="/register" class="nav-btn">Get started</a>
  </div>
</nav>

<div class="hero">
  <div class="hero-badge">🟢 Streams running 24/7</div>
  <h1>24/7 YouTube Streaming<br>for <span>$5/month</span></h1>
  <p>Upload your video, enter your stream key, and we stream it to YouTube forever. No PC needed. No technical knowledge required.</p>
  <div class="hero-btns">
    <a href="/register" class="btn-primary">Start streaming — $5/mo</a>
    <a href="#how" class="btn-secondary">See how it works</a>
  </div>
  <div class="hero-note">No credit card required to create account · Cancel anytime</div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-num">$5</div><div class="stat-label">per stream per month</div></div>
  <div class="stat"><div class="stat-num">24/7</div><div class="stat-label">always streaming</div></div>
  <div class="stat"><div class="stat-num">1080p</div><div class="stat-label">full HD quality</div></div>
  <div class="stat"><div class="stat-num">10x</div><div class="stat-label">cheaper than competitors</div></div>
</div>

<section id="how">
  <div class="section-label">How it works</div>
  <div class="section-title">Up and running in 3 minutes</div>
  <p class="section-sub">No technical knowledge needed. If you can upload a file, you can set up a 24/7 stream.</p>
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <h3>Create your account</h3>
      <p>Sign up in seconds. No credit card needed to get started.</p>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <h3>Upload your content</h3>
      <p>Upload any image, GIF, or video file up to 12 hours long. We support all formats.</p>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <h3>Add your stream key</h3>
      <p>Paste your YouTube stream key. Find it in YouTube Studio under Live Streaming.</p>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <h3>Hit start</h3>
      <p>Your stream goes live instantly and runs 24/7. Turn off your PC — we handle everything.</p>
    </div>
  </div>
</section>

<section>
  <div class="section-label">Comparison</div>
  <div class="section-title">Why pay more?</div>
  <p class="section-sub">We do exactly what the expensive tools do, for a fraction of the price.</p>
  <div class="comparison">
    <div class="comparison-header">
      <div>Feature</div>
      <div class="ours">StreamForCheap</div>
      <div>Competitors</div>
    </div>
    <div class="comparison-row">
      <div class="feature">Price per stream</div>
      <div class="ours">$5/month</div>
      <div class="theirs">$24-49/month</div>
    </div>
    <div class="comparison-row">
      <div class="feature">24/7 streaming</div>
      <div class="ours check">✓</div>
      <div class="theirs check">✓</div>
    </div>
    <div class="comparison-row">
      <div class="feature">1080p quality</div>
      <div class="ours check">✓</div>
      <div class="theirs check">✓</div>
    </div>
    <div class="comparison-row">
      <div class="feature">Image, GIF & video support</div>
      <div class="ours check">✓</div>
      <div class="theirs check">✓</div>
    </div>
    <div class="comparison-row">
      <div class="feature">Auto-restart on crash</div>
      <div class="ours check">✓</div>
      <div class="theirs check">✓</div>
    </div>
    <div class="comparison-row">
      <div class="feature">Up to 12 hour video loops</div>
      <div class="ours check">✓</div>
      <div class="theirs cross">✗ extra cost</div>
    </div>
    <div class="comparison-row">
      <div class="feature">No watermark</div>
      <div class="ours check">✓</div>
      <div class="theirs cross">✗ paid plans only</div>
    </div>
  </div>
</section>

<section id="pricing">
  <div class="section-label">Pricing</div>
  <div class="section-title">Simple, honest pricing</div>
  <p class="section-sub">No hidden fees. No per-platform charges. No watermarks. Just streams.</p>
  <div class="pricing-grid">
    <div class="pricing-card">
      <div class="plan-name">Starter</div>
      <div class="plan-price">$2<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — static image or GIF only</div>
      <ul class="plan-features">
        <li>720p quality</li>
        <li>24/7 streaming</li>
        <li>Auto-restart on crash</li>
        <li>Up to 20GB file size</li>
        <li>No watermark</li>
      </ul>
      <a href="/register"><button class="plan-btn plan-btn-secondary">Get started</button></a>
    </div>
    <div class="pricing-card featured">
      <div class="pricing-badge">MOST POPULAR</div>
      <div class="plan-name">Pro</div>
      <div class="plan-price">$5<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — image, GIF, or video loop</div>
      <ul class="plan-features">
        <li>1080p quality</li>
        <li>24/7 streaming</li>
        <li>Auto-restart on crash</li>
        <li>Up to 20GB file size</li>
        <li>Video loops up to 12 hours</li>
        <li>No watermark</li>
      </ul>
      <a href="/register"><button class="plan-btn plan-btn-primary">Get started</button></a>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Creator</div>
      <div class="plan-price">$12<span>/mo</span></div>
      <div class="plan-streams"><strong>3 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features">
        <li>1080p quality</li>
        <li>24/7 streaming</li>
        <li>Auto-restart on crash</li>
        <li>Up to 20GB per stream</li>
        <li>Video loops up to 12 hours</li>
        <li>No watermark</li>
      </ul>
      <a href="/register"><button class="plan-btn plan-btn-secondary">Get started</button></a>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Studio</div>
      <div class="plan-price">$20<span>/mo</span></div>
      <div class="plan-streams"><strong>6 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features">
        <li>1080p quality</li>
        <li>24/7 streaming</li>
        <li>Auto-restart on crash</li>
        <li>Up to 20GB per stream</li>
        <li>Video loops up to 12 hours</li>
        <li>No watermark</li>
      </ul>
      <a href="/register"><button class="plan-btn plan-btn-secondary">Get started</button></a>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Agency</div>
      <div class="plan-price">$35<span>/mo</span></div>
      <div class="plan-streams"><strong>12 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features">
        <li>1080p quality</li>
        <li>24/7 streaming</li>
        <li>Auto-restart on crash</li>
        <li>Up to 20GB per stream</li>
        <li>Video loops up to 12 hours</li>
        <li>No watermark</li>
        <li>Priority support</li>
      </ul>
      <a href="/register"><button class="plan-btn plan-btn-secondary">Get started</button></a>
    </div>
  </div>
</section>

<section id="faq">
  <div class="section-label">FAQ</div>
  <div class="section-title">Got questions?</div>
  <div class="faq">
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">Do I need to keep my computer on? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">No. Once you start your stream it runs on our servers 24/7. You can turn off your PC completely.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">What file types are supported? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">We support images (JPG, PNG, WebP), GIFs, and videos (MP4, MOV, AVI, MKV, WebM). Files can be up to 20GB.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">Where do I find my YouTube stream key? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">Go to YouTube Studio → Go Live → Stream. Your stream key is listed there. Keep it private — anyone with it can stream to your channel.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">What happens if the stream crashes? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">Our system automatically detects crashes and restarts your stream within seconds. No action needed from you.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">Can I change my video after the stream starts? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">Yes. Stop your stream, upload a new file, and restart. The whole process takes less than a minute.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">Is this against YouTube's terms of service? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">No. Streaming pre-recorded content is explicitly allowed by YouTube. Thousands of channels do this for lofi, ambient, study music and more.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)">Can I cancel anytime? <span class="faq-arrow">▼</span></div>
      <div class="faq-a">Yes. Cancel anytime from your dashboard. No contracts, no cancellation fees.</div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-logo">stream<span>forcheap</span></div>
  <div class="footer-links">
    <a href="#how">How it works</a>
    <a href="#pricing">Pricing</a>
    <a href="#faq">FAQ</a>
    <a href="/login">Login</a>
    <a href="/register">Sign up</a>
  </div>
  <div class="footer-copy">© 2026 StreamForCheap. The cheapest 24/7 streaming service on the internet.</div>
</footer>

<script>
function toggleFaq(el) {
  const item = el.closest('.faq-item');
  item.classList.toggle('open');
}
</script>
</body>
</html>`);
});

// Register page
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sign Up — StreamForCheap</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .card { background: #111; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 2.5rem; max-width: 420px; width: 100%; }
  .logo { font-size: 20px; font-weight: 800; margin-bottom: 2rem; text-align: center; }
  .logo span { color: #aaff00; }
  h1 { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 2rem; }
  .field { margin-bottom: 16px; }
  .field label { font-size: 13px; color: #888; display: block; margin-bottom: 6px; }
  .field input { width: 100%; padding: 12px 14px; background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.15s; }
  .field input:focus { border-color: #aaff00; }
  .btn { width: 100%; padding: 13px; background: #aaff00; color: #000; font-size: 15px; font-weight: 700; border-radius: 10px; border: none; cursor: pointer; transition: opacity 0.15s; margin-top: 8px; }
  .btn:hover { opacity: 0.85; }
  .link { text-align: center; font-size: 13px; color: #666; margin-top: 1.5rem; }
  .link a { color: #aaff00; }
  .error { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .plan-select { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
  .plan-opt { border: 1.5px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; cursor: pointer; text-align: center; transition: all 0.15s; }
  .plan-opt:hover { border-color: #aaff00; }
  .plan-opt.selected { border-color: #aaff00; background: rgba(170,255,0,0.08); }
  .plan-opt .price { font-size: 20px; font-weight: 800; color: #aaff00; }
  .plan-opt .name { font-size: 12px; color: #888; margin-top: 2px; }
  .plan-opt .streams { font-size: 11px; color: #666; margin-top: 2px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">stream<span>forcheap</span></div>
  <h1>Create account</h1>
  <p class="sub">Start your 24/7 stream today</p>
  <div class="error" id="error"></div>
  <div class="field">
    <label>Choose your plan</label>
    <div class="plan-select">
      <div class="plan-opt" id="plan-starter" onclick="selectPlan('starter')">
        <div class="price">$2</div>
        <div class="name">Starter</div>
        <div class="streams">1 stream · 720p</div>
      </div>
      <div class="plan-opt selected" id="plan-pro" onclick="selectPlan('pro')">
        <div class="price">$5</div>
        <div class="name">Pro ⭐</div>
        <div class="streams">1 stream · 1080p</div>
      </div>
      <div class="plan-opt" id="plan-creator" onclick="selectPlan('creator')">
        <div class="price">$12</div>
        <div class="name">Creator</div>
        <div class="streams">3 streams · 1080p</div>
      </div>
      <div class="plan-opt" id="plan-studio" onclick="selectPlan('studio')">
        <div class="price">$20</div>
        <div class="name">Studio</div>
        <div class="streams">6 streams · 1080p</div>
      </div>
    </div>
  </div>
  <div class="field">
    <label>Email address</label>
    <input type="email" id="email" placeholder="you@example.com" />
  </div>
  <div class="field">
    <label>Password</label>
    <input type="password" id="password" placeholder="Min 8 characters" />
  </div>
  <button class="btn" onclick="register()">Create account</button>
  <div class="link">Already have an account? <a href="/login">Log in</a></div>
  <div style="font-size:11px;color:#444;text-align:center;margin-top:1rem;">Payment collected manually — we'll contact you after signup</div>
</div>
<script>
let selectedPlan = 'pro';
function selectPlan(plan) {
  selectedPlan = plan;
  document.querySelectorAll('.plan-opt').forEach(el => el.classList.remove('selected'));
  document.getElementById('plan-' + plan).classList.add('selected');
}
async function register() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error');
  if (!email || !password) { errorEl.textContent = 'Please fill in all fields'; errorEl.style.display = 'block'; return; }
  if (password.length < 8) { errorEl.textContent = 'Password must be at least 8 characters'; errorEl.style.display = 'block'; return; }
  const res = await fetch('/api/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email, password, plan: selectedPlan }) });
  const data = await res.json();
  if (data.error) { errorEl.textContent = data.error; errorEl.style.display = 'block'; return; }
  window.location.href = '/dashboard';
}
</script>
</body>
</html>`);
});

// Login page
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Log In — StreamForCheap</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .card { background: #111; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 2.5rem; max-width: 420px; width: 100%; }
  .logo { font-size: 20px; font-weight: 800; margin-bottom: 2rem; text-align: center; }
  .logo span { color: #aaff00; }
  h1 { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 2rem; }
  .field { margin-bottom: 16px; }
  .field label { font-size: 13px; color: #888; display: block; margin-bottom: 6px; }
  .field input { width: 100%; padding: 12px 14px; background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.15s; }
  .field input:focus { border-color: #aaff00; }
  .btn { width: 100%; padding: 13px; background: #aaff00; color: #000; font-size: 15px; font-weight: 700; border-radius: 10px; border: none; cursor: pointer; transition: opacity 0.15s; margin-top: 8px; }
  .btn:hover { opacity: 0.85; }
  .link { text-align: center; font-size: 13px; color: #666; margin-top: 1.5rem; }
  .link a { color: #aaff00; }
  .error { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">stream<span>forcheap</span></div>
  <h1>Welcome back</h1>
  <p class="sub">Log in to manage your streams</p>
  <div class="error" id="error"></div>
  <div class="field">
    <label>Email address</label>
    <input type="email" id="email" placeholder="you@example.com" />
  </div>
  <div class="field">
    <label>Password</label>
    <input type="password" id="password" placeholder="Your password" />
  </div>
  <button class="btn" onclick="login()">Log in</button>
  <div class="link">Don't have an account? <a href="/register">Sign up</a></div>
</div>
<script>
async function login() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error');
  const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (data.error) { errorEl.textContent = data.error; errorEl.style.display = 'block'; return; }
  window.location.href = '/dashboard';
}
document.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
</script>
</body>
</html>`);
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId])).rows[0];
  const streams = (await pool.query('SELECT * FROM streams WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId])).rows;

  const planSlots = { starter: 1, pro: 1, creator: 3, studio: 6, agency: 12 };
  const maxSlots = planSlots[user.plan] || 1;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dashboard — StreamForCheap</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0a0a0a; --surface: #111; --surface2: #1a1a1a; --border: rgba(255,255,255,0.08); --accent: #aaff00; --muted: #888; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: #fff; min-height: 100vh; }
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 2rem; height: 64px; display: flex; align-items: center; justify-content: space-between; position: fixed; top: 0; left: 0; right: 0; z-index: 100; }
  .logo { font-size: 18px; font-weight: 800; }
  .logo span { color: var(--accent); }
  .topbar-right { display: flex; align-items: center; gap: 16px; }
  .plan-badge { background: rgba(170,255,0,0.1); border: 1px solid rgba(170,255,0,0.2); color: var(--accent); font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 99px; text-transform: uppercase; }
  .logout { font-size: 13px; color: var(--muted); text-decoration: none; }
  .logout:hover { color: #f87171; }
  .main { max-width: 900px; margin: 0 auto; padding: 84px 1rem 4rem; }
  .page-title { font-size: 26px; font-weight: 800; margin-bottom: 4px; letter-spacing: -0.5px; }
  .page-sub { font-size: 14px; color: var(--muted); margin-bottom: 2rem; }
  .streams-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .streams-header h2 { font-size: 16px; font-weight: 700; }
  .slots-info { font-size: 13px; color: var(--muted); }
  .add-btn { background: var(--accent); color: #000; border: none; border-radius: 8px; padding: 9px 18px; font-size: 14px; font-weight: 700; cursor: pointer; transition: opacity 0.15s; }
  .add-btn:hover { opacity: 0.85; }
  .add-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stream-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.5rem; margin-bottom: 12px; }
  .stream-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 10px; }
  .stream-name { font-size: 17px; font-weight: 700; }
  .stream-status { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-live { color: var(--accent); }
  .status-live .status-dot { background: var(--accent); animation: pulse 1.5s infinite; }
  .status-stopped { color: var(--muted); }
  .status-stopped .status-dot { background: #444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .stream-info { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 1rem; }
  .stream-info-item { font-size: 13px; color: var(--muted); }
  .stream-info-item strong { color: #ccc; }
  .stream-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn-start { background: var(--accent); color: #000; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity 0.15s; }
  .btn-start:hover { opacity: 0.85; }
  .btn-stop { background: rgba(248,113,113,0.1); color: #f87171; border: 1px solid rgba(248,113,113,0.3); border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.15s; }
  .btn-stop:hover { background: rgba(248,113,113,0.2); }
  .btn-edit { background: var(--surface2); color: #aaa; border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-edit:hover { border-color: var(--accent); color: var(--accent); }
  .btn-delete { background: transparent; color: #555; border: 1px solid #222; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .btn-delete:hover { color: #f87171; border-color: #f87171; }
  .empty-state { text-align: center; padding: 4rem 2rem; background: var(--surface); border: 1px dashed #222; border-radius: 14px; }
  .empty-icon { font-size: 48px; margin-bottom: 1rem; }
  .empty-state h3 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
  .empty-state p { font-size: 14px; color: var(--muted); margin-bottom: 1.5rem; }

  /* MODAL */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 200; display: none; align-items: center; justify-content: center; padding: 1rem; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 2rem; max-width: 500px; width: 100%; max-height: 90vh; overflow-y: auto; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .modal-header h2 { font-size: 20px; font-weight: 800; }
  .modal-close { background: none; border: none; color: #555; font-size: 22px; cursor: pointer; }
  .modal-close:hover { color: #fff; }
  .field { margin-bottom: 16px; }
  .field label { font-size: 13px; color: var(--muted); display: block; margin-bottom: 6px; }
  .field input, .field select { width: 100%; padding: 11px 14px; background: var(--surface2); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 14px; outline: none; transition: border-color 0.15s; }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .field select option { background: #1a1a1a; }
  .field-note { font-size: 11px; color: #555; margin-top: 5px; line-height: 1.5; }
  .upload-zone { border: 1.5px dashed #2a2a2a; border-radius: 10px; padding: 1.5rem; text-align: center; cursor: pointer; position: relative; transition: all 0.15s; }
  .upload-zone:hover { border-color: var(--accent); background: rgba(170,255,0,0.03); }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-zone.done { border-color: var(--accent); border-style: solid; }
  .upload-zone p { font-size: 13px; color: #555; }
  .upload-zone.done p { color: var(--accent); font-weight: 600; }
  .modal-btn { width: 100%; padding: 13px; background: var(--accent); color: #000; font-size: 15px; font-weight: 700; border-radius: 10px; border: none; cursor: pointer; transition: opacity 0.15s; margin-top: 8px; }
  .modal-btn:hover { opacity: 0.85; }
  .modal-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .progress-wrap { margin-top: 12px; display: none; }
  .progress-track { height: 4px; background: #222; border-radius: 99px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 99px; width: 0%; transition: width 0.3s; }
  .progress-label { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .error-box { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 10px; display: none; }
</style>
</head>
<body>

<div class="topbar">
  <div class="logo">stream<span>forcheap</span></div>
  <div class="topbar-right">
    <span class="plan-badge">${user.plan}</span>
    <a href="/logout" class="logout">Log out</a>
  </div>
</div>

<!-- ADD/EDIT STREAM MODAL -->
<div class="modal-overlay" id="stream-modal">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modal-title">Add stream</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="field">
      <label>Stream name</label>
      <input type="text" id="stream-name" placeholder="My Lofi Stream" />
    </div>
    <div class="field">
      <label>YouTube Stream Key</label>
      <input type="password" id="stream-key" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx" />
      <div class="field-note">Find this in YouTube Studio → Go Live → Stream. Keep it private.</div>
    </div>
    <div class="field">
      <label>Resolution</label>
      <select id="stream-res">
        <option value="720p">720p (Starter plan)</option>
        <option value="1080p" selected>1080p (Pro and above)</option>
      </select>
    </div>
    <div class="field">
      <label>Upload your video, image, or GIF</label>
      <div class="upload-zone" id="upload-zone">
        <input type="file" id="stream-file" accept=".mp4,.mov,.avi,.mkv,.webm,.gif,.jpg,.jpeg,.png,.webp" onchange="handleFileSelect(event)" />
        <p id="upload-label">📁 Click to upload or drag file here<br><span style="font-size:11px;color:#444;">MP4, MOV, GIF, JPG, PNG — up to 20GB</span></p>
      </div>
    </div>
    <div class="progress-wrap" id="upload-progress">
      <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label" id="progress-label">Uploading...</div>
    </div>
    <div class="error-box" id="modal-error"></div>
    <button class="modal-btn" id="save-btn" onclick="saveStream()">Save stream</button>
  </div>
</div>

<div class="main">
  <div class="page-title">Your Streams</div>
  <div class="page-sub">${user.email} · ${user.plan} plan</div>

  <div class="streams-header">
    <h2>Streams <span class="slots-info">(${streams.length}/${maxSlots} slots used)</span></h2>
    <button class="add-btn" id="add-btn" onclick="openModal()" ${streams.length >= maxSlots ? 'disabled' : ''}>+ Add stream</button>
  </div>

  <div id="streams-list">
    ${streams.length === 0 ? `
    <div class="empty-state">
      <div class="empty-icon">📡</div>
      <h3>No streams yet</h3>
      <p>Add your first stream to get started. It only takes a minute.</p>
      <button class="add-btn" onclick="openModal()">+ Add your first stream</button>
    </div>
    ` : streams.map(s => {
      const isLive = activeStreams.has(s.id);
      return `
      <div class="stream-card" id="stream-${s.id}">
        <div class="stream-top">
          <div class="stream-name">${s.name}</div>
          <div class="stream-status ${isLive ? 'status-live' : 'status-stopped'}">
            <div class="status-dot"></div>
            ${isLive ? 'LIVE' : 'Stopped'}
          </div>
        </div>
        <div class="stream-info">
          <div class="stream-info-item"><strong>File:</strong> ${s.file_name || 'No file uploaded'}</div>
          <div class="stream-info-item"><strong>Resolution:</strong> ${s.resolution}</div>
          <div class="stream-info-item"><strong>Stream key:</strong> ${s.stream_key ? '••••••••' : 'Not set'}</div>
        </div>
        <div class="stream-actions">
          ${!isLive ? `<button class="btn-start" onclick="startStream(${s.id})" ${!s.file_path || !s.stream_key ? 'disabled title="Upload a file and add stream key first"' : ''}>▶ Start stream</button>` : ''}
          ${isLive ? `<button class="btn-stop" onclick="stopStream(${s.id})">⬛ Stop stream</button>` : ''}
          <button class="btn-edit" onclick="editStream(${s.id}, '${s.name}', '${s.stream_key || ''}', '${s.resolution}')">✏️ Edit</button>
          <button class="btn-delete" onclick="deleteStream(${s.id})">🗑 Delete</button>
        </div>
      </div>
      `;
    }).join('')}
  </div>
</div>

<script>
let editingStreamId = null;
let selectedFile = null;

function openModal(streamId) {
  editingStreamId = null;
  selectedFile = null;
  document.getElementById('modal-title').textContent = 'Add stream';
  document.getElementById('stream-name').value = '';
  document.getElementById('stream-key').value = '';
  document.getElementById('stream-res').value = '1080p';
  document.getElementById('upload-label').innerHTML = '📁 Click to upload or drag file here<br><span style="font-size:11px;color:#444;">MP4, MOV, GIF, JPG, PNG — up to 20GB</span>';
  document.getElementById('upload-zone').classList.remove('done');
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'none';
  document.getElementById('stream-modal').classList.add('open');
}

function editStream(id, name, key, res) {
  editingStreamId = id;
  document.getElementById('modal-title').textContent = 'Edit stream';
  document.getElementById('stream-name').value = name;
  document.getElementById('stream-key').value = key;
  document.getElementById('stream-res').value = res;
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('stream-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('stream-modal').classList.remove('open');
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  document.getElementById('upload-label').innerHTML = '✓ ' + file.name + '<br><span style="font-size:11px;color:#aaff00;">' + (file.size / 1024 / 1024).toFixed(1) + ' MB</span>';
  document.getElementById('upload-zone').classList.add('done');
}

async function saveStream() {
  const name = document.getElementById('stream-name').value.trim();
  const key = document.getElementById('stream-key').value.trim();
  const res = document.getElementById('stream-res').value;
  const errorEl = document.getElementById('modal-error');
  const saveBtn = document.getElementById('save-btn');

  if (!name) { errorEl.textContent = 'Please enter a stream name'; errorEl.style.display = 'block'; return; }

  saveBtn.disabled = true;
  errorEl.style.display = 'none';

  if (editingStreamId) {
    // Update existing stream
    const r = await fetch('/api/streams/' + editingStreamId, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, streamKey: key, resolution: res })
    });
    const data = await r.json();
    if (data.error) { errorEl.textContent = data.error; errorEl.style.display = 'block'; saveBtn.disabled = false; return; }
    closeModal();
    location.reload();
    return;
  }

  // Create new stream then upload file
  const r = await fetch('/api/streams', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, streamKey: key, resolution: res })
  });
  const data = await r.json();
  if (data.error) { errorEl.textContent = data.error; errorEl.style.display = 'block'; saveBtn.disabled = false; return; }

  const streamId = data.id;

  if (selectedFile) {
    const formData = new FormData();
    formData.append('file', selectedFile);

    const progressWrap = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressLabel = document.getElementById('progress-label');
    progressWrap.style.display = 'block';

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
        progressLabel.textContent = 'Uploading ' + pct + '%...';
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        closeModal();
        location.reload();
      } else {
        errorEl.textContent = 'File upload failed. Please try again.';
        errorEl.style.display = 'block';
        saveBtn.disabled = false;
      }
    };
    xhr.onerror = () => {
      errorEl.textContent = 'Upload error. Please try again.';
      errorEl.style.display = 'block';
      saveBtn.disabled = false;
    };
    xhr.open('POST', '/api/streams/' + streamId + '/upload');
    xhr.send(formData);
  } else {
    closeModal();
    location.reload();
  }
}

async function startStream(id) {
  const btn = document.querySelector('#stream-' + id + ' .btn-start');
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  const res = await fetch('/api/streams/' + id + '/start', { method: 'POST' });
  const data = await res.json();
  if (data.error) { alert(data.error); location.reload(); return; }
  location.reload();
}

async function stopStream(id) {
  const res = await fetch('/api/streams/' + id + '/stop', { method: 'POST' });
  location.reload();
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

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ==================== API ROUTES ====================

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, plan } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password too short' });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });
    const planSlots = { starter: 1, pro: 1, creator: 3, studio: 6, agency: 12 };
    const slots = planSlots[plan] || 1;
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, plan, stream_slots) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hashed, plan || 'pro', slots]
    );
    req.session.userId = result.rows[0].id;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams', requireAuth, async (req, res) => {
  try {
    const { name, streamKey, resolution } = req.body;
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId])).rows[0];
    const count = (await pool.query('SELECT COUNT(*) FROM streams WHERE user_id = $1', [req.session.userId])).rows[0].count;
    if (parseInt(count) >= user.stream_slots) return res.status(400).json({ error: 'Stream slot limit reached. Upgrade your plan.' });
    const result = await pool.query(
      'INSERT INTO streams (user_id, name, stream_key, resolution) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.session.userId, name, streamKey || null, resolution || '1080p']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/streams/:id', requireAuth, async (req, res) => {
  try {
    const { name, streamKey, resolution } = req.body;
    const stream = (await pool.query('SELECT * FROM streams WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    await pool.query(
      'UPDATE streams SET name = $1, stream_key = $2, resolution = $3 WHERE id = $4',
      [name, streamKey || null, resolution, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    // Delete old file
    if (stream.file_path && fs.existsSync(stream.file_path)) {
      try { fs.unlinkSync(stream.file_path); } catch(e) {}
    }
    await pool.query('UPDATE streams SET file_path = $1, file_name = $2 WHERE id = $3',
      [req.file.path, req.file.originalname, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/start', requireAuth, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.file_path || !fs.existsSync(stream.file_path)) return res.status(400).json({ error: 'No file uploaded for this stream' });
    if (!stream.stream_key) return res.status(400).json({ error: 'No stream key set' });
    if (activeStreams.has(stream.id)) return res.status(400).json({ error: 'Stream already running' });

    const width = stream.resolution === '1080p' ? 1920 : 1280;
    const height = stream.resolution === '1080p' ? 1080 : 720;
    const ext = path.extname(stream.file_path).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);

    let ffmpegArgs;
    if (isImage) {
      ffmpegArgs = [
        '-loop', '1', '-framerate', '1', '-i', stream.file_path,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
        '-c:a', 'aac', '-b:a', '320k', '-ar', '44100',
        '-f', 'flv', '-threads', '0',
        `rtmp://a.rtmp.youtube.com/live2/${stream.stream_key}`
      ];
    } else {
      ffmpegArgs = [
        '-re', '-stream_loop', '-1', '-i', stream.file_path,
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
        '-c:a', 'aac', '-b:a', '320k', '-ar', '44100',
        '-f', 'flv', '-threads', '0',
        `rtmp://a.rtmp.youtube.com/live2/${stream.stream_key}`
      ];
    }

    const startFFmpeg = () => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      activeStreams.set(stream.id, { proc, streamKey: stream.stream_key });

      proc.stderr.on('data', () => {});
      proc.on('close', (code) => {
        if (activeStreams.has(stream.id)) {
          // Auto-restart after 3 seconds
          setTimeout(() => {
            if (activeStreams.has(stream.id)) {
              activeStreams.delete(stream.id);
              startFFmpeg();
            }
          }, 3000);
        }
      });
    };

    startFFmpeg();
    await pool.query('UPDATE streams SET status = $1 WHERE id = $2', ['live', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/stop', requireAuth, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const streamData = activeStreams.get(stream.id);
    if (streamData) {
      try { streamData.proc.kill('SIGKILL'); } catch(e) {}
      activeStreams.delete(stream.id);
    }
    await pool.query('UPDATE streams SET status = $1 WHERE id = $2', ['stopped', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/streams/:id', requireAuth, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    // Stop if running
    const streamData = activeStreams.get(stream.id);
    if (streamData) {
      try { streamData.proc.kill('SIGKILL'); } catch(e) {}
      activeStreams.delete(stream.id);
    }
    // Delete file
    if (stream.file_path && fs.existsSync(stream.file_path)) {
      try { fs.unlinkSync(stream.file_path); } catch(e) {}
    }
    await pool.query('DELETE FROM streams WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamForCheap running on port ' + PORT));
