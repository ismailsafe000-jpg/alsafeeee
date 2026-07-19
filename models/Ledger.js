const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
  partyId: { type: mongoose.Schema.Types.ObjectId, refPath: 'partyModel', required: true },
  partyModel: { type: String, enum: ['Customer', 'Dealer'], required: true },
  partyName: { type: String, required: true },
  type: { type: String, enum: ['debit', 'credit'], required: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, default: Date.now },
  paymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'check', 'card', 'other'], default: 'cash' },
  chequeNumber: { type: String, default: '' },
  bankName: { type: String, default: '' },
  chequeReceivedDate: { type: Date, default: null },
  chequeDueDate: { type: Date, default: null },
  chequeStatus: { type: String, enum: ['pending', 'cleared', 'bounced'], default: 'pending' },
  refNo: { type: String, default: '' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
  itemsDetails: { type: String, default: '' },
  // isReversal: قيد "مدين" يُرجع مبلغاً كان قد احتُسب كمدفوع على فاتورة (مثال: شيك مرتجع)
  // يُستخدم في recalcInvoicePaid ليُطرح من مجموع الدفعات دون التأثير على قيد أصل الفاتورة
  isReversal: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// ─── Performance indexes ──────────────────────────────────────────────────────
ledgerSchema.index({ partyId: 1, partyModel: 1 });
ledgerSchema.index({ date: -1 });
ledgerSchema.index({ invoiceId: 1 });
ledgerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Ledger', ledgerSchema);
