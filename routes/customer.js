const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Ledger = require('../models/Ledger');
const Visit = require('../models/Visit');
const Setting = require('../models/Setting');

const isAuth = (req, res, next) => req.session.customerAuth ? next() : res.redirect('/');

// Dashboard
router.get('/', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    res.render('customer/dashboard', { customer });
  } catch (err) { res.redirect('/'); }
});

// Statement (read-only)
router.get('/statement', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }

    const entries = await Ledger.find({ partyId: customer._id, partyModel: 'Customer' })
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

    const settings = await Setting.findOne() || new Setting();
    res.render('customer/statement', { customer, transactions, totals, settings });
  } catch (err) { console.error(err); res.redirect('/'); }
});

// قائمة الفواتير
router.get('/invoices', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    const invoices = await Invoice.find({ partyId: customer._id, type: 'customer' }).sort({ invoiceDate: -1 });
    res.render('customer/invoices', { customer, invoices });
  } catch (err) { console.error(err); res.redirect('/'); }
});

// عرض فاتورة واحدة
router.get('/invoices/:id', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.partyId.toString() !== customer._id.toString()) {
      return res.redirect('/customer/invoices');
    }
    const payments = await Ledger.find({ invoiceId: invoice._id, type: 'credit' }).sort({ date: 1 });
    const settings = await Setting.findOne() || new Setting();
    res.render('customer/invoice-view', { customer, invoice, payments, settings });
  } catch (err) { console.error(err); res.redirect('/customer/invoices'); }
});

// Visits list
router.get('/visits', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    const visits = await Visit.find({ customerId: customer._id }).sort({ visitNumber: -1 });
    res.render('customer/visits', { customer, visits });
  } catch (err) { console.error(err); res.redirect('/'); }
});

// View single visit (read-only)
router.get('/visits/:visitId', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    const visit = await Visit.findById(req.params.visitId);
    if (!visit || visit.customerId.toString() !== customer._id.toString()) {
      return res.redirect('/customer/visits');
    }
    res.render('customer/visit-view', { customer, visit });
  } catch (err) { console.error(err); res.redirect('/customer/visits'); }
});

// Print visit measurements (dedicated print page)
router.get('/visits/:visitId/print', isAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.session.customerId);
    if (!customer) { req.session.destroy(); return res.redirect('/'); }
    const visit = await Visit.findById(req.params.visitId);
    if (!visit || visit.customerId.toString() !== customer._id.toString()) {
      return res.redirect('/customer/visits');
    }
    res.render('customer/measurements', { customer, visit, layout: false });
  } catch (err) { console.error(err); res.redirect('/customer/visits'); }
});

module.exports = router;
