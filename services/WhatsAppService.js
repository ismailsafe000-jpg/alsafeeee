'use strict';
/**
 * WhatsAppService — إدارة جلسة WhatsApp وإرسال الرسائل
 * يستخدم @whiskeysockets/baileys
 *
 * التحسينات:
 * ① Queue: طابور إرسال يمنع التعارض بين رسائل متزامنة
 * ② Watchdog: كل 4 دقائق يتحقق أن الاتصال حي فعلاً
 * ③ Fallback version: إصدار احتياطي إذا فشل fetchLatestBaileysVersion
 * ④ Session cleanup: كل 6 ساعات يحذف pre-keys القديمة من MongoDB
 * ⑤ Stale lock: يحذف القفل اليتيم فور الـ startup
 */

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom }              = require('@hapi/boom');
const { useMongoAuthState } = require('./MongoAuthState');
const QRCode                = require('qrcode');
const pino                  = require('pino');
const mongoose              = require('mongoose');
const crypto                = require('crypto');

// ─── ثوابت ────────────────────────────────────────────────────────────────────
const INSTANCE_ID            = crypto.randomBytes(8).toString('hex');
const LOCK_TTL_MS            = 90_000;
const LOCK_RENEW_MS          = 30_000;
const WATCHDOG_INTERVAL_MS   = 4 * 60 * 1000;   // ② كل 4 دقائق
const SESSION_CLEANUP_MS     = 6 * 60 * 60 * 1000; // ④ كل 6 ساعات
const MAX_PREKEYS_TO_KEEP    = 300;
const FALLBACK_WA_VERSION    = [2, 3000, 1015901307]; // ③ إصدار احتياطي
const RECONNECT_DELAY_NORMAL = 20;   // ثواني — قلّلنا من 30 إلى 20 للسرعة
const RECONNECT_DELAY_LOCKED = 60;
const CONFLICT_DELAYS        = [15, 30, 60, 120, 300];

// ─── Lock model ──────────────────────────────────────────────────────────────
const _lockSchema = new mongoose.Schema(
  { _id: { type: String, default: 'wa-lock' }, instanceId: String, acquiredAt: Date, expiresAt: Date },
  { versionKey: false }
);
const WaLock = mongoose.models.WaLock || mongoose.model('WaLock', _lockSchema);

// ─── حالة داخلية ─────────────────────────────────────────────────────────────
let _sock            = null;
let _status          = 'disconnected';
let _qrBase64        = null;
let _reconnectTimer  = null;
let _lockRenewTimer  = null;
let _watchdogTimer   = null;
let _cleanupTimer    = null;
let _initialized     = false;
let _hasLock         = false;
let _conflictRetries = 0;
let _messageHandler  = null;   // مستمع الرسائل الواردة

// ─── ① طابور الإرسال ─────────────────────────────────────────────────────────
// يضمن عدم إرسال رسالتين في نفس الوقت — يمنع "Stream Errored"
let _sendQueue   = Promise.resolve();
function _enqueue(fn) {
  _sendQueue = _sendQueue.then(fn).catch(() => {});
  return _sendQueue;
}

// ─── ⑤ حذف القفل اليتيم عند الـ startup ─────────────────────────────────────
async function _clearStaleLockOnStartup() {
  try {
    // حذف أي قفل موجود (سواء منهي أو لا) — Instance جديد يأخذ الأولوية دائماً
    const now  = new Date();
    const lock = await WaLock.findById('wa-lock');
    if (lock && lock.instanceId !== INSTANCE_ID) {
      await WaLock.deleteOne({ _id: 'wa-lock' });
      console.log('[WhatsApp] 🗑️ حُذف قفل قديم من instance آخر —_instance جديد يأخذ الأولوية');
    }
  } catch (_) {}
}

// ─── إدارة القفل ─────────────────────────────────────────────────────────────
async function _acquireLock() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    await WaLock.findOneAndUpdate(
      { _id: 'wa-lock', $or: [{ expiresAt: { $lt: now } }, { instanceId: INSTANCE_ID }] },
      { instanceId: INSTANCE_ID, acquiredAt: now, expiresAt },
      { upsert: true, new: true }
    );
    _hasLock = true;
    return true;
  } catch (_) { _hasLock = false; return false; }
}

async function _renewLock() {
  if (!_hasLock) return;
  try {
    const result = await WaLock.updateOne(
      { _id: 'wa-lock', instanceId: INSTANCE_ID },
      { expiresAt: new Date(Date.now() + LOCK_TTL_MS) }
    );
    if (result.matchedCount === 0) {
      console.warn('[WhatsApp] ⚠️ فقدنا القفل — إيقاف الاتصال');
      _hasLock = false;
      _stopLockRenew();
      if (_sock) { try { _sock.end(undefined); } catch (_) {} _sock = null; }
      _status = 'disconnected';
    }
  } catch (_) {}
}

function _startLockRenew() { _stopLockRenew(); _lockRenewTimer = setInterval(_renewLock, LOCK_RENEW_MS); }
function _stopLockRenew()  { if (_lockRenewTimer) { clearInterval(_lockRenewTimer); _lockRenewTimer = null; } }

async function _releaseLock() {
  _hasLock = false;
  _stopLockRenew();
  try { await WaLock.deleteOne({ _id: 'wa-lock', instanceId: INSTANCE_ID }); } catch (_) {}
}

// ─── ② Watchdog ───────────────────────────────────────────────────────────────
function _startWatchdog() {
  _stopWatchdog();
  _watchdogTimer = setInterval(async () => {
    if (_status === 'connected') {
      const alive = _sock && _sock.ws && _sock.ws.readyState === 1;
      if (!alive) {
        console.warn('[WhatsApp] 🐕 Watchdog: اتصال ميت — إعادة الاتصال...');
        _status = 'disconnected';
        if (_sock) { try { _sock.end(undefined); } catch (_) {} _sock = null; }
        await _releaseLock();
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        _scheduleReconnect(5);
      }
    }
    if (_status === 'disconnected' && !_reconnectTimer) {
      console.warn('[WhatsApp] 🐕 Watchdog: منقطع بدون timer — إعادة الجدولة...');
      _scheduleReconnect(5);
    }
  }, WATCHDOG_INTERVAL_MS);
}
function _stopWatchdog() { if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; } }

// ─── ④ تنظيف Session Keys ─────────────────────────────────────────────────────
async function _cleanupOldSessionKeys() {
  try {
    const WaSession = mongoose.models.WaSession;
    if (!WaSession) return;
    const total = await WaSession.countDocuments({});
    if (total <= MAX_PREKEYS_TO_KEEP) return;
    const toDelete = await WaSession
      .find({ _id: { $regex: /^(pre-key|sender-key-memory)-/ } })
      .sort({ _id: 1 }).limit(total - MAX_PREKEYS_TO_KEEP).select('_id').lean();
    if (toDelete.length > 0) {
      await WaSession.deleteMany({ _id: { $in: toDelete.map(d => d._id) } });
      console.log(`[WhatsApp] 🧹 حُذفت ${toDelete.length} مفتاح قديم (من أصل ${total})`);
    }
  } catch (e) { console.error('[WhatsApp] خطأ تنظيف session:', e.message); }
}

function _startSessionCleanup() {
  _stopSessionCleanup();
  _cleanupOldSessionKeys();
  _cleanupTimer = setInterval(_cleanupOldSessionKeys, SESSION_CLEANUP_MS);
}
function _stopSessionCleanup() { if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; } }

// ─── تنسيق رقم الهاتف ────────────────────────────────────────────────────────
function _formatPhone(phone) {
  if (!phone) return null;
  // إذا كان الرقم يحتوي على @ (مثل JID) أرجعه كما هو
  if (phone.includes('@')) return phone;
  let p = phone.replace(/[\s\-().+]/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0'))  p = '970' + p.slice(1);
  if (p.length === 9)     p = '970' + p;
  return p + '@s.whatsapp.net';
}

// ─── جدولة إعادة الاتصال ─────────────────────────────────────────────────────
function _scheduleReconnect(delaySec = RECONNECT_DELAY_NORMAL) {
  if (_reconnectTimer) return;
  console.log(`[WhatsApp] ⏳ إعادة الاتصال خلال ${delaySec} ثانية...`);
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    await _init(true);
  }, delaySec * 1000);
}

// ─── ③ جلب إصدار Baileys مع Fallback ────────────────────────────────────────
async function _getWAVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch (e) {
    console.warn('[WhatsApp] ⚠️ فشل جلب الإصدار — الإصدار الاحتياطي:', FALLBACK_WA_VERSION.join('.'));
    return FALLBACK_WA_VERSION;
  }
}

// ─── تهيئة الاتصال ───────────────────────────────────────────────────────────
async function _init(force = false) {
  if (_sock && !force) return;
  if (_sock) { try { _sock.end(undefined); } catch (_) {} _sock = null; }
  _status = 'disconnected';

  const gotLock = await _acquireLock();
  if (!gotLock) {
    console.warn('[WhatsApp] 🔒 instance آخر يملك الجلسة — سيُعاد المحاولة بعد 60 ثانية');
    _scheduleReconnect(RECONNECT_DELAY_LOCKED);
    return;
  }
  _startLockRenew();

  try {
    const { state, saveCreds } = await useMongoAuthState();
    const version              = await _getWAVersion();

    _sock = makeWASocket({
      version,
      auth:                  state,
      printQRInTerminal:     true,
      logger:                pino({ level: 'silent' }),
      browser:               ['Chrome', 'Windows', '120.0.0'],  // أكثر طبيعية
      connectTimeoutMs:      60_000,
      defaultQueryTimeoutMs: 30_000,
      keepAliveIntervalMs:   15_000,  // أسرع: كل 15 ثانية بدل 25
    });

    _sock.ev.on('creds.update', saveCreds);

    _sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        _status   = 'qr_ready';
        _qrBase64 = null;
        try {
          _qrBase64 = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', margin: 2, scale: 6 });
        } catch (_) {}
        console.log('[WhatsApp] QR Code جاهز — امسحه بتطبيق WhatsApp');
      }

      if (connection === 'open') {
        _status          = 'connected';
        _qrBase64        = null;
        _conflictRetries = 0;
        console.log('[WhatsApp] ✅ متصل بنجاح');
      }

      if (connection === 'close') {
        const err        = lastDisconnect?.error;
        const statusCode = (err instanceof Boom) ? err.output.statusCode : 0;
        const errMsg     = (err?.message || '').toLowerCase();
        const isConflict = errMsg.includes('conflict') || statusCode === 440;
        const loggedOut  = !isConflict && statusCode === DisconnectReason.loggedOut;

        console.warn('[WhatsApp] ⚠️ انقطع الاتصال:', err?.message || 'غير معروف');
        _sock = null;

        if (loggedOut) {
          _status = 'error';
          _conflictRetries = 0;
          console.error('[WhatsApp] ❌ تسجيل خروج — مسح الجلسة');
          try { if (mongoose.models.WaSession) await mongoose.models.WaSession.deleteMany({}); } catch (_) {}
          await _releaseLock();
          _scheduleReconnect(5);

        } else if (isConflict) {
          _status = 'disconnected';
          const delay = CONFLICT_DELAYS[Math.min(_conflictRetries, CONFLICT_DELAYS.length - 1)];
          _conflictRetries++;
          console.warn(`[WhatsApp] ⚠️ تعارض جلسة (${_conflictRetries}) — إعادة خلال ${delay} ثانية`);
          await _releaseLock();
          _scheduleReconnect(delay);

        } else {
          _status          = 'disconnected';
          _conflictRetries = 0;
          await _releaseLock();
          _scheduleReconnect(RECONNECT_DELAY_NORMAL);
        }
      }
    });

    // ─── مستمع الرسائل الواردة (للبوت) ────────────────────────────────────
    _sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key?.fromMe) continue;
        if (_messageHandler) {
          _messageHandler(msg).catch(e => console.error('[WA-Msg] خطأ:', e.message));
        }
      }
    });

  } catch (err) {
    _status = 'error';
    console.error('[WhatsApp] ❌ خطأ في التهيئة:', err.message);
    await _releaseLock();
    _scheduleReconnect(60);
  }
}

// ─── واجهة عامة ──────────────────────────────────────────────────────────────

async function start() {
  if (_initialized) return;
  _initialized = true;
  console.log(`[WhatsApp] 🚀 بدء التشغيل... (instance: ${INSTANCE_ID})`);
  await _clearStaleLockOnStartup(); // ⑤
  _init().catch(e => console.error('[WhatsApp] خطأ غير متوقع:', e.message));
  _startWatchdog();        // ②
  _startSessionCleanup();  // ④
}

async function reconnect() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _conflictRetries = 0;
  _initialized     = true;
  await _releaseLock();
  await _init(true);
}

// ─── إرسال نص — عبر الطابور ① ───────────────────────────────────────────────
async function sendMessage(phone, text) {
  const chatId = _formatPhone(phone);
  if (!chatId) throw new Error('رقم الهاتف غير صالح: ' + phone);

  return new Promise((resolve, reject) => {
    _enqueue(async () => {
      if (_status !== 'connected' || !_sock)
        return reject(new Error('WhatsApp غير متصل (الحالة: ' + _status + ')'));
      let lastErr;
      for (let i = 1; i <= 3; i++) {
        try { await _sock.sendMessage(chatId, { text }); return resolve(); }
        catch (e) { lastErr = e; if (i < 3) await new Promise(r => setTimeout(r, 2000 * i)); }
      }
      reject(new Error('فشل بعد 3 محاولات: ' + lastErr.message));
    });
  });
}

// ─── إرسال ملف PDF — عبر الطابور ① ─────────────────────────────────────────
async function sendDocument(phone, buffer, fileName, mimetype = 'application/pdf', caption = '') {
  const chatId = _formatPhone(phone);
  if (!chatId) throw new Error('رقم الهاتف غير صالح: ' + phone);

  return new Promise((resolve, reject) => {
    _enqueue(async () => {
      if (_status !== 'connected' || !_sock)
        return reject(new Error('WhatsApp غير متصل (الحالة: ' + _status + ')'));
      let lastErr;
      for (let i = 1; i <= 3; i++) {
        try {
          await _sock.sendMessage(chatId, { document: buffer, mimetype, fileName, caption: caption || '' });
          return resolve();
        } catch (e) { lastErr = e; if (i < 3) await new Promise(r => setTimeout(r, 2000 * i)); }
      }
      reject(new Error('فشل إرسال الملف بعد 3 محاولات: ' + lastErr.message));
    });
  });
}

function getStatus()     { return _status; }
function getQR()         { return _qrBase64; }
function getInstanceId() { return INSTANCE_ID; }

/** تسجيل مستمع رسائل واردة — يُستدعى عند كل رسالة جديدة */
function onMessage(handler) {
  _messageHandler = handler;
}

module.exports = { start, reconnect, sendMessage, sendDocument, getStatus, getQR, getInstanceId, onMessage };
