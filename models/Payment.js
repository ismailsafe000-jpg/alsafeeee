const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: { type: String },
  user: { type: String, default: 'admin' },
  date: { type: Date, default: Date.now },
  note: { type: String, default: '' }
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  voucherNumber: { type: String, default: '' },
  voucherType:   { type: String, enum: ['receipt', 'payment'], default: 'receipt' },
  type: { type: String, enum: ['customer', 'dealer'], required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, refPath: 'partyModel', required: true },
  partyModel: { type: String, enum: ['Customer', 'Dealer'], required: true },
  partyName: { type: String, required: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: '₪' },
  paymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'check', 'card'], required: true },
  paymentDate: { type: Date, default: Date.now },
  description: { type: String, default: '' },
  notes: { type: String, default: '' },
  chequeNumber: { type: String, default: '' },
  bankName: { type: String, default: '' },
  chequeReceivedDate: { type: Date, default: null },
  chequeDueDate: { type: Date, default: null },
  chequeStatus: { type: String, enum: ['pending', 'cleared', 'bounced'], default: 'pending' },
  employeeName: { type: String, default: '' },
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
  ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ledger', default: null },
  auditLog: { type: [auditLogSchema], default: [] },
  // batchId: يجمع عدة سندات أُنشئت معاً من شاشة "دفعات متعددة" في عملية واحدة
  batchId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

paymentSchema.index({ batchId: 1 });

// ─── Performance indexes ──────────────────────────────────────────────────────
paymentSchema.index({ partyId: 1, type: 1 });
paymentSchema.index({ paymentDate: -1 });
paymentSchema.index({ voucherNumber: 1 });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ status: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
