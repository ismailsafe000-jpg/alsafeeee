const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const Setting = require('../models/Setting');
const Customer = require('../models/Customer');
const Dealer = require('../models/Dealer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Check = require('../models/Check');
const Ledger = require('../models/Ledger');
const Visit = require('../models/Visit');
const Sale = require('../models/Sale');
const Measurement = require('../models/Measurement');
const Profit = require('../models/Profit');
const PDFDocument = require('pdfkit');
const CNS = require('../services/CheckNotificationService');

const isAdmin = (req, res, next) => req.session.adminAuth ? next() : res.redirect('/');

// Dashboard
router.get('/dashboard', isAdmin, async (req, res) => {
  try {
    const moment = require('moment');
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [custTotal, dealerTotal, invTotal, payTotal, checkTotal,
           custMonth, invMonth, payMonth,
           custLast, invLast, payLast] = await Promise.all([
      Customer.countDocuments(),
      Dealer.countDocuments(),
      Invoice.countDocuments(),
      Payment.countDocuments(),
      Check.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Invoice.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Payment.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Customer.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      Invoice.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      Payment.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } })
    ]);

    const pct = (a, b) => b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100);

    // Recent activity
    const recentInvoices = await Invoice.find().sort({ createdAt: -1 }).limit(4).lean();
    const recentPayments = await Payment.find().sort({ createdAt: -1 }).limit(2).lean();

    // Upcoming checks (pending, sorted by maturityDate)
    const upcomingChecks = await Check.find({ status: 'pending' })
      .sort({ maturityDate: 1 }).limit(5).lean();

    // Invoice status breakdown
    const [unpaidCount, partialCount, paidCount] = await Promise.all([
      Invoice.countDocuments({ status: 'unpaid' }),
      Invoice.countDocuments({ status: 'partial' }),
      Invoice.countDocuments({ status: 'paid' })
    ]);

    // 7-day chart data (invoices total by day)
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6); sevenDaysAgo.setHours(0,0,0,0);
    const dailyAgg = await Invoice.aggregate([
      { $match: { invoiceDate: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' } }, total: { $sum: '$totalAmount' } } },
      { $sort: { _id: 1 } }
    ]);
    const weekDaysAr = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    const chartLabels = [], chartData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
      const key = d.toISOString().slice(0,10);
      const found = dailyAgg.find(x => x._id === key);
      chartLabels.unshift(weekDaysAr[d.getDay()]);
      chartData.unshift(found ? found.total : 0);
    }
    chartLabels.reverse(); chartData.reverse();

    res.render('admin/dashboard', {
      title: 'لوحة التحكم',
      counts: { customers: custTotal, dealers: dealerTotal, invoices: invTotal, payments: payTotal, checks: checkTotal },
      trends: {
        customers: pct(custMonth, custLast),
        invoices:  pct(invMonth, invLast),
        payments:  pct(payMonth, payLast)
      },
      recentInvoices,
      recentPayments,
      upcomingChecks,
      invoiceStatuses: { unpaid: unpaidCount, partial: partialCount, paid: paidCount },
      chartLabels: JSON.stringify(chartLabels),
      chartData:   JSON.stringify(chartData)
    });
  } catch(err) { res.status(500).render('500', { error: err.message }); }
});

// Settings
router.get('/settings', isAdmin, async (req, res) => {
  try {
    let s = await Setting.findOne();
    if (!s) { s = new Setting(); await s.save(); }
    res.render('admin/settings', { title: 'إعدادات النظام', settings: s });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});

router.post('/settings', isAdmin, (req, res, next) => {
  upload.fields([{ name: 'storeLogo', maxCount: 1 }, { name: 'adminBg', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      req.flash('error_msg', 'خطأ في رفع الملف: ' + err.message);
      return res.redirect('/admin/settings');
    }
    next();
  });
}, async (req, res) => {
  try {
    let s = await Setting.findOne() || new Setting();
    
    // بيانات المعرض
    s.storeName            = req.body.storeName || s.storeName;
    s.systemTitle          = req.body.systemTitle || 'نظام إدارة متكامل وعصري';
    s.storePhone           = req.body.storePhone || '';
    s.storeWhatsapp        = req.body.storeWhatsapp || '';
    s.storeAddress         = req.body.storeAddress || '';
    s.storeEmail           = req.body.storeEmail || '';
    s.footerText           = req.body.footerText || '';
    s.storeCity            = req.body.storeCity || '';
    s.storeCountry         = req.body.storeCountry || '';
    s.storeMobile          = req.body.storeMobile || '';
    s.storeWebsite         = req.body.storeWebsite || '';
    s.storeTaxNumber       = req.body.storeTaxNumber || '';
    s.storeCommercialReg   = req.body.storeCommercialReg || '';
    s.storeLicenseNumber   = req.body.storeLicenseNumber || '';

    s.currency             = req.body.currency || '₪';
    s.invoicePrefix        = req.body.invoicePrefix || 'INV';
    s.primaryColor         = req.body.primaryColor || '#4F46E5';
    s.sidebarColor         = req.body.sidebarColor || '#1E1B4B';
    s.fontFamily           = req.body.fontFamily || 'Cairo';
    s.defaultTheme         = req.body.defaultTheme || 'light';

    // النسخ الاحتياطي
    s.backupEnabled    = req.body.backupEnabled === 'on';
    s.backupDay        = req.body.backupDay        || 'sunday';
    s.backupTime       = req.body.backupTime       || '02:00';
    s.backupKeepCount  = Number(req.body.backupKeepCount) || 5;

    // التكامل
    s.whatsappApiKey   = req.body.whatsappApiKey   || '';
    s.emailHost        = req.body.emailHost        || '';
    s.emailPort        = Number(req.body.emailPort) || 587;
    s.emailUser        = req.body.emailUser        || '';
    s.emailFromName    = req.body.emailFromName    || '';
    s.telegramBotToken = req.body.telegramBotToken || '';
    s.telegramChatId   = req.body.telegramChatId   || '';
    s.googleMapsApiKey = req.body.googleMapsApiKey || '';
    s.smsApiKey        = req.body.smsApiKey        || '';
    s.smsProvider      = req.body.smsProvider      || '';

    // إعدادات الطباعة
    s.invoicePrintSize   = req.body.invoicePrintSize   || 'A4';
    s.receiptPrintSize   = req.body.receiptPrintSize   || 'A4';
    s.paymentPrintSize   = req.body.paymentPrintSize   || 'A4';
    s.statementPrintSize = req.body.statementPrintSize || 'A4';
    s.salePrintSize      = req.body.salePrintSize      || 'A4';
    s.visitPrintSize     = req.body.visitPrintSize     || 'A4';
    s.printFontSize      = Number(req.body.printFontSize)   || 12;
    s.printMarginTop     = Number(req.body.printMarginTop)  || 15;
    s.printMarginSide    = Number(req.body.printMarginSide) || 15;
    s.printLogoSize      = Number(req.body.printLogoSize)   || 70;
    s.printShowSignature = req.body.printShowSignature === 'on';
    s.printShowStamp     = req.body.printShowStamp     === 'on';
    s.printDataPosition  = req.body.printDataPosition  || 'right';

    // إعدادات النظام
    s.maintenanceMode    = req.body.maintenanceMode === 'on';
    s.maintenanceMessage = req.body.maintenanceMessage || 'النظام تحت الصيانة، يرجى المحاولة لاحقاً';
    s.systemVersion      = req.body.systemVersion || s.systemVersion || '2.0.0';
    s.enableCustomerPortal = req.body.enableCustomerPortal === 'on';
    s.enableDealerPortal   = req.body.enableDealerPortal === 'on';
    s.customerPortalName   = req.body.customerPortalName || 'بوابة الزبائن';
    s.dealerPortalName     = req.body.dealerPortalName || 'بوابة التجار';
    s.catalogPricesMode    = req.body.catalogPricesMode === 'on';
    s.showLogoInInvoice    = req.body.showLogoInInvoice === 'on';
    s.showAddressInInvoice = req.body.showAddressInInvoice === 'on';
    s.showPhoneInInvoice   = req.body.showPhoneInInvoice === 'on';

    s.customerShowStatement = req.body.customerShowStatement === 'on';
    s.customerShowInvoices  = req.body.customerShowInvoices === 'on';
    s.customerShowVisits    = req.body.customerShowVisits === 'on';
    s.dealerShowStatement   = req.body.dealerShowStatement === 'on';
    s.dealerShowInvoices    = req.body.dealerShowInvoices === 'on';
    
    s.curtainPricePerMeter = Number(req.body.curtainPricePerMeter) || 0;
    s.carpetPricePerMeter  = Number(req.body.carpetPricePerMeter) || 0;
    s.qaadaPricePerMeter   = Number(req.body.qaadaPricePerMeter) || 0;
    s.sofaDefaultPrice     = Number(req.body.sofaDefaultPrice) || 0;
    
    s.showSofas       = req.body.showSofas === 'on';
    s.showQaadas      = req.body.showQaadas === 'on';
    s.showRooms       = req.body.showRooms === 'on';
    s.showWindows     = req.body.showWindows === 'on';
    s.showPhotos      = req.body.showPhotos === 'on';
    s.showNotes       = req.body.showNotes === 'on';
    s.showSignatures  = req.body.showSignatures === 'on';
    s.showCarpetTotal = req.body.showCarpetTotal === 'on';
    s.showCurtainTotal = req.body.showCurtainTotal === 'on';
    s.showCurtainCount = req.body.showCurtainCount === 'on';
    s.showCurtainDetails = req.body.showCurtainDetails === 'on';
    s.showPrices      = req.body.showPrices === 'on';
    s.compactPrint    = req.body.compactPrint === 'on';
    s.printMargin     = req.body.printMargin || '6';
    
    if (req.files && req.files['storeLogo']) s.storeLogo = '/uploads/' + req.files['storeLogo'][0].filename;
    if (req.files && req.files['adminBg'])   s.adminBg   = '/uploads/' + req.files['adminBg'][0].filename;
    if (req.body.removeAdminBg === 'yes')    s.adminBg   = '';
    s.adminBgOpacity = Number(req.body.adminBgOpacity) || 15;
    s.adminBgBlur    = Number(req.body.adminBgBlur)    || 0;
    if (req.body.adminPassword && req.body.adminPassword.trim() !== '') {
      // ✅ تشفير كلمة السر قبل الحفظ في قاعدة البيانات
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash(req.body.adminPassword.trim(), 10);
      s.adminPassword = hashed;
    }
    await s.save();
    req.flash('success_msg', 'تم حفظ الإعدادات بنجاح');
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحفظ: ' + err.message);
  }
  res.redirect('/admin/settings');
});

// =============================================
// النسخ الاحتياطي — تنزيل PDF
// =============================================
router.get('/backup/download', isAdmin, async (req, res) => {
  try {
    const s          = await Setting.findOne() || {};
    const customers  = await Customer.find().lean();
    const dealers    = await Dealer.find().lean();
    const invoices   = await Invoice.find().lean();
    const payments   = await Payment.find().lean();
    const sales      = await Sale.find().lean();
    const visits     = await Visit.find().lean();
    const checks     = await Check.find().lean();

    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const filename = `backup-${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const font = 'Helvetica';
    const fontBold = 'Helvetica-Bold';

    // ── Header ──
    doc.font(fontBold).fontSize(18).text('Saffi ERP — System Backup', { align: 'center' });
    doc.font(font).fontSize(11).text(s.storeName || '', { align: 'center' });
    doc.fontSize(10).text(`Date: ${new Date().toLocaleString('en-GB')}`, { align: 'center' });
    doc.moveDown(1);

    const section = (title, items, fields) => {
      doc.addPage();
      doc.font(fontBold).fontSize(14).fillColor('#1E1B4B').text(title);
      doc.moveDown(0.4);
      doc.font(font).fontSize(9).fillColor('#000000');
      if (!items.length) { doc.text('No records found.'); return; }
      const colW = (doc.page.width - 80) / fields.length;
      // Header row
      doc.font(fontBold).fontSize(9);
      fields.forEach((f, i) => {
        doc.text(f.label, 40 + i * colW, doc.y, { width: colW - 4, continued: i < fields.length - 1 });
      });
      doc.moveDown(0.3);
      doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.2);
      doc.font(font).fontSize(8);
      items.forEach(item => {
        const y = doc.y;
        if (y > doc.page.height - 80) { doc.addPage(); }
        fields.forEach((f, i) => {
          const val = String(item[f.key] || '').slice(0, 30);
          doc.text(val, 40 + i * colW, doc.y, { width: colW - 4, continued: i < fields.length - 1 });
        });
        doc.moveDown(0.15);
      });
    };

    // ── Summary ──
    doc.font(fontBold).fontSize(13).text('Summary');
    doc.font(font).fontSize(11);
    doc.text(`Customers:  ${customers.length}`);
    doc.text(`Dealers:    ${dealers.length}`);
    doc.text(`Invoices:   ${invoices.length}`);
    doc.text(`Payments:   ${payments.length}`);
    doc.text(`Sales:      ${sales.length}`);
    doc.text(`Visits:     ${visits.length}`);
    doc.text(`Checks:     ${checks.length}`);

    section('Customers', customers, [
      { key: 'fullName', label: 'Name' },       // ✅ إصلاح: fullName بدل name
      { key: 'phone',    label: 'Phone' },
      { key: 'address',  label: 'Address' },
      { key: 'isActive', label: 'Active' }       // ✅ إصلاح: isActive بدل balance (لا يوجد balance)
    ]);
    section('Dealers', dealers, [
      { key: 'fullName', label: 'Name' },        // ✅ إصلاح: fullName بدل name
      { key: 'phone',    label: 'Phone' },
      { key: 'isActive', label: 'Active' }       // ✅ إصلاح: isActive بدل balance
    ]);
    section('Invoices', invoices, [
      { key: 'invoiceNumber', label: 'Invoice#' },
      { key: 'customerName', label: 'Customer' },
      { key: 'totalAmount', label: 'Total' },
      { key: 'status', label: 'Status' },
      { key: 'date', label: 'Date' }
    ]);
    section('Payments', payments, [
      { key: 'voucherNumber', label: 'Voucher#' },
      { key: 'partyName', label: 'Party' },
      { key: 'amount', label: 'Amount' },
      { key: 'paymentMethod', label: 'Method' },
      { key: 'date', label: 'Date' }
    ]);
    section('Sales', sales, [
      { key: 'saleNumber', label: 'Sale#' },
      { key: 'customerName', label: 'Customer' },
      { key: 'totalAmount', label: 'Total' },
      { key: 'date', label: 'Date' }
    ]);

    // Page numbers
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.font(font).fontSize(8).fillColor('#999999')
         .text(`Page ${i + 1} of ${pages.count}`, 40, doc.page.height - 40, { align: 'center' });
    }
    doc.end();
  } catch(err) {
    console.error('Backup error:', err);
    res.status(500).send('Backup failed: ' + err.message);
  }
});

// =============================================
// مسح الكاش / إعادة بناء الفهارس
// =============================================
router.post('/clear-cache', isAdmin, async (req, res) => {
  // ✅ مسح كاش الإعدادات الفعلي في app.js
  try {
    const { clearSettingsCache } = require('../app');
    clearSettingsCache();
  } catch(e) {}
  req.flash('success_msg', 'تم مسح الكاش بنجاح');
  res.redirect('/admin/settings#system');
});

router.post('/rebuild-indexes', isAdmin, async (req, res) => {
  try {
    await Customer.syncIndexes();
    await Dealer.syncIndexes();
    await Invoice.syncIndexes();
    await Payment.syncIndexes();
    await Sale.syncIndexes();
    req.flash('success_msg', 'تم إعادة بناء الفهارس بنجاح');
  } catch(e) {
    req.flash('error_msg', 'خطأ في إعادة الفهارس: ' + e.message);
  }
  res.redirect('/admin/settings#system');
});

// =============================================
// إعدادات سندات القبض والصرف
// =============================================
router.get('/voucher-settings', isAdmin, async (req, res) => {
  let s = await Setting.findOne();
  if (!s) { s = new Setting(); await s.save(); }
  res.render('admin/voucher-settings', { title: 'إعدادات سندات القبض والصرف', settings: s });
});

router.post('/voucher-settings', isAdmin, async (req, res) => {
  try {
    let s = await Setting.findOne() || new Setting();
    // بيانات المعرض الإضافية
    s.storeCity          = req.body.storeCity || '';
    s.storeCountry       = req.body.storeCountry || '';
    s.storeMobile        = req.body.storeMobile || '';
    s.storeWebsite       = req.body.storeWebsite || '';
    s.storeTaxNumber     = req.body.storeTaxNumber || '';
    s.storeCommercialReg = req.body.storeCommercialReg || '';
    s.storeLicenseNumber = req.body.storeLicenseNumber || '';
    // الترقيم
    s.rcPrefix           = req.body.rcPrefix || 'RC';
    s.pvPrefix           = req.body.pvPrefix || 'PV';
    s.voucherDigits      = Number(req.body.voucherDigits) || 6;
    s.rcStartNumber      = Number(req.body.rcStartNumber) || 1;
    s.pvStartNumber      = Number(req.body.pvStartNumber) || 1;
    s.resetVoucherYearly = req.body.resetVoucherYearly === 'on';
    // حجم الطباعة
    s.voucherPaperSize   = req.body.voucherPaperSize || 'A4';
    // إظهار / إخفاء
    const boolFields = [
      'voucherShowLogo','voucherShowStoreName','voucherShowAddress','voucherShowPhone',
      'voucherShowMobile','voucherShowEmail','voucherShowWebsite','voucherShowCommercialReg',
      'voucherShowTaxNumber','voucherShowVoucherNumber','voucherShowDate','voucherShowTime',
      'voucherShowEmployee','voucherShowPaymentMethod','voucherShowBank','voucherShowChequeNumber',
      'voucherShowInvoiceRef','voucherShowDescription','voucherShowNotes','voucherShowQR',
      'voucherShowBarcode','voucherShowStamp','voucherShowReceiverSignature',
      'voucherShowClientSignature','voucherShowAccountantSignature',
      'voucherShowBalanceBefore','voucherShowBalanceAfter','voucherShowAmountInWords'
    ];
    boolFields.forEach(f => { s[f] = req.body[f] === 'on'; });
    // الألوان
    s.voucherHeaderColor = req.body.voucherHeaderColor || '#1e293b';
    s.voucherTextColor   = req.body.voucherTextColor   || '#1e293b';
    s.voucherTableColor  = req.body.voucherTableColor  || '#f8f9fa';
    s.voucherFooterColor = req.body.voucherFooterColor || '#f1f5f9';
    s.voucherBorderColor = req.body.voucherBorderColor || '#dee2e6';
    // الخطوط
    s.voucherFont        = req.body.voucherFont      || 'Cairo';
    s.voucherFontSize    = Number(req.body.voucherFontSize)  || 12;
    s.voucherTitleSize   = Number(req.body.voucherTitleSize) || 18;
    s.voucherLogoSize    = Number(req.body.voucherLogoSize)  || 70;
    // النصوص
    s.voucherHeaderText  = req.body.voucherHeaderText || '';
    s.voucherFooterText  = req.body.voucherFooterText || '';
    await s.save();
    req.flash('success_msg', 'تم حفظ إعدادات السندات بنجاح');
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحفظ: ' + err.message);
  }
  res.redirect('/admin/voucher-settings');
});


// Customers
router.get('/customers', isAdmin, async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    res.render('admin/customers', { title: 'الزبائن', customers });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});
router.get('/customers/add', isAdmin, (req, res) => res.render('admin/customer-form', { title: 'إضافة زبون', customer: {} }));
router.post('/customers/add', isAdmin, async (req, res) => {
  try {
    await new Customer(req.body).save();
    req.flash('success_msg', 'تم إضافة الزبون بنجاح');
    res.redirect('/admin/customers');
  } catch(err) { req.flash('error_msg', 'خطأ في الإضافة: ' + err.message); res.redirect('/admin/customers/add'); }
});
router.get('/customers/edit/:id', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) { req.flash('error_msg', 'الزبون غير موجود'); return res.redirect('/admin/customers'); }
    res.render('admin/customer-form', { title: 'تعديل زبون', customer });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});
router.post('/customers/edit/:id', isAdmin, async (req, res) => {
  try {
    await Customer.findByIdAndUpdate(req.params.id, req.body);
    req.flash('success_msg', 'تم تعديل الزبون بنجاح');
    res.redirect('/admin/customers');
  } catch(err) { req.flash('error_msg', 'خطأ في التعديل: ' + err.message); res.redirect('/admin/customers'); }
});
router.get('/customers/delete/:id', isAdmin, async (req, res) => {
  try {
    await Customer.findByIdAndDelete(req.params.id);
    req.flash('success_msg', 'تم حذف الزبون');
    res.redirect('/admin/customers');
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});

// Dealers
router.get('/dealers', isAdmin, async (req, res) => {
  try {
    const dealers = await Dealer.find().sort({ createdAt: -1 });
    res.render('admin/dealers', { title: 'التجار', dealers });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});
router.get('/dealers/add', isAdmin, (req, res) => res.render('admin/dealer-form', { title: 'إضافة تاجر', dealer: {} }));
router.post('/dealers/add', isAdmin, async (req, res) => {
  try {
    await new Dealer(req.body).save();
    req.flash('success_msg', 'تم إضافة التاجر بنجاح');
    res.redirect('/admin/dealers');
  } catch(err) { req.flash('error_msg', 'خطأ في الإضافة: ' + err.message); res.redirect('/admin/dealers/add'); }
});
router.get('/dealers/edit/:id', isAdmin, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.params.id);
    if (!dealer) { req.flash('error_msg', 'التاجر غير موجود'); return res.redirect('/admin/dealers'); }
    res.render('admin/dealer-form', { title: 'تعديل تاجر', dealer });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dealers'); }
});
router.post('/dealers/edit/:id', isAdmin, async (req, res) => {
  try {
    await Dealer.findByIdAndUpdate(req.params.id, req.body);
    req.flash('success_msg', 'تم تعديل التاجر بنجاح');
    res.redirect('/admin/dealers');
  } catch(err) { req.flash('error_msg', 'خطأ في التعديل: ' + err.message); res.redirect('/admin/dealers'); }
});
router.get('/dealers/delete/:id', isAdmin, async (req, res) => {
  try {
    await Dealer.findByIdAndDelete(req.params.id);
    req.flash('success_msg', 'تم حذف التاجر');
    res.redirect('/admin/dealers');
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dealers'); }
});

// =============================================
// الفواتير - Invoices
// =============================================
router.get('/invoices', isAdmin, async (req, res) => {
  const invoices = await Invoice.find().sort({ createdAt: -1 });
  res.render('admin/invoices', { title: 'الفواتير', invoices });
});

router.get('/invoices/add', isAdmin, async (req, res) => {
  res.render('admin/invoice-form', {
    title: 'إضافة فاتورة',
    customers: await Customer.find().sort({ fullName: 1 }),
    dealers: await Dealer.find().sort({ fullName: 1 })
  });
});

router.post('/invoices/add', isAdmin, async (req, res) => {
  try {
    const { type, partyId, items, totalAmount, discount, notes, invoiceDate,
            payEnabled, payMethod, payAmount, payDate, payRef,
            payChequeNumber, payBankName, payChequeReceived, payChequeDue, payChequeStatus } = req.body;

    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) {
      req.flash('error_msg', 'الطرف غير موجود');
      return res.redirect('/admin/invoices/add');
    }

    const parsedItems    = JSON.parse(items);
    const parsedTotal    = parseFloat(totalAmount);
    const parsedDiscount = parseFloat(discount) || 0;
    const partyModel     = type === 'customer' ? 'Customer' : 'Dealer';
    const invDate        = invoiceDate ? new Date(invoiceDate) : new Date();

    let setting = await Setting.findOne();
    const prefix = (setting && setting.invoicePrefix) ? setting.invoicePrefix : 'INV';

    // ===== تفاصيل الأصناف كاملة =====
    let itemsDetails = parsedItems.map((it, idx) => {
      let qStr = '';
      if (it.quantityType === 'sqmeter') {
        qStr = `${it.length} × ${it.width} = ${it.quantity} م²`;
      } else if (it.quantityType === 'meter') {
        qStr = `${it.quantity} م`;
      } else {
        qStr = `${it.quantity}`;
      }
      return `${idx+1}- ${it.description} | الكمية: ${qStr} | السعر: ${it.unitPrice} ₪ | الإجمالي: ${it.total} ₪`;
    }).join('\n');

    // ===== ملخص سريع =====
    const itemsSummary = parsedItems.map(it => {
      let qStr = '';
      if (it.quantityType === 'sqmeter') qStr = `${it.length}×${it.width}م²`;
      else if (it.quantityType === 'meter') qStr = `${it.quantity}م`;
      else qStr = `${it.quantity}`;
      return `${it.description} (${qStr})`;
    }).join(' | ');

    const invoice = await new Invoice({
      invoiceNumber: prefix + '-' + Date.now(),
      type, partyId, partyModel,
      partyName: party.fullName,
      items: parsedItems,
      totalAmount: parsedTotal,
      discount: parsedDiscount,
      notes,
      invoiceDate: invDate
    }).save();

    await new Ledger({
      partyId, partyModel,
      partyName: party.fullName,
      type: 'debit',
      description: `فاتورة رقم ${invoice.invoiceNumber}`,
      amount: parsedTotal,
      date: invDate,
      refNo: invoice.invoiceNumber,
      paymentMethod: 'other',
      invoiceId: invoice._id,
      itemsDetails: itemsDetails
    }).save();

    if (payEnabled === 'on' && payAmount && parseFloat(payAmount) > 0) {
      const pAmount = parseFloat(payAmount);
      const pDate   = payDate ? new Date(payDate) : new Date();
      const pMethod = payMethod || 'cash';

      invoice.paidAmount += pAmount;
      await invoice.save();

      const creditEntry = new Ledger({
        partyId, partyModel,
        partyName: party.fullName,
        type: 'credit',
        description: `دفعة على فاتورة ${invoice.invoiceNumber}`,
        amount: pAmount,
        date: pDate,
        refNo: payRef || invoice.invoiceNumber,
        paymentMethod: pMethod,
        invoiceId: invoice._id
      });

      if (pMethod === 'check') {
        creditEntry.chequeNumber       = payChequeNumber || '';
        creditEntry.bankName           = payBankName || '';
        creditEntry.chequeReceivedDate = payChequeReceived || pDate;
        creditEntry.chequeDueDate      = payChequeDue || pDate;
        creditEntry.chequeStatus       = 'pending';
      }
      await creditEntry.save();

      const payRecord = await new Payment({
        type, partyId, partyModel,
        partyName: party.fullName,
        amount: pAmount,
        paymentMethod: pMethod,
        notes: `دفعة على فاتورة ${invoice.invoiceNumber}`,
        paymentDate: pDate,
        invoiceId: invoice._id,
        ledgerId: creditEntry._id,
        chequeNumber: pMethod === 'check' ? (payChequeNumber || '') : '',
        bankName: pMethod === 'check' ? (payBankName || '') : '',
        chequeReceivedDate: pMethod === 'check' ? (payChequeReceived ? new Date(payChequeReceived) : pDate) : null,
        chequeDueDate: pMethod === 'check' ? (payChequeDue ? new Date(payChequeDue) : pDate) : null,
        chequeStatus: pMethod === 'check' ? (payChequeStatus || 'pending') : 'pending'
      }).save();

      if (pMethod === 'check') {
        const newCheck1 = await new Check({
          checkNumber: payChequeNumber || '-',
          bankName: payBankName || '-',
          amount: pAmount,
          type: 'received',
          partyId, partyModel,
          partyName: party.fullName,
          receivedDate: payChequeReceived ? new Date(payChequeReceived) : pDate,
          maturityDate: payChequeDue ? new Date(payChequeDue) : pDate,
          status: mapCheckStatus(payChequeStatus),
          notes: `دفعة على فاتورة ${invoice.invoiceNumber}`,
          paymentId: payRecord._id,
          ledgerId: creditEntry._id
        }).save();
        CNS.notifyAdded(newCheck1).catch(e => console.error('[WA]', e.message));
      }
    }

    CNS.notifyInvoiceNew(invoice).catch(e => console.error('[WA]', e.message));
    req.flash('success_msg', `تم حفظ الفاتورة ${invoice.invoiceNumber} وإضافتها على كشف حساب ${party.fullName}`);
    res.redirect('/admin/invoices/view/' + invoice._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في حفظ الفاتورة: ' + err.message);
    res.redirect('/admin/invoices/add');
  }
});

// عرض فاتورة واحدة
router.get('/invoices/view/:id', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/invoices');
    }
    const payments = await Ledger.find({ invoiceId: invoice._id, type: 'credit' }).sort({ date: 1 });
    const settings = await Setting.findOne() || new Setting();
    res.render('admin/invoice-view', { title: `فاتورة ${invoice.invoiceNumber}`, invoice, payments, settings });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/invoices');
  }
});

// ====== تعديل فاتورة ======
router.get('/invoices/edit/:id', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/invoices');
    }
    res.render('admin/invoice-edit', {
      title: `تعديل فاتورة ${invoice.invoiceNumber}`,
      invoice,
      customers: await Customer.find().sort({ fullName: 1 }),
      dealers: await Dealer.find().sort({ fullName: 1 })
    });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/invoices');
  }
});

router.post('/invoices/edit/:id', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/invoices');
    }

    const { type, partyId, items, totalAmount, discount, notes, invoiceDate } = req.body;
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) {
      req.flash('error_msg', 'الطرف غير موجود');
      return res.redirect('/admin/invoices/edit/' + req.params.id);
    }

    const parsedItems    = JSON.parse(items);
    const parsedTotal    = parseFloat(totalAmount);
    const parsedDiscount = parseFloat(discount) || 0;
    const partyModel     = type === 'customer' ? 'Customer' : 'Dealer';
    const invDate        = invoiceDate ? new Date(invoiceDate) : invoice.invoiceDate;

    let itemsDetails = parsedItems.map((it, idx) => {
      let qStr = '';
      if (it.quantityType === 'sqmeter') {
        qStr = `${it.length} × ${it.width} = ${it.quantity} م²`;
      } else if (it.quantityType === 'meter') {
        qStr = `${it.quantity} م`;
      } else {
        qStr = `${it.quantity}`;
      }
      return `${idx+1}- ${it.description} | الكمية: ${qStr} | السعر: ${it.unitPrice} ₪ | الإجمالي: ${it.total} ₪`;
    }).join('\n');

    invoice.type          = type;
    invoice.partyId       = partyId;
    invoice.partyModel    = partyModel;
    invoice.partyName     = party.fullName;
    invoice.items         = parsedItems;
    invoice.totalAmount   = parsedTotal;
    invoice.discount      = parsedDiscount;
    invoice.notes         = notes || '';
    invoice.invoiceDate   = invDate;
    await invoice.save();

    const ledgerEntry = await Ledger.findOne({ invoiceId: invoice._id, type: 'debit' });
    if (ledgerEntry) {
      ledgerEntry.amount     = parsedTotal;
      ledgerEntry.partyId    = partyId;
      ledgerEntry.partyModel = partyModel;
      ledgerEntry.partyName  = party.fullName;
      ledgerEntry.date       = invDate;
      ledgerEntry.itemsDetails = itemsDetails;
      await ledgerEntry.save();
    }

    await Ledger.updateMany(
      { invoiceId: invoice._id, type: 'credit' },
      { $set: { partyId, partyModel, partyName: party.fullName } }
    );

    req.flash('success_msg', `تم تعديل الفاتورة ${invoice.invoiceNumber} بنجاح`);
    res.redirect('/admin/invoices/view/' + invoice._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في تعديل الفاتورة: ' + err.message);
    res.redirect('/admin/invoices/edit/' + req.params.id);
  }
});

// ====== حذف فاتورة ======
router.post('/invoices/delete/:id', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/invoices');
    }

    // جلب جميع إدخالات Ledger المرتبطة بالفاتورة
    const ledgerEntries = await Ledger.find({ invoiceId: invoice._id });
    const ledgerIds = ledgerEntries.map(e => e._id);

    // حذف الشيكات المرتبطة بهذه الإدخالات أو بالدفعات المرتبطة
    if (ledgerIds.length > 0) {
      await Check.deleteMany({ ledgerId: { $in: ledgerIds } });
    }
    // حذف الشيكات المرتبطة عبر Payment أيضاً
    const paymentDocs = await Payment.find({ invoiceId: invoice._id });
    const paymentIds = paymentDocs.map(p => p._id);
    if (paymentIds.length > 0) {
      await Check.deleteMany({ paymentId: { $in: paymentIds } });
    }

    // حذف Ledger والدفعات
    await Ledger.deleteMany({ invoiceId: invoice._id });
    await Payment.deleteMany({ invoiceId: invoice._id });

    // حذف الفاتورة
    await Invoice.findByIdAndDelete(req.params.id);
    req.flash('success_msg', `تم حذف الفاتورة ${invoice.invoiceNumber} بنجاح`);
    res.redirect('/admin/invoices');
  } catch (err) {
    req.flash('error_msg', 'خطأ في حذف الفاتورة: ' + err.message);
    res.redirect('/admin/invoices');
  }
});

// =============================================
// الأرباح - Profits (صفحة مستقلة، لا تعدل الفواتير الأصلية)
// =============================================

function profitStatus(p) {
  if (p.netProfit > 0) return 'profit';
  if (p.netProfit < 0) return 'loss';
  return 'even';
}

// قائمة سجلات الأرباح مع البحث والفلترة
router.get('/profits', isAdmin, async (req, res) => {
  try {
    const { q, dateFrom, dateTo, status } = req.query;
    const filter = {};
    if (q && q.trim()) {
      filter.$or = [
        { invoiceNumber: { $regex: q.trim(), $options: 'i' } },
        { partyName: { $regex: q.trim(), $options: 'i' } }
      ];
    }
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo + 'T23:59:59');
    }
    let profits = await Profit.find(filter).sort({ createdAt: -1 }).lean();
    if (status) {
      profits = profits.filter(p => profitStatus(p) === status);
    }
    const stats = {
      count: profits.length,
      totalSale: profits.reduce((s, p) => s + (p.totalSale || 0), 0),
      totalCost: profits.reduce((s, p) => s + (p.totalCost || 0), 0),
      netProfit: profits.reduce((s, p) => s + (p.netProfit || 0), 0)
    };
    res.render('admin/profits', {
      title: 'الأرباح',
      profits,
      stats,
      query: { q: q || '', dateFrom: dateFrom || '', dateTo: dateTo || '', status: status || '' }
    });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/dashboard');
  }
});

// اختيار فاتورة موجودة لإنشاء سجل أرباح منها
router.get('/profits/select-invoice', isAdmin, async (req, res) => {
  try {
    const usedInvoiceIds = (await Profit.find().distinct('invoiceId')).map(id => String(id));
    const invoices = await Invoice.find().sort({ createdAt: -1 }).lean();
    res.render('admin/profit-select-invoice', {
      title: 'اختيار فاتورة',
      invoices,
      usedInvoiceIds
    });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/profits');
  }
});

// فتح فاتورة داخل صفحة الأرباح لإدخال تكلفة الوحدة
router.get('/profits/create/:invoiceId', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.invoiceId).lean();
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/profits/select-invoice');
    }
    const existing = await Profit.findOne({ invoiceId: invoice._id });
    if (existing) {
      req.flash('error_msg', 'يوجد سجل أرباح لهذه الفاتورة بالفعل');
      return res.redirect('/admin/profits/edit/' + existing._id);
    }
    res.render('admin/profit-form', {
      title: `سجل أرباح - فاتورة ${invoice.invoiceNumber}`,
      invoice,
      profit: null
    });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/profits/select-invoice');
  }
});

// حفظ سجل أرباح جديد (لا يعدل الفاتورة الأصلية إطلاقاً)
router.post('/profits/create/:invoiceId', isAdmin, async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.invoiceId).lean();
    if (!invoice) {
      req.flash('error_msg', 'الفاتورة غير موجودة');
      return res.redirect('/admin/profits/select-invoice');
    }
    const existing = await Profit.findOne({ invoiceId: invoice._id });
    if (existing) {
      req.flash('error_msg', 'يوجد سجل أرباح لهذه الفاتورة بالفعل');
      return res.redirect('/admin/profits/edit/' + existing._id);
    }
    const unitCosts = JSON.parse(req.body.unitCosts || '[]');
    const items = invoice.items.map((it, idx) => ({
      description: it.description,
      quantityType: it.quantityType,
      length: it.length,
      width: it.width,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
      unitCost: Number(unitCosts[idx]) || 0
    }));

    const profit = await new Profit({
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      partyName: invoice.partyName,
      invoiceDate: invoice.invoiceDate,
      items,
      notes: req.body.notes || ''
    }).save();

    req.flash('success_msg', `تم حفظ سجل الأرباح لفاتورة ${invoice.invoiceNumber} بنجاح`);
    res.redirect('/admin/profits/view/' + profit._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحفظ: ' + err.message);
    res.redirect('/admin/profits/create/' + req.params.invoiceId);
  }
});

// معاينة سجل أرباح
router.get('/profits/view/:id', isAdmin, async (req, res) => {
  try {
    const profit = await Profit.findById(req.params.id).lean();
    if (!profit) {
      req.flash('error_msg', 'سجل الأرباح غير موجود');
      return res.redirect('/admin/profits');
    }
    const settings = await Setting.findOne() || new Setting();
    res.render('admin/profit-view', { title: `أرباح فاتورة ${profit.invoiceNumber}`, profit, settings });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/profits');
  }
});

// تعديل سجل أرباح - تعديل تكلفة الوحدة فقط
router.get('/profits/edit/:id', isAdmin, async (req, res) => {
  try {
    const profit = await Profit.findById(req.params.id).lean();
    if (!profit) {
      req.flash('error_msg', 'سجل الأرباح غير موجود');
      return res.redirect('/admin/profits');
    }
    res.render('admin/profit-form', {
      title: `تعديل أرباح فاتورة ${profit.invoiceNumber}`,
      invoice: null,
      profit
    });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/profits');
  }
});

router.post('/profits/edit/:id', isAdmin, async (req, res) => {
  try {
    const profit = await Profit.findById(req.params.id);
    if (!profit) {
      req.flash('error_msg', 'سجل الأرباح غير موجود');
      return res.redirect('/admin/profits');
    }
    const unitCosts = JSON.parse(req.body.unitCosts || '[]');
    profit.items.forEach((it, idx) => {
      it.unitCost = Number(unitCosts[idx]) || 0;
    });
    profit.notes = req.body.notes || '';
    await profit.save();
    req.flash('success_msg', `تم تحديث سجل أرباح فاتورة ${profit.invoiceNumber} بنجاح`);
    res.redirect('/admin/profits/view/' + profit._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في التعديل: ' + err.message);
    res.redirect('/admin/profits/edit/' + req.params.id);
  }
});

// حذف سجل أرباح فقط (لا يحذف الفاتورة الأصلية)
router.post('/profits/delete/:id', isAdmin, async (req, res) => {
  try {
    const profit = await Profit.findById(req.params.id);
    if (!profit) {
      req.flash('error_msg', 'سجل الأرباح غير موجود');
      return res.redirect('/admin/profits');
    }
    await Profit.findByIdAndDelete(req.params.id);
    req.flash('success_msg', `تم حذف سجل أرباح فاتورة ${profit.invoiceNumber}`);
    res.redirect('/admin/profits');
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحذف: ' + err.message);
    res.redirect('/admin/profits');
  }
});

// طباعة تقرير أرباح داخلي (خاص بالمدير فقط)
router.get('/profits/print/:id', isAdmin, async (req, res) => {
  try {
    const profit = await Profit.findById(req.params.id).lean();
    if (!profit) {
      req.flash('error_msg', 'سجل الأرباح غير موجود');
      return res.redirect('/admin/profits');
    }
    const settings = await Setting.findOne() || new Setting();
    res.render('admin/profit-print', { profit, settings });
  } catch (err) {
    req.flash('error_msg', err.message);
    res.redirect('/admin/profits');
  }
});

// =============================================
// دالة مساعدة: إعادة حساب المبلغ المدفوع للفاتورة من Ledger
// =============================================
async function recalcInvoicePaid(invoiceId) {
  if (!invoiceId) return;
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) return;
  const prevStatus = invoice.status;
  const credits = await Ledger.find({ invoiceId: invoice._id, type: 'credit' });
  // قيود الاسترجاع (مثل شيك مرتجع كان قد احتُسب كدفعة) تُطرح من إجمالي المدفوع
  const reversals = await Ledger.find({ invoiceId: invoice._id, type: 'debit', isReversal: true });
  const totalCredits   = credits.reduce((s, e) => s + e.amount, 0);
  const totalReversals = reversals.reduce((s, e) => s + e.amount, 0);
  invoice.paidAmount = Math.max(0, totalCredits - totalReversals);
  await invoice.save();
  if (prevStatus !== 'paid' && invoice.status === 'paid') {
    CNS.notifyInvoicePaid(invoice).catch(e => console.error('[WA]', e.message));
  }
}

// =============================================
// دالة مساعدة: توليد رقم السند (مع حماية من التكرار)
// =============================================
async function generateVoucherNumber(voucherType, settings) {
  const isReceipt = voucherType === 'receipt';
  const prefix = isReceipt ? (settings.rcPrefix || 'RC') : (settings.pvPrefix || 'PV');
  const digits  = settings.voucherDigits || 6;
  const startN  = isReceipt ? (settings.rcStartNumber || 1) : (settings.pvStartNumber || 1);

  for (let attempt = 0; attempt < 10; attempt++) {
    const last = await Payment.findOne({ voucherType }).sort({ createdAt: -1 }).select('voucherNumber');
    let nextNum = startN;
    if (last && last.voucherNumber) {
      const m = last.voucherNumber.match(/(\d+)$/);
      if (m) nextNum = Math.max(nextNum, parseInt(m[1]) + 1 + attempt);
    } else {
      nextNum = startN + attempt;
    }
    const candidate = prefix + '-' + String(nextNum).padStart(digits, '0');
    const exists = await Payment.findOne({ voucherNumber: candidate }).select('_id');
    if (!exists) return candidate;
  }
  // fallback: timestamp-based
  return prefix + '-' + Date.now().toString().slice(-digits);
}

// دالة مساعدة: تحويل حالة الشيك من نموذج السند إلى نموذج Check
// Payment/UI يستخدم: pending / cleared / bounced
// Check model يستخدم: pending / cleared / returned
function mapCheckStatus(chequeStatus) {
  if (chequeStatus === 'bounced') return 'returned';
  return chequeStatus || 'pending';
}

// دالة مساعدة: المبلغ بالحروف (عربي)
function amountToArabicWords(amount) {
  const ones = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة',
                 'عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر',
                 'ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
  const tens  = ['','عشرة','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];
  const hunds = ['','مئة','مئتان','ثلاثمئة','أربعمئة','خمسمئة','ستمئة','سبعمئة','ثمانمئة','تسعمئة'];
  if (!amount || isNaN(amount)) return 'صفر';
  const n = Math.floor(amount);
  const fils = Math.round((amount - n) * 100);
  function below1000(x) {
    if (x === 0) return '';
    if (x < 20) return ones[x];
    const t = Math.floor(x / 10), o = x % 10;
    if (o === 0) return tens[t];
    return ones[o] + ' و' + tens[t];
  }
  function below1M(x) {
    if (x < 1000) return below1000(x);
    const h = Math.floor(x / 1000), r = x % 1000;
    let s = h === 1 ? 'ألف' : h === 2 ? 'ألفان' : h < 11 ? ones[h] + ' آلاف' : below1000(h) + ' ألف';
    if (r > 0) s += ' و' + below1000(r);
    return s;
  }
  let result = '';
  if (n === 0) result = 'صفر';
  else if (n < 1000000) result = below1M(n);
  else {
    const m = Math.floor(n / 1000000), r = n % 1000000;
    result = below1M(m) + ' مليون';
    if (r > 0) result += ' و' + below1M(r);
  }
  if (fils > 0) result += ' و' + below1000(fils) + ' فلس';
  return result;
}

// =============================================
// السندات - Payments / Vouchers
// =============================================
router.get('/payments', isAdmin, async (req, res) => {
  const payments = await Payment.find().sort({ createdAt: -1 }).populate('invoiceId', 'invoiceNumber');
  const s = await Setting.findOne() || {};
  res.render('admin/payments', { title: 'سندات القبض والصرف', payments, settings: s });
});

router.get('/payments/add', isAdmin, async (req, res) => {
  const s = await Setting.findOne() || new Setting();
  // نولّد رقمَي السندين مسبقاً للعرض فقط
  const previewRC = await generateVoucherNumber('receipt', s);
  const previewPV = await generateVoucherNumber('payment', s);
  res.render('admin/payment-form', {
    title: 'إضافة سند',
    isEdit: false,
    payment: {},
    customers: await Customer.find().sort({ fullName: 1 }),
    dealers:   await Dealer.find().sort({ fullName: 1 }),
    invoices:  await Invoice.find({ remainingBalance: { $gt: 0 } }).sort({ invoiceDate: -1 }),
    settings: s,
    previewRC,
    previewPV
  });
});

router.post('/payments/add', isAdmin, async (req, res) => {
  try {
    const {
      voucherType, type, partyId, amount, currency, paymentMethod,
      description, notes, paymentDate, invoiceId,
      chequeNumber, bankName, chequeReceivedDate, chequeDueDate, chequeStatus,
      employeeName
    } = req.body;

    const partyModel = type === 'customer' ? 'Customer' : 'Dealer';
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) { req.flash('error_msg', 'الطرف غير موجود'); return res.redirect('/admin/payments/add'); }

    const s = await Setting.findOne() || new Setting();
    const vNum    = await generateVoucherNumber(voucherType || 'receipt', s);
    const pAmount = parseFloat(amount);
    const pDate   = paymentDate ? new Date(paymentDate) : new Date();
    const invId   = invoiceId || null;
    const pMethod = paymentMethod || 'cash';

    let linkedInv = null;
    if (invId) linkedInv = await Invoice.findById(invId);

    // نوع القيد في الكشف: يجب أن يطابق اتجاه تغيّر الرصيد
    // الزبون: سند قبض (نستلم منه) = ينقص رصيده = credit | سند صرف (نعطيه) = يزيد رصيده = debit
    // التاجر: سند قبض (نستلم منه) = يزيد رصيده = debit | سند صرف (نعطيه) = ينقص رصيده = credit
    const ledgerEntryType = type === 'customer'
      ? ((voucherType === 'payment') ? 'debit' : 'credit')
      : ((voucherType === 'receipt') ? 'debit' : 'credit');
    const desc = description || (linkedInv ? `سند على فاتورة ${linkedInv.invoiceNumber}` : (voucherType === 'receipt' ? 'سند قبض' : 'سند صرف'));

    // 1) إنشاء سجل Ledger
    const ledgerData = {
      partyId, partyModel, partyName: party.fullName,
      type: ledgerEntryType,
      description: desc,
      amount: pAmount,
      date: pDate,
      paymentMethod: pMethod,
      refNo: vNum,
      invoiceId: invId
    };
    // بيانات الشيك والتحويل البنكي مشتركة
    if (pMethod === 'check') {
      ledgerData.chequeNumber       = chequeNumber || '';
      ledgerData.bankName           = bankName || '';
      ledgerData.chequeReceivedDate = chequeReceivedDate ? new Date(chequeReceivedDate) : pDate;
      ledgerData.chequeDueDate      = chequeDueDate ? new Date(chequeDueDate) : pDate;
      ledgerData.chequeStatus       = chequeStatus || 'pending';
    } else if (pMethod === 'bank_transfer') {
      ledgerData.bankName = bankName || '';
    }
    const ledgerEntry = await new Ledger(ledgerData).save();

    // 2) إنشاء سجل Payment
    const payData = {
      voucherNumber: vNum,
      voucherType:   voucherType || 'receipt',
      type, partyId, partyModel, partyName: party.fullName,
      amount: pAmount, currency: currency || s.currency || '₪',
      paymentMethod: pMethod,
      description: desc,
      notes: notes || '',
      paymentDate: pDate, invoiceId: invId,
      ledgerId: ledgerEntry._id,
      employeeName: employeeName || '',
      auditLog: [{ action: 'created', user: 'admin', date: new Date() }]
    };
    if (pMethod === 'check') {
      payData.chequeNumber       = chequeNumber || '';
      payData.bankName           = bankName || '';
      payData.chequeReceivedDate = chequeReceivedDate ? new Date(chequeReceivedDate) : pDate;
      payData.chequeDueDate      = chequeDueDate ? new Date(chequeDueDate) : pDate;
      payData.chequeStatus       = chequeStatus || 'pending';
    } else if (pMethod === 'bank_transfer') {
      payData.bankName = bankName || '';
    }
    const pay = await new Payment(payData).save();

    // 3) إذا كانت شيك: إنشاء سجل في دفتر الشيكات
    if (pMethod === 'check') {
      const newCheck2 = await new Check({
        checkNumber: chequeNumber || '-',
        bankName: bankName || '-',
        amount: pAmount,
        type: voucherType === 'payment' ? 'issued' : 'received',
        partyId, partyModel, partyName: party.fullName,
        receivedDate: chequeReceivedDate ? new Date(chequeReceivedDate) : pDate,
        maturityDate: chequeDueDate ? new Date(chequeDueDate) : pDate,
        status: mapCheckStatus(chequeStatus),
        notes: notes || '',
        paymentId: pay._id,
        ledgerId: ledgerEntry._id
      }).save();
      CNS.notifyAdded(newCheck2).catch(e => console.error('[WA]', e.message));
    }

    // =============================================
    // ===== تحديث رصيد الطرف =====
    // =============================================
    let newBalance = party.balance || 0;

    if (type === 'customer') {
      // الزبون: قبض = ينقص، صرف = يزيد
      if (voucherType === 'receipt') {
        newBalance = party.balance - pAmount;
      } else if (voucherType === 'payment') {
        newBalance = party.balance + pAmount;
      }
    } else if (type === 'dealer') {
      // التاجر: قبض = يزيد، صرف = ينقص
      if (voucherType === 'receipt') {
        newBalance = party.balance + pAmount;
      } else if (voucherType === 'payment') {
        newBalance = party.balance - pAmount;
      }
    }

    party.balance = newBalance;
    await party.save();

    // إشعار الواتساب بعد تحديث الرصيد (نمرر المتبقي)
    if (voucherType === 'receipt' && type === 'customer') {
      CNS.notifyPaymentReceived(pay, newBalance).catch(e => console.error('[WA]', e.message));
    }
    // =============================================

    // 4) إعادة حساب الفاتورة المرتبطة
    await recalcInvoicePaid(invId);

    req.flash('success_msg', `تم تسجيل السند ${vNum} بنجاح وتحديث جميع الأقسام المرتبطة`);
    res.redirect('/admin/payments/view/' + pay._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في حفظ السند: ' + err.message);
    res.redirect('/admin/payments/add');
  }
});

// ====== عرض سند ======
// =============================================
// دفعات متعددة في عملية واحدة — "حفظ جميع الدفعات"
// كل دفعة تُسجَّل بشكل مستقل (سند + قيد كشف حساب + شيك عند الحاجة)
// وتُجمع فقط عن طريق batchId ونفس التاريخ/الطرف
// =============================================
router.get('/payments/add-multi', isAdmin, async (req, res) => {
  const s = await Setting.findOne() || new Setting();
  res.render('admin/payment-form-multi', {
    title: 'إضافة دفعات متعددة',
    customers: await Customer.find().sort({ fullName: 1 }),
    dealers:   await Dealer.find().sort({ fullName: 1 }),
    invoices:  await Invoice.find({ remainingBalance: { $gt: 0 } }).sort({ invoiceDate: -1 }),
    settings: s
  });
});

router.post('/payments/add-multi', isAdmin, async (req, res) => {
  try {
    const {
      voucherType, type, partyId, paymentDate, invoiceId,
      description, notes, employeeName, paymentsJson
    } = req.body;

    let rows;
    try { rows = JSON.parse(paymentsJson || '[]'); } catch (e) { rows = []; }
    rows = rows.filter(r => r && parseFloat(r.amount) > 0);
    if (!rows.length) {
      req.flash('error_msg', 'يجب إضافة دفعة واحدة على الأقل بمبلغ صحيح');
      return res.redirect('/admin/payments/add-multi');
    }

    const partyModel = type === 'customer' ? 'Customer' : 'Dealer';
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) { req.flash('error_msg', 'الطرف غير موجود'); return res.redirect('/admin/payments/add-multi'); }

    const s = await Setting.findOne() || new Setting();
    const pDate = paymentDate ? new Date(paymentDate) : new Date();
    const invId = invoiceId || null;
    let linkedInv = null;
    if (invId) linkedInv = await Invoice.findById(invId);

    const batchId = 'B-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const ledgerEntryType = type === 'customer'
      ? ((voucherType === 'payment') ? 'debit' : 'credit')
      : ((voucherType === 'receipt') ? 'debit' : 'credit');
    const baseDesc = description || (linkedInv ? `سند على فاتورة ${linkedInv.invoiceNumber}` : (voucherType === 'receipt' ? 'سند قبض' : 'سند صرف'));

    let totalAmount = 0;
    const createdVouchers = [];
    const batchPayments   = [];

    for (const row of rows) {
      const pAmount = parseFloat(row.amount);
      const pMethod = row.paymentMethod || 'cash';
      const vNum = await generateVoucherNumber(voucherType || 'receipt', s);

      const ledgerData = {
        partyId, partyModel, partyName: party.fullName,
        type: ledgerEntryType,
        description: baseDesc,
        amount: pAmount,
        date: pDate,
        paymentMethod: pMethod,
        refNo: vNum,
        invoiceId: invId
      };
      if (pMethod === 'check') {
        ledgerData.chequeNumber       = row.chequeNumber || '';
        ledgerData.bankName           = row.bankName || '';
        ledgerData.chequeReceivedDate = row.chequeReceivedDate ? new Date(row.chequeReceivedDate) : pDate;
        ledgerData.chequeDueDate      = row.chequeDueDate ? new Date(row.chequeDueDate) : pDate;
        ledgerData.chequeStatus       = row.chequeStatus || 'pending';
      } else if (pMethod === 'bank_transfer') {
        ledgerData.bankName = row.bankName || '';
      }
      const ledgerEntry = await new Ledger(ledgerData).save();

      const payData = {
        voucherNumber: vNum,
        voucherType:   voucherType || 'receipt',
        type, partyId, partyModel, partyName: party.fullName,
        amount: pAmount, currency: s.currency || '₪',
        paymentMethod: pMethod,
        description: baseDesc,
        notes: notes || '',
        paymentDate: pDate, invoiceId: invId,
        ledgerId: ledgerEntry._id,
        employeeName: employeeName || '',
        batchId,
        auditLog: [{ action: 'created', user: 'admin', date: new Date(), note: 'ضمن دفعة متعددة' }]
      };
      if (pMethod === 'check') {
        payData.chequeNumber       = row.chequeNumber || '';
        payData.bankName           = row.bankName || '';
        payData.chequeReceivedDate = row.chequeReceivedDate ? new Date(row.chequeReceivedDate) : pDate;
        payData.chequeDueDate      = row.chequeDueDate ? new Date(row.chequeDueDate) : pDate;
        payData.chequeStatus       = row.chequeStatus || 'pending';
      } else if (pMethod === 'bank_transfer') {
        payData.bankName = row.bankName || '';
      }
      const pay = await new Payment(payData).save();

      if (pMethod === 'check') {
        const newCheck2 = await new Check({
          checkNumber: row.chequeNumber || '-',
          bankName: row.bankName || '-',
          amount: pAmount,
          type: voucherType === 'payment' ? 'issued' : 'received',
          partyId, partyModel, partyName: party.fullName,
          receivedDate: row.chequeReceivedDate ? new Date(row.chequeReceivedDate) : pDate,
          maturityDate: row.chequeDueDate ? new Date(row.chequeDueDate) : pDate,
          status: mapCheckStatus(row.chequeStatus),
          notes: notes || '',
          paymentId: pay._id,
          ledgerId: ledgerEntry._id
        }).save();
        CNS.notifyAdded(newCheck2).catch(e => console.error('[WA]', e.message));
      }

      totalAmount += pAmount;
      createdVouchers.push(vNum);
      if (voucherType === 'receipt' && type === 'customer') batchPayments.push(pay);
    }

    // تحديث رصيد الطرف مرة واحدة بإجمالي كل الدفعات
    let newBalance = party.balance || 0;
    if (type === 'customer') {
      newBalance = voucherType === 'receipt' ? (party.balance - totalAmount) : (party.balance + totalAmount);
    } else if (type === 'dealer') {
      newBalance = voucherType === 'receipt' ? (party.balance + totalAmount) : (party.balance - totalAmount);
    }
    party.balance = newBalance;
    await party.save();

    // إشعار واحد يجمع كل الدفعات بعد تحديث الرصيد
    if (batchPayments.length > 0) {
      CNS.notifyPaymentsBatch(batchPayments, newBalance).catch(e => console.error('[WA]', e.message));
    }

    await recalcInvoicePaid(invId);

    req.flash('success_msg', `تم حفظ ${rows.length} دفعة/دفعات بنجاح (${createdVouchers.join(', ')}) وتحديث كشف الحساب`);
    res.redirect('/admin/payments');
  } catch (err) {
    req.flash('error_msg', 'خطأ في حفظ الدفعات: ' + err.message);
    res.redirect('/admin/payments/add-multi');
  }
});

router.get('/payments/view/:id', isAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).populate('invoiceId', 'invoiceNumber totalAmount remainingBalance');
    if (!payment) { req.flash('error_msg', 'السند غير موجود'); return res.redirect('/admin/payments'); }
    const s = await Setting.findOne() || new Setting();
    // حساب الرصيد قبل وبعد
    const allLedger = await Ledger.find({ partyId: payment.partyId, partyModel: payment.partyModel }).sort({ date: 1, _id: 1 });
    let balanceBefore = 0, balanceAfter = 0;
    for (const e of allLedger) {
      if (e._id.toString() === (payment.ledgerId ? payment.ledgerId.toString() : '')) {
        balanceBefore = balanceBefore; // الرصيد قبل هذه الحركة
      }
      if (e.type === 'debit') balanceBefore += e.amount;
      else balanceBefore -= e.amount;
      if (e._id.toString() === (payment.ledgerId ? payment.ledgerId.toString() : '')) {
        balanceAfter = balanceBefore;
        break;
      }
    }
    // حساب الرصيد الحقيقي
    let runBal = 0;
    let bBefore = 0, bAfter = 0;
    for (const e of allLedger) {
      const prev = runBal;
      if (e.type === 'debit') runBal += e.amount;
      else runBal -= e.amount;
      if (payment.ledgerId && e._id.toString() === payment.ledgerId.toString()) {
        bBefore = prev;
        bAfter  = runBal;
      }
    }
    const amountWords = amountToArabicWords(payment.amount);
    res.render('admin/payment-view', {
      title: `سند ${payment.voucherNumber || payment._id}`,
      payment, settings: s, amountWords, bBefore, bAfter
    });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/payments');
  }
});

// ====== طباعة سند ======
router.get('/payments/print/:id', isAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).populate('invoiceId', 'invoiceNumber totalAmount');
    if (!payment) return res.status(404).send('السند غير موجود');
    const s = await Setting.findOne() || new Setting();
    const allLedger = await Ledger.find({ partyId: payment.partyId, partyModel: payment.partyModel }).sort({ date: 1, _id: 1 });
    let runBal = 0, bBefore = 0, bAfter = 0;
    for (const e of allLedger) {
      const prev = runBal;
      if (e.type === 'debit') runBal += e.amount;
      else runBal -= e.amount;
      if (payment.ledgerId && e._id.toString() === payment.ledgerId.toString()) {
        bBefore = prev; bAfter = runBal;
      }
    }
    const amountWords = amountToArabicWords(payment.amount);
    res.render('admin/payment-print', {
      payment, settings: s, amountWords, bBefore, bAfter, layout: false
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ====== تعديل سند ======
router.get('/payments/edit/:id', isAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) { req.flash('error_msg', 'السند غير موجود'); return res.redirect('/admin/payments'); }
    const s = await Setting.findOne() || new Setting();
    res.render('admin/payment-form', {
      title: 'تعديل سند',
      isEdit: true,
      payment,
      customers: await Customer.find().sort({ fullName: 1 }),
      dealers:   await Dealer.find().sort({ fullName: 1 }),
      invoices:  await Invoice.find().sort({ invoiceDate: -1 }),
      settings: s,
      previewRC: payment.voucherNumber,
      previewPV: payment.voucherNumber
    });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/payments');
  }
});

router.post('/payments/edit/:id', isAdmin, async (req, res) => {
  try {
    const pay = await Payment.findById(req.params.id);
    if (!pay) { req.flash('error_msg', 'السند غير موجود'); return res.redirect('/admin/payments'); }

    const {
      voucherType, type, partyId, amount, currency, paymentMethod,
      description, notes, paymentDate, invoiceId,
      chequeNumber, bankName, chequeReceivedDate, chequeDueDate, chequeStatus,
      employeeName
    } = req.body;

    const partyModel = type === 'customer' ? 'Customer' : 'Dealer';
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) { req.flash('error_msg', 'الطرف غير موجود'); return res.redirect('/admin/payments/edit/' + req.params.id); }

    const oldInvoiceId = pay.invoiceId ? pay.invoiceId.toString() : null;
    const newInvoiceId = invoiceId || null;
    const pAmount = parseFloat(amount);
    const pDate   = paymentDate ? new Date(paymentDate) : new Date();
    const pMethod = paymentMethod || 'cash';

    let linkedInv = null;
    if (newInvoiceId) linkedInv = await Invoice.findById(newInvoiceId);
    // نفس منطق نوع القيد في سند الإضافة (راجع اتجاه الرصيد حسب الزبون/التاجر)
    const ledgerEntryType = type === 'customer'
      ? ((voucherType === 'payment') ? 'debit' : 'credit')
      : ((voucherType === 'receipt') ? 'debit' : 'credit');
    const desc = description || (linkedInv ? `سند على فاتورة ${linkedInv.invoiceNumber}` : (voucherType === 'receipt' ? 'سند قبض' : 'سند صرف'));

    // 1) تحديث Ledger
    if (pay.ledgerId) {
      await Ledger.findByIdAndUpdate(pay.ledgerId, {
        partyId, partyModel, partyName: party.fullName,
        type: ledgerEntryType,
        amount: pAmount, date: pDate, paymentMethod: pMethod,
        description: desc,
        refNo: pay.voucherNumber || '',
        invoiceId: newInvoiceId,
        chequeNumber: pMethod === 'check' ? (chequeNumber || '') : '',
        bankName: (pMethod === 'check' || pMethod === 'bank_transfer') ? (bankName || '') : '',
        chequeReceivedDate: pMethod === 'check' && chequeReceivedDate ? new Date(chequeReceivedDate) : null,
        chequeDueDate: pMethod === 'check' && chequeDueDate ? new Date(chequeDueDate) : null,
        chequeStatus: pMethod === 'check' ? (chequeStatus || 'pending') : 'pending'
      });
    }

    // 2) تحديث / إنشاء / حذف سجل الشيك
    const oldMethod = pay.paymentMethod;
    if (oldMethod === 'check' && pMethod !== 'check') {
      await Check.deleteOne({ paymentId: pay._id });
    } else if (oldMethod !== 'check' && pMethod === 'check') {
      const newCheck3 = await new Check({
        checkNumber: chequeNumber || '-', bankName: bankName || '-',
        amount: pAmount,
        type: voucherType === 'payment' ? 'issued' : 'received',
        partyId, partyModel, partyName: party.fullName,
        receivedDate: chequeReceivedDate ? new Date(chequeReceivedDate) : pDate,
        maturityDate: chequeDueDate ? new Date(chequeDueDate) : pDate,
        status: mapCheckStatus(chequeStatus), notes: notes || '',
        paymentId: pay._id, ledgerId: pay.ledgerId
      }).save();
      CNS.notifyAdded(newCheck3).catch(e => console.error('[WA]', e.message));
    } else if (pMethod === 'check') {
      const updatedCheck = await Check.findOneAndUpdate({ paymentId: pay._id }, {
        checkNumber: chequeNumber || '-', bankName: bankName || '-',
        amount: pAmount, partyId, partyModel, partyName: party.fullName,
        receivedDate: chequeReceivedDate ? new Date(chequeReceivedDate) : pDate,
        maturityDate: chequeDueDate ? new Date(chequeDueDate) : pDate,
        status: mapCheckStatus(chequeStatus), notes: notes || ''
      }, { new: true });
      // إشعار WhatsApp بتعديل بيانات الشيك
      if (updatedCheck) CNS.notifyEdited(updatedCheck).catch(e => console.error('[WA]', e.message));
    }

    // 3) تحديث Payment + سجل التدقيق
    pay.voucherType       = voucherType || pay.voucherType;
    pay.type              = type;
    pay.partyId           = partyId;
    pay.partyModel        = partyModel;
    pay.partyName         = party.fullName;
    pay.amount            = pAmount;
    pay.currency          = currency || pay.currency;
    pay.paymentMethod     = pMethod;
    pay.description       = desc;
    pay.notes             = notes || '';
    pay.paymentDate       = pDate;
    pay.invoiceId         = newInvoiceId;
    pay.employeeName      = employeeName || '';
    pay.chequeNumber      = pMethod === 'check' ? (chequeNumber || '') : '';
    pay.bankName          = (pMethod === 'check' || pMethod === 'bank_transfer') ? (bankName || '') : '';
    pay.chequeReceivedDate= pMethod === 'check' && chequeReceivedDate ? new Date(chequeReceivedDate) : null;
    pay.chequeDueDate     = pMethod === 'check' && chequeDueDate ? new Date(chequeDueDate) : null;
    pay.chequeStatus      = pMethod === 'check' ? (chequeStatus || 'pending') : 'pending';
    pay.auditLog.push({ action: 'edited', user: 'admin', date: new Date() });
    await pay.save();

    // =============================================
    // ===== تحديث رصيد الطرف =====
    // =============================================
    let newBalance = party.balance || 0;

    if (type === 'customer') {
      // الزبون: قبض = ينقص، صرف = يزيد
      if (voucherType === 'receipt') {
        newBalance = party.balance - pAmount;
      } else if (voucherType === 'payment') {
        newBalance = party.balance + pAmount;
      }
    } else if (type === 'dealer') {
      // التاجر: قبض = يزيد، صرف = ينقص
      if (voucherType === 'receipt') {
        newBalance = party.balance + pAmount;
      } else if (voucherType === 'payment') {
        newBalance = party.balance - pAmount;
      }
    }

    party.balance = newBalance;
    await party.save();
    // =============================================

    // 4) إعادة حساب الفواتير
    if (oldInvoiceId && oldInvoiceId !== newInvoiceId) await recalcInvoicePaid(oldInvoiceId);
    await recalcInvoicePaid(newInvoiceId);

    req.flash('success_msg', 'تم تعديل السند وتحديث جميع الأقسام المرتبطة بنجاح');
    res.redirect('/admin/payments/view/' + pay._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في تعديل السند: ' + err.message);
    res.redirect('/admin/payments/edit/' + req.params.id);
  }
});

// ====== حذف سند ======
router.post('/payments/delete/:id', isAdmin, async (req, res) => {
  try {
    const pay = await Payment.findById(req.params.id);
    if (!pay) { req.flash('error_msg', 'السند غير موجود'); return res.redirect('/admin/payments'); }

    const savedInvoiceId = pay.invoiceId;

    // تسجيل عملية الحذف في سجل التدقيق قبل الحذف
    pay.auditLog.push({ action: 'deleted', user: 'admin', date: new Date(), note: `حذف السند ${pay.voucherNumber || ''}` });
    await pay.save().catch(() => {});

    // 1) حذف Ledger المرتبط
    if (pay.ledgerId) await Ledger.findByIdAndDelete(pay.ledgerId);

    // 2) حذف الشيك إن وجد
    await Check.deleteOne({ paymentId: pay._id });

    // 3) حذف السند
    await Payment.findByIdAndDelete(pay._id);

    // 4) إعادة حساب الفاتورة
    await recalcInvoicePaid(savedInvoiceId);

    req.flash('success_msg', 'تم حذف السند وتحديث جميع الأقسام المرتبطة بنجاح');
    res.redirect('/admin/payments');
  } catch (err) {
    req.flash('error_msg', 'خطأ في حذف السند: ' + err.message);
    res.redirect('/admin/payments');
  }
});

// Checks & Global Balances
router.get('/checks', isAdmin, async (req, res) => {
  try {
    const allChecks = await Check.find().sort({ maturityDate: 1 });
    // شيكات الزبائن: كل شيك استلمناه من زبون (بما فيها التي حُوّلت لاحقاً لتاجر - تبقى بنفس السجل)
    const customerChecks = allChecks.filter(c => c.partyModel === 'Customer');
    // شيكات التجار: شيكات صادرة أصلاً للتاجر (جديدة من المعرض) + شيكات زبائن تم تحويلها لتاجر
    const dealerChecks = allChecks.filter(c => c.partyModel === 'Dealer' || c.status === 'transferred_to_dealer');
    const dealers = await Dealer.find().sort({ fullName: 1 });
    res.render('admin/checks', { title: 'دفتر الشيكات', customerChecks, dealerChecks, dealers });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});

// تحويل شيك زبون لتاجر: نفس الشيك يبقى كما هو، فقط تتغيّر حالته (لا يُنشأ شيك جديد)
router.post('/checks/transfer/:id', isAdmin, async (req, res) => {
  try {
    const { dealerId, transferDate } = req.body;
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }
    if (check.partyModel !== 'Customer') { req.flash('error_msg', 'يمكن تحويل شيكات الزبائن فقط'); return res.redirect('/admin/checks'); }
    if (check.status !== 'pending') { req.flash('error_msg', 'هذا الشيك تمت معالجته مسبقاً'); return res.redirect('/admin/checks'); }

    const dealer = await Dealer.findById(dealerId);
    if (!dealer) { req.flash('error_msg', 'التاجر غير موجود'); return res.redirect('/admin/checks'); }

    const s = await Setting.findOne() || new Setting();
    const vNum = await generateVoucherNumber('payment', s);
    const tDate = transferDate ? new Date(transferDate) : new Date();
    const desc = `سند صرف - تحويل شيك رقم ${check.checkNumber} من الزبون ${check.partyName}`;

    // التاجر: سند صرف (نعطيه) = ينقص رصيده = credit في الكشف
    const ledgerEntry = await new Ledger({
      partyId: dealer._id, partyModel: 'Dealer', partyName: dealer.fullName,
      type: 'credit',
      description: desc,
      amount: check.amount,
      date: tDate,
      paymentMethod: 'check',
      chequeNumber: check.checkNumber,
      bankName: check.bankName,
      chequeReceivedDate: check.receivedDate,
      chequeDueDate: check.maturityDate,
      chequeStatus: 'pending',
      refNo: vNum
    }).save();

    const pay = await new Payment({
      voucherNumber: vNum,
      voucherType: 'payment',
      type: 'dealer', partyId: dealer._id, partyModel: 'Dealer', partyName: dealer.fullName,
      amount: check.amount, currency: s.currency || '₪',
      paymentMethod: 'check',
      description: desc,
      notes: `تحويل شيك زبون رقم ${check.checkNumber} (${check.bankName}) بدلاً من الدفع النقدي`,
      paymentDate: tDate, invoiceId: null,
      ledgerId: ledgerEntry._id,
      chequeNumber: check.checkNumber,
      bankName: check.bankName,
      chequeReceivedDate: check.receivedDate,
      chequeDueDate: check.maturityDate,
      chequeStatus: 'pending',
      auditLog: [{ action: 'created', user: 'admin', date: new Date(), note: 'تحويل شيك زبون لتاجر' }]
    }).save();

    // تحديث رصيد التاجر (نفس منطق سند الصرف الحالي بدون أي تغيير)
    dealer.balance = (dealer.balance || 0) - check.amount;
    await dealer.save();

    // الشيك الأصلي نفسه فقط تتغيّر حالته - لا يُنشأ شيك جديد ولا تتغيّر بياناته الأساسية
    check.status = 'transferred_to_dealer';
    check.transferredToDealerId = dealer._id;
    check.transferredToDealerName = dealer.fullName;
    check.transferDate = tDate;
    check.transferVoucherNumber = vNum;
    check.transferPaymentId = pay._id;
    check.transferLedgerId = ledgerEntry._id;
    await check.save();

    req.flash('success_msg', `تم تحويل الشيك رقم ${check.checkNumber} إلى ${dealer.fullName} بسند صرف ${vNum} دون إنشاء شيك جديد`);
    res.redirect('/admin/checks');
  } catch (err) {
    req.flash('error_msg', 'خطأ في تحويل الشيك: ' + err.message);
    res.redirect('/admin/checks');
  }
});
router.get('/global-balances', isAdmin, async (req, res) => {
  try {
    const customerRows = [];
    for (const c of await Customer.find().sort({ fullName: 1 })) {
      const entries = await Ledger.find({ partyId: c._id, partyModel: 'Customer' });
      const totalDebit  = entries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
      const totalCredit = entries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
      customerRows.push({ id: c._id, name: c.fullName, phone: c.phone || '', totalDebit, totalCredit, balance: totalDebit - totalCredit });
    }
    const dealerRows = [];
    for (const d of await Dealer.find().sort({ fullName: 1 })) {
      const entries = await Ledger.find({ partyId: d._id, partyModel: 'Dealer' });
      const totalDebit  = entries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
      const totalCredit = entries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
      dealerRows.push({ id: d._id, name: d.fullName, phone: d.phone || '', totalDebit, totalCredit, balance: totalDebit - totalCredit });
    }
    const customerTotals = {
      totalDebit:  customerRows.reduce((s, r) => s + r.totalDebit, 0),
      totalCredit: customerRows.reduce((s, r) => s + r.totalCredit, 0),
      balance:     customerRows.reduce((s, r) => s + r.balance, 0)
    };
    const dealerTotals = {
      totalDebit:  dealerRows.reduce((s, r) => s + r.totalDebit, 0),
      totalCredit: dealerRows.reduce((s, r) => s + r.totalCredit, 0),
      balance:     dealerRows.reduce((s, r) => s + r.balance, 0)
    };
    res.render('admin/global-balances', { title: 'كشف الأرصدة العام', customerRows, dealerRows, customerTotals, dealerTotals });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});

// =============================================
// كشف حساب تفصيلي
// =============================================
router.post('/statement/delete/:entryId', isAdmin, async (req, res) => {
  try {
    const entry = await Ledger.findByIdAndDelete(req.params.entryId);
    if (entry) {
      req.flash('success_msg', 'تم حذف الحركة');
      const t = entry.partyModel === 'Customer' ? 'customer' : 'dealer';
      res.redirect(`/admin/statement/${t}/${entry.partyId}`);
    } else {
      req.flash('error_msg', 'الحركة غير موجودة');
      res.redirect('/admin/dashboard');
    }
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحذف: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

router.post('/statement/edit/:entryId', isAdmin, async (req, res) => {
  try {
    const { description, amount, date, refNo, type, partyId } = req.body;
    await Ledger.findByIdAndUpdate(req.params.entryId, {
      description: description || '',
      amount: parseFloat(amount),
      date: date || Date.now(),
      refNo: refNo || ''
    });
    req.flash('success_msg', 'تم تعديل الحركة بنجاح');
    res.redirect(`/admin/statement/${type}/${partyId}`);
  } catch (err) {
    req.flash('error_msg', 'خطأ في التعديل: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

router.get('/statement/:type/:id', isAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(id);
    if (!party) return res.status(404).send('غير موجود');

    const entries = await Ledger.find({
      partyId: id,
      partyModel: type === 'customer' ? 'Customer' : 'Dealer'
    }).populate('invoiceId').sort({ date: 1, _id: 1 });

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
        _id: e._id,
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
    res.render('admin/statement', {
      title: `كشف حساب - ${party.fullName}`,
      party, transactions, totals, type, settings
    });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'خطأ في جلب الكشف');
    res.redirect('/admin/dashboard');
  }
});

router.post('/statement/add', isAdmin, async (req, res) => {
  try {
    const { type, partyId, transactionType, description, amount, date,
            paymentMethod, chequeNumber, bankName, chequeReceivedDate,
            chequeDueDate, chequeStatus, refNo } = req.body;
    const Model = type === 'customer' ? Customer : Dealer;
    const party = await Model.findById(partyId);
    if (!party) { req.flash('error_msg', 'الطرف غير موجود'); return res.redirect('/admin/dashboard'); }
    const partyModel = type === 'customer' ? 'Customer' : 'Dealer';
    const parsedAmount = parseFloat(amount);
    const entryDate = date || Date.now();

    const entry = new Ledger({
      partyId, partyModel,
      partyName: party.fullName,
      type: transactionType,
      description: description || (transactionType === 'debit' ? 'صنف/بيان يدوي' : 'دفعة يدوية'),
      amount: parsedAmount,
      date: entryDate,
      refNo: refNo || '',
      paymentMethod: transactionType === 'credit' ? (paymentMethod || 'cash') : 'other'
    });

    if (transactionType === 'credit' && paymentMethod === 'check') {
      entry.chequeNumber = chequeNumber || '';
      entry.bankName = bankName || '';
      entry.chequeReceivedDate = chequeReceivedDate || Date.now();
      entry.chequeDueDate = chequeDueDate || Date.now();
      entry.chequeStatus = 'pending';
    }

    await entry.save();

    // حساب الرصيد المتبقي للزبون بعد الحركة لإرفاقه في الإشعار
    let statementRemaining = null;
    if (type === 'customer' && typeof party.balance === 'number') {
      statementRemaining = transactionType === 'debit'
        ? party.balance + parsedAmount
        : party.balance - parsedAmount;
    }
    CNS.notifyStatementEntry(entry, statementRemaining).catch(e => console.error('[WA]', e.message));

    if (transactionType === 'credit') {
      if (paymentMethod === 'cash' || paymentMethod === 'bank_transfer') {
        await new Payment({
          type, partyId, partyModel, partyName: party.fullName,
          amount: parsedAmount, paymentMethod,
          notes: description || '', paymentDate: entryDate, invoiceId: null
        }).save();
      } else if (paymentMethod === 'check') {
        const newCheck4 = await new Check({
          checkNumber: chequeNumber || '-', bankName: bankName || '-',
          amount: parsedAmount, type: 'received', partyId, partyModel,
          partyName: party.fullName, receivedDate: chequeReceivedDate || Date.now(),
          maturityDate: chequeDueDate || Date.now(), status: 'pending',
          notes: description || '', ledgerId: entry._id
        }).save();
        CNS.notifyAdded(newCheck4).catch(e => console.error('[WA]', e.message));
      }
    }

    req.flash('success_msg', 'تم تسجيل الحركة بنجاح');
    res.redirect(`/admin/statement/${type}/${partyId}`);
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحفظ: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

// =============================================
// إدارة الشيكات
// =============================================
router.post('/checks/clear/:id', isAdmin, async (req, res) => {
  try {
    const { clearDate } = req.body;
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }
    // السماح بالصرف حتى لو كان الشيك محوّلاً لتاجر (المرجع يبقى الزبون)
    if (check.status !== 'pending' && check.status !== 'transferred_to_dealer') {
      req.flash('error_msg', 'هذا الشيك تمت معالجته مسبقاً'); return res.redirect('/admin/checks');
    }
    const wasTransferred = check.status === 'transferred_to_dealer';
    check.status = 'cleared';
    check.clearDate = clearDate ? new Date(clearDate) : new Date();
    await check.save();

    // إذا كان محوّلاً لتاجر: تحديث قيد كشف التاجر ليعكس أن الشيك انصرف فعلاً
    if (wasTransferred && check.transferLedgerId) {
      await Ledger.findByIdAndUpdate(check.transferLedgerId, {
        chequeStatus: 'cleared',
        description: `سند صرف - تحويل شيك رقم ${check.checkNumber} من الزبون ${check.partyName} (تم صرف الشيك)`
      });
    }

    // إشعار WhatsApp للزبون دائماً — مرجع الشيك هو الزبون حتى لو كان محوّلاً لتاجر
    CNS.notifyCleared(check).catch(e => console.error('[WA]', e.message));
    req.flash('success_msg', `تم تسجيل صرف الشيك رقم ${check.checkNumber} بنجاح${wasTransferred ? ' — الشيك كان محوّلاً للتاجر ' + check.transferredToDealerName : ''}`);
    res.redirect('/admin/checks');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/checks');
  }
});

router.post('/checks/delete/:id', isAdmin, async (req, res) => {
  try {
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }

    let invoiceIdToRecalc = null;

    // 1) حذف قيد كشف الحساب المرتبط بالشيك (يظهر كدفعة/راجع وانصرف)
    if (check.ledgerId) {
      const ledgerEntry = await Ledger.findById(check.ledgerId);
      if (ledgerEntry) {
        invoiceIdToRecalc = ledgerEntry.invoiceId || null;
        await Ledger.findByIdAndDelete(check.ledgerId);
      }
    }

    // 2) حذف أي قيد "شيك راجع/مرتجع" تم إنشاؤه عند تسجيل رجوع الشيك
    if (check.status === 'returned') {
      await Ledger.deleteOne({
        partyId: check.partyId,
        partyModel: check.partyModel,
        type: 'debit',
        refNo: check.checkNumber,
        description: new RegExp('^شيك راجع/مرتجع')
      });
    }

    // 3) حذف السند المرتبط (إن وجد) لتحديث سجل المدفوعات في الفاتورة
    if (check.paymentId) {
      const pay = await Payment.findById(check.paymentId);
      if (pay) {
        invoiceIdToRecalc = invoiceIdToRecalc || pay.invoiceId;
        await Payment.findByIdAndDelete(pay._id);
      }
    }

    // 3ب) إذا كان الشيك محوّلاً لتاجر: التراجع عن سند الصرف وقيد الكشف الخاص بالتاجر وإعادة رصيده
    if (check.status === 'transferred_to_dealer' && check.transferredToDealerId) {
      if (check.transferLedgerId) await Ledger.findByIdAndDelete(check.transferLedgerId);
      if (check.transferPaymentId) await Payment.findByIdAndDelete(check.transferPaymentId);
      const dealer = await Dealer.findById(check.transferredToDealerId);
      if (dealer) {
        dealer.balance = (dealer.balance || 0) + check.amount;
        await dealer.save();
      }
    }

    // إشعار WhatsApp قبل الحذف
    CNS.notifyCancelled(check).catch(e => console.error('[WA]', e.message));
    // 4) حذف الشيك نفسه
    await Check.findByIdAndDelete(check._id);

    // 5) إعادة حساب الفاتورة المرتبطة (المبلغ المدفوع والحالة)
    if (invoiceIdToRecalc) await recalcInvoicePaid(invoiceIdToRecalc);

    req.flash('success_msg', `تم حذف الشيك رقم ${check.checkNumber} وتحديث الفاتورة وكشف الحساب بنجاح`);
    res.redirect('/admin/checks');
  } catch (err) {
    req.flash('error_msg', 'خطأ في حذف الشيك: ' + err.message);
    res.redirect('/admin/checks');
  }
});

router.post('/checks/bounce/:id', isAdmin, async (req, res) => {
  try {
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }
    // السماح بالإرجاع حتى لو كان الشيك محوّلاً لتاجر (المرجع يبقى الزبون)
    if (check.status !== 'pending' && check.status !== 'transferred_to_dealer') {
      req.flash('error_msg', 'هذا الشيك تمت معالجته مسبقاً'); return res.redirect('/admin/checks');
    }
    const wasTransferred = check.status === 'transferred_to_dealer';
    check.status = 'returned';
    await check.save();

    // إشعار WhatsApp للزبون دائماً — المرجع هو الزبون حتى لو كان الشيك محوّلاً لتاجر
    CNS.notifyReturned(check).catch(e => console.error('[WA]', e.message));

    // إيجاد الفاتورة المرتبطة بهذا الشيك (إن وُجدت) عبر السند أو قيد الكشف الأصلي
    let linkedInvoiceId = null;
    if (check.paymentId) {
      const linkedPay = await Payment.findById(check.paymentId);
      if (linkedPay) linkedInvoiceId = linkedPay.invoiceId || null;
    }
    if (!linkedInvoiceId && check.ledgerId) {
      const linkedLedger = await Ledger.findById(check.ledgerId);
      if (linkedLedger) linkedInvoiceId = linkedLedger.invoiceId || null;
    }

    // قيد مدين على الزبون: الشيك المرتجع يجعله مديناً بقيمته
    await new Ledger({
      partyId: check.partyId, partyModel: check.partyModel, partyName: check.partyName,
      type: 'debit',
      description: `شيك راجع/مرتجع - رقم ${check.checkNumber} - بنك ${check.bankName}${wasTransferred ? ' (كان محوّلاً للتاجر ' + check.transferredToDealerName + ')' : ''}`,
      amount: check.amount, date: new Date(), refNo: check.checkNumber, paymentMethod: 'other',
      invoiceId: linkedInvoiceId,
      isReversal: !!linkedInvoiceId
    }).save();

    // إذا كان محوّلاً لتاجر: عكس أثر التحويل محاسبياً (قيد مدين على التاجر يعكس الدائن السابق)
    if (wasTransferred && check.transferredToDealerId) {
      await new Ledger({
        partyId: check.transferredToDealerId, partyModel: 'Dealer', partyName: check.transferredToDealerName,
        type: 'debit',
        description: `عكس تحويل شيك مرتجع - رقم ${check.checkNumber} من الزبون ${check.partyName}`,
        amount: check.amount, date: new Date(), refNo: check.checkNumber,
        paymentMethod: 'check', chequeNumber: check.checkNumber, bankName: check.bankName,
        chequeStatus: 'bounced'
      }).save();
      // تحديث قيد كشف التاجر الأصلي ليعكس رجوع الشيك
      if (check.transferLedgerId) {
        await Ledger.findByIdAndUpdate(check.transferLedgerId, {
          chequeStatus: 'bounced',
          description: `سند صرف - تحويل شيك رقم ${check.checkNumber} من الزبون ${check.partyName} (الشيك رجع)`
        });
      }
    }

    // تحديث حالة الفاتورة المرتبطة (إن وُجدت)
    if (linkedInvoiceId) await recalcInvoicePaid(linkedInvoiceId);

    req.flash('success_msg',
      `تم تسجيل رجوع الشيك رقم ${check.checkNumber} وإضافة ${check.amount.toLocaleString('ar-EG')} ₪ مديناً على حساب ${check.partyName}` +
      (wasTransferred ? ` وعكس أثر التحويل للتاجر ${check.transferredToDealerName}` : '') +
      (linkedInvoiceId ? ' وتحديث حالة الفاتورة المرتبطة' : '')
    );
    res.redirect('/admin/checks');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/checks');
  }
});

// تحصيل الشيك المرتجع — عرض صفحة التحصيل
router.get('/checks/collect/:id', isAdmin, async (req, res) => {
  try {
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }
    if (check.status !== 'returned') { req.flash('error_msg', 'يمكن تحصيل الشيكات المرتجعة فقط'); return res.redirect('/admin/checks'); }
    // جلب الشيك البديل إن وُجد
    const replacementCheck = check.replacedByCheckId
      ? await Check.findById(check.replacedByCheckId).lean()
      : null;
    res.render('admin/check-collect', {
      title: `تحصيل الشيك المرتجع رقم ${check.checkNumber}`,
      check, replacementCheck
    });
  } catch (err) {
    req.flash('error_msg', err.message); res.redirect('/admin/checks');
  }
});

// تحصيل الشيك المرتجع — حفظ عملية التحصيل
router.post('/checks/collect/:id', isAdmin, async (req, res) => {
  try {
    const check = await Check.findById(req.params.id);
    if (!check) { req.flash('error_msg', 'الشيك غير موجود'); return res.redirect('/admin/checks'); }
    if (check.status !== 'returned') { req.flash('error_msg', 'يمكن تحصيل الشيكات المرتجعة فقط'); return res.redirect('/admin/checks'); }

    // استخراج مصفوفات دفعات التحصيل
    const methodArr    = [].concat(req.body.methods    || []);
    const amountArr    = [].concat(req.body.amounts    || []);
    const checkNumArr  = [].concat(req.body.checkNumbers  || []);
    const bankNameArr  = [].concat(req.body.bankNames  || []);
    const receivedArr  = [].concat(req.body.receivedDates || []);
    const maturityArr  = [].concat(req.body.maturityDates || []);

    if (methodArr.length === 0) {
      req.flash('error_msg', 'يرجى إضافة دفعة واحدة على الأقل');
      return res.redirect(`/admin/checks/collect/${check._id}`);
    }

    const s = await Setting.findOne() || new Setting();
    const collectionRef = `COL-${check.checkNumber}-${Date.now()}`;
    let newCheckId = null;
    let totalCollected = 0;

    for (let i = 0; i < methodArr.length; i++) {
      const method = methodArr[i];
      const amount = parseFloat(amountArr[i]) || 0;
      if (!method || amount <= 0) continue;
      totalCollected += amount;

      if (method === 'check') {
        // إنشاء شيك جديد مستقل كبديل للشيك المرتجع
        const newCheck = await new Check({
          checkNumber:  checkNumArr[i]  || '-',
          bankName:     bankNameArr[i]  || '-',
          amount,
          type:         'received',
          partyId:      check.partyId,
          partyModel:   check.partyModel,
          partyName:    check.partyName,
          receivedDate: receivedArr[i] ? new Date(receivedArr[i]) : new Date(),
          maturityDate: maturityArr[i] ? new Date(maturityArr[i]) : new Date(),
          status:       'pending',
          notes:        `شيك بديل للشيك المرتجع رقم ${check.checkNumber} (${check.bankName})`,
          replacesReturnedCheckId: check._id,
          collectionRef
        }).save();
        if (!newCheckId) newCheckId = newCheck._id;

        // قيد كشف حساب: شيك بديل دائن — يخفف مديونية الزبون تلقائياً
        await new Ledger({
          partyId: check.partyId, partyModel: check.partyModel, partyName: check.partyName,
          type: 'credit',
          description: `شيك بديل #${newCheck.checkNumber} (${newCheck.bankName}) — بديل الشيك المرتجع #${check.checkNumber}`,
          amount, date: new Date(), paymentMethod: 'check',
          chequeNumber: newCheck.checkNumber, bankName: newCheck.bankName,
          chequeReceivedDate: newCheck.receivedDate, chequeDueDate: newCheck.maturityDate,
          chequeStatus: 'pending', refNo: collectionRef
        }).save();

        CNS.notifyAdded(newCheck).catch(e => console.error('[WA]', e.message));

      } else {
        // نقدي / تحويل بنكي / بطاقة
        const methodLabels = { cash: 'نقدي', bank_transfer: 'تحويل بنكي', card: 'بطاقة' };
        const vNum = await generateVoucherNumber('receipt', s);
        const ledgerEntry = await new Ledger({
          partyId: check.partyId, partyModel: check.partyModel, partyName: check.partyName,
          type: 'credit',
          description: `تحصيل الشيك المرتجع #${check.checkNumber} — ${methodLabels[method] || method}`,
          amount, date: new Date(), paymentMethod: method, refNo: vNum
        }).save();

        await new Payment({
          voucherNumber: vNum, voucherType: 'receipt',
          type: 'customer',
          partyId: check.partyId, partyModel: check.partyModel, partyName: check.partyName,
          amount, currency: s.currency || '₪',
          paymentMethod: method,
          description: `تحصيل الشيك المرتجع #${check.checkNumber} — ${methodLabels[method] || method}`,
          notes: `ضمن عملية تحصيل الشيك المرتجع رقم ${check.checkNumber}`,
          paymentDate: new Date(),
          ledgerId: ledgerEntry._id,
          auditLog: [{ action: 'created', user: 'admin', date: new Date(), note: 'تحصيل شيك مرتجع' }]
        }).save();
      }
    }

    // ربط الشيك المرتجع بالشيك البديل (أول شيك جديد في العملية)
    if (newCheckId) {
      check.replacedByCheckId = newCheckId;
      await check.save();
    }

    req.flash('success_msg',
      `تم تسجيل عملية تحصيل الشيك المرتجع رقم ${check.checkNumber} ` +
      `بمبلغ إجمالي ${totalCollected.toLocaleString('ar-EG')} ₪ بنجاح`
    );
    res.redirect('/admin/checks');
  } catch (err) {
    req.flash('error_msg', 'خطأ في تحصيل الشيك: ' + err.message);
    res.redirect('/admin/checks');
  }
});


// ===================== CATALOG MANAGEMENT =====================
const Catalog = require('../models/Catalog');
const path = require('path');
const fs = require('fs');

router.get('/catalogs', isAdmin, async (req, res) => {
  try {
    const catalogs = await Catalog.find().sort({ createdAt: -1 });
    res.render('admin/catalogs', { title: 'إدارة الكتالوجات', catalogs });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/dashboard'); }
});

router.get('/catalogs/add', isAdmin, (req, res) => {
  res.render('admin/catalog-form', { title: 'إضافة كتالوج', catalog: null });
});

router.post('/catalogs/add', isAdmin, upload.single('cover'), async (req, res) => {
  try {
    const cat = new Catalog({
      name: req.body.name,
      description: req.body.description || '',
      isActive: req.body.isActive === 'on'
    });
    if (req.file) cat.cover = '/uploads/' + req.file.filename;
    await cat.save();
    req.flash('success_msg', 'تم إنشاء الكتالوج بنجاح');
    res.redirect('/admin/catalogs');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/catalogs/add');
  }
});

router.get('/catalogs/edit/:id', isAdmin, async (req, res) => {
  try {
    const catalog = await Catalog.findById(req.params.id);
    if (!catalog) return res.redirect('/admin/catalogs');
    res.render('admin/catalog-form', { title: 'تعديل الكتالوج', catalog });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/catalogs'); }
});

router.post('/catalogs/edit/:id', isAdmin, upload.single('cover'), async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (!cat) return res.redirect('/admin/catalogs');
    cat.name = req.body.name;
    cat.description = req.body.description || '';
    cat.isActive = req.body.isActive === 'on';
    if (req.file) cat.cover = '/uploads/' + req.file.filename;
    await cat.save();
    req.flash('success_msg', 'تم تحديث الكتالوج');
    res.redirect('/admin/catalogs');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/catalogs/edit/' + req.params.id);
  }
});

router.get('/catalogs/toggle/:id', isAdmin, async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (cat) { cat.isActive = !cat.isActive; await cat.save(); }
    res.redirect('/admin/catalogs');
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/catalogs'); }
});

router.get('/catalogs/delete/:id', isAdmin, async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (cat) {
      cat.images.forEach(img => {
        const fp = path.join(__dirname, '..', 'public', img.url.replace(/^\//, ''));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
      if (cat.cover) {
        const fp = path.join(__dirname, '..', 'public', cat.cover.replace(/^\//, ''));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      await Catalog.findByIdAndDelete(req.params.id);
    }
    req.flash('success_msg', 'تم حذف الكتالوج');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
  }
  res.redirect('/admin/catalogs');
});

router.get('/catalogs/:id/images', isAdmin, async (req, res) => {
  const catalog = await Catalog.findById(req.params.id);
  if (!catalog) return res.redirect('/admin/catalogs');
  res.render('admin/catalog-images', { title: 'صور الكتالوج: ' + catalog.name, catalog });
});

router.post('/catalogs/:id/images/add', isAdmin, upload.array('images', 100), async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (!cat) return res.status(404).json({ ok: false, error: 'الكتالوج غير موجود' });
    const captions = Array.isArray(req.body.captions) ? req.body.captions : [req.body.captions || ''];
    if (req.files && req.files.length > 0) {
      req.files.forEach((file, i) => {
        cat.images.push({ url: '/uploads/' + file.filename, caption: captions[i] || '' });
      });
      await cat.save();
    }
    res.json({ ok: true, count: req.files ? req.files.length : 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/catalogs/:id/images/delete/:imgId', isAdmin, async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (!cat) return res.redirect('/admin/catalogs');
    const img = cat.images.id(req.params.imgId);
    if (img) {
      const fp = path.join(__dirname, '..', 'public', img.url.replace(/^\//, ''));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      img.deleteOne();
      await cat.save();
    }
    req.flash('success_msg', 'تم حذف الصورة');
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
  }
  res.redirect('/admin/catalogs/' + req.params.id + '/images');
});

router.post('/catalogs/:id/images/caption/:imgId', isAdmin, async (req, res) => {
  try {
    const cat = await Catalog.findById(req.params.id);
    if (cat) {
      const img = cat.images.id(req.params.imgId);
      if (img) { img.caption = req.body.caption || ''; await cat.save(); }
    }
  } catch(e) {}
  res.redirect('/admin/catalogs/' + req.params.id + '/images');
});

// ====== VISITS ======
router.get('/customers/:customerId/visits', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    if (!customer) { req.flash('error_msg', 'الزبون غير موجود'); return res.redirect('/admin/customers'); }
    const visits = await Visit.find({ customerId: customer._id }).sort({ visitNumber: -1 });
    res.render('admin/visits-list', { title: 'زيارات ' + customer.fullName, customer, visits });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});

router.get('/customers/:customerId/visits/new', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    if (!customer) { req.flash('error_msg', 'الزبون غير موجود'); return res.redirect('/admin/customers'); }
    res.render('admin/visit-form', { title: 'زيارة جديدة', customer, visit: null, isNew: true });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});

router.post('/customers/:customerId/visits', isAdmin, async (req, res) => {
  try {
    const { sofas, qaadas, qaadaCanvasData, rooms, windows, windowsCanvasData, generalNotes, visitDate } = req.body;
    
    let processedSofas = sofas || [];
    if (Array.isArray(processedSofas)) {
      processedSofas = processedSofas.map(s => ({
        ...s,
        price: Number(s.price) || 0
      }));
    }
    
    let processedQaadas = qaadas || [];
    if (Array.isArray(processedQaadas)) {
      processedQaadas = processedQaadas.map(q => ({
        ...q,
        pricePerMeter: Number(q.pricePerMeter) || 0
      }));
    }
    
    let processedRooms = rooms || [];
    if (Array.isArray(processedRooms)) {
      processedRooms = processedRooms.map(r => ({
        ...r,
        pricePerMeter: Number(r.pricePerMeter) || 0,
        area: (Number(r.length) || 0) * (Number(r.width) || 0)
      }));
    }
    
    let processedWindows = windows || [];
    if (Array.isArray(processedWindows)) {
      processedWindows = processedWindows.map(w => ({
        ...w,
        count: Number(w.count) || 1,
        total: (Number(w.width) || 0) * (Number(w.count) || 1),
        pricePerMeter: Number(w.pricePerMeter) || 0
      }));
    }
    
    const v = new Visit({
      customerId: req.params.customerId,
      sofas: processedSofas, 
      qaadas: processedQaadas,
      qaadaCanvasData: qaadaCanvasData || '',
      rooms: processedRooms, 
      windows: processedWindows,
      windowsCanvasData: windowsCanvasData || '',
      generalNotes: generalNotes || '',
      visitDate: visitDate ? new Date(visitDate) : new Date()
    });
    await v.save();
    res.json({ ok: true, visitId: v._id, visitNumber: v.visitNumber });
  } catch(err) { 
    console.error('Create error:', err);
    res.json({ ok: false, error: err.message }); 
  }
});

router.get('/customers/:customerId/visits/:visitId', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    const visit = await Visit.findById(req.params.visitId);
    if (!customer || !visit) { req.flash('error_msg', 'البيانات غير موجودة'); return res.redirect('/admin/customers'); }
    res.render('admin/visit-view', { title: 'زيارة #' + visit.visitNumber, customer, visit });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});

router.get('/customers/:customerId/visits/:visitId/edit', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    const visit = await Visit.findById(req.params.visitId);
    if (!customer || !visit) { req.flash('error_msg', 'البيانات غير موجودة'); return res.redirect('/admin/customers'); }
    res.render('admin/visit-form', { title: 'تعديل زيارة #' + visit.visitNumber, customer, visit, isNew: false });
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers'); }
});

router.post('/customers/:customerId/visits/:visitId/update', isAdmin, async (req, res) => {
  try {
    const { sofas, qaadas, qaadaCanvasData, rooms, windows, windowsCanvasData, generalNotes, visitDate } = req.body;
    const v = await Visit.findById(req.params.visitId);
    if (!v) return res.json({ ok: false, error: 'الزيارة غير موجودة' });
    
    let processedSofas = sofas;
    if (sofas && Array.isArray(sofas)) {
      processedSofas = sofas.map(s => ({
        ...s,
        price: Number(s.price) || 0
      }));
    }
    
    let processedQaadas = qaadas;
    if (qaadas && Array.isArray(qaadas)) {
      processedQaadas = qaadas.map(q => ({
        ...q,
        pricePerMeter: Number(q.pricePerMeter) || 0
      }));
    }
    
    let processedRooms = rooms;
    if (rooms && Array.isArray(rooms)) {
      processedRooms = rooms.map(r => ({
        ...r,
        pricePerMeter: Number(r.pricePerMeter) || 0,
        area: (Number(r.length) || 0) * (Number(r.width) || 0)
      }));
    }
    
    let processedWindows = windows;
    if (windows && Array.isArray(windows)) {
      processedWindows = windows.map(w => ({
        ...w,
        count: Number(w.count) || 1,
        total: (Number(w.width) || 0) * (Number(w.count) || 1),
        pricePerMeter: Number(w.pricePerMeter) || 0
      }));
    }
    
    if (processedSofas)  v.sofas  = processedSofas;
    if (processedQaadas) v.qaadas = processedQaadas;
    if (qaadaCanvasData  !== undefined) v.qaadaCanvasData   = qaadaCanvasData;
    if (processedRooms)  v.rooms  = processedRooms;
    if (processedWindows) v.windows = processedWindows;
    if (windowsCanvasData !== undefined) v.windowsCanvasData = windowsCanvasData;
    if (generalNotes !== undefined) v.generalNotes = generalNotes;
    if (visitDate) v.visitDate = new Date(visitDate);
    await v.save();
    res.json({ ok: true });
  } catch(err) { 
    console.error('Save error:', err);
    res.json({ ok: false, error: err.message }); 
  }
});

router.post('/customers/:customerId/visits/:visitId/delete', isAdmin, async (req, res) => {
  try {
    await Visit.findByIdAndDelete(req.params.visitId);
    req.flash('success_msg', 'تم حذف الزيارة');
    res.redirect('/admin/customers/' + req.params.customerId + '/visits');
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers/' + req.params.customerId + '/visits'); }
});

router.post('/customers/:customerId/visits/:visitId/copy', isAdmin, async (req, res) => {
  try {
    const src = await Visit.findById(req.params.visitId).lean();
    if (!src) { req.flash('error_msg', 'الزيارة غير موجودة'); return res.redirect('/admin/customers/' + req.params.customerId + '/visits'); }
    delete src._id; delete src.__v; delete src.createdAt; delete src.updatedAt; delete src.visitNumber;
    src.visitDate = new Date();
    src.photos = [];
    const newV = new Visit(src);
    await newV.save();
    req.flash('success_msg', 'تم نسخ الزيارة → زيارة رقم ' + newV.visitNumber);
    res.redirect('/admin/customers/' + req.params.customerId + '/visits/' + newV._id + '/edit');
  } catch(err) { req.flash('error_msg', err.message); res.redirect('/admin/customers/' + req.params.customerId + '/visits'); }
});

router.get('/customers/:customerId/visits/:visitId/print', isAdmin, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    const visit = await Visit.findById(req.params.visitId);
    const settings = await Setting.findOne() || {};
    if (!customer || !visit) return res.status(404).send('غير موجود');
    res.render('admin/visit-print', { customer, visit, settings, layout: false });
  } catch(err) { res.status(500).send(err.message); }
});

router.post('/visits/upload-photo/:visitId', isAdmin, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'لم يتم رفع الصورة' });
    const v = await Visit.findById(req.params.visitId);
    if (!v) return res.json({ ok: false, error: 'الزيارة غير موجودة' });
    const url = '/uploads/' + req.file.filename;
    v.photos.push({ url, caption: req.body.caption || '' });
    await v.save();
    res.json({ ok: true, url, index: v.photos.length - 1 });
  } catch(err) { res.json({ ok: false, error: err.message }); }
});

router.post('/visits/delete-photo/:visitId', isAdmin, async (req, res) => {
  try {
    const v = await Visit.findById(req.params.visitId);
    if (!v) return res.json({ ok: false });
    v.photos.splice(Number(req.body.index), 1);
    await v.save();
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, error: err.message }); }
});

router.post('/visits/upload-style/:visitId/:type/:index', isAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'لم يتم رفع الصورة' });
    const url = '/uploads/' + req.file.filename;
    const v = await Visit.findById(req.params.visitId);
    if (!v) return res.json({ ok: true, url });
    const idx = Number(req.params.index);
    if (req.params.type === 'sofa' && v.sofas[idx]) { v.sofas[idx].styleImage = url; await v.save(); }
    if (req.params.type === 'qaada' && v.qaadas[idx]) { v.qaadas[idx].styleImage = url; await v.save(); }
    res.json({ ok: true, url });
  } catch(err) { res.json({ ok: false, error: err.message }); }
});

router.post('/visits/upload-curtain/:visitId/:index', isAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'لم يتم رفع الصورة' });
    const url = '/uploads/' + req.file.filename;
    const v = await Visit.findById(req.params.visitId);
    if (v) {
      const idx = Number(req.params.index);
      if (v.windows[idx]) { v.windows[idx].curtainTypeImage = url; await v.save(); }
    }
    res.json({ ok: true, url });
  } catch(err) { res.json({ ok: false, error: err.message }); }
});

// =================================================================
// ==================== مبيعات المعرض (Sales) =====================
// =================================================================

async function generateSaleNumber() {
  const last = await Sale.findOne().sort({ createdAt: -1 }).select('saleNumber');
  let next = 1;
  if (last && last.saleNumber) {
    const m = last.saleNumber.match(/(\d+)$/);
    if (m) next = parseInt(m[1]) + 1;
  }
  for (let i = 0; i < 5; i++) {
    const candidate = 'SL-' + String(next + i).padStart(6, '0');
    const exists = await Sale.findOne({ saleNumber: candidate }).select('_id');
    if (!exists) return candidate;
  }
  return 'SL-' + Date.now().toString().slice(-6);
}

// قائمة المبيعات
router.get('/sales', isAdmin, async (req, res) => {
  try {
    const sales = await Sale.find().sort({ createdAt: -1 });
    const totalSales     = sales.reduce((s, x) => s + x.totalAmount, 0);
    const totalPaid      = sales.reduce((s, x) => s + x.paidAmount, 0);
    const totalRemaining = sales.reduce((s, x) => s + x.remainingBalance, 0);
    res.render('admin/sales', { title: 'مبيعات المعرض', sales, totalSales, totalPaid, totalRemaining });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/dashboard');
  }
});

// نموذج إضافة مبيعة
router.get('/sales/add', isAdmin, async (req, res) => {
  res.render('admin/sale-form', { title: 'مبيعة جديدة', sale: null });
});

// حفظ مبيعة جديدة
router.post('/sales/add', isAdmin, async (req, res) => {
  try {
    const { customerName, customerPhone, saleDate, discount, notes, totalAmount, subtotal,
            payEnabled, payMethod, payAmount, payDate, payNotes,
            checkNumber, checkBankName, checkDueDate, checkStatus,
            saveCustomer } = req.body;

    const items = JSON.parse(req.body.items || '[]');
    if (items.length === 0) { req.flash('error_msg', 'أضف صنفاً واحداً على الأقل'); return res.redirect('/admin/sales/add'); }

    const saleNum = await generateSaleNumber();
    const cName   = (customerName || '').trim() || 'زبون نقدي';

    // حفظ الزبون في النظام إذا طلب
    let savedCustomerId = null;
    if (saveCustomer === 'on' && cName && cName !== 'زبون نقدي' && cName !== 'زبون زائر') {
      const existing = await Customer.findOne({ fullName: cName });
      if (existing) {
        savedCustomerId = existing._id;
      } else {
        const newCust = await new Customer({ fullName: cName, phone: customerPhone || '' }).save();
        savedCustomerId = newCust._id;
      }
    }

    const sale = new Sale({
      saleNumber: saleNum,
      customerName: cName,
      customerPhone: customerPhone || '',
      savedCustomerId,
      items,
      subtotal: parseFloat(subtotal) || 0,
      discount: parseFloat(discount) || 0,
      totalAmount: parseFloat(totalAmount) || 0,
      notes: notes || '',
      saleDate: saleDate ? new Date(saleDate) : new Date()
    });

    // إضافة دفعة إن وُجدت
    if (payEnabled === 'on' && payAmount && parseFloat(payAmount) > 0) {
      const pMethod = payMethod || 'cash';
      const payEntry = {
        amount: parseFloat(payAmount),
        method: pMethod,
        date: payDate ? new Date(payDate) : new Date(),
        notes: payNotes || '',
        bankName: pMethod === 'bank_transfer' ? (checkBankName || '') : '',
        checkNumber: pMethod === 'check' ? (checkNumber || '') : '',
        checkDueDate: pMethod === 'check' && checkDueDate ? new Date(checkDueDate) : null,
        checkStatus: pMethod === 'check' ? (checkStatus || 'pending') : 'pending'
      };
      sale.payments.push(payEntry);
    }

    await sale.save();
    req.flash('success_msg', `تم حفظ المبيعة ${saleNum} بنجاح`);
    res.redirect('/admin/sales/view/' + sale._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في حفظ المبيعة: ' + err.message);
    res.redirect('/admin/sales/add');
  }
});

// عرض مبيعة
router.get('/sales/view/:id', isAdmin, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) { req.flash('error_msg', 'المبيعة غير موجودة'); return res.redirect('/admin/sales'); }
    const settings = await Setting.findOne() || {};
    res.render('admin/sale-view', { title: 'مبيعة ' + sale.saleNumber, sale, settings });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/sales');
  }
});

// طباعة مبيعة
router.get('/sales/print/:id', isAdmin, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) return res.status(404).send('المبيعة غير موجودة');
    const settings = await Setting.findOne() || {};
    res.render('admin/sale-print', { title: 'طباعة ' + sale.saleNumber, sale, settings });
  } catch (err) {
    res.status(500).send('خطأ: ' + err.message);
  }
});

// نموذج تعديل مبيعة
router.get('/sales/edit/:id', isAdmin, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) { req.flash('error_msg', 'المبيعة غير موجودة'); return res.redirect('/admin/sales'); }
    res.render('admin/sale-form', { title: 'تعديل مبيعة ' + sale.saleNumber, sale });
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/sales');
  }
});

// حفظ تعديل مبيعة
router.post('/sales/edit/:id', isAdmin, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) { req.flash('error_msg', 'المبيعة غير موجودة'); return res.redirect('/admin/sales'); }

    const { customerName, customerPhone, saleDate, discount, notes, totalAmount, subtotal,
            payEnabled, payMethod, payAmount, payDate, payNotes,
            checkNumber, checkBankName, checkDueDate, checkStatus,
            saveCustomer } = req.body;

    const items = JSON.parse(req.body.items || '[]');
    if (items.length === 0) {
      req.flash('error_msg', 'أضف صنفاً واحداً على الأقل');
      return res.redirect('/admin/sales/edit/' + req.params.id);
    }

    const cName = (customerName || '').trim() || 'زبون نقدي';
    sale.customerName  = cName;
    sale.customerPhone = customerPhone || '';
    sale.items         = items;
    sale.subtotal      = parseFloat(subtotal) || 0;
    sale.discount      = parseFloat(discount) || 0;
    sale.totalAmount   = parseFloat(totalAmount) || 0;
    sale.notes         = notes || '';
    sale.saleDate      = saleDate ? new Date(saleDate) : sale.saleDate;

    // حفظ الزبون إذا طلب
    if (saveCustomer === 'on' && cName && cName !== 'زبون نقدي' && cName !== 'زبون زائر' && !sale.savedCustomerId) {
      const existing = await Customer.findOne({ fullName: cName });
      sale.savedCustomerId = existing ? existing._id : (await new Customer({ fullName: cName, phone: customerPhone || '' }).save())._id;
    }

    // إضافة دفعة جديدة
    if (payEnabled === 'on' && payAmount && parseFloat(payAmount) > 0) {
      const pMethod = payMethod || 'cash';
      sale.payments.push({
        amount: parseFloat(payAmount),
        method: pMethod,
        date: payDate ? new Date(payDate) : new Date(),
        notes: payNotes || '',
        bankName: pMethod === 'bank_transfer' ? (checkBankName || '') : '',
        checkNumber: pMethod === 'check' ? (checkNumber || '') : '',
        checkDueDate: pMethod === 'check' && checkDueDate ? new Date(checkDueDate) : null,
        checkStatus: pMethod === 'check' ? (checkStatus || 'pending') : 'pending'
      });
    }

    await sale.save();
    req.flash('success_msg', 'تم تعديل المبيعة بنجاح');
    res.redirect('/admin/sales/view/' + sale._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ في التعديل: ' + err.message);
    res.redirect('/admin/sales/edit/' + req.params.id);
  }
});

// حذف دفعة من مبيعة
router.post('/sales/payment/delete/:saleId/:paymentId', isAdmin, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.saleId);
    if (!sale) { req.flash('error_msg', 'المبيعة غير موجودة'); return res.redirect('/admin/sales'); }
    sale.payments = sale.payments.filter(p => p._id.toString() !== req.params.paymentId);
    await sale.save();
    req.flash('success_msg', 'تم حذف الدفعة بنجاح');
    res.redirect('/admin/sales/edit/' + sale._id);
  } catch (err) {
    req.flash('error_msg', 'خطأ: ' + err.message);
    res.redirect('/admin/sales');
  }
});

// حذف مبيعة
router.post('/sales/delete/:id', isAdmin, async (req, res) => {
  try {
    await Sale.findByIdAndDelete(req.params.id);
    req.flash('success_msg', 'تم حذف المبيعة بنجاح');
    res.redirect('/admin/sales');
  } catch (err) {
    req.flash('error_msg', 'خطأ في الحذف: ' + err.message);
    res.redirect('/admin/sales');
  }
});

module.exports = router;