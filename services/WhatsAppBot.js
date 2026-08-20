'use strict';
/**
 * WhatsAppBot — بوت تحكم المدير من واتساب
 *
 * يمكّن المدير من إدارة النظام بالكامل عبر رسائل واتساب.
 * جميع الأوامر للمدير فقط (waManagerPhone).
 *
 * الأوامر:
 *   مساعدة / help         → عرض جميع الأوامر
 *   رصيد                  → أرصدة جميع الزبائن
 *   رصيد [اسم]            → رصيد زبون محدد
 *   كشف [اسم]             → كشف حساب تفصيلي
 *   فواتير                → الفواتير المعلقة
 *   فواتير [اسم]          → فواتير زبون محدد
 *   شيكات                 → الشيكات المستحقة
 *   دفعات [اسم]           → آخر الدفعات لزبون
 *   زبائن                 → قائمة الزبائن
 *   تجار                  → قائمة التجار
 *   تقرير                 → تقرير شامل
 *   تقرير [اسم]           → تقرير زبون محدد
 *   حركة [اسم] [مبلغ] [نوع:مدين/دائن] [وصف]  → إضافة حركة كشف حساب
 *   دفعة [اسم] [مبلغ] [طريقة:نقد/شيك/تحويل/بطاقة]  → تسجيل دفعة
 *   فاتورة [اسم] [مبلغ]   → إنشاء فاتورة جديدة
 *   تذكير                 → إرسال تقرير التذكيرات الآن
 */

const WA = require('./WhatsAppService');
const Setting = require('../models/Setting');
const Customer = require('../models/Customer');
const Dealer = require('../models/Dealer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Check = require('../models/Check');
const Ledger = require('../models/Ledger');
const moment = require('moment');

let _initialized = false;
let _settingsCache = null;
let _settingsCacheAt = 0;

// ─── مساعدات ──────────────────────────────────────────────────────────────────

async function _getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5000) return _settingsCache;
  const s = (await Setting.findOne().lean()) || {};
  _settingsCache = s;
  _settingsCacheAt = Date.now();
  return s;
}

function _fmt(date) { return date ? moment(date).locale('ar').format('DD/MM/YYYY') : '-'; }

function _methodAr(m) {
  return { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' }[m] || m || '-';
}

function _money(n) { return (n || 0).toLocaleString('ar-EG') + ' ₪'; }

function _statusAr(s) {
  return { unpaid: 'غير مدفوعة', partial: 'مدفوعة جزئياً', paid: 'مدفوعة بالكامل' }[s] || s || '-';
}

function _checkStatusAr(s) {
  return { pending: 'جديد', cleared: 'تم الصرف', returned: 'مرتجع' }[s] || s || '-';
}

// ─── التحقق من المدير ─────────────────────────────────────────────────────────

async function _isManager(phone, message) {
  const s = await _getSettings();
  const fullJid = phone; // مثلاً 85242887049286@lid أو 9705xxxxxxx@s.whatsapp.net

  // ── 1. التحقق من waManagerJid (الأسرع) ──
  if (s.waManagerJid && fullJid === s.waManagerJid) {
    console.log(`[WA-Bot] ✅ تم التعرف عبر JID المحفوظ`);
    return true;
  }

  // ── 2. حفظ JID المدير تلقائياً إذا لم يكن محفوظاً ──
  if (!s.waManagerJid && s.waManagerPhone) {
    // المستخدم الذي يرسل رسالة وهو الرقم الوحيد المسجّل — نحفظ JIDه
    console.log(`[WA-Bot] 🔄 حفظ JID المدير تلقائياً: ${fullJid}`);
    try {
      await Setting.findOneAndUpdate({}, { waManagerJid: fullJid });
      _settingsCache = null;
      _settingsCacheAt = 0;
    } catch (_) {}
    return true;
  }

  // ── 3. إذا لم يكن هناك waManagerPhone — حفظ أول شخص يرسل رسالة كمدير ──
  if (!s.waManagerPhone) {
    console.log(`[WA-Bot] 🔑 لا يوجد مدير مُعرّف — حفظ أول مرسل كمدير: ${fullJid}`);
    try {
      await Setting.findOneAndUpdate({}, { waManagerPhone: fullJid, waManagerJid: fullJid });
      _settingsCache = null;
      _settingsCacheAt = 0;
    } catch (_) {}
    await _reply('✅ تم تعيينك كمدير للنظام بنجاح!\n\nاكتب *مساعدة* لعرض الأوامر المتاحة.');
    return true;
  }

  // ── 4. مقارنة أرقام الهاتف (للأرقام العادية) ──
  const normalize = p => {
    let n = (p || '').replace(/[^\d]/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    if (n.startsWith('970') && n.length > 10) n = n.slice(3);
    if (n.startsWith('972') && n.length > 10) n = n.slice(3);
    if (n.startsWith('0')) n = '970' + n.slice(1);
    if (n.length === 9) n = '970' + n;
    return n;
  };
  const np = normalize(fullJid);
  const nm = normalize(s.waManagerPhone);
  if (np && nm && np === nm) {
    console.log(`[WA-Bot] ✅ تم التعرف عبر رقم الهاتف`);
    return true;
  }

  console.log(`[WA-Bot] ❌ لم يتم التعرف: JID=${fullJid} | المدير_JID=${s.waManagerJid || '(فارغ)'} | المدير_رقم=${s.waManagerPhone || '(فارغ)'}`);
  return false;
}

// ─── البحث عن طرف بالاسم ─────────────────────────────────────────────────────

async function _findParty(name) {
  const trimmed = name.trim();
  // البحث في الزبائن أولاً
  let party = await Customer.findOne({
    fullName: { $regex: trimmed, $options: 'i' }
  }).lean();
  if (party) return { ...party, partyModel: 'Customer' };

  // ثم في التجار
  party = await Dealer.findOne({
    fullName: { $regex: trimmed, $options: 'i' }
  }).lean();
  if (party) return { ...party, partyModel: 'Dealer' };

  return null;
}

// ─── معالجة الأوامر ───────────────────────────────────────────────────────────

async function _handleCommand(text, senderPhone) {
  if (!(await _isManager(senderPhone))) return;

  const raw = (text || '').trim();
  if (!raw) return;

  // تطبيع الأمر
  const cmd = raw.replace(/[?؟!.]/g, '').trim();
  const lower = cmd.toLowerCase();

  // ─── مساعدة ───
  if (/^(مساعدة|help|اوامر|start)$/i.test(lower)) {
    await _reply(
`🤖 *بوت تحكم معرض الصافي*
━━━━━━━━━━━━━━━━━━━━

📋 *عرض المعلومات:*
• *رصيد* — أرصدة جميع الزبائن
• *رصيد [اسم]* — رصيد طرف محدد
• *كشف [اسم]* — كشف حساب تفصيلي
• *فواتير* — الفواتير المعلقة
• *فواتير [اسم]* — فواتير طرف
• *شيكات* — الشيكات المستحقة
• *دفعات [اسم]* — آخر الدفعات
• *زبائن* — قائمة الزبائن
• *تجار* — قائمة التجار
• *تقرير* — تقرير شامل
• *تقرير [اسم]* — تقرير طرف

✏️ *إضافة وتسجيل:*
• *دفعة [اسم] [مبلغ] [طريقة]* — تسجيل دفعة
  (طريقة: نقد/شيك/تحويل/بطاقة)
• *فاتورة [اسم] [مبلغ]* — فاتورة جديدة
• *حركة [اسم] [مبلغ] [مدين/دائن] [وصف]* — قيد يدوي

🔧 *أخرى:*
• *تذكير* — تشغيل التذكيرات الآن
• *تقرير يومي* — التقرير اليومي الآن
• *مساعدات* — هذه القائمة`);
    return;
  }

  // ─── رصيد ───
  if (/^رصيد$/i.test(lower)) {
    const customers = await Customer.find().sort({ fullName: 1 }).lean();
    if (customers.length === 0) return await _reply('لا يوجد زبائن مسجلين');

    const lines = customers.map((c, i) =>
      `${i + 1}. ${c.fullName} — ${_money(c.balance)}`
    ).join('\n');
    const total = customers.reduce((s, c) => s + (c.balance || 0), 0);

    await _reply(
`💰 *أرصدة الزبائن*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
📊 الإجمالي: *${_money(total)}*
👥 العدد: ${customers.length}`);
    return;
  }

  // ─── رصيد [اسم] ───
  const balanceMatch = cmd.match(/^رصيد\s+(.+)$/i);
  if (balanceMatch) {
    const party = await _findParty(balanceMatch[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${balanceMatch[1]}"`);

    // جلب آخر الحركات
    const entries = await Ledger.find({ partyId: party._id, partyModel: party.partyModel })
      .sort({ date: -1 }).limit(5).lean();

    const lastEntries = entries.length > 0
      ? entries.map(e => `• ${e.type === 'debit' ? '📤' : '📥'} ${_money(e.amount)} — ${e.description || '-'} (${_fmt(e.date)})`).join('\n')
      : 'لا توجد حركات';

    await _reply(
`💰 *رصيد ${party.fullName}*
━━━━━━━━━━━━━━━━━━━━
🏷️ النوع: ${party.partyModel === 'Customer' ? 'زبون' : 'تاجر'}
💰 الرصيد الحالي: *${_money(party.balance)}*
📱 الهاتف: ${party.phone || '-'}

📋 *آخر الحركات:*
${lastEntries}`);
    return;
  }

  // ─── كشف [اسم] ───
  const statementMatch = cmd.match(/^كشف\s+(.+)$/i);
  if (statementMatch) {
    const party = await _findParty(statementMatch[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${statementMatch[1]}"`);

    const entries = await Ledger.find({ partyId: party._id, partyModel: party.partyModel })
      .sort({ date: 1 }).lean();

    let totalDebit = 0, totalCredit = 0, runBal = 0;
    const rows = entries.map((e, i) => {
      if (e.type === 'debit') { totalDebit += e.amount; runBal += e.amount; }
      else { totalCredit += e.amount; runBal -= e.amount; }
      return `${i + 1}. ${_fmt(e.date)} | ${e.type === 'debit' ? '📤 مدين' : '📥 دائن'} | ${_money(e.amount)} | ${e.description || '-'}`;
    }).join('\n');

    if (entries.length === 0) {
      await _reply(`📒 كشف حساب ${party.fullName}\n\nلا توجد حركات مسجلة`);
      return;
    }

    // قص الرسالة إذا كانت طويلة جداً (حد واتساب 65536)
    const header = `📒 *كشف حساب — ${party.fullName}*
━━━━━━━━━━━━━━━━━━━━
📤 إجمالي المدين: ${_money(totalDebit)}
📥 إجمالي الدائن: ${_money(totalCredit)}
💰 الرصيد النهائي: *${_money(runBal)}*
━━━━━━━━━━━━━━━━━━━━
`;
    // آخر 15 حركة فقط لتجنب الطول
    const recentRows = rows.split('\n').slice(-15).join('\n');
    const fullText = header + recentRows;

    if (fullText.length > 5000) {
      await _reply(header + '\n(الكشف طويل — آخر 15 حركة فقط)\n' + recentRows);
    } else {
      await _reply(fullText);
    }
    return;
  }

  // ─── فواتير ───
  if (/^فواتير$/i.test(lower)) {
    const invoices = await Invoice.find({ status: { $in: ['unpaid', 'partial'] } })
      .sort({ createdAt: -1 }).lean();

    if (invoices.length === 0) return await _reply('✅ لا توجد فواتير معلقة');

    const lines = invoices.map((inv, i) =>
      `${i + 1}. ${inv.invoiceNumber} | ${inv.partyName} | ${_money(inv.totalAmount)} | ${_statusAr(inv.status)} | المتبقي: ${_money(inv.totalAmount - inv.paidAmount)}`
    ).join('\n');
    const total = invoices.reduce((s, inv) => s + (inv.totalAmount - inv.paidAmount), 0);

    await _reply(
`📋 *الفواتير المعلقة*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
💰 إجمالي المتبقي: *${_money(total)}*
📄 العدد: ${invoices.length}`);
    return;
  }

  // ─── فواتير [اسم] ───
  const invoicesMatch = cmd.match(/^فواتير\s+(.+)$/i);
  if (invoicesMatch) {
    const party = await _findParty(invoicesMatch[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${invoicesMatch[1]}"`);

    const invoices = await Invoice.find({
      partyId: party._id, partyModel: party.partyModel,
      status: { $in: ['unpaid', 'partial'] }
    }).sort({ createdAt: -1 }).lean();

    if (invoices.length === 0) return await _reply(`✅ لا توجد فواتير معلقة لـ ${party.fullName}`);

    const lines = invoices.map((inv, i) =>
      `${i + 1}. ${inv.invoiceNumber} | ${_money(inv.totalAmount)} | ${_statusAr(inv.status)} | المتبقي: ${_money(inv.totalAmount - inv.paidAmount)}`
    ).join('\n');

    await _reply(
`📋 *فواتير ${party.fullName}*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
📄 العدد: ${invoices.length}`);
    return;
  }

  // ─── شيكات ───
  if (/^شيكات$/i.test(lower)) {
    const checks = await Check.find({ status: 'pending' })
      .sort({ maturityDate: 1 }).lean();

    if (checks.length === 0) return await _reply('✅ لا توجد شيكات معلقة');

    const lines = checks.map((c, i) => {
      const daysLeft = Math.ceil((new Date(c.maturityDate) - new Date()) / (1000 * 60 * 60 * 24));
      const urgency = daysLeft <= 0 ? '⚠️ متأخر' : daysLeft <= 7 ? `⏰ بعد ${daysLeft} يوم` : '';
      return `${i + 1}. شيك #${c.checkNumber} | ${c.partyName} | ${_money(c.amount)} | استحقاق: ${_fmt(c.maturityDate)} ${urgency}`;
    }).join('\n');
    const total = checks.reduce((s, c) => s + (c.amount || 0), 0);

    await _reply(
`📝 *الشيكات المستحقة*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
💰 الإجمالي: *${_money(total)}*
📄 العدد: ${checks.length}`);
    return;
  }

  // ─── دفعات [اسم] ───
  const paymentsMatch = cmd.match(/^دفعات\s+(.+)$/i);
  if (paymentsMatch) {
    const party = await _findParty(paymentsMatch[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${paymentsMatch[1]}"`);

    const payments = await Payment.find({ partyId: party._id, partyModel: party.partyModel })
      .sort({ createdAt: -1 }).limit(10).lean();

    if (payments.length === 0) return await _reply(`لا توجد دفعات مسجلة لـ ${party.fullName}`);

    const lines = payments.map((p, i) =>
      `${i + 1}. ${p.voucherNumber || '-'} | ${_money(p.amount)} | ${_methodAr(p.paymentMethod)} | ${_fmt(p.paymentDate)}`
    ).join('\n');

    await _reply(
`💳 *آخر الدفعات — ${party.fullName}*
━━━━━━━━━━━━━━━━━━━━
${lines}`);
    return;
  }

  // ─── زبائن ───
  if (/^زبائن$/i.test(lower)) {
    const customers = await Customer.find().sort({ fullName: 1 }).lean();
    if (customers.length === 0) return await _reply('لا يوجد زبائن مسجلين');

    const lines = customers.map((c, i) =>
      `${i + 1}. ${c.fullName} | ${c.phone || '-'} | ${_money(c.balance)}`
    ).join('\n');

    await _reply(
`👥 *قائمة الزبائن*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
📊 العدد: ${customers.length}`);
    return;
  }

  // ─── تجار ───
  if (/^تجار$/i.test(lower)) {
    const dealers = await Dealer.find().sort({ fullName: 1 }).lean();
    if (dealers.length === 0) return await _reply('لا يوجد تجار مسجلين');

    const lines = dealers.map((d, i) =>
      `${i + 1}. ${d.fullName} | ${d.phone || '-'} | ${_money(d.balance)}`
    ).join('\n');

    await _reply(
`🏪 *قائمة التجار*
━━━━━━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━━━━━━
📊 العدد: ${dealers.length}`);
    return;
  }

  // ─── تقرير شامل ───
  if (/^تقرير$/i.test(lower)) {
    const [custCount, dealerCount, invCount, payCount, checkCount] = await Promise.all([
      Customer.countDocuments(),
      Dealer.countDocuments(),
      Invoice.countDocuments({ status: { $in: ['unpaid', 'partial'] } }),
      Payment.countDocuments({ createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }),
      Check.countDocuments({ status: 'pending' }),
    ]);

    const unpaidInv = await Invoice.find({ status: { $in: ['unpaid', 'partial'] } }).lean();
    const totalUnpaid = unpaidInv.reduce((s, inv) => s + (inv.totalAmount - inv.paidAmount), 0);
    const pendingChecks = await Check.find({ status: 'pending' }).lean();
    const totalChecks = pendingChecks.reduce((s, c) => s + (c.amount || 0), 0);

    await _reply(
`📊 *تقرير شامل — معرض الصافي*
━━━━━━━━━━━━━━━━━━━━
📅 التاريخ: ${moment().locale('ar').format('DD/MM/YYYY HH:mm')}

👥 الزبائن: ${custCount}
🏪 التجار: ${dealerCount}

📋 فواتير معلقة: ${invCount}
💰 إجمالي المتبقي من الفواتير: *${_money(totalUnpaid)}*

📝 شيكات مستحقة: ${checkCount}
💰 إجمالي قيمتها: *${_money(totalChecks)}*

💳 مدفوعات آخر 30 يوم: ${payCount}
━━━━━━━━━━━━━━━━━━━━`);
    return;
  }

  // ─── تقرير [اسم] ───
  const reportMatch = cmd.match(/^تقرير\s+(.+)$/i);
  if (reportMatch) {
    const party = await _findParty(reportMatch[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${reportMatch[1]}"`);

    const [entries, invoices, payments] = await Promise.all([
      Ledger.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
      Invoice.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
      Payment.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
    ]);

    const totalDebit = entries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
    const totalCredit = entries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
    const unpaid = invoices.filter(i => i.status !== 'paid');

    await _reply(
`📊 *تقرير ${party.fullName}*
━━━━━━━━━━━━━━━━━━━━
🏷️ النوع: ${party.partyModel === 'Customer' ? 'زبون' : 'تاجر'}
💰 الرصيد الحالي: *${_money(party.balance)}

📤 إجمالي المدين: ${_money(totalDebit)}
📥 إجمالي الدائن: ${_money(totalCredit)}

📄 إجمالي الفواتير: ${invoices.length}
❌ فواتير غير مدفوعة: ${unpaid.length}
💳 عدد الدفعات: ${payments.length}
📋 عدد الحركات: ${entries.length}
━━━━━━━━━━━━━━━━━━━━`);
    return;
  }

  // ─── دفعة [اسم] [مبلغ] [طريقة] ───
  const paymentCmd = cmd.match(/^دفعة\s+(.+?)\s+([\d.,]+)\s*(نقد|شيك|تحويل|بطاقة)?$/i);
  if (paymentCmd) {
    const party = await _findParty(paymentCmd[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${paymentCmd[1]}"`);

    const amount = parseFloat(paymentCmd[2].replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) return await _reply('❌ المبلغ غير صحيح');

    const methodMap = { 'نقد': 'cash', 'شيك': 'check', 'تحويل': 'bank_transfer', 'بطاقة': 'card' };
    const methodAr = paymentCmd[3] || 'نقد';
    const method = methodMap[methodAr.toLowerCase()] || 'cash';

    const s = await _getSettings();
    const prefix = s.pvPrefix || 'RC';
    const vNum = prefix + '-' + Date.now().toString().slice(-6);

    // تحديث الرصيد
    const prevBalance = party.balance || 0;
    let newBalance;
    if (party.partyModel === 'Customer') {
      newBalance = prevBalance - amount;
    } else {
      newBalance = prevBalance + amount;
    }
    await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(party._id, { balance: newBalance });

    // إنشاء القيد
    const ledgerType = party.partyModel === 'Customer' ? 'credit' : 'debit';
    await new Ledger({
      partyId: party._id, partyModel: party.partyModel, partyName: party.fullName,
      type: ledgerType, description: `دفعة يدوية عبر واتساب`,
      amount, date: new Date(), refNo: vNum, paymentMethod: method
    }).save();

    // إنشاء السند
    await new Payment({
      voucherNumber: vNum, voucherType: 'receipt',
      type: party.partyModel === 'Customer' ? 'customer' : 'dealer',
      partyId: party._id, partyModel: party.partyModel, partyName: party.fullName,
      amount, paymentMethod: method, description: 'دفعة يدوية عبر واتساب',
      paymentDate: new Date()
    }).save();

    await _reply(
`✅ *تم تسجيل الدفعة*
━━━━━━━━━━━━━━━━━━━━
👤 الطرف: ${party.fullName}
💰 المبلغ: ${_money(amount)}
💳 الطريقة: ${methodAr}
🔢 رقم السند: ${vNum}
💵 الرصيد السابق: ${_money(prevBalance)}
💰 الرصيد الجديد: *${_money(newBalance)}
━━━━━━━━━━━━━━━━━━━━`);
    return;
  }

  // ─── فاتورة [اسم] [مبلغ] ───
  const invoiceCmd = cmd.match(/^فاتورة\s+(.+?)\s+([\d.,]+)$/i);
  if (invoiceCmd) {
    const party = await _findParty(invoiceCmd[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${invoiceCmd[1]}"`);

    const amount = parseFloat(invoiceCmd[2].replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) return await _reply('❌ المبلغ غير صحيح');

    const s = await _getSettings();
    const invPrefix = s.invoicePrefix || 'INV';
    const invNum = invPrefix + '-' + Date.now().toString().slice(-6);

    const invoice = await new Invoice({
      invoiceNumber: invNum,
      type: party.partyModel === 'Customer' ? 'customer' : 'dealer',
      partyId: party._id, partyModel: party.partyModel, partyName: party.fullName,
      items: [{ description: 'فاتورة يدوية عبر واتساب', quantity: 1, unitPrice: amount, total: amount }],
      totalAmount: amount, notes: 'تم إنشاؤها عبر واتساب'
    }).save();

    // قيد كشف حساب
    await new Ledger({
      partyId: party._id, partyModel: party.partyModel, partyName: party.fullName,
      type: 'debit', description: `فاتورة رقم ${invNum}`,
      amount, date: new Date(), refNo: invNum, invoiceId: invoice._id
    }).save();

    // تحديث رصيد الزبون
    const prevBalance = party.balance || 0;
    if (party.partyModel === 'Customer') {
      await Customer.findByIdAndUpdate(party._id, { balance: prevBalance + amount });
    } else {
      await Dealer.findByIdAndUpdate(party._id, { balance: prevBalance + amount });
    }

    await _reply(
`📄 *تم إنشاء الفاتورة*
━━━━━━━━━━━━━━━━━━━━
👤 الطرف: ${party.fullName}
🔢 رقم الفاتورة: ${invNum}
💰 المبلغ: ${_money(amount)}
💵 رصيد الطرف بعد الفاتورة: ${_money(prevBalance + amount)}
━━━━━━━━━━━━━━━━━━━━`);
    return;
  }

  // ─── حركة [اسم] [مبلغ] [مدين/دائن] [وصف] ───
  const ledgerCmd = cmd.match(/^حركة\s+(.+?)\s+([\d.,]+)\s+(مدين|دائن)\s+(.+)$/i);
  if (ledgerCmd) {
    const party = await _findParty(ledgerCmd[1]);
    if (!party) return await _reply(`❌ لم يتم العثور على "${ledgerCmd[1]}"`);

    const amount = parseFloat(ledgerCmd[2].replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) return await _reply('❌ المبلغ غير صحيح');

    const typeAr = ledgerCmd[3];
    const ledgerType = typeAr === 'مدين' ? 'debit' : 'credit';
    const description = ledgerCmd[4];

    await new Ledger({
      partyId: party._id, partyModel: party.partyModel, partyName: party.fullName,
      type: ledgerType, description, amount, date: new Date(), refNo: 'يدوي-واتساب'
    }).save();

    // تحديث الرصيد
    const prevBalance = party.balance || 0;
    const newBalance = ledgerType === 'debit' ? prevBalance + amount : prevBalance - amount;
    await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(party._id, { balance: newBalance });

    await _reply(
`✅ *تم تسجيل الحركة*
━━━━━━━━━━━━━━━━━━━━
👤 الطرف: ${party.fullName}
📤 النوع: ${typeAr}
💰 المبلغ: ${_money(amount)}
📋 الوصف: ${description}
💵 الرصيد السابق: ${_money(prevBalance)}
💰 الرصيد الجديد: *${_money(newBalance)}
━━━━━━━━━━━━━━━━━━━━`);
    return;
  }

  // ─── تذكير ───
  if (/^تذكير$/i.test(lower)) {
    const CheckNotificationService = require('./CheckNotificationService');
    CheckNotificationService.runDailyJob().catch(e => {});
    await _reply('⏳ جاري تشغيل التذكيرات... ستصلك النتيجة قريباً');
    return;
  }

  // ─── تقرير يومي ───
  if (/^(تقرير يومي|تقرير اليوم)$/i.test(lower)) {
    const CheckNotificationService = require('./CheckNotificationService');
    await CheckNotificationService.runDailyJob();
    await _reply('✅ تم إرسال التقرير اليومي');
    return;
  }

  // ─── أمر غير معروف ───
  await _reply(
`🤔 أمر غير معروف: "${raw}"

اكتب *مساعدة* لعرض جميع الأوامر المتاحة.`);
}

// ─── إرسال رد ─────────────────────────────────────────────────────────────────

async function _reply(text) {
  const s = await _getSettings();
  if (!s.waManagerPhone) return;
  try {
    await WA.sendMessage(s.waManagerPhone, text);
  } catch (e) {
    console.error('[WA-Bot] خطأ في إرسال الرد:', e.message);
  }
}

// ─── تشغيل البوت ─────────────────────────────────────────────────────────────

async function startBot() {
  if (_initialized) return;
  _initialized = true;

  // تسجيل مستمع الرسائل
  WA.onMessage(async (message) => {
    try {
      const senderPhone = message.key?.remoteJid?.replace('@s.whatsapp.net', '') || '';
      const text = message.message?.conversation
        || message.message?.extendedTextMessage?.text
        || '';

      console.log(`[WA-Bot] 📩 رسالة واردة: من=${senderPhone} | نص=${text || '(فارغة)'}`);

      if (!text || !senderPhone) {
        console.log('[WA-Bot] ⚠️ رسالة فارغة أو بدون رقم — تم تجاهلها');
        return;
      }

      // تجاهل الرسائل من غير المدير
      if (!(await _isManager(senderPhone))) {
        console.log(`[WA-Bot] 🚫 تم تجاهل رسالة من رقم غير مُصرّح: ${senderPhone}`);
        return;
      }

      console.log(`[WA-Bot] 📩 رسالة من المدير: ${text}`);
      await _handleCommand(text, senderPhone);
    } catch (e) {
      console.error('[WA-Bot] خطأ في معالجة الرسالة:', e.message);
    }
  });

  console.log('[WA-Bot] 🤖 بوت التحكم جاهز — ينتظر رسائل المدير');
  console.log(`[WA-Bot] رقم المدير المُعرّف: ${(await _getSettings()).waManagerPhone || 'غير مُعرّف'}`);
}

module.exports = { startBot };
