const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  invoiceNumber: { type: String, required: true },
  partyName: { type: String, required: true },
  invoiceDate: { type: Date, required: true },
  items: [{
    description: String,
    quantityType: { type: String, enum: ['piece','meter','sqmeter'], default: 'piece' },
    length: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    itemProfit: { type: Number, default: 0 }
  }],
  totalSale: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  netProfit: { type: Number, default: 0 },
  profitMargin: { type: Number, default: 0 },
  notes: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

schema.pre('save', function(next) {
  let totalSale = 0;
  let totalCost = 0;
  this.items.forEach(it => {
    const qty = Number(it.quantity) || 0;
    const unitCost = Number(it.unitCost) || 0;
    const total = Number(it.total) || 0;
    it.totalCost = qty * unitCost;
    it.itemProfit = total - it.totalCost;
    totalSale += total;
    totalCost += it.totalCost;
  });
  this.totalSale = totalSale;
  this.totalCost = totalCost;
  this.netProfit = totalSale - totalCost;
  this.profitMargin = totalSale > 0 ? (this.netProfit / totalSale) * 100 : 0;
  this.updatedAt = Date.now();
  next();
});

schema.index({ invoiceId: 1 });
schema.index({ invoiceNumber: 1 });
schema.index({ partyName: 'text' });
schema.index({ createdAt: -1 });
schema.index({ invoiceDate: -1 });

module.exports = mongoose.model('Profit', schema);
