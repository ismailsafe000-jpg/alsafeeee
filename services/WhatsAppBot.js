'use strict';
/**
 * WhatsAppBot — بوت تحكم المدير من واتساب
 * مع نظام فواتير تفاعلي (إضافة أصناف + خصم + تأكيد)
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

// ─── جلسات الفواتير التفاعلية ──────────────────────────────────────────────
// كل مدير عنده جلسة فاتورة نشطة (أو null)
const _invoiceSessions = new Map();

// ─── مساعدات ──────────────────────────────────────────────────────────────────

async function _getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 5000) return _settingsCache;
  const s = (await Setting.findOne().lean()) || {};
  _settingsCache = s;
  _settingsCacheAt = Date.now();
  return s;
}

function _fmt(d) { return d ? moment(d).locale('ar').format('DD/MM/YYYY') : '-'; }
function _money(n) { return (n || 0).toLocaleString('ar-EG') + ' ₪'; }
function _methodAr(m) {
  return { cash: 'نقداً', check: 'شيك', bank_transfer: 'تحويل بنكي', card: 'بطاقة', other: 'أخرى' }[m] || m || '-';
}
function _statusAr(s) {
  return { unpaid: 'غير مدفوعة', partial: 'مدفوعة جزئياً', paid: 'مدفوعة بالكامل' }[s] || s || '-';
}
function _partyLabel(m) { return m === 'Dealer' ? 'تاجر' : 'زبون'; }

// ─── التحقق من المدير ─────────────────────────────────────────────────────────

async function _isManager(jid) {
  const s = await _getSettings();
  if (s.waManagerJid && jid === s.waManagerJid) return true;
  if (!s.waManagerJid && !s.waManagerPhone) {
    try {
      await Setting.findOneAndUpdate({}, { waManagerJid: jid });
      _settingsCache = null;
    } catch (_) {}
    await _reply('✅ تم تعيينك كمدير للنظام!\nاكتب *مساعدة* لعرض الأوامر.');
    return true;
  }
  return false;
}

// ─── البحث عن طرف ────────────────────────────────────────────────────────────

async function _findParty(name) {
  const t = name.trim();
  let p = await Customer.findOne({ fullName: { $regex: t, $options: 'i' } }).lean();
  if (p) return { ...p, partyModel: 'Customer' };
  p = await Dealer.findOne({ fullName: { $regex: t, $options: 'i' } }).lean();
  if (p) return { ...p, partyModel: 'Dealer' };
  return null;
}

async function _reply(text) {
  const s = await _getSettings();
  const target = s.waManagerJid || s.waManagerPhone;
  if (!target) return;
  try { await WA.sendMessage(target, text); } catch (e) {
    console.error('[WA-Bot] خطأ إرسال:', e.message);
  }
}

// ─── جلسة الفاتورة التفاعلية ─────────────────────────────────────────────────

function _getSession(jid) {
  return _invoiceSessions.get(jid) || null;
}

function _setSession(jid, session) {
  _invoiceSessions.set(jid, session);
}

function _clearSession(jid) {
  _invoiceSessions.delete(jid);
}

function _formatItemsList(items) {
  if (!items.length) return 'لا توجد أصناف بعد';
  return items.map((it, i) => {
    let unit = it.unit === 'م2' ? 'م²' : it.unit === 'م' ? 'م' : 'حبة';
    return `${i + 1}. ${it.name} — ${it.qty} ${unit} × ${_money(it.price)} = *${_money(it.qty * it.price)}*`;
  }).join('\n');
}

async function _handleInvoiceSession(jid, text) {
  const session = _getSession(jid);
  if (!session) return false;

  const cmd = text.trim();

  // ─── إلغاء ───
  if (/^(الغاء|الغى|cancel|غ)$/i.test(cmd)) {
    _clearSession(jid);
    await _reply('❌ تم إلغاء إنشاء الفاتورة');
    return true;
  }

  // ─── إضافة صنف: صنف [اسم] [كمية] [وحدة] [سعر] ───
  const itemMatch = cmd.match(/^صنف\s+(.+?)\s+([\d.,]+)\s*(م2|متر مربع|متر|م|حبة|كمية)?\s*([\d.,]+)$/i);
  if (itemMatch) {
    const name = itemMatch[1].trim();
    const qty = parseFloat(itemMatch[2].replace(/,/g, ''));
    let unit = itemMatch[3] || 'حبة';
    const price = parseFloat(itemMatch[4].replace(/,/g, ''));

    if (isNaN(qty) || qty <= 0) { await _reply('❌ الكمية غير صحيحة'); return true; }
    if (isNaN(price) || price <= 0) { await _reply('❌ السعر غير صحيحة'); return true; }

    // توحيد الوحدة
    if (['م2', 'متر مربع'].includes(unit)) unit = 'م2';
    else if (['م', 'متر'].includes(unit)) unit = 'م';
    else unit = 'حبة';

    session.items.push({ name, qty, unit, price, total: qty * price });
    session.step = 'items'; // يبقى في مرحلة الإضافة

    const subtotal = session.items.reduce((s, it) => s + it.total, 0);
    const total = Math.max(0, subtotal - session.discount);

    await _reply(
      `✅ تم إضافة الصنف: *${name}*\n` +
      `📦 ${qty} ${unit === 'م2' ? 'م²' : unit === 'م' ? 'م' : 'حبة'} × ${_money(price)} = *${_money(qty * price)}*\n\n` +
      `📋 الأصناف الحالية (${session.items.length}):\n${_formatItemsList(session.items)}\n\n` +
      `💰 المجموع: ${_money(subtotal)} | الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(total)}*\n\n` +
      `💡 أرسل:\n` +
      `• *صنف [اسم] [كمية] [وحدة] [سعر]* — لإضافة صنف آخر\n` +
      `• *خصم [مبلغ]* — لخصم مبلغ\n` +
      `• *حذف صنف [رقم]* — لحذف صنف\n` +
      `• *خالص* — لإنشاء الفاتورة\n` +
      `• *الغاء* — لإلغاء`
    );
    return true;
  }

  // ─── حذف صنف: حذف صنف [رقم] ───
  const delItemMatch = cmd.match(/^حذف\s+صنف\s+(\d+)$/i);
  if (delItemMatch) {
    const idx = parseInt(delItemMatch[1]) - 1;
    if (idx < 0 || idx >= session.items.length) {
      await _reply('❌ رقم الصنف غير صحيح');
      return true;
    }
    const removed = session.items.splice(idx, 1)[0];
    const subtotal = session.items.reduce((s, it) => s + it.total, 0);
    const total = Math.max(0, subtotal - session.discount);
    await _reply(
      `🗑️ تم حذف: *${removed.name}*\n\n` +
      `📋 الأصناف (${session.items.length}):\n${_formatItemsList(session.items)}\n\n` +
      `💰 المجموع: ${_money(subtotal)} | الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(total)}*`
    );
    return true;
  }

  // ─── خصم: خصم [مبلغ] ───
  const discountMatch = cmd.match(/^خصم\s+([\d.,]+)$/i);
  if (discountMatch) {
    const amt = parseFloat(discountMatch[1].replace(/,/g, ''));
    if (isNaN(amt) || amt < 0) { await _reply('❌ مبلغ الخصم غير صحيح'); return true; }
    session.discount = amt;
    const subtotal = session.items.reduce((s, it) => s + it.total, 0);
    const total = Math.max(0, subtotal - amt);
    await _reply(
      `💰 تم تحديد الخصم: *${_money(amt)}*\n\n` +
      `📋 الأصناف (${session.items.length}):\n${_formatItemsList(session.items)}\n\n` +
      `📊 المجموع: ${_money(subtotal)} | الخصم: ${_money(amt)} | *الإجمالي: ${_money(total)}*`
    );
    return true;
  }

  // ─── ملاحظات: ملاحظات [نص] ───
  const notesMatch = cmd.match(/^ملاحظات\s+(.+)$/i);
  if (notesMatch) {
    session.notes = notesMatch[1].trim();
    await _reply(`📝 تم حفظ الملاحظات: ${session.notes}`);
    return true;
  }

  // ─── خالص — إنشاء الفاتورة ───
  if (/^(خالص|تم|انهاء|finish|done)$/i.test(cmd)) {
    if (!session.items.length) {
      await _reply('❌ لا يوجد أصناف! أضف صنفاً أولاً بـ *صنف [اسم] [كمية] [وحدة] [سعر]*');
      return true;
    }

    try {
      const party = session.party;
      const s = await _getSettings();
      const invNum = (s.invoicePrefix || 'INV') + '-' + Date.now().toString().slice(-6);

      const items = session.items.map(it => ({
        description: it.name,
        quantityType: it.unit === 'م2' ? 'sqmeter' : it.unit === 'م' ? 'meter' : 'piece',
        length: it.unit === 'حبة' ? it.qty : it.qty,
        width: it.unit === 'م2' ? 1 : 0,
        quantity: it.qty,
        unitPrice: it.price,
        total: it.total
      }));

      const subtotal = items.reduce((s, it) => s + it.total, 0);
      const totalAmount = Math.max(0, subtotal - session.discount);

      const inv = await new Invoice({
        invoiceNumber: invNum,
        type: party.partyModel === 'Customer' ? 'customer' : 'dealer',
        partyId: party._id,
        partyModel: party.partyModel,
        partyName: party.fullName,
        items,
        totalAmount,
        discount: session.discount,
        notes: session.notes || 'إنشاء عبر واتساب',
        invoiceDate: new Date()
      }).save();

      // قيد في كشف الحساب
      const itemsDetails = items.map((it, idx) =>
        `${idx + 1}- ${it.description} | الكمية: ${it.quantity} | السعر: ${it.unitPrice} ₪ | الإجمالي: ${it.total} ₪`
      ).join('\n');

      await new Ledger({
        partyId: party._id,
        partyModel: party.partyModel,
        partyName: party.fullName,
        type: 'debit',
        description: `فاتورة ${invNum}`,
        amount: totalAmount,
        date: new Date(),
        refNo: invNum,
        invoiceId: inv._id,
        itemsDetails
      }).save();

      // تحديث رصيد الطرف
      const prev = party.balance || 0;
      await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(
        party._id, { balance: prev + totalAmount }
      );

      // إشعار المدير
      const CNS = require('./CheckNotificationService');
      CNS.notifyInvoiceNew(inv).catch(e => console.error('[WA]', e.message));

      _clearSession(jid);

      // ملخص الفاتورة
      await _reply(
        `✅ *تم إنشاء الفاتورة بنجاح!*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📄 الفاتورة: *${invNum}*\n` +
        `👤 الطرف: ${party.fullName} (${_partyLabel(party.partyModel)})\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${_formatItemsList(session.items)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 المجموع: ${_money(subtotal)}\n` +
        `💰 الخصم: ${_money(session.discount)}\n` +
        `💳 *الإجمالي: ${_money(totalAmount)}*\n` +
        `${session.notes ? '📝 ملاحظات: ' + session.notes + '\n' : ''}` +
        `💵 الرصيد: ${_money(prev)} → *${_money(prev + totalAmount)}*`
      );
    } catch (e) {
      console.error('[WA-Bot] خطأ إنشاء الفاتورة:', e.message);
      await _reply('❌ حدث خطأ أثناء إنشاء الفاتورة: ' + e.message);
    }
    return true;
  }

  // ─── عرض الحالة الحالية ───
  if (/^(حاله|status)$/i.test(cmd)) {
    const subtotal = session.items.reduce((s, it) => s + it.total, 0);
    const total = Math.max(0, subtotal - session.discount);
    await _reply(
      `📋 *حالة الفاتورة*\n` +
      `👤 الطرف: ${session.party.fullName}\n` +
      `📦 الأصناف: ${session.items.length}\n` +
      `${_formatItemsList(session.items)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 المجموع: ${_money(subtotal)} | الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(total)}*`
    );
    return true;
  }

  // ─── رسالة مساعدة للجلسة ───
  await _reply(
    `📦 *أنت في وضع إنشاء فاتورة*\n` +
    `👤 الطرف: ${session.party.fullName}\n\n` +
    `💡 الأوامر المتاحة:\n` +
    `• *صنف [اسم] [كمية] [وحدة] [سعر]* — إضافة صنف\n` +
    `  مثال: *صنف ستارة 3 م 50*\n` +
    `  مثال: *صنف بلاطة 10 م2 80*\n` +
    `  مثال: *صنف وسادة 5 حبة 25*\n` +
    `• *خصم [مبلغ]* — خصم من المجموع\n` +
    `• *حذف صنف [رقم]* — حذف صنف\n` +
    `• *ملاحظات [نص]* — إضافة ملاحظات\n` +
    `• *خالص* — إنشاء الفاتورة\n` +
    `• *الغاء* — إلغاء`
  );
  return true;
}

// ─── معالجة الأوامر ───────────────────────────────────────────────────────────

async function _handleCommand(text, jid) {
  const raw = (text || '').trim();
  if (!raw) return;
  const cmd = raw.replace(/[?؟!.]/g, '').trim();
  const L = cmd.toLowerCase();

  // ─── تحقق أولاً: هل المدير في جلسة فاتورة؟ ───
  const session = _getSession(jid);
  if (session) {
    const handled = await _handleInvoiceSession(jid, text);
    if (handled) return;
  }

  // ══════════════════════════════════════════════════════════════
  // 📋 عرض المعلومات
  // ══════════════════════════════════════════════════════════════

  if (/^(مساعدة|help|اوامر|start)$/i.test(L)) {
    return await _reply(
`🤖 *بوت تحكم معرض الصافي*
━━━━━━━━━━━━━━━━━━━━

📋 *عرض المعلومات:*
• *رصيد* — أرصدة جميع الزبائن
• *رصيد [اسم]* — رصيد طرف
• *كشف [اسم]* — كشف حساب تفصيلي
• *فواتير* / *فواتير [اسم]*
• *شيكات* — الشيكات المستحقة
• *دفعات [اسم]* — آخر الدفعات
• *زبائن* / *تجار* — القوائم
• *تقرير* / *تقرير [اسم]*
• *احصائيات* — ملخص النظام

✏️ *إضافة وتسجيل:*
• *دفعة [اسم] [مبلغ] [طريقة]*
• *شيك [اسم] [مبلغ] [بنك] [رقم] [تاريخ]*
• *حركة [اسم] [مبلغ] [مدين/دائن] [وصف]*

📄 *إنشاء فاتورة من الواتساب:*
• *فاتورة [اسم]* — يبدأ وضع الإنشاء
• ثم أضف الأصناف:
  *صنف [اسم] [كمية] [وحدة] [سعر]*
  مثال: *صنف ستارة 3 م 50*
  مثال: *صنف بلاطة 10 م2 80*
  مثال: *صنف وسادة 5 حبة 25*
• *خصم [مبلغ]* — خصم من المجموع
• *حذف صنف [رقم]* — حذف صنف
• *ملاحظات [نص]* — ملاحظات
• *خالص* — إنشاء الفاتورة
• *الغاء* — إلغاء

👥 *إدارة الزبائن والتجار:*
• *اضف زبون [اسم] [هاتف]*
• *اضف تاجر [اسم] [هاتف]*
• *حذف زبون [اسم]*
• *حذف تاجر [اسم]*
• *تعديل زبون [اسم] [هاتف]*
• *تعديل تاجر [اسم] [هاتف]*

🔧 *أخرى:*
• *تذكير* — تشغيل التذكيرات
• *تقرير يومي* — التقرير اليومي`);
  }

  // ══════════════════════════════════════════════════════════════
  // 💰 رصيد
  // ══════════════════════════════════════════════════════════════

  if (/^رصيد$/i.test(L)) {
    const list = await Customer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد زبائن');
    const lines = list.map((c, i) => `${i + 1}. ${c.fullName} — ${_money(c.balance)}`).join('\n');
    const total = list.reduce((s, c) => s + (c.balance || 0), 0);
    return await _reply(`💰 *أرصدة الزبائن*\n━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━\n📊 الإجمالي: *${_money(total)}*`);
  }

  const balanceM = cmd.match(/^رصيد\s+(.+)$/i);
  if (balanceM) {
    const party = await _findParty(balanceM[1]);
    if (!party) return await _reply(`❌ لم أجد "${balanceM[1]}"`);
    const entries = await Ledger.find({ partyId: party._id, partyModel: party.partyModel }).sort({ date: -1 }).limit(5).lean();
    const lastE = entries.length ? entries.map(e => `• ${e.type === 'debit' ? '📤' : '📥'} ${_money(e.amount)} — ${e.description || '-'} (${_fmt(e.date)})`).join('\n') : 'لا توجد حركات';
    return await _reply(`💰 *${party.fullName}*\nالنوع: ${_partyLabel(party.partyModel)} | الرصيد: *${_money(party.balance)}*\n📱 ${party.phone || '-'}\n\nآخر الحركات:\n${lastE}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 📒 كشف حساب
  // ══════════════════════════════════════════════════════════════

  const stmtM = cmd.match(/^كشف\s+(.+)$/i);
  if (stmtM) {
    const party = await _findParty(stmtM[1]);
    if (!party) return await _reply(`❌ لم أجد "${stmtM[1]}"`);
    const entries = await Ledger.find({ partyId: party._id, partyModel: party.partyModel }).sort({ date: 1 }).lean();
    let tD = 0, tC = 0;
    const rows = entries.map((e, i) => {
      if (e.type === 'debit') { tD += e.amount; } else { tC += e.amount; }
      return `${i + 1}. ${_fmt(e.date)} | ${e.type === 'debit' ? '📤' : '📥'} ${_money(e.amount)} | ${e.description || '-'}`;
    }).join('\n');
    if (!entries.length) return await _reply(`📒 كشف ${party.fullName}\nلا توجد حركات`);
    const runBal = tD - tC;
    const hdr = `📒 *كشف ${party.fullName}*\n📤 المدين: ${_money(tD)} | 📥 الدائن: ${_money(tC)} | 💰 الرصيد: *${_money(runBal)}*\n━━━━━━━━━━━━━━\n`;
    const recent = rows.split('\n').slice(-15).join('\n');
    return await _reply(hdr + recent);
  }

  // ══════════════════════════════════════════════════════════════
  // 📋 فواتير / شيكات / دفعات
  // ══════════════════════════════════════════════════════════════

  if (/^فواتير$/i.test(L)) {
    const invs = await Invoice.find({ status: { $in: ['unpaid', 'partial'] } }).sort({ createdAt: -1 }).lean();
    if (!invs.length) return await _reply('✅ لا توجد فواتير معلقة');
    const lines = invs.map((v, i) => `${i + 1}. ${v.invoiceNumber} | ${v.partyName} | ${_money(v.totalAmount)} | ${_statusAr(v.status)} | متبقي: ${_money(v.totalAmount - v.paidAmount)}`).join('\n');
    const total = invs.reduce((s, v) => s + (v.totalAmount - v.paidAmount), 0);
    return await _reply(`📋 *فواتير معلقة*\n${lines}\n━━━━━━━━━━━━━━\n💰 المتبقي: *${_money(total)}*`);
  }

  const invM = cmd.match(/^فواتير\s+(.+)$/i);
  if (invM) {
    const party = await _findParty(invM[1]);
    if (!party) return await _reply(`❌ لم أجد "${invM[1]}"`);
    const invs = await Invoice.find({ partyId: party._id, partyModel: party.partyModel, status: { $in: ['unpaid', 'partial'] } }).sort({ createdAt: -1 }).lean();
    if (!invs.length) return await _reply(`✅ لا توجد فواتير معلقة لـ ${party.fullName}`);
    const lines = invs.map((v, i) => `${i + 1}. ${v.invoiceNumber} | ${_money(v.totalAmount)} | متبقي: ${_money(v.totalAmount - v.paidAmount)}`).join('\n');
    return await _reply(`📋 *فواتير ${party.fullName}*\n${lines}`);
  }

  if (/^شيكات$/i.test(L)) {
    const checks = await Check.find({ status: 'pending' }).sort({ maturityDate: 1 }).lean();
    if (!checks.length) return await _reply('✅ لا توجد شيكات معلقة');
    const lines = checks.map((c, i) => {
      const d = Math.ceil((new Date(c.maturityDate) - new Date()) / 864e5);
      const u = d <= 0 ? '⚠️ متأخر' : d <= 7 ? `⏰ ${d} يوم` : '';
      return `${i + 1}. #${c.checkNumber} | ${c.partyName} | ${_money(c.amount)} | ${_fmt(c.maturityDate)} ${u}`;
    }).join('\n');
    const total = checks.reduce((s, c) => s + (c.amount || 0), 0);
    return await _reply(`📝 *شيكات مستحقة*\n${lines}\n━━━━━━━━━━━━━━\n💰 الإجمالي: *${_money(total)}*`);
  }

  const payM = cmd.match(/^دفعات\s+(.+)$/i);
  if (payM) {
    const party = await _findParty(payM[1]);
    if (!party) return await _reply(`❌ لم أجد "${payM[1]}"`);
    const pays = await Payment.find({ partyId: party._id, partyModel: party.partyModel }).sort({ createdAt: -1 }).limit(10).lean();
    if (!pays.length) return await _reply(`لا توجد دفعات لـ ${party.fullName}`);
    const lines = pays.map((p, i) => `${i + 1}. ${p.voucherNumber || '-'} | ${_money(p.amount)} | ${_methodAr(p.paymentMethod)} | ${_fmt(p.paymentDate)}`).join('\n');
    return await _reply(`💳 *دفعات ${party.fullName}*\n${lines}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 👥 زبائن / تجار
  // ══════════════════════════════════════════════════════════════

  if (/^زبائن$/i.test(L)) {
    const list = await Customer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد زبائن');
    const lines = list.map((c, i) => `${i + 1}. ${c.fullName} | ${c.phone || '-'} | ${_money(c.balance)}`).join('\n');
    return await _reply(`👥 *الزبائن (${list.length})*\n${lines}`);
  }

  if (/^تجار$/i.test(L)) {
    const list = await Dealer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد تجار');
    const lines = list.map((d, i) => `${i + 1}. ${d.fullName} | ${d.phone || '-'} | ${_money(d.balance)}`).join('\n');
    return await _reply(`🏪 *التجار (${list.length})*\n${lines}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 📊 تقرير / إحصائيات
  // ══════════════════════════════════════════════════════════════

  if (/^(تقرير|احصائيات)$/i.test(L)) {
    const [cC, dC, iC, pC, chC] = await Promise.all([
      Customer.countDocuments(), Dealer.countDocuments(),
      Invoice.countDocuments({ status: { $in: ['unpaid', 'partial'] } }),
      Payment.countDocuments({ createdAt: { $gte: new Date(Date.now() - 30 * 864e5) } }),
      Check.countDocuments({ status: 'pending' }),
    ]);
    const unpaidInv = await Invoice.find({ status: { $in: ['unpaid', 'partial'] } }).lean();
    const totalU = unpaidInv.reduce((s, v) => s + (v.totalAmount - v.paidAmount), 0);
    const pChecks = await Check.find({ status: 'pending' }).lean();
    const totalCh = pChecks.reduce((s, c) => s + (c.amount || 0), 0);
    return await _reply(
`📊 *تقرير شامل*
━━━━━━━━━━━━━━
📅 ${moment().locale('ar').format('DD/MM/YYYY HH:mm')}
👥 زبائن: ${cC} | 🏪 تجار: ${dC}
📋 فواتير معلقة: ${iC} — *${_money(totalU)}*
📝 شيكات مستحقة: ${chC} — *${_money(totalCh)}*
💳 مدفوعات 30 يوم: ${pC}`);
  }

  const rptM = cmd.match(/^تقرير\s+(.+)$/i);
  if (rptM) {
    const party = await _findParty(rptM[1]);
    if (!party) return await _reply(`❌ لم أجد "${rptM[1]}"`);
    const [ents, invs, pays] = await Promise.all([
      Ledger.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
      Invoice.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
      Payment.find({ partyId: party._id, partyModel: party.partyModel }).lean(),
    ]);
    const tD = ents.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
    const tC = ents.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
    const unpd = invs.filter(i => i.status !== 'paid');
    return await _reply(
`📊 *تقرير ${party.fullName}*
━━━━━━━━━━━━━━
💰 الرصيد: *${_money(party.balance)}*
📤 المدين: ${_money(tD)} | 📥 الدائن: ${_money(tC)}
📄 فواتير: ${invs.length} (${unpd.length} غير مدفوعة)
💳 دفعات: ${pays.length} | 📋 حركات: ${ents.length}`);
  }

  // ══════════════════════════════════════════════════════════════
  // ✏️ تسجيل دفعة
  // ══════════════════════════════════════════════════════════════

  const payCmd = cmd.match(/^دفعة\s+(.+?)\s+([\d.,]+)\s*(نقد|شيك|تحويل|بطاقة)?$/i);
  if (payCmd) {
    const party = await _findParty(payCmd[1]);
    if (!party) return await _reply(`❌ لم أجد "${payCmd[1]}"`);
    const amt = parseFloat(payCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const methodMap = { 'نقد': 'cash', 'شيك': 'check', 'تحويل': 'bank_transfer', 'بطاقة': 'card' };
    const mAr = payCmd[3] || 'نقد';
    const m = methodMap[mAr.toLowerCase()] || 'cash';
    const s = await _getSettings();
    const vNum = (s.pvPrefix || 'RC') + '-' + Date.now().toString().slice(-6);
    const prev = party.balance || 0;
    const newB = party.partyModel === 'Customer' ? prev - amt : prev + amt;
    await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(party._id, { balance: newB });
    const lType = party.partyModel === 'Customer' ? 'credit' : 'debit';
    await new Ledger({ partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, type: lType, description: 'دفعة عبر واتساب', amount: amt, date: new Date(), refNo: vNum, paymentMethod: m }).save();
    await new Payment({ voucherNumber: vNum, voucherType: 'receipt', type: party.partyModel === 'Customer' ? 'customer' : 'dealer', partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, amount: amt, paymentMethod: m, description: 'دفعة عبر واتساب', paymentDate: new Date() }).save();
    return await _reply(`✅ *تم تسجيل الدفعة*\n👤 ${party.fullName} | 💰 ${_money(amt)} | 💳 ${mAr}\n🔢 ${vNum}\n💵 ${_money(prev)} → *${_money(newB)}*`);
  }

  // ══════════════════════════════════════════════════════════════
  // 📄 فاتورة سريعة (مبلغ واحد فقط — بدون أصناف)
  // ══════════════════════════════════════════════════════════════

  const invCmd = cmd.match(/^فاتورة\s+(.+?)\s+([\d.,]+)$/i);
  if (invCmd) {
    const party = await _findParty(invCmd[1]);
    if (!party) return await _reply(`❌ لم أجد "${invCmd[1]}"`);
    const amt = parseFloat(invCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const s = await _getSettings();
    const invNum = (s.invoicePrefix || 'INV') + '-' + Date.now().toString().slice(-6);
    const inv = await new Invoice({ invoiceNumber: invNum, type: party.partyModel === 'Customer' ? 'customer' : 'dealer', partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, items: [{ description: 'فاتورة عبر واتساب', quantity: 1, unitPrice: amt, total: amt }], totalAmount: amt, notes: 'عبر واتساب' }).save();
    await new Ledger({ partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, type: 'debit', description: `فاتورة ${invNum}`, amount: amt, date: new Date(), refNo: invNum, invoiceId: inv._id }).save();
    const prev = party.balance || 0;
    await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(party._id, { balance: prev + amt });
    return await _reply(`📄 *فاتورة جديدة*\n👤 ${party.fullName} | 🔢 ${invNum} | 💰 ${_money(amt)}\n💵 الرصيد: ${_money(prev)} → *${_money(prev + amt)}*`);
  }

  // ══════════════════════════════════════════════════════════════
  // 📄 فاتورة تفاعلية (بدون مبلغ — يبدأ وضع الإضافة)
  // ══════════════════════════════════════════════════════════════

  const invStartM = cmd.match(/^فاتورة\s+(.+)$/i);
  if (invStartM) {
    const party = await _findParty(invStartM[1]);
    if (!party) return await _reply(`❌ لم أجد "${invStartM[1]}"`);

    // إنشاء جلسة جديدة
    _setSession(jid, {
      party: { _id: party._id, fullName: party.fullName, partyModel: party.partyModel },
      items: [],
      discount: 0,
      notes: '',
      step: 'items',
      createdAt: Date.now()
    });

    return await _reply(
      `📄 *بدء إنشاء فاتورة لـ ${party.fullName}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💡 أضف الأصناف بكتابة:\n\n` +
      `*صنف [اسم الصنف] [الكمية] [الوحدة] [سعر الوحدة]*\n\n` +
      `📦 أمثلة:\n` +
      `• *صنف ستارة 3 م 50*\n` +
      `• *صنف بلاطة 10 م2 80*\n` +
      `• *صنف وسادة 5 حبة 25*\n` +
      `• *صنف كنبة 2 حبة 500*\n\n` +
      `📋 الوحدات المتاحة:\n` +
      `• *حبة* — كمية عددية\n` +
      `• *م* أو *متر* — متر طولي\n` +
      `• *م2* أو *متر مربع* — متر مربع\n\n` +
      `🔄 أوامر إضافية:\n` +
      `• *خصم [مبلغ]* — خصم من المجموع\n` +
      `• *حذف صنف [رقم]* — حذف صنف\n` +
      `• *ملاحظات [نص]* — إضافة ملاحظات\n` +
      `• *خالص* — إنشاء الفاتورة\n` +
      `• *الغاء* — إلغاء`
    );
  }

  // ══════════════════════════════════════════════════════════════
  // 📝 حركة كشف حساب
  // ══════════════════════════════════════════════════════════════

  const ledCmd = cmd.match(/^حركة\s+(.+?)\s+([\d.,]+)\s+(مدين|دائن)\s+(.+)$/i);
  if (ledCmd) {
    const party = await _findParty(ledCmd[1]);
    if (!party) return await _reply(`❌ لم أجد "${ledCmd[1]}"`);
    const amt = parseFloat(ledCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const lType = ledCmd[3] === 'مدين' ? 'debit' : 'credit';
    const desc = ledCmd[4];
    await new Ledger({ partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, type: lType, description: desc, amount: amt, date: new Date(), refNo: 'يدوي-واتساب' }).save();
    const prev = party.balance || 0;
    const newB = lType === 'debit' ? prev + amt : prev - amt;
    await (party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(party._id, { balance: newB });
    return await _reply(`✅ *حركة مسجلة*\n👤 ${party.fullName} | ${ledCmd[3]} ${_money(amt)}\n📋 ${desc}\n💵 ${_money(prev)} → *${_money(newB)}*`);
  }

  // ══════════════════════════════════════════════════════════════
  // 📝 تسجيل شيك
  // ══════════════════════════════════════════════════════════════

  const chkCmd = cmd.match(/^شيك\s+(.+?)\s+([\d.,]+)\s+(.+?)\s+(.+?)\s+([\d\-]+)$/i);
  if (chkCmd) {
    const party = await _findParty(chkCmd[1]);
    if (!party) return await _reply(`❌ لم أجد "${chkCmd[1]}"`);
    const amt = parseFloat(chkCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const bankName = chkCmd[3].trim();
    const checkNum = chkCmd[4].trim();
    const dueDate = new Date(chkCmd[5]);
    if (isNaN(dueDate.getTime())) return await _reply('❌ تاريخ الاستحقاق غير صحيح (الصيغة: YYYY-MM-DD)');
    const newCheck = await new Check({ checkNumber: checkNum, bankName, amount: amt, type: 'received', partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, receivedDate: new Date(), maturityDate: dueDate, status: 'pending' }).save();
    await new Ledger({ partyId: party._id, partyModel: party.partyModel, partyName: party.fullName, type: 'credit', description: `شيك #${checkNum}`, amount: amt, date: new Date(), refNo: checkNum, chequeNumber: checkNum, bankName, chequeDueDate: dueDate, chequeStatus: 'pending' }).save();
    return await _reply(`📝 *شيك مسجل*\n👤 ${party.fullName} | 🏦 ${bankName}\n🔢 #${checkNum} | 💰 ${_money(amt)}\n📅 الاستحقاق: ${_fmt(dueDate)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 👥 إضافة زبون/تاجر
  // ══════════════════════════════════════════════════════════════

  const addCustM = cmd.match(/^اضف\s+زبون\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (addCustM) {
    const name = addCustM[1].trim();
    const phone = addCustM[2].trim();
    const exists = await Customer.findOne({ fullName: name });
    if (exists) return await _reply(`⚠️ الزبون "${name}" موجود مسبقاً`);
    await new Customer({ fullName: name, phone, balance: 0 }).save();
    return await _reply(`✅ *تم إضافة الزبون*\n👤 ${name} | 📱 ${phone}`);
  }

  const addDealM = cmd.match(/^اضف\s+تاجر\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (addDealM) {
    const name = addDealM[1].trim();
    const phone = addDealM[2].trim();
    const exists = await Dealer.findOne({ fullName: name });
    if (exists) return await _reply(`⚠️ التاجر "${name}" موجود مسبقاً`);
    await new Dealer({ fullName: name, phone, balance: 0 }).save();
    return await _reply(`✅ *تم إضافة التاجر*\n🏪 ${name} | 📱 ${phone}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 🗑️ حذف زبون/تاجر
  // ══════════════════════════════════════════════════════════════

  const delCustM = cmd.match(/^حذف\s+زبون\s+(.+)$/i);
  if (delCustM) {
    const party = await _findParty(delCustM[1]);
    if (!party) return await _reply(`❌ لم أجد "${delCustM[1]}"`);
    if (party.partyModel !== 'Customer') return await _reply(`❌ "${delCustM[1]}" تاجر وليس زبون — استخدم حذف تاجر`);
    await Customer.findByIdAndDelete(party._id);
    await Ledger.deleteMany({ partyId: party._id, partyModel: 'Customer' });
    await Invoice.deleteMany({ partyId: party._id, partyModel: 'Customer' });
    await Payment.deleteMany({ partyId: party._id, partyModel: 'Customer' });
    return await _reply(`🗑️ *تم حذف الزبون ${party.fullName} وجميع بياناته*`);
  }

  const delDealM = cmd.match(/^حذف\s+تاجر\s+(.+)$/i);
  if (delDealM) {
    const party = await _findParty(delDealM[1]);
    if (!party) return await _reply(`❌ لم أجد "${delDealM[1]}"`);
    if (party.partyModel !== 'Dealer') return await _reply(`❌ "${delDealM[1]}" زبون وليس تاجر — استخدم حذف زبون`);
    await Dealer.findByIdAndDelete(party._id);
    await Ledger.deleteMany({ partyId: party._id, partyModel: 'Dealer' });
    await Invoice.deleteMany({ partyId: party._id, partyModel: 'Dealer' });
    await Payment.deleteMany({ partyId: party._id, partyModel: 'Dealer' });
    return await _reply(`🗑️ *تم حذف التاجر ${party.fullName} وجميع بياناته*`);
  }

  // ══════════════════════════════════════════════════════════════
  // ✏️ تعديل زبون/تاجر
  // ══════════════════════════════════════════════════════════════

  const edCustM = cmd.match(/^تعديل\s+زبون\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (edCustM) {
    const party = await _findParty(edCustM[1]);
    if (!party) return await _reply(`❌ لم أجد "${edCustM[1]}"`);
    if (party.partyModel !== 'Customer') return await _reply(`❌ "${edCustM[1]}" تاجر وليس زبون`);
    const newPhone = edCustM[2].trim();
    await Customer.findByIdAndUpdate(party._id, { phone: newPhone });
    return await _reply(`✅ *تم تعديل الزبون*\n👤 ${party.fullName} | 📱 ${newPhone}`);
  }

  const edDealM = cmd.match(/^تعديل\s+تاجر\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (edDealM) {
    const party = await _findParty(edDealM[1]);
    if (!party) return await _reply(`❌ لم أجد "${edDealM[1]}"`);
    if (party.partyModel !== 'Dealer') return await _reply(`❌ "${edDealM[1]}" زبون وليس تاجر`);
    const newPhone = edDealM[2].trim();
    await Dealer.findByIdAndUpdate(party._id, { phone: newPhone });
    return await _reply(`✅ *تم تعديل التاجر*\n🏪 ${party.fullName} | 📱 ${newPhone}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 🔧 أخرى
  // ══════════════════════════════════════════════════════════════

  if (/^تذكير$/i.test(L)) {
    const CNS = require('./CheckNotificationService');
    CNS.runDailyJob().catch(() => {});
    return await _reply('⏳ جاري التذكيرات...');
  }

  if (/^(تقرير يومي|تقرير اليوم)$/i.test(L)) {
    const CNS = require('./CheckNotificationService');
    await CNS.runDailyJob();
    return await _reply('✅ تم إرسال التقرير اليومي');
  }

  // ─── أمر غير معروف ───
  await _reply(`🤔 أمر غير معروف: "${raw}"\nاكتب *مساعدة* لعرض الأوامر.`);
}

// ─── تشغيل ───────────────────────────────────────────────────────────────────

async function startBot() {
  if (_initialized) return;
  _initialized = true;
  WA.onMessage(async (message) => {
    try {
      const jid = message.key?.remoteJid || '';
      const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
      if (!text || !jid) return;
      if (!(await _isManager(jid))) return;
      console.log(`[WA-Bot] 📩 ${text}`);
      await _handleCommand(text, jid);
    } catch (e) {
      console.error('[WA-Bot] خطأ:', e.message);
    }
  });
  console.log('[WA-Bot] 🤖 جاهز — ينتظر رسائل المدير');
}

module.exports = { startBot };
