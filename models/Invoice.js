const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  type: { type: String, enum: ['customer','dealer'], required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, refPath: 'partyModel', required: true },
  partyModel: { type: String, enum: ['Customer','Dealer'], required: true },
  partyName: String,
  items: [{
    description: String,
    quantityType: { type: String, enum: ['piece','meter','sqmeter'], default: 'piece' },
    length: { type: Number, default: 0 },
    width:  { type: Number, default: 0 },
    quantity: Number,
    unitPrice: Number,
    total: Number
  }],
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  paidAmount: { type: Number, default: 0 },
  remainingBalance: { type: Number, default: 0 },
  status: { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  notes: String,
  invoiceDate: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

schema.pre('save', function(next) {
  this.remainingBalance = this.totalAmount - this.paidAmount;
  this.status = this.remainingBalance <= 0 ? 'paid' : this.paidAmount > 0 ? 'partial' : 'unpaid';
  this.updatedAt = Date.now();
  next();
});

// ─── Performance indexes ──────────────────────────────────────────────────────
schema.index({ partyId: 1, type: 1 });
schema.index({ status: 1 });
schema.index({ invoiceDate: -1 });
schema.index({ createdAt: -1 });
schema.index({ partyName: 'text' });

module.exports = mongoose.model('Invoice', schema);
