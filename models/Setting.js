const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  // ===== إعدادات المعرض الأساسية =====
  storeName:            { type: String, default: 'معرض الصافي للمفروشات' },
  storePhone:           String,
  storeWhatsapp:        String,
  storeAddress:         String,
  storeLogo:            { type: String, default: '/images/default-logo.png' },
  storeEmail:           { type: String, default: '' },
  footerText:           { type: String, default: '' },
  // حقول جديدة لبيانات المعرض
  storeCity:            { type: String, default: '' },
  storeCountry:         { type: String, default: '' },
  storeMobile:          { type: String, default: '' },
  storeWebsite:         { type: String, default: '' },
  storeTaxNumber:       { type: String, default: '' },
  storeCommercialReg:   { type: String, default: '' },
  storeLicenseNumber:   { type: String, default: '' },

  // ===== إعدادات عامة =====
  catalogPricesMode:    { type: Boolean, default: true },
  enableCustomerPortal: { type: Boolean, default: true },
  enableDealerPortal:   { type: Boolean, default: true },
  customerPortalName:   { type: String, default: 'بوابة الزبائن' },
  dealerPortalName:     { type: String, default: 'بوابة التجار' },
  systemTitle:          { type: String, default: 'نظام إدارة متكامل وعصري' },
  currency:             { type: String, default: '₪' },
  invoicePrefix:        { type: String, default: 'INV' },
  adminPassword:        { type: String, default: '' },
  primaryColor:         { type: String, default: '#4F46E5' },
  sidebarColor:         { type: String, default: '#1E1B4B' },
  fontFamily:           { type: String, default: 'Cairo' },
  defaultTheme:         { type: String, enum: ['light','dark'], default: 'light' },
  showLogoInInvoice:    { type: Boolean, default: true },
  showAddressInInvoice: { type: Boolean, default: true },
  showPhoneInInvoice:   { type: Boolean, default: true },

  // إعدادات بوابة الزبائن
  customerShowStatement: { type: Boolean, default: true },
  customerShowInvoices:  { type: Boolean, default: true },
  customerShowVisits:    { type: Boolean, default: true },
  // إعدادات بوابة التجار
  dealerShowStatement:  { type: Boolean, default: true },
  dealerShowInvoices:   { type: Boolean, default: true },

  // ===== إعدادات سندات القبض والصرف =====

  // الترقيم
  rcPrefix:             { type: String, default: 'RC' },
  pvPrefix:             { type: String, default: 'PV' },
  voucherDigits:        { type: Number, default: 6 },
  rcStartNumber:        { type: Number, default: 1 },
  pvStartNumber:        { type: Number, default: 1 },
  resetVoucherYearly:   { type: Boolean, default: false },

  // حجم الطباعة
  voucherPaperSize:     { type: String, enum: ['A4','A5','R80','R58'], default: 'A4' },

  // إعدادات إظهار / إخفاء عناصر السند
  voucherShowLogo:              { type: Boolean, default: true },
  voucherShowStoreName:         { type: Boolean, default: true },
  voucherShowAddress:           { type: Boolean, default: true },
  voucherShowPhone:             { type: Boolean, default: true },
  voucherShowMobile:            { type: Boolean, default: true },
  voucherShowEmail:             { type: Boolean, default: false },
  voucherShowWebsite:           { type: Boolean, default: false },
  voucherShowCommercialReg:     { type: Boolean, default: false },
  voucherShowTaxNumber:         { type: Boolean, default: false },
  voucherShowVoucherNumber:     { type: Boolean, default: true },
  voucherShowDate:              { type: Boolean, default: true },
  voucherShowTime:              { type: Boolean, default: true },
  voucherShowEmployee:          { type: Boolean, default: true },
  voucherShowPaymentMethod:     { type: Boolean, default: true },
  voucherShowBank:              { type: Boolean, default: true },
  voucherShowChequeNumber:      { type: Boolean, default: true },
  voucherShowInvoiceRef:        { type: Boolean, default: true },
  voucherShowDescription:       { type: Boolean, default: true },
  voucherShowNotes:             { type: Boolean, default: true },
  voucherShowQR:                { type: Boolean, default: false },
  voucherShowBarcode:           { type: Boolean, default: false },
  voucherShowStamp:             { type: Boolean, default: false },
  voucherShowReceiverSignature: { type: Boolean, default: true },
  voucherShowClientSignature:   { type: Boolean, default: true },
  voucherShowAccountantSignature:{ type: Boolean, default: false },
  voucherShowBalanceBefore:     { type: Boolean, default: false },
  voucherShowBalanceAfter:      { type: Boolean, default: true },
  voucherShowAmountInWords:     { type: Boolean, default: true },

  // تخصيص الألوان
  voucherHeaderColor:   { type: String, default: '#1e293b' },
  voucherTextColor:     { type: String, default: '#1e293b' },
  voucherTableColor:    { type: String, default: '#f8f9fa' },
  voucherFooterColor:   { type: String, default: '#f1f5f9' },
  voucherBorderColor:   { type: String, default: '#dee2e6' },

  // تخصيص الخطوط
  voucherFont:          { type: String, default: 'Cairo' },
  voucherFontSize:      { type: Number, default: 12 },
  voucherTitleSize:     { type: Number, default: 18 },
  voucherLogoSize:      { type: Number, default: 70 },

  // نصوص السند
  voucherHeaderText:    { type: String, default: '' },
  voucherFooterText:    { type: String, default: 'شكراً لتعاملكم مع معرض الصافي للمفروشات' },

  // ===== النسخ الاحتياطي =====
  backupEnabled:        { type: Boolean, default: false },
  backupDay:            { type: String,  default: 'sunday' },
  backupTime:           { type: String,  default: '02:00' },
  backupKeepCount:      { type: Number,  default: 5 },

  // ===== التكامل =====
  whatsappApiKey:       { type: String, default: '' },
  emailHost:            { type: String, default: '' },
  emailPort:            { type: Number, default: 587 },
  emailUser:            { type: String, default: '' },
  emailFromName:        { type: String, default: '' },
  telegramBotToken:     { type: String, default: '' },
  telegramChatId:       { type: String, default: '' },
  googleMapsApiKey:     { type: String, default: '' },
  smsApiKey:            { type: String, default: '' },
  smsProvider:          { type: String, default: '' },

  // ===== إعدادات الطباعة لكل مستند =====
  invoicePrintSize:     { type: String, enum: ['A4','A5','Thermal'], default: 'A4' },
  receiptPrintSize:     { type: String, enum: ['A4','A5','R80','R58'], default: 'A4' },
  paymentPrintSize:     { type: String, enum: ['A4','A5','R80','R58'], default: 'A4' },
  statementPrintSize:   { type: String, enum: ['A4','A5'], default: 'A4' },
  salePrintSize:        { type: String, enum: ['A4','A5'], default: 'A4' },
  visitPrintSize:       { type: String, enum: ['A4','A5'], default: 'A4' },
  printFontSize:        { type: Number, default: 12 },
  printMarginTop:       { type: Number, default: 15 },
  printMarginSide:      { type: Number, default: 15 },
  printLogoSize:        { type: Number, default: 70 },
  printShowSignature:   { type: Boolean, default: true },
  printShowStamp:       { type: Boolean, default: false },
  printDataPosition:    { type: String, enum: ['right','left','center'], default: 'right' },

  // ===== إعدادات إشعارات WhatsApp =====
  waNotificationsEnabled:  { type: Boolean, default: false },
  // الشيكات
  waAddedEnabled:          { type: Boolean, default: true  },
  waClearedEnabled:        { type: Boolean, default: true  },
  waReturnedEnabled:       { type: Boolean, default: true  },
  waCancelledEnabled:      { type: Boolean, default: true  },
  waEditEnabled:           { type: Boolean, default: false },
  waReminderEnabled:       { type: Boolean, default: true  },
  waReminderDays:          { type: Number,  default: 5     },
  // الفواتير والمدفوعات
  waInvoiceNewEnabled:     { type: Boolean, default: true  },
  waInvoicePaidEnabled:    { type: Boolean, default: true  },
  waPaymentReceivedEnabled:{ type: Boolean, default: true  },
  waStatementEntryEnabled: { type: Boolean, default: true  },
  waBotEnabled:              { type: Boolean, default: true  },
  waManagerJid:              { type: String,  default: ''    },
  // عام
  waManagerPhone:          { type: String,  default: ''    },
  waAccountantPhone:       { type: String,  default: ''    },
  waCronTime:              { type: String,  default: '09:00' },
  // تقارير الحسابات الأسبوعية للمدير
  waWeeklyReportEnabled:   { type: Boolean, default: false  },
  waWeeklyReportDay:       { type: String,  default: '6'    },   // 0=أحد … 6=سبت
  waWeeklyReportTime:      { type: String,  default: '08:00' },

  // ===== حقول إضافية للإعدادات (صورة الخلفية، أسعار المنتجات، عرض/إخفاء الأقسام) =====
  adminBg:              { type: String,  default: '' },
  adminBgOpacity:       { type: Number,  default: 15 },
  adminBgBlur:          { type: Number,  default: 0  },

  curtainPricePerMeter: { type: Number,  default: 0 },
  carpetPricePerMeter:  { type: Number,  default: 0 },
  qaadaPricePerMeter:   { type: Number,  default: 0 },
  sofaDefaultPrice:     { type: Number,  default: 0 },

  showSofas:            { type: Boolean, default: true },
  showQaadas:           { type: Boolean, default: true },
  showRooms:            { type: Boolean, default: true },
  showWindows:          { type: Boolean, default: true },
  showPhotos:           { type: Boolean, default: true },
  showNotes:            { type: Boolean, default: true },
  showSignatures:       { type: Boolean, default: true },
  showCarpetTotal:      { type: Boolean, default: true },
  showCurtainTotal:     { type: Boolean, default: true },
  showCurtainCount:     { type: Boolean, default: true },
  showCurtainDetails:   { type: Boolean, default: true },
  showPrices:           { type: Boolean, default: true },
  compactPrint:         { type: Boolean, default: false },
  printMargin:          { type: String,  default: '6' },

  // ===== إعدادات النظام =====
  maintenanceMode:      { type: Boolean, default: false },
  maintenanceMessage:   { type: String,  default: 'النظام تحت الصيانة، يرجى المحاولة لاحقاً' },
  systemVersion:        { type: String,  default: '2.0.0' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
schema.pre('save', function(next){ this.updatedAt = Date.now(); next(); });
module.exports = mongoose.model('Setting', schema);
