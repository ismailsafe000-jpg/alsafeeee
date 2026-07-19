'use strict';
/**
 * مسارات نظام إشعارات WhatsApp
 *
 * الأزرار اليدوية المضافة:
 * POST /whatsapp-send-customer-statement/:id  → أرسل كشف حساب زبون لرقمه مباشرة
 * POST /whatsapp-send-invoice/:id             → أرسل إشعار فاتورة يدوياً
 * POST /whatsapp-send-payment/:id             → أرسل إشعار دفعة يدوياً
 * POST /whatsapp-send-check/:id              → أرسل إشعار شيك يدوياً
 */

const express = require('express');
const router  = express.Router();
const moment  = require('moment');

const Setting         = require('../models/Setting');
const NotificationLog = require('../models/NotificationLog');
const CronHistory     = require('../models/CronHistory');
const Customer        = require('../models/Customer');
const Invoice         = require('../models/Invoice');
const Payment         = require('../models/Payment');
const Check           = require('../models/Check');

const WA  = require('../services/WhatsAppService');
const CNS = require('../services/CheckNotificationService');
const MRS = require('../services/ManagerReportService');

function isAdmin(req, res, next) {
  if (req.session && req.session.adminAuth) return next();
  res.redirect('/');
}

function _fmt(date) { return date ? moment(date).format('DD/MM/YYYY') : '-'; }

// ─── صفحة الإعدادات ──────────────────────────────────────────────────────────
router.get('/whatsapp-settings', isAdmin, async (req, res) => {
  try {
    const [settings, logs, cronHistory] = await Promise.all([
      Setting.findOne().lean(),
      NotificationLog.find().sort({ sentAt: -1 }).limit(100).lean(),
      CronHistory.find().sort({ startTime: -1 }).limit(20).lean(),
    ]);
    res.render('admin/whatsapp-settings', {
      title:    'إعدادات إشعارات الشيكات',
      settings: settings || {},
      logs,
      cronHistory,
      waStatus:  WA.getStatus(),
      waQR:      WA.getQR(),
    });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

// ─── حفظ الإعدادات ───────────────────────────────────────────────────────────
router.post('/whatsapp-settings', isAdmin, async (req, res) => {
  try {
    let s = await Setting.findOne();
    if (!s) s = new Setting();
    const bool = v => v === 'on' || v === 'true' || v === true || v === '1';

    s.waNotificationsEnabled   = bool(req.body.waNotificationsEnabled);
    s.waAddedEnabled           = bool(req.body.waAddedEnabled);
    s.waClearedEnabled         = bool(req.body.waClearedEnabled);
    s.waReturnedEnabled        = bool(req.body.waReturnedEnabled);
    s.waCancelledEnabled       = bool(req.body.waCancelledEnabled);
    s.waEditEnabled            = bool(req.body.waEditEnabled);
    s.waReminderEnabled        = bool(req.body.waReminderEnabled);
    s.waReminderDays           = parseInt(req.body.waReminderDays) || 5;
    s.waInvoiceNewEnabled      = bool(req.body.waInvoiceNewEnabled);
    s.waInvoicePaidEnabled     = bool(req.body.waInvoicePaidEnabled);
    s.waPaymentReceivedEnabled = bool(req.body.waPaymentReceivedEnabled);
    s.waStatementEntryEnabled  = bool(req.body.waStatementEntryEnabled);
    s.waManagerPhone           = (req.body.waManagerPhone    || '').trim();
    s.waAccountantPhone        = (req.body.waAccountantPhone || '').trim();
    s.waCronTime               = (req.body.waCronTime        || '09:00').trim();
    s.waWeeklyReportEnabled    = bool(req.body.waWeeklyReportEnabled);
    s.waWeeklyReportDay        = (req.body.waWeeklyReportDay  || '6').trim();
    s.waWeeklyReportTime       = (req.body.waWeeklyReportTime || '08:00').trim();

    await s.save();
    await CNS.refreshCron();
    await MRS.refreshWeeklyCron();

    req.flash('success_msg', 'تم حفظ إعدادات الإشعارات بنجاح');
    res.redirect('/admin/whatsapp-settings');
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحفظ: ' + err.message);
    res.redirect('/admin/whatsapp-settings');
  }
});

// ─── حالة WhatsApp (JSON) ─────────────────────────────────────────────────────
router.get('/whatsapp-status', isAdmin, (req, res) => {
  res.json({ status: WA.getStatus(), qr: WA.getQR() });
});

// ─── رسالة اختبار ────────────────────────────────────────────────────────────
router.post('/whatsapp-test', isAdmin, async (req, res) => {
  try {
    await CNS.sendTestMessage();
    req.flash('success_msg', '✅ تم إرسال رسالة الاختبار للمدير بنجاح');
  } catch (err) {
    req.flash('error_msg', '❌ فشل إرسال رسالة الاختبار: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── إرسال جماعي ─────────────────────────────────────────────────────────────
router.post('/whatsapp-bulk', isAdmin, async (req, res) => {
  try {
    const result = await CNS.sendBulkAudit();
    req.flash('success_msg', `✅ تم الإرسال: ${result.sent} رسالة ناجحة من ${result.total} شيك، فشل: ${result.failed}`);
  } catch (err) {
    req.flash('error_msg', '❌ خطأ في الإرسال الجماعي: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── إعادة الاتصال ───────────────────────────────────────────────────────────
router.post('/whatsapp-reconnect', isAdmin, async (req, res) => {
  try {
    await WA.reconnect();
    req.flash('success_msg', '⏳ جارٍ إعادة الاتصال بـ WhatsApp...');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── حذف سجل الرسائل ─────────────────────────────────────────────────────────
router.post('/whatsapp-logs-clear', isAdmin, async (req, res) => {
  try {
    const { mode } = req.body;
    if (mode === 'old') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const { deletedCount } = await NotificationLog.deleteMany({ sentAt: { $lt: cutoff } });
      req.flash('success_msg', `✅ تم حذف ${deletedCount} سجل أقدم من 30 يوم`);
    } else {
      const { deletedCount } = await NotificationLog.deleteMany({});
      req.flash('success_msg', `✅ تم حذف جميع السجلات (${deletedCount} سجل)`);
    }
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحذف: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── تغيير الرقم — مسح الجلسة ────────────────────────────────────────────────
router.post('/whatsapp-logout', isAdmin, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.models.WaSession) await mongoose.models.WaSession.deleteMany({});
    await WA.reconnect();
    req.flash('success_msg', '✅ تم مسح الجلسة — امسح الـ QR بالرقم الجديد');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── إرسال كشوفات المدير الأسبوعية يدوياً ────────────────────────────────────
router.post('/whatsapp-manager-report', isAdmin, async (req, res) => {
  try {
    const result = await MRS.sendManagerReport('admin');
    if (result.error) {
      req.flash('error_msg', `❌ ${result.error}`);
    } else {
      req.flash('success_msg',
        `✅ تم إرسال كشوفات الحسابات للمدير — ${result.sent} زبون بنجاح` +
        (result.failed  > 0 ? `، فشل ${result.failed}`   : '') +
        (result.skipped > 0 ? `، تخطى ${result.skipped}` : '')
      );
    }
  } catch (err) {
    req.flash('error_msg', '❌ خطأ في إرسال التقرير: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ─── تشغيل يدوي لـ Cron اليومي ───────────────────────────────────────────────
router.post('/whatsapp-run-cron', isAdmin, async (req, res) => {
  try {
    CNS.runDailyJob();
    req.flash('success_msg', '⏳ تم تشغيل المهمة اليومية في الخلفية');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
  }
  res.redirect('/admin/whatsapp-settings');
});

// ══════════════════════════════════════════════════════════════════════════════
// ─── الأزرار اليدوية الجديدة ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /admin/whatsapp-send-customer-statement/:id
 * يرسل كشف حساب الزبون (PDF) إلى رقمه على واتساب مباشرةً
 * يُستخدم من صفحة كشف حساب الزبون عبر زر "إرسال للزبون"
 */
router.post('/whatsapp-send-customer-statement/:id', isAdmin, async (req, res) => {
  try {
    const result = await MRS.sendCustomerStatementToCustomer(req.params.id, 'admin');
    req.flash('success_msg',
      `✅ تم إرسال كشف حساب ${result.fullName} إلى واتسابه` +
      (result.entries === 0 ? ' (لا توجد حركات)' : ` (${result.entries} حركة، الرصيد: ${result.balance.toLocaleString('ar-EG')} ₪)`)
    );
  } catch (err) {
    req.flash('error_msg', '❌ فشل الإرسال: ' + err.message);
  }
  // العودة للصفحة السابقة (كشف حساب الزبون أو قائمة الزبائن)
  const back = req.get('Referer') || `/admin/statement/customer/${req.params.id}`;
  res.redirect(back);
});

/**
 * POST /admin/whatsapp-send-statement-to-manager/:id
 * يرسل كشف حساب زبون واحد للمدير عبر واتساب
 */
router.post('/whatsapp-send-statement-to-manager/:id', isAdmin, async (req, res) => {
  try {
    const result = await MRS.sendCustomerStatementToManager(req.params.id, 'admin');
    req.flash('success_msg',
      `✅ تم إرسال كشف حساب ${result.fullName} للمدير` +
      (result.entries === 0 ? ' (لا توجد حركات)' : ` — ${result.entries} حركة، الرصيد: ${result.balance.toLocaleString('ar-EG')} ₪`)
    );
  } catch (err) {
    req.flash('error_msg', '❌ فشل الإرسال: ' + err.message);
  }
  const back = req.get('Referer') || `/admin/statement/customer/${req.params.id}`;
  res.redirect(back);
});

/**
 * POST /admin/whatsapp-send-invoice/:id
 * يُعيد إرسال إشعار الفاتورة يدوياً للزبون
 */
router.post('/whatsapp-send-invoice/:id', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) { req.flash('error_msg', 'الفاتورة غير موجودة'); return res.redirect('back'); }
    if (invoice.partyModel === 'Dealer') {
      req.flash('error_msg', '🚫 واتساب مخصص للزبائن فقط — هذه الفاتورة لتاجر');
      return res.redirect('back');
    }

    const customer = await Customer.findById(invoice.partyId).lean();
    if (!customer || !customer.phone) {
      req.flash('error_msg', `❌ الزبون ${invoice.partyName} ليس لديه رقم هاتف مسجّل`);
      return res.redirect('back');
    }

    const discountPart = invoice.discount > 0
      ? `المبلغ قبل الخصم: ${(invoice.subtotal || 0).toLocaleString('ar-EG')} ₪\n` +
        `الخصم: ${(invoice.discount || 0).toLocaleString('ar-EG')} ₪\n`
      : '';
    const text =
      `عزيزنا ${invoice.partyName}\n\n` +
      `نود إعلامكم بتفاصيل الفاتورة الخاصة بكم في معرض الصافي للمفروشات.\n\n` +
      `رقم الفاتورة: ${invoice.invoiceNumber}\n` +
      discountPart +
      `المبلغ الإجمالي: ${(invoice.totalAmount || 0).toLocaleString('ar-EG')} ₪\n` +
      `المدفوع: ${(invoice.paidAmount || 0).toLocaleString('ar-EG')} ₪\n` +
      `المتبقي: ${((invoice.totalAmount || 0) - (invoice.paidAmount || 0)).toLocaleString('ar-EG')} ₪\n` +
      `تاريخ الفاتورة: ${_fmt(invoice.invoiceDate)}\n\n` +
      `شكراً لتعاملكم معنا.`;

    await WA.sendMessage(customer.phone, text);
    await new NotificationLog({
      partyName: invoice.partyName, partyPhone: customer.phone,
      checkNumber: invoice.invoiceNumber, messageType: 'invoice_manual',
      messageText: text, status: 'SUCCESS', sentBy: 'admin'
    }).save();

    req.flash('success_msg', `✅ تم إرسال إشعار الفاتورة ${invoice.invoiceNumber} إلى ${invoice.partyName}`);
  } catch (err) {
    req.flash('error_msg', '❌ فشل الإرسال: ' + err.message);
  }
  res.redirect('back');
});

/**
 * POST /admin/whatsapp-send-payment/:id
 * يُعيد إرسال إشعار الدفعة يدوياً للزبون
 */
router.post('/whatsapp-send-payment/:id', isAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment) { req.flash('error_msg', 'الدفعة غير موجودة'); return res.redirect('back'); }
    if (payment.partyModel === 'Dealer') {
      req.flash('error_msg', '🚫 واتساب مخصص للزبائن فقط');
      return res.redirect('back');
    }

    const customer = await Customer.findById(payment.partyId).lean();
    if (!customer || !customer.phone) {
      req.flash('error_msg', `❌ الزبون ${payment.partyName} ليس لديه رقم هاتف مسجّل`);
      return res.redirect('back');
    }

    const methodMap = { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' };
    const remainingBalance = typeof customer.balance === 'number' ? customer.balance : null;
    const remainingLine = remainingBalance !== null
      ? `المتبقي على حسابكم: ${remainingBalance.toLocaleString('ar-EG')} ₪\n`
      : '';
    const text =
      `عزيزنا ${payment.partyName}\n\n` +
      `نود إعلامكم بأنه تم استلام دفعتكم بنجاح في معرض الصافي للمفروشات.\n\n` +
      `رقم السند: ${payment.voucherNumber || '-'}\n` +
      `المبلغ: ${(payment.amount || 0).toLocaleString('ar-EG')} ₪\n` +
      `طريقة الدفع: ${methodMap[payment.paymentMethod] || payment.paymentMethod}\n` +
      `التاريخ: ${_fmt(payment.paymentDate)}\n` +
      remainingLine + `\n` +
      `شكراً لتعاملكم مع معرض الصافي للمفروشات.`;

    await WA.sendMessage(customer.phone, text);
    await new NotificationLog({
      partyName: payment.partyName, partyPhone: customer.phone,
      checkNumber: payment.voucherNumber || '-', messageType: 'payment_manual',
      messageText: text, status: 'SUCCESS', sentBy: 'admin'
    }).save();

    req.flash('success_msg', `✅ تم إرسال إشعار الدفعة ${payment.voucherNumber || ''} إلى ${payment.partyName}`);
  } catch (err) {
    req.flash('error_msg', '❌ فشل الإرسال: ' + err.message);
  }
  res.redirect('back');
});

/**
 * POST /admin/whatsapp-send-check/:id
 * يُعيد إرسال إشعار شيك يدوياً للزبون
 */
router.post('/whatsapp-send-check/:id', isAdmin, async (req, res) => {
  try {
    const check = await Check.findById(req.params.id).lean();
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('back'); }
    if (check.partyModel === 'Dealer') {
      req.flash('error_msg', '🚫 واتساب مخصص للزبائن فقط');
      return res.redirect('back');
    }

    const customer = await Customer.findById(check.partyId).lean();
    if (!customer || !customer.phone) {
      req.flash('error_msg', `❌ الزبون ${check.partyName} ليس لديه رقم هاتف مسجّل`);
      return res.redirect('back');
    }

    const statusMap = { pending: 'قيد الانتظار', cleared: 'تم صرفه', returned: 'مرتجع', cancelled: 'ملغى' };
    const text =
      `عزيزنا الزبون ${check.partyName}\n\n` +
      `تذكير بالشيك المسجّل لدينا في معرض الصافي للمفروشات.\n\n` +
      `رقم الشيك: ${check.checkNumber}\n` +
      `القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪\n` +
      `تاريخ الاستحقاق: ${_fmt(check.maturityDate)}\n` +
      `الحالة: ${statusMap[check.status] || check.status}\n\n` +
      `للاستفسار يرجى التواصل معنا.`;

    await WA.sendMessage(customer.phone, text);
    await new NotificationLog({
      partyName: check.partyName, partyPhone: customer.phone,
      checkNumber: check.checkNumber, checkId: check._id,
      messageType: 'check_manual', messageText: text, status: 'SUCCESS', sentBy: 'admin'
    }).save();

    req.flash('success_msg', `✅ تم إرسال إشعار الشيك ${check.checkNumber} إلى ${check.partyName}`);
  } catch (err) {
    req.flash('error_msg', '❌ فشل الإرسال: ' + err.message);
  }
  res.redirect('back');
});

module.exports = router;
