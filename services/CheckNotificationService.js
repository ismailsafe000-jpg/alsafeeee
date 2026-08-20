'use strict';
/**
 * CheckNotificationService — نظام إشعارات WhatsApp للمدير فقط
 *
 * جميع الإشعارات تذهب حصراً إلى رقم المدير (waManagerPhone).
 * لا يُرسل أي إشعار تلقائي للزبائن أو التجار.
 * كل عملية تُسجَّل في NotificationLog مع حالة النجاح/الفشل.
 * فشل WhatsApp لا يُعطّل العمليات الأساسية.
 */

const cron = require('node-cron');
const moment = require('moment');
const WA = require('./WhatsAppService');
const NotificationLog = require('../models/NotificationLog');
const CronHistory = require('../models/CronHistory');
const Check = require('../models/Check');
const Customer = require('../models/Customer');
const Dealer = require('../models/Dealer');
const Setting = require('../models/Setting');

let _cronJob = null;

// ─── مساعدات ──────────────────────────────────────────────────────────────────

async function _getSettings() {
  let s = await Setting.findOne().lean();
  if (!s) s = {};
  return s;
}

function _fmt(date) {
  if (!date) return '-';
  return moment(date).locale('ar').format('DD/MM/YYYY');
}

function _fmtDateTime(date) {
  if (!date) return '-';
  return moment(date).locale('ar').format('DD/MM/YYYY HH:mm');
}

function _methodAr(method) {
  const map = { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' };
  return map[method] || method || 'غير محدد';
}

function _partyTypeAr(partyModel) {
  return partyModel === 'Dealer' ? 'تاجر' : 'زبون';
}

function _statusAr(status) {
  const map = { pending: 'جديد', cleared: 'تم الصرف', returned: 'مرتجع', transferred_to_dealer: 'محوّل لتاجر' };
  return map[status] || status || '';
}

// ─── جلب رقم المدير ──────────────────────────────────────────────────────────

async function _getManagerPhone() {
  const s = await _getSettings();
  return s.waManagerPhone || null;
}

// ─── التحقق من تفعيل نوع إشعار معين ─────────────────────────────────────────

function _isEnabled(settings, key) {
  if (!settings.waNotificationsEnabled) return false;
  if (settings[key] === false) return false;
  return true;
}

// ─── إرسال رسالة للمدير وتسجيلها ─────────────────────────────────────────────

async function _sendToManager(text, logData) {
  const phone = await _getManagerPhone();
  if (!phone) {
    console.log('[WA] ⚠️ لا يوجد رقم مدير — تم تخطي الإشعار');
    return false;
  }
  let status = 'SUCCESS', failReason = '';
  try {
    await WA.sendMessage(phone, text);
  } catch (err) {
    status = 'FAILED';
    failReason = err.message;
  }
  try {
    await new NotificationLog({
      partyName: logData.partyName || 'المدير',
      partyPhone: phone,
      checkNumber: logData.checkNumber || '-',
      checkId: logData.checkId || null,
      messageType: logData.messageType,
      messageText: text,
      status,
      failReason,
      retries: status === 'FAILED' ? 3 : 0,
      sentBy: logData.sentBy || 'system'
    }).save();
  } catch (e) {
    console.error('[WA-Log] خطأ في حفظ السجل:', e.message);
  }
  if (status === 'FAILED') {
    console.error(`[WA] ❌ فشل إرسال إشعار ${logData.messageType}: ${failReason}`);
  }
  return status === 'SUCCESS';
}

// ─── التحقق من عدم التكرار ───────────────────────────────────────────────────

async function _isDuplicate(refId, messageType) {
  const last = await NotificationLog.findOne({ checkId: refId, messageType, status: 'SUCCESS' }).sort({ sentAt: -1 }).lean();
  return !!last;
}


// ══════════════════════════════════════════════════════════════════════════════
// إشعارات الفواتير — للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function notifyInvoiceNew(invoice) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waInvoiceNewEnabled')) return;

    const text =
`📋 *فاتورة جديدة — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(invoice.partyModel)}
👤 الطرف: ${invoice.partyName || '-'}
🔢 رقم الفاتورة: ${invoice.invoiceNumber || '-'}
💰 المبلغ الإجمالي: ${(invoice.totalAmount || 0).toLocaleString('ar-EG')} ₪
${invoice.discount > 0 ? `💸 الخصم: ${(invoice.discount || 0).toLocaleString('ar-EG')} ₪
` : ''}📅 التاريخ: ${_fmt(invoice.invoiceDate)}
📝 ملاحظات: ${invoice.notes || 'لا توجد'}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: invoice.partyName,
      checkNumber: invoice.invoiceNumber,
      messageType: 'invoice_new',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الفاتورة الجديدة:', e.message);
  }
}

async function notifyInvoicePaid(invoice) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waInvoicePaidEnabled')) return;

    const text =
`✅ *فاتورة مدفوعة بالكامل — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(invoice.partyModel)}
👤 الطرف: ${invoice.partyName || '-'}
🔢 رقم الفاتورة: ${invoice.invoiceNumber || '-'}
💰 المبلغ الإجمالي: ${(invoice.totalAmount || 0).toLocaleString('ar-EG')} ₪
💳 المدفوع: ${(invoice.paidAmount || 0).toLocaleString('ar-EG')} ₪
💵 المتبقي: ${((invoice.totalAmount || 0) - (invoice.paidAmount || 0)).toLocaleString('ar-EG')} ₪
${invoice.discount > 0 ? `💸 الخصم: ${(invoice.discount || 0).toLocaleString('ar-EG')} ₪
` : ''}📅 التاريخ: ${_fmt(invoice.invoiceDate)}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: invoice.partyName,
      checkNumber: invoice.invoiceNumber,
      messageType: 'invoice_paid',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الفاتورة المدفوعة:', e.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// إشعارات المدفوعات — للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function notifyPaymentReceived(payment, remainingBalance, previousBalance) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waPaymentReceivedEnabled')) return;

    const balanceInfo = (remainingBalance !== undefined && remainingBalance !== null)
      ? `💵 الرصيد السابق: ${(previousBalance || 0).toLocaleString('ar-EG')} ₪
💰 الرصيد الجديد: ${remainingBalance.toLocaleString('ar-EG')} ₪
📊 المتبقي: ${remainingBalance.toLocaleString('ar-EG')} ₪`
      : '';

    const text =
`💳 *سند قبض/صرف — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(payment.partyModel)}
👤 الطرف: ${payment.partyName || '-'}
🔢 رقم السند: ${payment.voucherNumber || '-'}
📋 نوع السند: ${payment.voucherType === 'receipt' ? 'قبض' : 'صرف'}
💰 المبلغ: ${(payment.amount || 0).toLocaleString('ar-EG')} ${payment.currency || '₪'}
💳 طريقة الدفع: ${_methodAr(payment.paymentMethod)}
${payment.paymentMethod === 'check' ? `🏦 البنك: ${payment.bankName || '-'}
📝 رقم الشيك: ${payment.chequeNumber || '-'}
📅 تاريخ الاستحقاق: ${_fmt(payment.chequeDueDate)}
` : ''}${payment.paymentMethod === 'bank_transfer' ? `🏦 البنك: ${payment.bankName || '-'}
` : ''}📄 الفاتورة المرتبطة: ${invoiceNumber(payment)}
📅 التاريخ: ${_fmt(payment.paymentDate)}
👤 الموظف: ${payment.employeeName || '-'}
📝 الوصف: ${payment.description || '-'}
${payment.notes ? `📝 ملاحظات: ${payment.notes}
` : ''}${balanceInfo}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: payment.partyName,
      checkNumber: payment.voucherNumber || '-',
      messageType: 'payment_received',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الدفعة:', e.message);
  }
}

function invoiceNumber(payment) {
  if (payment.invoiceId) {
    if (typeof payment.invoiceId === 'object' && payment.invoiceId.invoiceNumber) {
      return payment.invoiceId.invoiceNumber;
    }
    return payment.invoiceId.toString().slice(-6);
  }
  return 'غير مرتبط';
}

async function notifyPaymentsBatch(payments, remainingBalance, previousBalance) {
  try {
    if (!payments || payments.length === 0) return;
    const s = await _getSettings();
    if (!_isEnabled(s, 'waPaymentReceivedEnabled')) return;

    const totalAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const methodMap = { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' };

    const paymentLines = payments.map((p, i) =>
      `${i + 1}. ${(p.amount || 0).toLocaleString('ar-EG')} ${p.currency || '₪'} — ${methodMap[p.paymentMethod] || p.paymentMethod} (${p.voucherNumber || '-'})`
    ).join('\n');

    const balanceInfo = (remainingBalance !== undefined && remainingBalance !== null)
      ? `💵 الرصيد السابق: ${(previousBalance || 0).toLocaleString('ar-EG')} ₪
💰 الرصيد الجديد: ${remainingBalance.toLocaleString('ar-EG')} ₪`
      : '';

    const text =
`💳 *دفعات متعددة (${payments.length}) — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(payments[0].partyModel)}
👤 الطرف: ${payments[0].partyName || '-'}

📋 تفاصيل الدفعات:
${paymentLines}

💰 الإجمالي: ${totalAmount.toLocaleString('ar-EG')} ${payments[0].currency || '₪'}
📅 التاريخ: ${_fmt(payments[0].paymentDate)}
${balanceInfo}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: payments[0].partyName,
      checkNumber: payments[0].voucherNumber || '-',
      messageType: 'payment_batch',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الدفعات المتعددة:', e.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// إشعارات كشف الحساب — للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function notifyStatementEntry(entry, remainingBalance, previousBalance) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waStatementEntryEnabled')) return;

    const typeAr = entry.type === 'debit' ? 'مدين' : 'دائن';
    const emoji = entry.type === 'debit' ? '📤' : '📥';

    const balanceInfo = (remainingBalance !== undefined && remainingBalance !== null)
      ? `💵 الرصيد السابق: ${(previousBalance || 0).toLocaleString('ar-EG')} ₪
💰 الرصيد الجديد: ${remainingBalance.toLocaleString('ar-EG')} ₪`
      : '';

    const text =
`${emoji} *حركة كشف حساب — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(entry.partyModel)}
👤 الطرف: ${entry.partyName || '-'}
📋 البيان: ${entry.description || '-'}
${emoji} النوع: ${typeAr}
💰 المبلغ: ${(entry.amount || 0).toLocaleString('ar-EG')} ₪
🔢 المرجع: ${entry.refNo || '-'}
💳 طريقة الدفع: ${_methodAr(entry.paymentMethod)}
📅 التاريخ: ${_fmt(entry.date)}
${entry.invoiceId ? `📄 الفاتورة المرتبطة: ${typeof entry.invoiceId === 'object' && entry.invoiceId.invoiceNumber ? entry.invoiceId.invoiceNumber : '-'}
` : ''}${balanceInfo}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: entry.partyName,
      checkNumber: entry.refNo || '-',
      messageType: 'statement_entry',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار كشف الحساب:', e.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// إشعارات الشيكات — للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function notifyAdded(check) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waAddedEnabled')) return;

    const text =
`📝 *شيك جديد — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(check.partyModel)}
👤 الطرف: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الاستلام: ${_fmt(check.receivedDate)}
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
📋 الحالة: ${_statusAr(check.status)}
📝 ملاحظات: ${check.notes || 'لا توجد'}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_added',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الشيك الجديد:', e.message);
  }
}

async function notifyCleared(check) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waClearedEnabled')) return;
    if (await _isDuplicate(check._id, 'check_cleared')) {
      console.log(`[WA] ⚠️ تم إشعار صرف الشيك مسبقاً — ${check.checkNumber}`);
      return;
    }

    const wasTransferred = check.status === 'transferred_to_dealer';

    const text =
`✅ *شيك تم صرفه — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(check.partyModel)}
👤 الطرف الأصلي: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الصرف: ${_fmt(check.clearDate || new Date())}
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
${wasTransferred ? `🔄 كان محوّلاً لتاجر: ${check.transferredToDealerName || '-'}
` : ''}━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_cleared',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار صرف الشيك:', e.message);
  }
}

async function notifyReturned(check) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waReturnedEnabled')) return;
    if (await _isDuplicate(check._id, 'check_returned')) {
      console.log(`[WA] ⚠️ تم إشعار رجوع الشيك مسبقاً — ${check.checkNumber}`);
      return;
    }

    const text =
`↩️ *شيك مرتجع — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(check.partyModel)}
👤 الطرف: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
⚠️ تم تسجيل رجوع الشيك — يُضاف المبلغ مدين على الحساب

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_returned',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار رجوع الشيك:', e.message);
  }
}

async function notifyCancelled(check) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waCancelledEnabled')) return;

    const text =
`🚫 *شيك ملغي — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(check.partyModel)}
👤 الطرف: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
⚠️ تم حذف الشيك نهائياً من النظام

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_cancelled',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار إلغاء الشيك:', e.message);
  }
}

async function notifyEdited(check) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waEditEnabled')) return;

    const text =
`✏️ *شيك تعديل — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

🏷️ نوع الطرف: ${_partyTypeAr(check.partyModel)}
👤 الطرف: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
📋 الحالة: ${_statusAr(check.status)}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_edited',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار تعديل الشيك:', e.message);
  }
}

async function notifyTransferred(check, dealerName) {
  try {
    const s = await _getSettings();
    if (!_isEnabled(s, 'waAddedEnabled')) return;

    const text =
`🔄 *شيك محوّل لتاجر — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

👤 الزبون الأصلي: ${check.partyName || '-'}
🔢 رقم الشيك: ${check.checkNumber || '-'}
🏦 البنك: ${check.bankName || '-'}
💰 القيمة: ${(check.amount || 0).toLocaleString('ar-EG')} ₪
📅 تاريخ الاستحقاق: ${_fmt(check.maturityDate)}
🏪 التاجر المستفيد: ${dealerName || '-'}
📋 تم تسجيل سند صرف بالتاجر

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

    await _sendToManager(text, {
      partyName: check.partyName,
      checkNumber: check.checkNumber,
      checkId: check._id,
      messageType: 'check_transferred',
      sentBy: 'system'
    });
  } catch (e) {
    console.error('[WA] خطأ في إشعار تحويل الشيك:', e.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// التذكيرات اليومية — للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function runDailyJob() {
  const history = new CronHistory({ startTime: new Date() });
  let sent = 0, failed = 0;
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) {
      history.lastError = 'الإشعارات معطلة من الإعدادات';
      history.endTime = new Date();
      await history.save();
      return;
    }

    const now = new Date();

    // جدول تذكيرات الشيكات: قبل 7 أيام، قبل 3 أيام، قبل يوم، ويوم الاستحقاق نفسه
    const REMINDER_STAGES = [
      { days: 7, messageType: 'reminder_7d', label: 'بعد 7 أيام' },
      { days: 3, messageType: 'reminder_3d', label: 'بعد 3 أيام' },
      { days: 1, messageType: 'reminder_1d', label: 'غداً' },
      { days: 0, messageType: 'reminder_due', label: 'اليوم' }
    ];

    let scannedTotal = 0;
    const managerPhone = s.waManagerPhone;
    const remindersSent = [];

    if (s.waReminderEnabled && managerPhone) {
      for (const stage of REMINDER_STAGES) {
        const targetDate = new Date(now.getTime() + stage.days * 24 * 60 * 60 * 1000);
        const startOfDay = new Date(targetDate); startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate); endOfDay.setHours(23, 59, 59, 999);

        const stageChecks = await Check.find({
          status: 'pending',
          maturityDate: { $gte: startOfDay, $lte: endOfDay }
        }).lean();
        scannedTotal += stageChecks.length;

        for (const check of stageChecks) {
          const existing = await NotificationLog.findOne({
            checkId: check._id, messageType: stage.messageType, status: 'SUCCESS'
          }).lean();
          if (existing) continue;

          remindersSent.push({
            checkNumber: check.checkNumber,
            partyName: check.partyName,
            amount: check.amount,
            maturityDate: check.maturityDate,
            label: stage.label
          });
        }
      }
    }

    history.checksScanned = scannedTotal;

    // إرسال ملخص التذكيرات للمدير
    if (remindersSent.length > 0 && managerPhone) {
      const reminderLines = remindersSent.map((r, i) =>
        `${i + 1}. شيك #${r.checkNumber} — ${r.partyName} — ${(r.amount || 0).toLocaleString('ar-EG')} ₪ — ${r.label}`
      ).join('\n');

      const text =
`⏰ *تذكيرات شيكات المستحقة — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

📅 التاريخ: ${_fmt(new Date())}
🔢 عدد الشيكات المستحقة: ${remindersSent.length}

📋 التفاصيل:
${reminderLines}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

      const ok = await _sendToManager(text, {
        partyName: 'المدير',
        checkNumber: '-',
        messageType: 'daily_reminders',
        sentBy: 'cron'
      });
      if (ok) sent++; else failed++;
    }

    // ─── التقرير اليومي للمدير ───────────────────────────────────────────────
    if (managerPhone) {
      const reminderDays = s.waReminderDays || 7;
      const reportWindowEnd = new Date(now.getTime() + reminderDays * 24 * 60 * 60 * 1000);
      const checks = await Check.find({
        status: 'pending',
        maturityDate: { $gte: now, $lte: reportWindowEnd }
      }).lean();

      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [clearedToday, returnedToday, failedLogs] = await Promise.all([
        NotificationLog.countDocuments({ messageType: 'check_cleared', status: 'SUCCESS', sentAt: { $gte: todayStart } }),
        NotificationLog.countDocuments({ messageType: 'check_returned', status: 'SUCCESS', sentAt: { $gte: todayStart } }),
        NotificationLog.countDocuments({ status: 'FAILED', sentAt: { $gte: todayStart } }),
      ]);
      const totalAmount = checks.reduce((sum, c) => sum + (c.amount || 0), 0);

      const report =
`📋 *التقرير اليومي — معرض الصافي للمفروشات*
━━━━━━━━━━━━━━━━━━━━━━━

📅 التاريخ: ${_fmt(new Date())}

🔔 شيكات مستحقة خلال ${reminderDays} أيام: ${checks.length}
💰 إجمالي قيمتها: ${totalAmount.toLocaleString('ar-EG')} ₪
💬 التذكيرات المرسلة: ${sent}
✅ شيكات صرفت اليوم: ${clearedToday}
↩️ شيكات مرتجعة اليوم: ${returnedToday}
❌ رسائل فاشلة اليوم: ${failedLogs}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

      const ok = await _sendToManager(report, {
        partyName: 'المدير',
        checkNumber: '-',
        messageType: 'daily_report',
        sentBy: 'cron'
      });
      if (!ok) failed++;
    }

    history.messagesSent = sent;
    history.messagesFailed = failed;
    history.endTime = new Date();
    await history.save();
    console.log(`[WA-Cron] ✅ انتهى: ${sent} رسالة ناجحة، ${failed} فاشلة`);
  } catch (err) {
    history.lastError = err.message;
    history.endTime = new Date();
    history.messagesSent = sent;
    history.messagesFailed = failed;
    await history.save().catch(() => {});
    console.error('[WA-Cron] ❌ خطأ:', err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// رسالة اختبار — للمدير
// ══════════════════════════════════════════════════════════════════════════════

async function sendTestMessage() {
  const phone = await _getManagerPhone();
  if (!phone) throw new Error('لم يتم إدخال رقم المدير في الإعدادات');
  const text =
`🚨 *اختبار نظام إشعارات المدير*

النظام يعمل بنجاح ✅

وقت الاختبار: ${_fmtDateTime(new Date())}

━━━━━━━━━━━━━━━━━━━━━━━
جميع إشعارات النظام (الفواتير، المدفوعات، الشيكات، كشف الحساب)
ستصلك على هذا الرقم حصراً.`;

  await WA.sendMessage(phone, text);
  await new NotificationLog({
    partyName: 'المدير', partyPhone: phone, checkNumber: '-',
    messageType: 'test', messageText: text, status: 'SUCCESS', sentBy: 'admin'
  }).save();
}


// ══════════════════════════════════════════════════════════════════════════════
// إعداد Cron Job
// ══════════════════════════════════════════════════════════════════════════════

async function setupCron() {
  if (_cronJob) { _cronJob.stop(); _cronJob = null; }
  const s = await _getSettings();
  const time = s.waCronTime || '09:00';
  const [hour, minute] = time.split(':');
  const expression = `${minute || '0'} ${hour || '9'} * * *`;
  console.log(`[WA-Cron] ⏰ إعداد Cron: ${expression}`);
  _cronJob = cron.schedule(expression, () => runDailyJob(), { timezone: 'Asia/Jerusalem' });
}

async function refreshCron() {
  await setupCron();
}


// ══════════════════════════════════════════════════════════════════════════════
// إرسال جماعي — ملخص للمدير فقط
// ══════════════════════════════════════════════════════════════════════════════

async function sendBulkAudit() {
  const s = await _getSettings();
  if (!s.waManagerPhone) throw new Error('لم يتم إدخال رقم المدير في الإعدادات');

  const pendingChecks = await Check.find({ status: 'pending' }).lean();
  if (pendingChecks.length === 0) {
    return { sent: 0, failed: 0, total: 0 };
  }

  const lines = pendingChecks.map((c, i) =>
    `${i + 1}. شيك #${c.checkNumber} — ${c.partyName} (${_partyTypeAr(c.partyModel)}) — ${(c.amount || 0).toLocaleString('ar-EG')} ₪ — استحقاق: ${_fmt(c.maturityDate)}`
  ).join('\n');

  const totalAmount = pendingChecks.reduce((sum, c) => sum + (c.amount || 0), 0);

  const text =
`📋 *ملخص الشيكات المعلقة — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━━━━

📅 التاريخ: ${_fmt(new Date())}
🔢 العدد: ${pendingChecks.length} شيك
💰 الإجمالي: ${totalAmount.toLocaleString('ar-EG')} ₪

📋 التفاصيل:
${lines}

━━━━━━━━━━━━━━━━━━━━━━━
⏰ ${_fmtDateTime(new Date())}`;

  const ok = await _sendToManager(text, {
    partyName: 'المدير',
    checkNumber: '-',
    messageType: 'daily_report',
    sentBy: 'admin'
  });

  return { sent: ok ? 1 : 0, failed: ok ? 0 : 1, total: pendingChecks.length };
}


module.exports = {
  // إشعارات الفواتير
  notifyInvoiceNew, notifyInvoicePaid,
  // إشعارات المدفوعات
  notifyPaymentReceived, notifyPaymentsBatch,
  // إشعارات كشف الحساب
  notifyStatementEntry,
  // إشعارات الشيكات
  notifyAdded, notifyCleared, notifyReturned, notifyCancelled, notifyEdited, notifyTransferred,
  // أدوات عامة
  sendTestMessage, setupCron, refreshCron, runDailyJob, sendBulkAudit
};
