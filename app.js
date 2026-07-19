const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const flash = require('connect-flash');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const gatewayRoutes = require('./routes/gateway');
const adminRoutes = require('./routes/admin');
const dealerRoutes = require('./routes/dealer');
const customerRoutes = require('./routes/customer');
const catalogRoutes = require('./routes/catalog');
const backupRoutes = require('./routes/backup');
const whatsappRoutes = require('./routes/whatsapp');
const Setting = require('./models/Setting');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(compression());

app.get('/healthz', (req, res) => res.status(200).send('ok'));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: 'محاولات تسجيل دخول كثيرة، يرجى الانتظار 15 دقيقة'
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d'
}));

// ✅ تم استبدال body-parser بمزايا Express المدمجة
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      const val = req.body[key];
      if (Array.isArray(val)) {
        const nonEmpty = [...val].reverse().find(v => v !== '' && v !== undefined && v !== null);
        req.body[key] = nonEmpty !== undefined ? nonEmpty : (val[val.length - 1] ?? '');
      }
    }
  }
  next();
});

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error('SESSION_SECRET is not set.');
  process.exit(1);
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 86400,
    autoRemove: 'native'
  }),
  cookie: {
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'strict',
    secure: true   // ✅ الموقع على HTTPS — الكوكي لا يُرسل إلا عبر HTTPS
  }
}));

app.use(flash());

let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_TTL = 30 * 1000;

app.use(async (req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.currentPath = req.path;
  try {
    if (!_settingsCache || Date.now() - _settingsCacheAt > SETTINGS_TTL) {
      let s = await Setting.findOne();
      if (!s) { s = new Setting(); await s.save(); }
      _settingsCache = s;
      _settingsCacheAt = Date.now();
    }
    res.locals.settings = _settingsCache;
  } catch(e) {
    res.locals.settings = _settingsCache || new Setting();
  }
  next();
});

app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/uploads') ||
      req.path === '/' || req.path === '/login' || req.path === '/logout') return next();
  try {
    const s = res.locals.settings;
    if (s && s.maintenanceMode) {
      return res.status(503).send(`
        <!DOCTYPE html><html lang="ar" dir="rtl">
        <head><meta charset="UTF-8"><title>صيانة</title>
        <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Cairo',sans-serif;background:#1E1B4B;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px;}
        .box{background:rgba(255,255,255,.08);border-radius:20px;padding:48px 40px;max-width:480px;}
        .icon{font-size:64px;margin-bottom:20px;}h1{font-size:28px;margin-bottom:12px;}p{opacity:.75;font-size:15px;line-height:1.7;}</style>
        </head><body><div class="box">
        <div class="icon">🔧</div>
        <h1>النظام تحت الصيانة</h1>
        <p>${s.maintenanceMessage || 'يرجى المحاولة لاحقاً'}</p>
        </div></body></html>
      `);
    }
  } catch(e) {}
  next();
});

app.use('/', gatewayRoutes);
app.use('/admin', adminRoutes);
app.use('/admin/backups', backupRoutes);
app.use('/dealer', dealerRoutes);
app.use('/customer', customerRoutes);
app.use('/catalog', catalogRoutes);
app.use('/admin', whatsappRoutes);

app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', { error: err.message });
});

module.exports = app;
module.exports.loginLimiter = loginLimiter;
// ✅ دالة مسح كاش الإعدادات — تُستدعى بعد تغيير الإعدادات مباشرة
module.exports.clearSettingsCache = () => { _settingsCache = null; _settingsCacheAt = 0; };