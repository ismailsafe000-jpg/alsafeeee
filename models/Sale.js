const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  amount:       { type: Number, required: true },
  method:       { type: String, enum: ['cash','bank_transfer','check','card'], default: 'cash' },
  date:         { type: Date, default: Date.now },
  notes:        { type: String, default: '' },
  bankName:     { type: String, default: '' },
  checkNumber:  { type: String, default: '' },
  checkDueDate: { type: Date },
  checkStatus:  { type: String, enum: ['pending','cleared','returned'], default: 'pending' }
}, { _id: true });

const itemSchema = new mongoose.Schema({
  description:  { type: String, required: true },
  quantityType: { type: String, enum: ['piece','meter','sqmeter'], default: 'piece' },
  length:       { type: Number, default: 0 },
  width:        { type: Number, default: 0 },
  quantity:     { type: Number, default: 1 },
  unitPrice:    { type: Number, default: 0 },
  discount:     { type: Number, default: 0 },
  total:        { type: Number, default: 0 },
  fromSystem:   { type: Boolean, default: false }
}, { _id: true });

const saleSchema = new mongoose.Schema({
  saleNumber:       { type: String, unique: true },
  customerName:     { type: String, default: 'زبون نقدي' },
  customerPhone:    { type: String, default: '' },
  savedCustomerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  items:            [itemSchema],
  subtotal:         { type: Number, default: 0 },
  discount:         { type: Number, default: 0 },
  totalAmount:      { type: Number, default: 0 },
  paidAmount:       { type: Number, default: 0 },
  remainingBalance: { type: Number, default: 0 },
  status:           { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  notes:            { type: String, default: '' },
  saleDate:         { type: Date, default: Date.now },
  payments:         [paymentSchema],
  createdAt:        { type: Date, default: Date.now },
  updatedAt:        { type: Date, default: Date.now }
});

saleSchema.pre('save', function(next) {
  this.paidAmount       = (this.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  this.remainingBalance = Math.max(0, this.totalAmount - this.paidAmount);
  this.status = this.remainingBalance <= 0 ? 'paid'
              : this.paidAmount > 0        ? 'partial'
              :                              'unpaid';
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Sale', saleSchema);
