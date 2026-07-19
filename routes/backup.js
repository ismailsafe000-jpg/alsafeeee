// routes/backup.js — Full backup management system
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const Customer = require('../models/Customer');
const Dealer = require('../models/Dealer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Visit = require('../models/Visit');
const Check = require('../models/Check');
const Ledger = require('../models/Ledger');
const Measurement = require('../models/Measurement');
const Catalog = require('../models/Catalog');
const Setting = require('../models/Setting');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const isAdmin = (req, res, next) => req.session.adminAuth ? next() : res.redirect('/');

// ─── Helper: collect all data ─────────────────────────────────────────────────
async function collectData() {
  const [customers, dealers, invoices, payments, sales, visits, checks, ledger, measurements, catalogs, settings] = await Promise.all([
    Customer.find().lean(),
    Dealer.find().lean(),
    Invoice.find().lean(),
    Payment.find().lean(),
    Sale.find().lean(),
    Visit.find().lean(),
    Check.find().lean(),
    Ledger.find().lean(),
    Measurement.find().lean(),
    Catalog.find().lean(),
    Setting.findOne().lean()
  ]);
  return { customers, dealers, invoices, payments, sales, visits, checks, ledger, measurements, catalogs, settings,
    meta: { createdAt: new Date().toISOString(), version: '1.0', collections: 10 } };
}

// ─── GET /admin/backups — list backups ────────────────────────────────────────
router.get('/', isAdmin, (req, res) => {
  try {
    const files = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR)
          .filter(f => f.endsWith('.json'))
          .map(f => {
            const stat = fs.statSync(path.join(BACKUP_DIR, f));
            return { name: f, size: (stat.size / 1024).toFixed(1) + ' KB', createdAt: stat.mtime };
          })
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      : [];
    res.render('admin/backups', { title: 'إدارة النسخ الاحتياطية', backups: files });
  } catch (err) {
    req.flash('error_msg', 'خطأ في قراءة قائمة النسخ: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

// ─── POST /admin/backups/create — create new JSON backup ──────────────────────
router.post('/create', isAdmin, async (req, res) => {
  try {
    const data = await collectData();
    const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const filepath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    req.flash('success_msg', `✅ تم إنشاء النسخة الاحتياطية: ${filename}`);
    res.redirect('/admin/backups');
  } catch (err) {
    req.flash('error_msg', 'فشل إنشاء النسخة: ' + err.message);
    res.redirect('/admin/backups');
  }
});

// ─── GET /admin/backups/download/:filename — download ─────────────────────────
router.get('/download/:filename', isAdmin, (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // sanitize
    const filepath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) {
      req.flash('error_msg', 'الملف غير موجود');
      return res.redirect('/admin/backups');
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filepath).pipe(res);
  } catch (err) {
    req.flash('error_msg', 'فشل التحميل: ' + err.message);
    res.redirect('/admin/backups');
  }
});

// ─── POST /admin/backups/restore/:filename — restore ─────────────────────────
router.post('/restore/:filename', isAdmin, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) {
      req.flash('error_msg', 'ملف النسخة غير موجود');
      return res.redirect('/admin/backups');
    }

    const raw = fs.readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw);

    // Restore each collection (insert if not exists by _id)
    const restore = async (Model, items) => {
      if (!items || !items.length) return;
      for (const item of items) {
        await Model.findOneAndUpdate({ _id: item._id }, item, { upsert: true, new: true }).catch(() => {});
      }
    };

    await Promise.all([
      restore(Customer, data.customers),
      restore(Dealer, data.dealers),
      restore(Invoice, data.invoices),
      restore(Payment, data.payments),
      restore(Sale, data.sales),
      restore(Visit, data.visits),
      restore(Check, data.checks),
      restore(Ledger, data.ledger),
      restore(Measurement, data.measurements),
      restore(Catalog, data.catalogs)
    ]);

    req.flash('success_msg', `✅ تمت الاستعادة بنجاح من: ${filename}`);
    res.redirect('/admin/backups');
  } catch (err) {
    req.flash('error_msg', 'فشلت الاستعادة: ' + err.message);
    res.redirect('/admin/backups');
  }
});

// ─── POST /admin/backups/delete/:filename — delete ────────────────────────────
router.post('/delete/:filename', isAdmin, (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(BACKUP_DIR, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    req.flash('success_msg', 'تم حذف النسخة الاحتياطية');
    res.redirect('/admin/backups');
  } catch (err) {
    req.flash('error_msg', 'فشل الحذف: ' + err.message);
    res.redirect('/admin/backups');
  }
});

// ─── Auto-backup: daily at 2:00 AM ────────────────────────────────────────────
function startAutoBackup() {
  // ✅ إصلاح: إضافة timezone مثل إشعارات الواتساب تماماً
  cron.schedule('0 2 * * *', async () => {
    try {
      const data = await collectData();
      const filename = `auto-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 10)}.json`;
      const filepath = path.join(BACKUP_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`✅ Auto-backup created: ${filename}`);

      // Keep only the last 7 auto-backups
      const autoFiles = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('auto-backup-') && f.endsWith('.json'))
        .sort()
        .reverse();
      autoFiles.slice(7).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(e) {}
      });
    } catch (err) {
      console.error('Auto-backup failed:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' }); // ✅ إصلاح: توقيت فلسطين مثل إشعارات الواتساب
  console.log('📦 Auto-backup scheduler started (daily at 2:00 AM Jerusalem time)');
}

module.exports = router;
module.exports.startAutoBackup = startAutoBackup;
