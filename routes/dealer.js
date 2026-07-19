const express = require('express');
const router = express.Router();
const Dealer = require('../models/Dealer');
const Invoice = require('../models/Invoice');
const Ledger = require('../models/Ledger');

const isAuth = (req, res, next) => req.session.dealerAuth ? next() : res.redirect('/');

// الصفحة الرئيسية للتاجر
router.get('/', isAuth, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.session.dealerId);
    if (!dealer) { req.session.destroy(); return res.redirect('/'); }
    res.render('dealer/dashboard', { dealer });
  } catch (err) { res.redirect('/'); }
});

// كشف الحساب
router.get('/statement', isAuth, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.session.dealerId);
    if (!dealer) { req.session.destroy(); return res.redirect('/'); }

    const entries = await Ledger.find({ partyId: dealer._id, partyModel: 'Dealer' })
      .populate('invoiceId').sort({ date: 1, _id: 1 });

    // جلب مدفوعات كل فاتورة دفعة واحدة
    const invoiceIds = entries.filter(e => e.invoiceId).map(e => e.invoiceId._id);
    const allInvPayments = await Ledger.find({ invoiceId: { $in: invoiceIds }, type: 'credit' }).sort({ date: 1 });
    const paysByInv = {};
    allInvPayments.forEach(p => {
      const k = p.invoiceId.toString();
      if (!paysByInv[k]) paysByInv[k] = [];
      paysByInv[k].push(p);
    });

    let runningBalance = 0;
    const transactions = entries.map(e => {
      if (e.type === 'debit') runningBalance += e.amount;
      else runningBalance -= e.amount;
      return {
        date: new Date(e.date),
        desc: e.description,
        refNo: e.refNo || '-',
        debit: e.type === 'debit' ? e.amount : 0,
        credit: e.type === 'credit' ? e.amount : 0,
        method: e.paymentMethod,
        cheque: e.chequeNumber ? `شيك #${e.chequeNumber} (${e.bankName})` : null,
        balance: runningBalance,
        invoice: e.invoiceId || null,
        invoicePayments: e.invoiceId ? (paysByInv[e.invoiceId._id.toString()] || []) : [],
        itemsDetails: e.itemsDetails || ''
      };
    });

    const totals = {
      totalDebit: transactions.reduce((s, t) => s + t.debit, 0),
      totalCredit: transactions.reduce((s, t) => s + t.credit, 0),
      finalBalance: runningBalance
    };

    res.render('dealer/statement', { dealer, transactions, totals, settings: res.locals.settings });
  } catch (err) { console.error(err); res.redirect('/'); }
});

// قائمة الفواتير
router.get('/invoices', isAuth, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.session.dealerId);
    if (!dealer) { req.session.destroy(); return res.redirect('/'); }
    const invoices = await Invoice.find({ partyId: dealer._id, type: 'dealer' }).sort({ invoiceDate: -1 });
    res.render('dealer/invoices', { dealer, invoices, settings: res.locals.settings });
  } catch (err) { console.error(err); res.redirect('/'); }
});

// عرض فاتورة واحدة
router.get('/invoices/:id', isAuth, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.session.dealerId);
    if (!dealer) { req.session.destroy(); return res.redirect('/'); }
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.partyId.toString() !== dealer._id.toString()) {
      return res.redirect('/dealer/invoices');
    }
    const payments = await Ledger.find({ invoiceId: invoice._id, type: 'credit' }).sort({ date: 1 });
    res.render('dealer/invoice-view', { dealer, invoice, payments, settings: res.locals.settings });
  } catch (err) { console.error(err); res.redirect('/dealer/invoices'); }
});

module.exports = router;
