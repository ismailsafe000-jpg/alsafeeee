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
const _invoiceSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 دقيقة تنتهي الجلسة

// ─── مساعدات ──────────────────────────────────────────────────────────────────

async function _getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < 10000) return _settingsCache;
  try {
    const s = (await Setting.findOne().lean()) || {};
    _settingsCache = s;
    _settingsCacheAt = Date.now();
    return s;
  } catch (_) { return _settingsCache || {}; }
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
  try {
    let p = await Customer.findOne({ fullName: { $regex: t, $options: 'i' } }).lean();
    if (p) return { ...p, partyModel: 'Customer' };
    p = await Dealer.findOne({ fullName: { $regex: t, $options: 'i' } }).lean();
    if (p) return { ...p, partyModel: 'Dealer' };
  } catch (_) {}
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

// ─── جلسة الفاتورة ──────────────────────────────────────────────────────────

function _getSession(jid) {
  const s = _invoiceSessions.get(jid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { _invoiceSessions.delete(jid); return null; }
  return s;
}

function _setSession(jid, session) { _invoiceSessions.set(jid, session); }
function _clearSession(jid) { _invoiceSessions.delete(jid); }

function _fmtItems(items) {
  if (!items.length) return 'لا توجد أصناف';
  return items.map((it, i) => {
    const u = it.unit === 'م2' ? 'م²' : it.unit === 'م' ? 'م' : 'حبة';
    return `${i + 1}. ${it.name} — ${it.qty} ${u} × ${_money(it.price)} = *${_money(it.total)}*`;
  }).join('\n');
}

// ─── معالجة جلسة الفاتورة ───────────────────────────────────────────────────

async function _handleInvoiceSession(jid, text) {
  const session = _getSession(jid);
  if (!session) return false;
  const cmd = text.trim();

  // إلغاء
  if (/^(الغاء|الغى|cancel|غ)$/i.test(cmd)) {
    _clearSession(jid);
    await _reply('❌ تم إلغاء إنشاء الفاتورة');
    return true;
  }

  // صنف [اسم] [كمية] [وحدة] [سعر]
  const itemM = cmd.match(/^صنف\s+(.+?)\s+([\d.,]+)\s*(م2|متر مربع|متر|م|حبة|كمية)?\s*([\d.,]+)$/i);
  if (itemM) {
    const name = itemM[1].trim();
    const qty = parseFloat(itemM[2].replace(/,/g, ''));
    let unit = itemM[3] || 'حبة';
    const price = parseFloat(itemM[4].replace(/,/g, ''));
    if (isNaN(qty) || qty <= 0) { await _reply('❌ الكمية غير صحيحة'); return true; }
    if (isNaN(price) || price <= 0) { await _reply('❌ السعر غير صحيح'); return true; }
    if (['م2', 'متر مربع'].includes(unit)) unit = 'م2';
    else if (['م', 'متر'].includes(unit)) unit = 'م';
    else unit = 'حبة';

    session.items.push({ name, qty, unit, price, total: qty * price });
    const sub = session.items.reduce((s, it) => s + it.total, 0);
    const tot = Math.max(0, sub - session.discount);
    await _reply(
      `✅ *${name}* — ${qty} ${unit === 'م2' ? 'م²' : unit === 'م' ? 'م' : 'حبة'} × ${_money(price)} = *${_money(qty * price)}*\n\n` +
      `📋 الأصناف (${session.items.length}):\n${_fmtItems(session.items)}\n\n` +
      `💰 المجموع: ${_money(sub)} | الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(tot)}*\n\n` +
      `💡 *صنف [اسم] [كمية] [وحدة] [سعر]* — صنف آخر\n` +
      `*خصم [مبلغ]* | *حذف صنف [رقم]* | *خالص* | *الغاء*`
    );
    return true;
  }

  // حذف صنف [رقم]
  const delM = cmd.match(/^حذف\s+صنف\s+(\d+)$/i);
  if (delM) {
    const idx = parseInt(delM[1]) - 1;
    if (idx < 0 || idx >= session.items.length) { await _reply('❌ رقم الصنف غير صحيح'); return true; }
    const rm = session.items.splice(idx, 1)[0];
    const sub = session.items.reduce((s, it) => s + it.total, 0);
    await _reply(`🗑️ تم حذف: *${rm.name}*\n\n📋 (${session.items.length}):\n${_fmtItems(session.items)}\n\n💰 *الإجمالي: ${_money(Math.max(0, sub - session.discount))}*`);
    return true;
  }

  // خصم [مبلغ]
  const discM = cmd.match(/^خصم\s+([\d.,]+)$/i);
  if (discM) {
    const amt = parseFloat(discM[1].replace(/,/g, ''));
    if (isNaN(amt) || amt < 0) { await _reply('❌ مبلغ الخصم غير صحيح'); return true; }
    session.discount = amt;
    const sub = session.items.reduce((s, it) => s + it.total, 0);
    await _reply(`💰 الخصم: *${_money(amt)}* | الإجمالي: *${_money(Math.max(0, sub - amt))}*`);
    return true;
  }

  // ملاحظات [نص]
  const notesM = cmd.match(/^ملاحظات\s+(.+)$/i);
  if (notesM) { session.notes = notesM[1].trim(); await _reply('📝 تم حفظ الملاحظات'); return true; }

  // حاله
  if (/^(حاله|status)$/i.test(cmd)) {
    const sub = session.items.reduce((s, it) => s + it.total, 0);
    await _reply(`📋 *حالة الفاتورة*\n👤 ${session.party.fullName}\n📦 ${session.items.length} أصناف\n${_fmtItems(session.items)}\n💰 المجموع: ${_money(sub)} | الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(Math.max(0, sub - session.discount))}*`);
    return true;
  }

  // خالص — إنشاء الفاتورة
  if (/^(خالص|تم|انهاء|finish|done)$/i.test(cmd)) {
    if (!session.items.length) { await _reply('❌ أضف صنفاً أولاً بـ *صنف [اسم] [كمية] [وحدة] [سعر]*'); return true; }
    try {
      const s = await _getSettings();
      const invNum = (s.invoicePrefix || 'INV') + '-' + Date.now().toString().slice(-6);
      const items = session.items.map(it => ({
        description: it.name,
        quantityType: it.unit === 'م2' ? 'sqmeter' : it.unit === 'م' ? 'meter' : 'piece',
        length: it.qty, width: it.unit === 'م2' ? 1 : 0,
        quantity: it.qty, unitPrice: it.price, total: it.total
      }));
      const sub = items.reduce((s, it) => s + it.total, 0);
      const total = Math.max(0, sub - session.discount);

      const inv = await new Invoice({
        invoiceNumber: invNum,
        type: session.party.partyModel === 'Customer' ? 'customer' : 'dealer',
        partyId: session.party._id, partyModel: session.party.partyModel, partyName: session.party.fullName,
        items, totalAmount: total, discount: session.discount,
        notes: session.notes || 'إنشاء عبر واتساب', invoiceDate: new Date()
      }).save();

      const details = items.map((it, idx) => `${idx + 1}- ${it.description} | الكمية: ${it.quantity} | السعر: ${it.unitPrice} ₪ | الإجمالي: ${it.total} ₪`).join('\n');
      await new Ledger({
        partyId: session.party._id, partyModel: session.party.partyModel, partyName: session.party.fullName,
        type: 'debit', description: `فاتورة ${invNum}`, amount: total, date: new Date(), refNo: invNum, invoiceId: inv._id, itemsDetails: details
      }).save();

      const prev = session.party.balance || 0;
      await (session.party.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(session.party._id, { balance: prev + total });

      // إشعار المدير (خفي — لا يُعطّل الفاتورة)
      try { require('./CheckNotificationService').notifyInvoiceNew(inv).catch(() => {}); } catch (_) {}

      _clearSession(jid);
      await _reply(
        `✅ *فاتورة جديدة*\n📄 ${invNum}\n👤 ${session.party.fullName}\n━━━━━━━━\n${_fmtItems(session.items)}\n━━━━━━━━\n💰 الخصم: ${_money(session.discount)} | *الإجمالي: ${_money(total)}*\n💵 ${_money(prev)} → *${_money(prev + total)}*`
      );
    } catch (e) {
      console.error('[WA-Bot] خطأ إنشاء فاتورة:', e.message);
      await _reply('❌ خطأ: ' + e.message);
    }
    return true;
  }

  // رسالة مساعدة للجلسة
  await _reply(
    `📦 *وضع إنشاء فاتورة — ${session.party.fullName}*\n\n` +
    `*صنف [اسم] [كمية] [وحدة] [سعر]*\n` +
    `مثال: *صنف ستارة 3 م 50*\n` +
    `مثال: *صنف بلاطة 10 م2 80*\n` +
    `مثال: *صنف وسادة 5 حبة 25*\n\n` +
    `*خصم [مبلغ]* | *حذف صنف [رقم]* | *خالص* | *الغاء*`
  );
  return true;
}

// ─── معالجة الأوامر الرئيسية ───────────────────────────────────────────────

async function _handleCommand(text, jid) {
  const raw = (text || '').trim();
  if (!raw) return;
  const cmd = raw.replace(/[?؟!.]/g, '').trim();
  const L = cmd.toLowerCase();

  // هل في جلسة فاتورة نشطة؟
  const session = _getSession(jid);
  if (session) { if (await _handleInvoiceSession(jid, text)) return; }

  // ═══ مساعدة ═══
  if (/^(مساعدة|help|اوامر|start)$/i.test(L)) {
    return await _reply(
`🤖 *بوت معرض الصافي*
━━━━━━━━━━━━━━

📋 *العرض:*
• *رصيد* | *رصيد [اسم]*
• *كشف [اسم]* — كشف حساب
• *فواتير* | *فواتير [اسم]*
• *شيكات* — شيكات مستحقة
• *دفعات [اسم]*
• *زبائن* | *تجار*
• *تقرير* | *احصائيات*

📄 *فاتورة بأصناف:*
• *فاتورة [اسم]* — يبدأ الوضع التفاعلي
• ثم: *صنف [اسم] [كمية] [وحدة] [سعر]*
  مثال: *صنف ستارة 3 م 50*
  مثال: *صنف بلاطة 10 م2 80*
• *خصم [مبلغ]* | *خالص* | *الغاء*

✏️ *تسجيل سريع:*
• *دفعة [اسم] [مبلغ] [طريقة]*
• *شيك [اسم] [مبلغ] [بنك] [رقم] [تاريخ]*
• *حركة [اسم] [مبلغ] [مدين/دãn] [وصف]*

👥 *إدارة:*
• *اضف زبون [اسم] [هاتف]*
• *اضف تاجر [اسم] [هاتف]*
• *حذف زبون [اسم]* | *حذف تاجر [اسم]*
• *تعديل زبون [اسم] [هاتف]*

🔧 *أخرى:*
• *تذكير* | *تقرير يومي*`);
  }

  // ═══ رصيد ═══
  if (/^رصيد$/i.test(L)) {
    const list = await Customer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد زبائن');
    const lines = list.map((c, i) => `${i + 1}. ${c.fullName} — ${_money(c.balance)}`).join('\n');
    const total = list.reduce((s, c) => s + (c.balance || 0), 0);
    return await _reply(`💰 *أرصدة الزبائن*\n${lines}\n━━━━\n📊 الإجمالي: *${_money(total)}*`);
  }

  const balM = cmd.match(/^رصيد\s+(.+)$/i);
  if (balM) {
    const p = await _findParty(balM[1]);
    if (!p) return await _reply(`❌ لم أجد "${balM[1]}"`);
    const entries = await Ledger.find({ partyId: p._id, partyModel: p.partyModel }).sort({ date: -1 }).limit(5).lean();
    const last = entries.length ? entries.map(e => `• ${e.type === 'debit' ? '📤' : '📥'} ${_money(e.amount)} — ${e.description || '-'} (${_fmt(e.date)})`).join('\n') : 'لا حركات';
    return await _reply(`💰 *${p.fullName}*\n${_partyLabel(p.partyModel)} | الرصيد: *${_money(p.balance)}*\n📱 ${p.phone || '-'}\n\nآخر الحركات:\n${last}`);
  }

  // ═══ كشف حساب ═══
  const stmtM = cmd.match(/^كشف\s+(.+)$/i);
  if (stmtM) {
    const p = await _findParty(stmtM[1]);
    if (!p) return await _reply(`❌ لم أجد "${stmtM[1]}"`);
    const entries = await Ledger.find({ partyId: p._id, partyModel: p.partyModel }).sort({ date: 1 }).lean();
    if (!entries.length) return await _reply(`📒 كشف ${p.fullName}\nلا توجد حركات`);
    let tD = 0, tC = 0;
    const rows = entries.map((e, i) => { if (e.type === 'debit') tD += e.amount; else tC += e.amount; return `${i + 1}. ${_fmt(e.date)} | ${e.type === 'debit' ? '📤' : '📥'} ${_money(e.amount)} | ${e.description || '-'}`; }).join('\n');
    return await _reply(`📒 *كشف ${p.fullName}*\n📤 المدين: ${_money(tD)} | 📥 الدائن: ${_money(tC)} | 💰 *${_money(tD - tC)}*\n━━━━\n${rows.split('\n').slice(-15).join('\n')}`);
  }

  // ═══ فواتير ═══
  if (/^فواتير$/i.test(L)) {
    const invs = await Invoice.find({ status: { $in: ['unpaid', 'partial'] } }).sort({ createdAt: -1 }).lean();
    if (!invs.length) return await _reply('✅ لا توجد فواتير معلقة');
    const lines = invs.map((v, i) => `${i + 1}. ${v.invoiceNumber} | ${v.partyName} | ${_money(v.totalAmount)} | متبقي: ${_money(v.totalAmount - v.paidAmount)}`).join('\n');
    const total = invs.reduce((s, v) => s + (v.totalAmount - v.paidAmount), 0);
    return await _reply(`📋 *فواتير معلقة*\n${lines}\n💰 المتبقي: *${_money(total)}*`);
  }

  const invM = cmd.match(/^فواتير\s+(.+)$/i);
  if (invM) {
    const p = await _findParty(invM[1]);
    if (!p) return await _reply(`❌ لم أجد "${invM[1]}"`);
    const invs = await Invoice.find({ partyId: p._id, partyModel: p.partyModel, status: { $in: ['unpaid', 'partial'] } }).sort({ createdAt: -1 }).lean();
    if (!invs.length) return await _reply(`✅ لا فواتير معلقة لـ ${p.fullName}`);
    return await _reply(`📋 *فواتير ${p.fullName}*\n${invs.map((v, i) => `${i + 1}. ${v.invoiceNumber} | ${_money(v.totalAmount)} | متبقي: ${_money(v.totalAmount - v.paidAmount)}`).join('\n')}`);
  }

  // ═══ شيكات ═══
  if (/^شيكات$/i.test(L)) {
    const checks = await Check.find({ status: 'pending' }).sort({ maturityDate: 1 }).lean();
    if (!checks.length) return await _reply('✅ لا توجد شيكات معلقة');
    const lines = checks.map((c, i) => { const d = Math.ceil((new Date(c.maturityDate) - new Date()) / 864e5); const u = d <= 0 ? '⚠️ متأخر' : d <= 7 ? `⏰ ${d} يوم` : ''; return `${i + 1}. #${c.checkNumber} | ${c.partyName} | ${_money(c.amount)} | ${_fmt(c.maturityDate)} ${u}`; }).join('\n');
    const total = checks.reduce((s, c) => s + (c.amount || 0), 0);
    return await _reply(`📝 *شيكات مستحقة*\n${lines}\n💰 الإجمالي: *${_money(total)}*`);
  }

  // ═══ دفعات ═══
  const payM = cmd.match(/^دفعات\s+(.+)$/i);
  if (payM) {
    const p = await _findParty(payM[1]);
    if (!p) return await _reply(`❌ لم أجد "${payM[1]}"`);
    const pays = await Payment.find({ partyId: p._id, partyModel: p.partyModel }).sort({ createdAt: -1 }).limit(10).lean();
    if (!pays.length) return await _reply(`لا توجد دفعات لـ ${p.fullName}`);
    return await _reply(`💳 *دفعات ${p.fullName}*\n${pays.map((p, i) => `${i + 1}. ${p.voucherNumber || '-'} | ${_money(p.amount)} | ${_methodAr(p.paymentMethod)} | ${_fmt(p.paymentDate)}`).join('\n')}`);
  }

  // ═══ زبائن ═══
  if (/^زبائن$/i.test(L)) {
    const list = await Customer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد زبائن');
    return await _reply(`👥 *الزبائن (${list.length})*\n${list.map((c, i) => `${i + 1}. ${c.fullName} | ${c.phone || '-'} | ${_money(c.balance)}`).join('\n')}`);
  }

  // ═══ تجار ═══
  if (/^تجار$/i.test(L)) {
    const list = await Dealer.find().sort({ fullName: 1 }).lean();
    if (!list.length) return await _reply('لا يوجد تجار');
    return await _reply(`🏪 *التجار (${list.length})*\n${list.map((d, i) => `${i + 1}. ${d.fullName} | ${d.phone || '-'} | ${_money(d.balance)}`).join('\n')}`);
  }

  // ═══ تقرير ═══
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
    return await _reply(`📊 *تقرير شامل*\n📅 ${moment().locale('ar').format('DD/MM/YYYY HH:mm')}\n👥 زبائن: ${cC} | 🏪 تجار: ${dC}\n📋 فواتير: ${iC} — *${_money(totalU)}*\n📝 شيكات: ${chC} — *${_money(totalCh)}*\n💳 مدفوعات 30 يوم: ${pC}`);
  }

  const rptM = cmd.match(/^تقرير\s+(.+)$/i);
  if (rptM) {
    const p = await _findParty(rptM[1]);
    if (!p) return await _reply(`❌ لم أجد "${rptM[1]}"`);
    const [ents, invs, pays] = await Promise.all([
      Ledger.find({ partyId: p._id, partyModel: p.partyModel }).lean(),
      Invoice.find({ partyId: p._id, partyModel: p.partyModel }).lean(),
      Payment.find({ partyId: p._id, partyModel: p.partyModel }).lean(),
    ]);
    const tD = ents.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
    const tC = ents.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
    const unpd = invs.filter(i => i.status !== 'paid');
    return await _reply(`📊 *تقرير ${p.fullName}*\n💰 الرصيد: *${_money(p.balance)}*\n📤 المدين: ${_money(tD)} | 📥 الدائن: ${_money(tC)}\n📄 فواتير: ${invs.length} (${unpd.length} غير مدفوعة)\n💳 دفعات: ${pays.length}`);
  }

  // ═══ دفعة ═══
  const payCmd = cmd.match(/^دفعة\s+(.+?)\s+([\d.,]+)\s*(نقد|شيك|تحويل|بطاقة)?$/i);
  if (payCmd) {
    const p = await _findParty(payCmd[1]);
    if (!p) return await _reply(`❌ لم أجد "${payCmd[1]}"`);
    const amt = parseFloat(payCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const mMap = { 'نقد': 'cash', 'شيك': 'check', 'تحويل': 'bank_transfer', 'بطاقة': 'card' };
    const mAr = payCmd[3] || 'نقد';
    const m = mMap[mAr.toLowerCase()] || 'cash';
    const s = await _getSettings();
    const vNum = (s.pvPrefix || 'RC') + '-' + Date.now().toString().slice(-6);
    const prev = p.balance || 0;
    const newB = p.partyModel === 'Customer' ? prev - amt : prev + amt;
    await (p.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(p._id, { balance: newB });
    const lType = p.partyModel === 'Customer' ? 'credit' : 'debit';
    await new Ledger({ partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, type: lType, description: 'دفعة عبر واتساب', amount: amt, date: new Date(), refNo: vNum, paymentMethod: m }).save();
    await new Payment({ voucherNumber: vNum, voucherType: 'receipt', type: p.partyModel === 'Customer' ? 'customer' : 'dealer', partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, amount: amt, paymentMethod: m, description: 'دفعة عبر واتساب', paymentDate: new Date() }).save();
    return await _reply(`✅ *دفعة مسجلة*\n👤 ${p.fullName} | 💰 ${_money(amt)} | 💳 ${mAr}\n🔢 ${vNum}\n💵 ${_money(prev)} → *${_money(newB)}*`);
  }

  // ═══ فاتورة سريعة (مبلغ واحد) ═══
  const invCmd = cmd.match(/^فاتورة\s+(.+?)\s+([\d.,]+)$/i);
  if (invCmd) {
    const p = await _findParty(invCmd[1]);
    if (!p) return await _reply(`❌ لم أجد "${invCmd[1]}"`);
    const amt = parseFloat(invCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const s = await _getSettings();
    const invNum = (s.invoicePrefix || 'INV') + '-' + Date.now().toString().slice(-6);
    const inv = await new Invoice({ invoiceNumber: invNum, type: p.partyModel === 'Customer' ? 'customer' : 'dealer', partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, items: [{ description: 'فاتورة عبر واتساب', quantity: 1, unitPrice: amt, total: amt }], totalAmount: amt, notes: 'عبر واتساب' }).save();
    await new Ledger({ partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, type: 'debit', description: `فاتورة ${invNum}`, amount: amt, date: new Date(), refNo: invNum, invoiceId: inv._id }).save();
    const prev = p.balance || 0;
    await (p.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(p._id, { balance: prev + amt });
    return await _reply(`📄 *فاتورة*\n👤 ${p.fullName} | 🔢 ${invNum} | 💰 ${_money(amt)}\n💵 ${_money(prev)} → *${_money(prev + amt)}*`);
  }

  // ═══ فاتورة تفاعلية ═══
  const invStartM = cmd.match(/^فاتورة\s+(.+)$/i);
  if (invStartM) {
    const p = await _findParty(invStartM[1]);
    if (!p) return await _reply(`❌ لم أجد "${invStartM[1]}"`);
    _setSession(jid, { party: { _id: p._id, fullName: p.fullName, partyModel: p.partyModel }, items: [], discount: 0, notes: '', createdAt: Date.now() });
    return await _reply(
      `📄 *فاتورة لـ ${p.fullName}*\n━━━━━━━━━━━━━━\n\n` +
      `💡 *صنف [اسم] [كمية] [وحدة] [سعر]*\n` +
      `مثال:\n• *صنف ستارة 3 م 50*\n• *صنف بلاطة 10 م2 80*\n• *صنف وسادة 5 حبة 25*\n\n` +
      `📦 الوحدات: *حبة* | *م* | *م2*\n\n` +
      `*خصم [مبلغ]* | *خالص* | *الغاء*`
    );
  }

  // ═══ حركة ═══
  const ledCmd = cmd.match(/^حركة\s+(.+?)\s+([\d.,]+)\s+(مدين|دائن)\s+(.+)$/i);
  if (ledCmd) {
    const p = await _findParty(ledCmd[1]);
    if (!p) return await _reply(`❌ لم أجد "${ledCmd[1]}"`);
    const amt = parseFloat(ledCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const lType = ledCmd[3] === 'مدين' ? 'debit' : 'credit';
    await new Ledger({ partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, type: lType, description: ledCmd[4], amount: amt, date: new Date(), refNo: 'يدوي-واتساب' }).save();
    const prev = p.balance || 0;
    const newB = lType === 'debit' ? prev + amt : prev - amt;
    await (p.partyModel === 'Customer' ? Customer : Dealer).findByIdAndUpdate(p._id, { balance: newB });
    return await _reply(`✅ *حركة*\n👤 ${p.fullName} | ${ledCmd[3]} ${_money(amt)}\n📋 ${ledCmd[4]}\n💵 ${_money(prev)} → *${_money(newB)}*`);
  }

  // ═══ شيك ═══
  const chkCmd = cmd.match(/^شيك\s+(.+?)\s+([\d.,]+)\s+(.+?)\s+(.+?)\s+([\d\-]+)$/i);
  if (chkCmd) {
    const p = await _findParty(chkCmd[1]);
    if (!p) return await _reply(`❌ لم أجد "${chkCmd[1]}"`);
    const amt = parseFloat(chkCmd[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return await _reply('❌ المبلغ غير صحيح');
    const dueDate = new Date(chkCmd[5]);
    if (isNaN(dueDate.getTime())) return await _reply('❌ التاريخ غير صحيح (YYYY-MM-DD)');
    await new Check({ checkNumber: chkCmd[4].trim(), bankName: chkCmd[3].trim(), amount: amt, type: 'received', partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, receivedDate: new Date(), maturityDate: dueDate, status: 'pending' }).save();
    await new Ledger({ partyId: p._id, partyModel: p.partyModel, partyName: p.fullName, type: 'credit', description: `شيك #${chkCmd[4].trim()}`, amount: amt, date: new Date(), refNo: chkCmd[4].trim(), chequeNumber: chkCmd[4].trim(), bankName: chkCmd[3].trim(), chequeDueDate: dueDate, chequeStatus: 'pending' }).save();
    return await _reply(`📝 *شيك*\n👤 ${p.fullName} | 🏦 ${chkCmd[3].trim()}\n🔢 #${chkCmd[4].trim()} | 💰 ${_money(amt)}\n📅 ${_fmt(dueDate)}`);
  }

  // ═══ إضافة زبون/تاجر ═══
  const addCustM = cmd.match(/^اضف\s+زبون\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (addCustM) {
    const name = addCustM[1].trim(), phone = addCustM[2].trim();
    if (await Customer.findOne({ fullName: name })) return await _reply(`⚠️ "${name}" موجود مسبقاً`);
    await new Customer({ fullName: name, phone, balance: 0 }).save();
    return await _reply(`✅ *زبون جديد*\n👤 ${name} | 📱 ${phone}`);
  }

  const addDealM = cmd.match(/^اضف\s+تاجر\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (addDealM) {
    const name = addDealM[1].trim(), phone = addDealM[2].trim();
    if (await Dealer.findOne({ fullName: name })) return await _reply(`⚠️ "${name}" موجود مسبقاً`);
    await new Dealer({ fullName: name, phone, balance: 0 }).save();
    return await _reply(`✅ *تاجر جديد*\n🏪 ${name} | 📱 ${phone}`);
  }

  // ═══ حذف ═══
  const delCustM = cmd.match(/^حذف\s+زبون\s+(.+)$/i);
  if (delCustM) {
    const p = await _findParty(delCustM[1]);
    if (!p) return await _reply(`❌ لم أجد "${delCustM[1]}"`);
    if (p.partyModel !== 'Customer') return await _reply('❌ تاجر — استخدم حذف تاجر');
    await Customer.findByIdAndDelete(p._id);
    await Ledger.deleteMany({ partyId: p._id, partyModel: 'Customer' });
    await Invoice.deleteMany({ partyId: p._id, partyModel: 'Customer' });
    await Payment.deleteMany({ partyId: p._id, partyModel: 'Customer' });
    return await _reply(`🗑️ *حُذف الزبون ${p.fullName}*`);
  }

  const delDealM = cmd.match(/^حذف\s+تاجر\s+(.+)$/i);
  if (delDealM) {
    const p = await _findParty(delDealM[1]);
    if (!p) return await _reply(`❌ لم أجد "${delDealM[1]}"`);
    if (p.partyModel !== 'Dealer') return await _reply('❌ زبون — استخدم حذف زبون');
    await Dealer.findByIdAndDelete(p._id);
    await Ledger.deleteMany({ partyId: p._id, partyModel: 'Dealer' });
    await Invoice.deleteMany({ partyId: p._id, partyModel: 'Dealer' });
    await Payment.deleteMany({ partyId: p._id, partyModel: 'Dealer' });
    return await _reply(`🗑️ *حُذف التاجر ${p.fullName}*`);
  }

  // ═══ تعديل ═══
  const edCustM = cmd.match(/^تعديل\s+زبون\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (edCustM) {
    const p = await _findParty(edCustM[1]);
    if (!p) return await _reply(`❌ لم أجد "${edCustM[1]}"`);
    if (p.partyModel !== 'Customer') return await _reply('❌ تاجر');
    await Customer.findByIdAndUpdate(p._id, { phone: edCustM[2].trim() });
    return await _reply(`✅ *تعديل*\n👤 ${p.fullName} | 📱 ${edCustM[2].trim()}`);
  }

  const edDealM = cmd.match(/^تعديل\s+تاجر\s+(.+?)\s+([\d\-\+\s]+)$/i);
  if (edDealM) {
    const p = await _findParty(edDealM[1]);
    if (!p) return await _reply(`❌ لم أجد "${edDealM[1]}"`);
    if (p.partyModel !== 'Dealer') return await _reply('❌ زبون');
    await Dealer.findByIdAndUpdate(p._id, { phone: edDealM[2].trim() });
    return await _reply(`✅ *تعديل*\n🏪 ${p.fullName} | 📱 ${edDealM[2].trim()}`);
  }

  // ═══ أخرى ═══
  if (/^تذكير$/i.test(L)) {
    try { require('./CheckNotificationService').runDailyJob().catch(() => {}); } catch (_) {}
    return await _reply('⏳ جاري التذكيرات...');
  }

  if (/^(تقرير يومي|تقرير اليوم)$/i.test(L)) {
    try { await require('./CheckNotificationService').runDailyJob(); } catch (_) {}
    return await _reply('✅ تم التقرير اليومي');
  }

  await _reply(`🤔 أمر غير معروف: "${raw}"\nاكتب *مساعدة*`);
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
  console.log('[WA-Bot] 🤖 جاهز');
}

module.exports = { startBot };
