'use strict';
/**
 * ManagerReportService — تقارير الحسابات لمدير المعرض عبر واتساب
 *
 * الوظائف:
 * - sendManagerReport()              → أرسل كشوفات كل الزبائن للمدير (PDF)
 * - sendCustomerStatementToCustomer(id) → أرسل كشف حساب الزبون لرقمه مباشرة
 * - setupWeeklyCron / refreshWeeklyCron → إعداد Cron أسبوعي
 */

const path        = require('path');
const cron        = require('node-cron');
const moment      = require('moment');
const PDFDocument = require('pdfkit');
const WA          = require('./WhatsAppService');
const Customer    = require('../models/Customer');
const Ledger      = require('../models/Ledger');
const Setting     = require('../models/Setting');
const NotificationLog = require('../models/NotificationLog');

let _weeklyCronJob = null;

const ARABIC_FONT = path.join(__dirname, '../public/fonts/Amiri-Regular.ttf');

// ─── مساعدات ──────────────────────────────────────────────────────────────────
async function _getSettings() { return (await Setting.findOne().lean()) || {}; }
function _fmt(date)  { return date ? moment(date).format('DD/MM/YYYY') : '-'; }
function _money(n)   { return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' ILS'; }

// ─── توليد PDF كشف حساب ───────────────────────────────────────────────────────
function _generateStatementPDF(customer, entries, totals, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const doc    = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let useArabic = false;
      try { doc.registerFont('Arabic', ARABIC_FONT); useArabic = true; } catch (_) {}

      const arabicFont = useArabic ? 'Arabic' : 'Helvetica';
      const latinFont  = 'Helvetica';
      const latinBold  = 'Helvetica-Bold';
      const pageW      = doc.page.width;
      const margin     = 40;
      const colW       = pageW - margin * 2;

      // رأس الصفحة
      doc.font(arabicFont).fontSize(16).fillColor('#1e293b')
         .text(storeName || 'معرض الصافي للمفروشات', margin, margin, { align: 'center', width: colW });
      doc.moveDown(0.3);
      doc.font(arabicFont).fontSize(13).fillColor('#1e293b')
         .text(`كشف حساب — ${customer.fullName}`, margin, doc.y, { align: 'center', width: colW });
      doc.moveDown(0.2);
      doc.font(latinFont).fontSize(10).fillColor('#64748b')
         .text(`Customer Statement | ${_fmt(new Date())}`, margin, doc.y, { align: 'center', width: colW });
      doc.moveDown(0.3);
      if (customer.phone) {
        doc.font(arabicFont).fontSize(10).fillColor('#475569')
           .text(`الهاتف: ${customer.phone}`, margin, doc.y, { align: 'center', width: colW });
        doc.moveDown(0.3);
      }
      doc.moveTo(margin, doc.y).lineTo(pageW - margin, doc.y).strokeColor('#e2e8f0').lineWidth(1).stroke();
      doc.moveDown(0.5);

      // مربعات الأرصدة
      const boxY   = doc.y;
      const boxH   = 56;
      const thirdW = colW / 3;
      [
        { label: 'Total Debit',  value: _money(totals.totalDebit),   color: '#fee2e2', text: '#991b1b' },
        { label: 'Total Credit', value: _money(totals.totalCredit),  color: '#dcfce7', text: '#166534' },
        { label: 'Balance',      value: _money(totals.finalBalance), color: totals.finalBalance > 0 ? '#fef3c7' : '#f0fdf4', text: totals.finalBalance > 0 ? '#92400e' : '#166534' }
      ].forEach((b, i) => {
        const bx = margin + i * thirdW;
        doc.roundedRect(bx, boxY, thirdW - 6, boxH, 6).fillColor(b.color).fill();
        doc.font(latinFont).fontSize(8).fillColor(b.text).text(b.label, bx + 6, boxY + 8, { width: thirdW - 18 });
        doc.font(latinBold).fontSize(13).fillColor(b.text).text(b.value, bx + 6, boxY + 22, { width: thirdW - 18 });
      });
      doc.y = boxY + boxH + 12;

      if (entries.length === 0) {
        doc.moveDown(1);
        doc.font(arabicFont).fontSize(12).fillColor('#94a3b8')
           .text('لا توجد حركات مسجّلة', margin, doc.y, { align: 'center', width: colW });
        doc.end();
        return;
      }

      // جدول الحركات
      const cols = [
        { label: 'Date',        key: 'date',    w: 70  },
        { label: 'Description', key: 'desc',    w: 200 },
        { label: 'Ref',         key: 'refNo',   w: 60  },
        { label: 'Debit',       key: 'debit',   w: 75  },
        { label: 'Credit',      key: 'credit',  w: 75  },
        { label: 'Balance',     key: 'balance', w: 80  }
      ];
      const rowH = 18;
      const hdrH = 22;

      const _drawHeader = () => {
        const hy = doc.y;
        doc.rect(margin, hy, colW, hdrH).fillColor('#1e293b').fill();
        let cx = margin + 4;
        cols.forEach(c => {
          doc.font(latinBold).fontSize(8).fillColor('#ffffff')
             .text(c.label, cx, hy + 6, { width: c.w - 4, align: 'left' });
          cx += c.w;
        });
        doc.y = hy + hdrH + 2;
        doc.fillColor('#000000');
      };
      _drawHeader();

      let rowIdx = 0;
      for (const e of entries) {
        if (doc.y + rowH > doc.page.height - 60) { doc.addPage(); _drawHeader(); }
        const ry = doc.y;
        doc.rect(margin, ry, colW, rowH).fillColor(rowIdx % 2 === 0 ? '#f8fafc' : '#ffffff').fill();
        const vals = {
          date:    _fmt(e.date),
          desc:    (e.description || '').slice(0, 38),
          refNo:   (e.refNo || '-').slice(0, 10),
          debit:   e.debit  > 0 ? _money(e.debit)  : '',
          credit:  e.credit > 0 ? _money(e.credit) : '',
          balance: _money(e.balance)
        };
        let cx = margin + 4;
        cols.forEach(c => {
          const color = c.key === 'debit'   && e.debit  > 0 ? '#991b1b'
                      : c.key === 'credit'  && e.credit > 0 ? '#166534'
                      : c.key === 'balance' ? (e.balance > 0 ? '#92400e' : '#166534')
                      : '#1e293b';
          const useAr = c.key === 'desc' && useArabic;
          doc.font(useAr ? arabicFont : latinFont).fontSize(8).fillColor(color)
             .text(vals[c.key] || '', cx, ry + 5, { width: c.w - 6, align: 'left', lineBreak: false });
          cx += c.w;
        });
        doc.y = ry + rowH;
        rowIdx++;
      }

      // تذييل الأرصدة
      doc.moveDown(0.8);
      doc.moveTo(margin, doc.y).lineTo(pageW - margin, doc.y).strokeColor('#e2e8f0').stroke();
      doc.moveDown(0.4);
      [
        { label: 'Total Debit:',   val: _money(totals.totalDebit),   color: '#991b1b' },
        { label: 'Total Credit:',  val: _money(totals.totalCredit),  color: '#166534' },
        { label: 'Final Balance:', val: _money(totals.finalBalance), color: totals.finalBalance > 0 ? '#92400e' : '#166534' }
      ].forEach(t => {
        const ty = doc.y;
        doc.font(latinBold).fontSize(10).fillColor('#1e293b').text(t.label, margin, ty, { width: 120 });
        doc.font(latinFont).fontSize(10).fillColor(t.color).text(t.val, margin + 125, ty);
      });

      doc.moveDown(1.5);
      doc.font(arabicFont).fontSize(9).fillColor('#94a3b8')
         .text(`تم توليد هذا الكشف تلقائياً بتاريخ ${_fmt(new Date())} — ${storeName || 'معرض الصافي'}`,
               margin, doc.y, { align: 'center', width: colW });
      doc.end();
    } catch (err) { reject(err); }
  });
}

// ─── بناء بيانات كشف حساب زبون ───────────────────────────────────────────────
async function _buildCustomerData(customer) {
  const ledgerEntries = await Ledger.find({ partyId: customer._id, partyModel: 'Customer' })
    .sort({ date: 1, _id: 1 }).lean();
  let totalDebit = 0, totalCredit = 0, runningBalance = 0;
  const entries = ledgerEntries.map(e => {
    if (e.type === 'debit') { totalDebit += e.amount; runningBalance += e.amount; }
    else                    { totalCredit += e.amount; runningBalance -= e.amount; }
    return { date: e.date, description: e.description || '', refNo: e.refNo || '-',
             debit: e.type === 'debit' ? e.amount : 0, credit: e.type === 'credit' ? e.amount : 0,
             balance: runningBalance };
  });
  return { entries, totals: { totalDebit, totalCredit, finalBalance: runningBalance } };
}

// ─── تسجيل في سجل الإشعارات ───────────────────────────────────────────────────
async function _log(phone, text, type, ok, reason, sentBy = 'system') {
  await new NotificationLog({
    partyName: 'المدير', partyPhone: phone, checkNumber: '-',
    messageType: type, messageText: text.slice(0, 400),
    status: ok ? 'SUCCESS' : 'FAILED', failReason: reason || undefined, sentBy
  }).save().catch(() => {});
}

// ─── إرسال كشوفات كل الزبائن للمدير ─────────────────────────────────────────
async function sendManagerReport(sentBy = 'system') {
  const s = await _getSettings();
  if (!s.waManagerPhone) {
    console.log('[ManagerReport] ⚠️ لا يوجد رقم واتساب للمدير');
    return { sent: 0, failed: 0, skipped: 0, error: 'لا يوجد رقم مدير' };
  }

  const managerPhone = s.waManagerPhone;
  const storeName    = s.storeName || 'معرض الصافي للمفروشات';
  const customers    = await Customer.find({ isActive: true }).sort({ fullName: 1 }).lean();

  let sent = 0, failed = 0, skipped = 0;
  let totalAllDebit = 0, totalAllCredit = 0;
  const summaryRows = [];

  for (const customer of customers) {
    try {
      const { entries, totals } = await _buildCustomerData(customer);
      totalAllDebit  += totals.totalDebit;
      totalAllCredit += totals.totalCredit;
      if (entries.length === 0) { skipped++; continue; }
      summaryRows.push({ name: customer.fullName, phone: customer.phone || '-', balance: totals.finalBalance });

      let pdfBuffer = null;
      try { pdfBuffer = await _generateStatementPDF(customer, entries, totals, storeName); } catch (_) {}

      const caption =
        `📊 كشف حساب — ${customer.fullName}\n` +
        `📱 ${customer.phone || 'لا يوجد رقم'}\n` +
        `━━━━━━━━━━━━━━\n` +
        `💳 الرصيد: *${totals.finalBalance.toLocaleString('ar-EG')} ₪*\n` +
        `📤 المدين: ${totals.totalDebit.toLocaleString('ar-EG')} ₪\n` +
        `📥 الدائن: ${totals.totalCredit.toLocaleString('ar-EG')} ₪`;

      if (pdfBuffer) {
        const safeFileName = `statement-${(customer.fullName || 'customer').replace(/\s+/g, '-').replace(/[^\w-]/g, '')}-${_fmt(new Date()).replace(/\//g, '')}.pdf`;
        try {
          await WA.sendDocument(managerPhone, pdfBuffer, safeFileName, 'application/pdf', caption);
          await _log(managerPhone, caption, 'manager_statement_pdf', true, '', sentBy);
          sent++;
        } catch (docErr) {
          try { await WA.sendMessage(managerPhone, caption); await _log(managerPhone, caption, 'manager_statement_text', true, '', sentBy); sent++; }
          catch (txtErr) { await _log(managerPhone, caption, 'manager_statement_text', false, txtErr.message, sentBy); failed++; }
        }
      } else {
        try { await WA.sendMessage(managerPhone, caption); await _log(managerPhone, caption, 'manager_statement_text', true, '', sentBy); sent++; }
        catch (txtErr) { await _log(managerPhone, caption, 'manager_statement_text', false, txtErr.message, sentBy); failed++; }
      }

      await new Promise(r => setTimeout(r, 800)); // فترة راحة بين الرسائل
    } catch (err) {
      console.error(`[ManagerReport] خطأ في كشف ${customer.fullName}:`, err.message);
      failed++;
    }
  }

  // ملخص إجمالي
  try {
    const date    = moment().format('dddd DD/MM/YYYY HH:mm');
    const netBal  = totalAllDebit - totalAllCredit;
    const topDebt = summaryRows.filter(r => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 10);
    let summary   = `📋 *ملخص كشوفات الحسابات*\n📅 ${date}\n━━━━━━━━━━━━━━━━━━━━\n`;
    summary += `👥 إجمالي الزبائن: ${customers.length}\n`;
    summary += `📤 إجمالي المديونيات: *${totalAllDebit.toLocaleString('ar-EG')} ₪*\n`;
    summary += `📥 إجمالي المدفوعات: *${totalAllCredit.toLocaleString('ar-EG')} ₪*\n`;
    summary += `💰 صافي الرصيد: *${netBal.toLocaleString('ar-EG')} ₪*\n`;
    summary += `✅ زبائن بدون مديونية: ${summaryRows.filter(r => r.balance <= 0).length}\n`;
    if (topDebt.length > 0) {
      summary += `\n🔴 *أعلى المديونيات:*\n`;
      topDebt.forEach(c => { summary += `• ${c.name} — ${c.balance.toLocaleString('ar-EG')} ₪\n`; });
    }
    summary += `\n📄 تم إرسال ${sent} كشف — فشل ${failed}`;
    await WA.sendMessage(managerPhone, summary);
    await _log(managerPhone, summary, 'manager_report_summary', true, '', sentBy);
  } catch (err) {
    console.error('[ManagerReport] خطأ في الملخص:', err.message);
    failed++;
  }

  console.log(`[ManagerReport] ✅ اكتمل: ${sent} نجح، ${failed} فشل، ${skipped} متخطى`);
  return { sent, failed, skipped, total: customers.length };
}

// ─── إرسال كشف حساب زبون واحد إلى رقمه مباشرة ───────────────────────────────
async function sendCustomerStatementToCustomer(customerId, sentBy = 'admin') {
  const s         = await _getSettings();
  const storeName = s.storeName || 'معرض الصافي للمفروشات';
  const customer  = await Customer.findById(customerId).lean();

  if (!customer) throw new Error('الزبون غير موجود');
  if (!customer.phone) throw new Error(`الزبون ${customer.fullName} ليس لديه رقم هاتف مسجّل`);

  const { entries, totals } = await _buildCustomerData(customer);

  if (entries.length === 0) {
    // أرسل رسالة نصية فقط إذا ما في حركات
    const msg =
      `عزيزنا ${customer.fullName}\n\n` +
      `كشف حسابكم لدى ${storeName}:\n` +
      `━━━━━━━━━━━━━━\n` +
      `لا توجد حركات مسجّلة على حسابكم حتى الآن.\n\n` +
      `شكراً لتعاملكم معنا.`;
    await WA.sendMessage(customer.phone, msg);
    await _log(customer.phone, msg, 'customer_statement_text', true, '', sentBy);
    return { fullName: customer.fullName, entries: 0, balance: 0 };
  }

  // توليد PDF
  let pdfBuffer = null;
  try { pdfBuffer = await _generateStatementPDF(customer, entries, totals, storeName); } catch (_) {}

  const caption =
    `عزيزنا ${customer.fullName}\n\n` +
    `كشف حسابكم لدى ${storeName}:\n` +
    `━━━━━━━━━━━━━━\n` +
    `💳 الرصيد الحالي: ${totals.finalBalance.toLocaleString('ar-EG')} ₪\n` +
    `📤 إجمالي المديونية: ${totals.totalDebit.toLocaleString('ar-EG')} ₪\n` +
    `📥 إجمالي المدفوعات: ${totals.totalCredit.toLocaleString('ar-EG')} ₪\n\n` +
    `شكراً لتعاملكم معنا.`;

  if (pdfBuffer) {
    const safeFileName = `كشف-حساب-${(customer.fullName).replace(/\s+/g, '-')}-${_fmt(new Date()).replace(/\//g, '')}.pdf`;
    try {
      await WA.sendDocument(customer.phone, pdfBuffer, safeFileName, 'application/pdf', caption);
      await _log(customer.phone, caption, 'customer_statement_pdf', true, '', sentBy);
    } catch (docErr) {
      // fallback: نص فقط
      await WA.sendMessage(customer.phone, caption);
      await _log(customer.phone, caption, 'customer_statement_text', true, '', sentBy);
    }
  } else {
    await WA.sendMessage(customer.phone, caption);
    await _log(customer.phone, caption, 'customer_statement_text', true, '', sentBy);
  }

  console.log(`[ManagerReport] ✅ أُرسل كشف ${customer.fullName} إلى ${customer.phone}`);
  return { fullName: customer.fullName, entries: entries.length, balance: totals.finalBalance };
}

// ─── إرسال كشف حساب زبون واحد إلى المدير ────────────────────────────────────
async function sendCustomerStatementToManager(customerId, sentBy = 'admin') {
  const s           = await _getSettings();
  const storeName   = s.storeName || 'معرض الصافي للمفروشات';
  const managerPhone = s.waManagerPhone;
  if (!managerPhone) throw new Error('لم يتم إدخال رقم المدير في الإعدادات');

  const customer = await Customer.findById(customerId).lean();
  if (!customer) throw new Error('الزبون غير موجود');

  const { entries, totals } = await _buildCustomerData(customer);

  const caption =
    `📊 كشف حساب — ${customer.fullName}\n` +
    `📱 ${customer.phone || 'لا يوجد رقم'}\n` +
    `━━━━━━━━━━━━━━\n` +
    `💳 الرصيد: *${totals.finalBalance.toLocaleString('ar-EG')} ₪*\n` +
    `📤 المدين: ${totals.totalDebit.toLocaleString('ar-EG')} ₪\n` +
    `📥 الدائن: ${totals.totalCredit.toLocaleString('ar-EG')} ₪`;

  if (entries.length === 0) {
    const msg = caption + '\n\nلا توجد حركات مسجّلة على هذا الحساب.';
    await WA.sendMessage(managerPhone, msg);
    await _log(managerPhone, msg, 'manager_one_statement_text', true, '', sentBy);
    return { fullName: customer.fullName, entries: 0, balance: totals.finalBalance };
  }

  let pdfBuffer = null;
  try { pdfBuffer = await _generateStatementPDF(customer, entries, totals, storeName); } catch (_) {}

  if (pdfBuffer) {
    const safeFileName = `statement-${(customer.fullName || 'customer').replace(/\s+/g, '-').replace(/[^\w-]/g, '')}-${_fmt(new Date()).replace(/\//g, '')}.pdf`;
    try {
      await WA.sendDocument(managerPhone, pdfBuffer, safeFileName, 'application/pdf', caption);
      await _log(managerPhone, caption, 'manager_one_statement_pdf', true, '', sentBy);
    } catch (docErr) {
      await WA.sendMessage(managerPhone, caption);
      await _log(managerPhone, caption, 'manager_one_statement_text', true, '', sentBy);
    }
  } else {
    await WA.sendMessage(managerPhone, caption);
    await _log(managerPhone, caption, 'manager_one_statement_text', true, '', sentBy);
  }

  console.log(`[ManagerReport] ✅ أُرسل كشف ${customer.fullName} للمدير`);
  return { fullName: customer.fullName, entries: entries.length, balance: totals.finalBalance };
}

// ─── Cron أسبوعي ──────────────────────────────────────────────────────────────
async function setupWeeklyCron() {
  if (_weeklyCronJob) { _weeklyCronJob.stop(); _weeklyCronJob = null; }
  const s = await _getSettings();
  if (!s.waWeeklyReportEnabled) { console.log('[ManagerReport] التقرير الأسبوعي معطّل'); return; }
  const day  = s.waWeeklyReportDay  || '6';
  const time = s.waWeeklyReportTime || '08:00';
  const [hour, minute] = time.split(':');
  const expression = `${minute || '0'} ${hour || '8'} * * ${day}`;
  console.log(`[ManagerReport] ⏰ إعداد التقرير الأسبوعي: ${expression}`);
  _weeklyCronJob = cron.schedule(
    expression,
    () => sendManagerReport('cron').catch(e => console.error('[ManagerReport] خطأ:', e.message)),
    { timezone: 'Asia/Jerusalem' }
  );
}

async function refreshWeeklyCron() { await setupWeeklyCron(); }

module.exports = {
  sendManagerReport,
  sendCustomerStatementToCustomer,
  sendCustomerStatementToManager,
  setupWeeklyCron,
  refreshWeeklyCron
};
