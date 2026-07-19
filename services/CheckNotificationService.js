'use strict';
/**
 * CheckNotificationService — إشعارات الشيكات عبر WhatsApp
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

// ─── جلب الإعدادات ───────────────────────────────────────────────────────────
async function _getSettings() {
  let s = await Setting.findOne().lean();
  if (!s) s = {};
  return s;
}

// ─── تنسيق التاريخ ───────────────────────────────────────────────────────────
function _fmt(date) {
  if (!date) return '-';
  return moment(date).locale('ar').format('DD/MM/YYYY');
}

// ─── قاعدة صارمة: الواتساب للزبائن فقط، ممنوع إرسال أي رسالة للتجار نهائيًا ────
// نقطة تحقق واحدة مركزية يمر منها كل إشعار (فاتورة/دفعة/سند/شيك/كشف حساب/تذكير)
// حتى لو أُضيفت وظيفة إشعار جديدة مستقبلاً، طالما تستخدم _getPartyPhone فهي محمية تلقائياً.
function _isDealerEntity(entity) {
  return entity && entity.partyModel === 'Dealer';
}

// ─── جلب رقم الهاتف للطرف ────────────────────────────────────────────────────
async function _getPartyPhone(entity) {
  try {
    if (_isDealerEntity(entity)) {
      console.log(`[WA] 🚫 تم تجاهل الإرسال — الطرف تاجر (${entity.partyName || ''}) والواتساب مخصص للزبائن فقط`);
      return null;
    }
    const Model = entity.partyModel === 'Customer' ? Customer : Dealer;
    const party = await Model.findById(entity.partyId).lean();
    return party ? party.phone : null;
  } catch (e) {
    return null;
  }
}

// ─── إرسال رسالة وتسجيلها ────────────────────────────────────────────────────
async function _send(phone, text, logData) {
  let status = 'SUCCESS', failReason = '', retries = 0;
  try {
    await WA.sendMessage(phone, text);
  } catch (err) {
    status = 'FAILED';
    failReason = err.message;
    retries = 3;
  }
  try {
    await new NotificationLog({ ...logData, partyPhone: phone, messageText: text, status, failReason, retries }).save();
  } catch (e) {
    console.error('[WA-Log] خطأ في حفظ السجل:', e.message);
  }
  return status === 'SUCCESS';
}

// ─── التحقق من عدم التكرار ───────────────────────────────────────────────────
async function _isDuplicate(checkId, messageType) {
  const last = await NotificationLog.findOne({ checkId, messageType, status: 'SUCCESS' }).sort({ sentAt: -1 }).lean();
  return !!last;
}

// ─── إشعار إضافة شيك جديد ────────────────────────────────────────────────────
async function notifyAdded(check) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) return;
    if (!s.waAddedEnabled)         return;
    const phone = await _getPartyPhone(check);
    if (!phone) { console.log(`[WA] ⚠️ لا يوجد رقم هاتف — شيك جديد ${check.checkNumber} / ${check.partyName}`); return; }
    const text =
`عزيزنا ${check.partyName}

نود إعلامكم بأنه تم تسجيل شيك باسمكم لدى معرض الصافي للمفروشات.

رقم الشيك: ${check.checkNumber}

القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل

تاريخ الاستحقاق: ${_fmt(check.maturityDate)}

شكراً لتعاملكم معنا.`;
    await _send(phone, text, { partyName: check.partyName, checkNumber: check.checkNumber, checkId: check._id, messageType: 'added', sentBy: 'system' });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الإضافة:', e.message);
  }
}

// ─── إشعار صرف الشيك ─────────────────────────────────────────────────────────
async function notifyCleared(check) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log(`[WA] ⚠️ الإشعارات معطلة — شيك ${check.checkNumber}`); return; }
    if (!s.waClearedEnabled)        { console.log(`[WA] ⚠️ إشعار الصرف معطل — شيك ${check.checkNumber}`); return; }
    if (await _isDuplicate(check._id, 'cleared')) { console.log(`[WA] ⚠️ تم الإرسال مسبقاً — شيك ${check.checkNumber}`); return; }
    const phone = await _getPartyPhone(check);
    if (!phone) { console.log(`[WA] ⚠️ لا يوجد رقم هاتف للطرف — شيك ${check.checkNumber} / ${check.partyName}`); return; }
    const text =
`عزيزنا الزبون ${check.partyName}

نود إعلامكم بأنه تم صرف الشيك الخاص بكم والمسجل لدينا في معرض الصافي للمفروشات.

رقم الشيك: ${check.checkNumber}

القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل

تاريخ الصرف: ${_fmt(check.clearDate || new Date())}

شكراً لتعاملكم معنا.`;
    await _send(phone, text, { partyName: check.partyName, checkNumber: check.checkNumber, checkId: check._id, messageType: 'cleared', sentBy: 'system' });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الصرف:', e.message);
  }
}

// ─── إشعار رجوع الشيك ────────────────────────────────────────────────────────
async function notifyReturned(check) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log(`[WA] ⚠️ الإشعارات معطلة — شيك ${check.checkNumber}`); return; }
    if (!s.waReturnedEnabled)       { console.log(`[WA] ⚠️ إشعار الرجوع معطل — شيك ${check.checkNumber}`); return; }
    if (await _isDuplicate(check._id, 'returned')) { console.log(`[WA] ⚠️ تم الإرسال مسبقاً — شيك ${check.checkNumber}`); return; }
    const phone = await _getPartyPhone(check);
    if (!phone) { console.log(`[WA] ⚠️ لا يوجد رقم هاتف للطرف — شيك ${check.checkNumber} / ${check.partyName}`); return; }
    const text =
`عزيزنا الزبون ${check.partyName}

نود إعلامكم بأن الشيك الخاص بكم قد تم إرجاعه.

رقم الشيك: ${check.checkNumber}

القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل

تاريخ الشيك: ${_fmt(check.maturityDate)}

يرجى التواصل معنا لمعالجة الأمر.`;
    await _send(phone, text, { partyName: check.partyName, checkNumber: check.checkNumber, checkId: check._id, messageType: 'returned', sentBy: 'system' });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الرجوع:', e.message);
  }
}

// ─── إشعار إلغاء الشيك ───────────────────────────────────────────────────────
async function notifyCancelled(check) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled || !s.waCancelledEnabled) return;
    const phone = await _getPartyPhone(check);
    if (!phone) return;
    const text =
`عزيزنا الزبون ${check.partyName}

نود إعلامكم بأنه تم إلغاء الشيك الخاص بكم المسجل لدينا.

رقم الشيك: ${check.checkNumber}

القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل

للاستفسار يرجى التواصل معنا.

شكراً لتعاملكم مع معرض الصافي للمفروشات.`;
    await _send(phone, text, { partyName: check.partyName, checkNumber: check.checkNumber, checkId: check._id, messageType: 'cancelled', sentBy: 'system' });
  } catch (e) {
    console.error('[WA] خطأ في إشعار الإلغاء:', e.message);
  }
}

// ─── إشعار فاتورة جديدة ──────────────────────────────────────────────────────
async function notifyInvoiceNew(invoice) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log('[WA] ⚠️ فاتورة جديدة — الإشعارات معطلة (waNotificationsEnabled=false)'); return; }
    if (s.waInvoiceNewEnabled === false) { console.log('[WA] ⚠️ فاتورة جديدة — إشعار الفاتورة معطل'); return; }
    const phone = await _getPartyPhone(invoice);
    if (!phone) {
      console.log(`[WA] ⚠️ فاتورة جديدة — لا يوجد رقم هاتف للزبون: ${invoice.partyName}`);
      // ✅ إصلاح: كانت مفقودة return — يكمل الكود ويطبع null في اللوجات بدون إرسال للمدير
    } else {
      console.log(`[WA] 📋 إرسال إشعار فاتورة جديدة → ${invoice.partyName} (${phone})`);
    }
    const text =
`عزيزنا ${invoice.partyName}

نود إعلامكم بأنه تم إصدار فاتورة جديدة باسمكم في معرض الصافي للمفروشات.

رقم الفاتورة: ${invoice.invoiceNumber}
${invoice.discount > 0 ? `المبلغ قبل الخصم: ${invoice.subtotal?.toLocaleString('ar-EG')} شيكل\nالخصم: ${invoice.discount?.toLocaleString('ar-EG')} شيكل\n` : ''}المبلغ الإجمالي: ${invoice.totalAmount?.toLocaleString('ar-EG')} شيكل

تاريخ الفاتورة: ${_fmt(invoice.invoiceDate)}

شكراً لتعاملكم معنا.`;
    if (phone) await _send(phone, text, { partyName: invoice.partyName, checkNumber: invoice.invoiceNumber, messageType: 'invoice_new', sentBy: 'system' });
    if (s.waManagerPhone) {
      const mg = `📋 فاتورة جديدة\n👤 ${invoice.partyName}\n🔢 ${invoice.invoiceNumber}\n💰 ${invoice.totalAmount?.toLocaleString('ar-EG')} ₪`;
      await _send(s.waManagerPhone, mg, { partyName: invoice.partyName, checkNumber: invoice.invoiceNumber, messageType: 'invoice_new_mgr', sentBy: 'system' });
    }
  } catch (e) { console.error('[WA] خطأ في إشعار الفاتورة الجديدة:', e.message); }
}

// ─── إشعار دفع الفاتورة كاملاً ───────────────────────────────────────────────
async function notifyInvoicePaid(invoice) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log('[WA] ⚠️ فاتورة مدفوعة — الإشعارات معطلة'); return; }
    if (s.waInvoicePaidEnabled === false) { console.log('[WA] ⚠️ فاتورة مدفوعة — إشعار الدفع الكامل معطل'); return; }
    const phone = await _getPartyPhone(invoice);
    console.log(`[WA] ✅ إرسال إشعار دفع كامل → ${invoice.partyName} (${phone})`);
    const text =
`عزيزنا ${invoice.partyName}

نود إعلامكم بأنه تم استلام كامل مبلغ الفاتورة.

رقم الفاتورة: ${invoice.invoiceNumber}
${invoice.discount > 0 ? `المبلغ قبل الخصم: ${invoice.subtotal?.toLocaleString('ar-EG')} شيكل\nالخصم: ${invoice.discount?.toLocaleString('ar-EG')} شيكل\n` : ''}المبلغ الإجمالي: ${invoice.totalAmount?.toLocaleString('ar-EG')} شيكل

شكراً لتعاملكم مع معرض الصافي للمفروشات.`;
    if (phone) await _send(phone, text, { partyName: invoice.partyName, checkNumber: invoice.invoiceNumber, messageType: 'invoice_paid', sentBy: 'system' });
    if (s.waManagerPhone) {
      const mg = `✅ فاتورة مدفوعة بالكامل\n👤 ${invoice.partyName}\n🔢 ${invoice.invoiceNumber}\n💰 ${invoice.totalAmount?.toLocaleString('ar-EG')} ₪`;
      await _send(s.waManagerPhone, mg, { partyName: invoice.partyName, checkNumber: invoice.invoiceNumber, messageType: 'invoice_paid_mgr', sentBy: 'system' });
    }
  } catch (e) { console.error('[WA] خطأ في إشعار الفاتورة المدفوعة:', e.message); }
}

// ─── إشعار استلام دفعة واحدة ─────────────────────────────────────────────────
async function notifyPaymentReceived(payment, remainingBalance) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log('[WA] ⚠️ دفعة — الإشعارات معطلة'); return; }
    if (s.waPaymentReceivedEnabled === false) { console.log('[WA] ⚠️ دفعة — إشعار الدفعة معطل'); return; }
    const phone = await _getPartyPhone(payment);
    console.log(`[WA] 💳 إرسال إشعار دفعة → ${payment.partyName} (${phone})`);
    const methodMap = { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' };
    const methodAr = methodMap[payment.paymentMethod] || payment.paymentMethod;
    const remainingLine = (remainingBalance !== undefined && remainingBalance !== null)
      ? `\nالمتبقي على حسابكم: ${remainingBalance.toLocaleString('ar-EG')} شيكل\n`
      : '\n';
    const text =
`عزيزنا ${payment.partyName}

نود إعلامكم بأنه تم استلام دفعتكم بنجاح.

المبلغ: ${payment.amount?.toLocaleString('ar-EG')} شيكل

طريقة الدفع: ${methodAr}

رقم السند: ${payment.voucherNumber || '-'}

التاريخ: ${_fmt(payment.paymentDate)}
${remainingLine}شكراً لتعاملكم مع معرض الصافي للمفروشات.`;
    if (phone) await _send(phone, text, { partyName: payment.partyName, checkNumber: payment.voucherNumber || '-', messageType: 'payment_received', sentBy: 'system' });
    if (s.waManagerPhone) {
      const mg = `💳 دفعة مستلمة\n👤 ${payment.partyName}\n💰 ${payment.amount?.toLocaleString('ar-EG')} ₪\n${methodAr}${remainingBalance !== undefined ? `\nالمتبقي: ${remainingBalance.toLocaleString('ar-EG')} ₪` : ''}`;
      await _send(s.waManagerPhone, mg, { partyName: payment.partyName, checkNumber: payment.voucherNumber || '-', messageType: 'payment_received_mgr', sentBy: 'system' });
    }
  } catch (e) { console.error('[WA] خطأ في إشعار الدفعة:', e.message); }
}

// ─── إشعار استلام دفعات متعددة (رسالة واحدة) ────────────────────────────────
async function notifyPaymentsBatch(payments, remainingBalance) {
  try {
    if (!payments || payments.length === 0) return;
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log('[WA] ⚠️ دفعات — الإشعارات معطلة'); return; }
    if (s.waPaymentReceivedEnabled === false) { console.log('[WA] ⚠️ دفعات — إشعار الدفعة معطل'); return; }
    // استخدم أول دفعة لجلب رقم الهاتف
    const phone = await _getPartyPhone(payments[0]);
    if (!phone) { console.log(`[WA] ⚠️ لا يوجد رقم هاتف — ${payments[0].partyName}`); return; }

    const methodMap = { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' };
    const totalAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    const paymentLines = payments.map((p, i) =>
      `${i + 1}. ${(p.amount || 0).toLocaleString('ar-EG')} شيكل — ${methodMap[p.paymentMethod] || p.paymentMethod} (${p.voucherNumber || '-'})`
    ).join('\n');

    const remainingLine = (remainingBalance !== undefined && remainingBalance !== null)
      ? `\nالمتبقي على حسابكم: ${remainingBalance.toLocaleString('ar-EG')} شيكل\n`
      : '\n';

    const text =
`عزيزنا ${payments[0].partyName}

نود إعلامكم بأنه تم استلام دفعاتكم بنجاح في معرض الصافي للمفروشات.

─────────────────
${paymentLines}
─────────────────
الإجمالي: ${totalAmount.toLocaleString('ar-EG')} شيكل

التاريخ: ${_fmt(payments[0].paymentDate)}
${remainingLine}شكراً لتعاملكم معنا.`;

    console.log(`[WA] 💳 إرسال إشعار دفعات (${payments.length}) → ${payments[0].partyName} (${phone})`);
    const firstVoucher = payments[0].voucherNumber || '-';
    await _send(phone, text, { partyName: payments[0].partyName, checkNumber: firstVoucher, messageType: 'payment_received', sentBy: 'system' });

    if (s.waManagerPhone) {
      const mg = `💳 دفعات مستلمة (${payments.length})\n👤 ${payments[0].partyName}\n💰 الإجمالي: ${totalAmount.toLocaleString('ar-EG')} ₪${remainingBalance !== undefined ? `\nالمتبقي: ${remainingBalance.toLocaleString('ar-EG')} ₪` : ''}`;
      await _send(s.waManagerPhone, mg, { partyName: payments[0].partyName, checkNumber: firstVoucher, messageType: 'payment_received_mgr', sentBy: 'system' });
    }
  } catch (e) { console.error('[WA] خطأ في إشعار الدفعات المتعددة:', e.message); }
}

// ─── إشعار حركة كشف الحساب ───────────────────────────────────────────────────
async function notifyStatementEntry(entry, remainingBalance) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled) { console.log('[WA] ⚠️ كشف حساب — الإشعارات معطلة'); return; }
    if (s.waStatementEntryEnabled === false) { console.log('[WA] ⚠️ كشف حساب — إشعار الكشف معطل'); return; }
    const phone = await _getPartyPhone(entry);
    console.log(`[WA] 📒 إرسال إشعار كشف حساب → ${entry.partyName} (${phone})`);
    const typeAr = entry.type === 'debit' ? 'مديونية' : 'دفعة';
    const remainingLine = (remainingBalance !== undefined && remainingBalance !== null)
      ? `\nالمتبقي على حسابكم: ${remainingBalance.toLocaleString('ar-EG')} شيكل\n`
      : '\n';
    const text =
`عزيزنا ${entry.partyName}

تم تسجيل حركة جديدة على حسابكم في معرض الصافي للمفروشات.

البيان: ${entry.description}

المبلغ: ${entry.amount?.toLocaleString('ar-EG')} شيكل

النوع: ${typeAr}

التاريخ: ${_fmt(entry.date)}
${remainingLine}للاستفسار تواصل معنا.`;
    if (phone) await _send(phone, text, { partyName: entry.partyName, checkNumber: entry.refNo || '-', messageType: 'statement_entry', sentBy: 'system' });
    if (s.waManagerPhone) {
      const mg = `📒 حركة كشف حساب\n👤 ${entry.partyName}\n${typeAr}: ${entry.amount?.toLocaleString('ar-EG')} ₪\n${entry.description}${remainingBalance !== undefined ? `\nالمتبقي: ${remainingBalance.toLocaleString('ar-EG')} ₪` : ''}`;
      await _send(s.waManagerPhone, mg, { partyName: entry.partyName, checkNumber: entry.refNo || '-', messageType: 'statement_entry_mgr', sentBy: 'system' });
    }
  } catch (e) { console.error('[WA] خطأ في إشعار كشف الحساب:', e.message); }
}

// ─── إشعار تعديل الشيك ───────────────────────────────────────────────────────
async function notifyEdited(check) {
  try {
    const s = await _getSettings();
    if (!s.waNotificationsEnabled || !s.waEditEnabled) return;
    const phone = await _getPartyPhone(check);
    if (!phone) return;
    const text =
`عزيزنا الزبون ${check.partyName}

نود إعلامكم بأنه تم تعديل بيانات الشيك الخاص بكم في معرض الصافي للمفروشات.

رقم الشيك: ${check.checkNumber}

القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل

تاريخ الاستحقاق: ${_fmt(check.maturityDate)}

للاستفسار يرجى التواصل معنا.`;
    await _send(phone, text, { partyName: check.partyName, checkNumber: check.checkNumber, checkId: check._id, messageType: 'edited', sentBy: 'system' });
  } catch (e) {
    console.error('[WA] خطأ في إشعار التعديل:', e.message);
  }
}

// ─── التشغيل اليومي: تذكيرات وتقرير ─────────────────────────────────────────
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

    if (s.waReminderEnabled) {
      for (const stage of REMINDER_STAGES) {
        const targetDate = new Date(now.getTime() + stage.days * 24 * 60 * 60 * 1000);
        const startOfDay = new Date(targetDate); startOfDay.setHours(0, 0, 0, 0);
        const endOfDay   = new Date(targetDate); endOfDay.setHours(23, 59, 59, 999);

        // الواتساب للزبائن فقط — شيكات التجار مستبعدة من التذكيرات والتقرير من الأساس
        const stageChecks = await Check.find({
          status: 'pending',
          partyModel: 'Customer',
          maturityDate: { $gte: startOfDay, $lte: endOfDay }
        }).lean();
        scannedTotal += stageChecks.length;

        for (const check of stageChecks) {
          // لا ترسل نفس مرحلة التذكير مرتين لنفس الشيك
          const existing = await NotificationLog.findOne({
            checkId: check._id, messageType: stage.messageType, status: 'SUCCESS'
          }).lean();
          if (existing) continue;

          const phone = await _getPartyPhone(check);
          if (!phone) continue;

          const dueLine = stage.days === 0
            ? 'اليوم هو موعد استحقاق الشيك الخاص بكم.'
            : `نود تذكيركم بأن موعد استحقاق الشيك الخاص بكم سيكون ${stage.label} بتاريخ:`;

          const text =
`عزيزنا الزبون ${check.partyName}

${dueLine}

رقم الشيك: ${check.checkNumber}

تاريخ الاستحقاق: ${_fmt(check.maturityDate)}

القيمة المطلوبة: ${check.amount?.toLocaleString('ar-EG')} شيكل.

شكراً لتعاونكم.`;

          const ok = await _send(phone, text, {
            partyName: check.partyName, checkNumber: check.checkNumber,
            checkId: check._id, messageType: stage.messageType, sentBy: 'cron'
          });
          if (ok) sent++; else failed++;
        }
      }
    }

    history.checksScanned = scannedTotal;

    // الشيكات المستحقة خلال نافذة التقرير (تُستخدم فقط لملخص المدير أدناه)
    const reminderDays = s.waReminderDays || 7;
    const reportWindowEnd = new Date(now.getTime() + reminderDays * 24 * 60 * 60 * 1000);
    const checks = await Check.find({
      status: 'pending',
      partyModel: 'Customer',
      maturityDate: { $gte: now, $lte: reportWindowEnd }
    }).lean();

    // ─── التقرير اليومي للمدير ───────────────────────────────────────────────
    const managerPhone = s.waManagerPhone;
    if (managerPhone) {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const [clearedToday, returnedToday, failedLogs] = await Promise.all([
        NotificationLog.countDocuments({ messageType: 'cleared', status: 'SUCCESS', sentAt: { $gte: todayStart } }),
        NotificationLog.countDocuments({ messageType: 'returned', status: 'SUCCESS', sentAt: { $gte: todayStart } }),
        NotificationLog.countDocuments({ status: 'FAILED', sentAt: { $gte: todayStart } }),
      ]);
      const totalAmount = checks.reduce((sum, c) => sum + (c.amount || 0), 0);

      const report =
`📋 التقرير اليومي — معرض الصافي للمفروشات

📅 التاريخ: ${_fmt(new Date())}

━━━━━━━━━━━━━━━━━━━━━━━━━
🔔 الشيكات المستحقة خلال ${reminderDays} أيام: ${checks.length}
💬 التذكيرات المرسلة: ${sent}
✅ الشيكات المصروفة (اليوم): ${clearedToday}
↩️ الشيكات المرتجعة (اليوم): ${returnedToday}
❌ الرسائل الفاشلة (اليوم): ${failedLogs}
💰 إجمالي قيمة الشيكات المستحقة: ${totalAmount.toLocaleString('ar-EG')} ₪
━━━━━━━━━━━━━━━━━━━━━━━━━`;

      const ok = await _send(managerPhone, report, {
        partyName: 'المدير', checkNumber: '-',
        messageType: 'daily_report', sentBy: 'cron'
      });
      if (!ok) failed++;
    }

    history.messagesSent   = sent;
    history.messagesFailed = failed;
    history.endTime        = new Date();
    await history.save();
    console.log(`[WA-Cron] ✅ انتهى: ${sent} رسالة ناجحة، ${failed} فاشلة`);
  } catch (err) {
    history.lastError  = err.message;
    history.endTime    = new Date();
    history.messagesSent   = sent;
    history.messagesFailed = failed;
    await history.save().catch(() => {});
    console.error('[WA-Cron] ❌ خطأ:', err.message);
  }
}

// ─── إرسال جماعي (تدقيق) ─────────────────────────────────────────────────────
async function sendBulkAudit() {
  const s = await _getSettings();
  // الواتساب للزبائن فقط — شيكات التجار مستبعدة من الإرسال الجماعي
  const checks = await Check.find({ status: 'pending', partyModel: 'Customer' }).lean();
  let sent = 0, failed = 0;
  for (const check of checks) {
    const phone = await _getPartyPhone(check);
    if (!phone) continue;
    const text =
`عزيزنا الزبون ${check.partyName}

هذا تأكيد من معرض الصافي للمفروشات بوجود شيك مسجل باسمكم.

رقم الشيك: ${check.checkNumber}
القيمة: ${check.amount?.toLocaleString('ar-EG')} شيكل
تاريخ الاستحقاق: ${_fmt(check.maturityDate)}

للاستفسار يرجى التواصل معنا.`;
    const ok = await _send(phone, text, {
      partyName: check.partyName, checkNumber: check.checkNumber,
      checkId: check._id, messageType: 'bulk', sentBy: 'admin'
    });
    if (ok) sent++; else failed++;
  }
  return { sent, failed, total: checks.length };
}

// ─── رسالة اختبار للمدير ──────────────────────────────────────────────────────
async function sendTestMessage() {
  const s = await _getSettings();
  const managerPhone = s.waManagerPhone;
  if (!managerPhone) throw new Error('لم يتم إدخال رقم المدير في الإعدادات');
  const text = `🚨 نظام إشعارات الشيكات يعمل بنجاح.\n\nوقت الإرسال:\n${moment().locale('ar').format('DD/MM/YYYY HH:mm:ss')}`;
  await WA.sendMessage(managerPhone, text);
  await new NotificationLog({
    partyName: 'المدير', partyPhone: managerPhone, checkNumber: '-',
    messageType: 'test', messageText: text, status: 'SUCCESS', sentBy: 'admin'
  }).save();
}

// ─── إعداد Cron Job ───────────────────────────────────────────────────────────
async function setupCron() {
  if (_cronJob) { _cronJob.stop(); _cronJob = null; }
  const s = await _getSettings();
  const time = s.waCronTime || '09:00';
  const [hour, minute] = time.split(':');
  const expression = `${minute || '0'} ${hour || '9'} * * *`;
  console.log(`[WA-Cron] ⏰ إعداد Cron: ${expression}`);
  _cronJob = cron.schedule(expression, () => runDailyJob(), { timezone: 'Asia/Jerusalem' });
}

/** إعادة إعداد Cron (تُستدعى بعد تغيير الإعدادات) */
async function refreshCron() {
  await setupCron();
}

module.exports = {
  notifyAdded, notifyCleared, notifyReturned, notifyCancelled, notifyEdited,
  notifyInvoiceNew, notifyInvoicePaid, notifyPaymentReceived, notifyPaymentsBatch,
  notifyStatementEntry,
  sendBulkAudit, sendTestMessage, setupCron, refreshCron, runDailyJob
};
