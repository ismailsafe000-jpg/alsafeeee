const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  address: String,
  email: String,
  company: String,
  notes: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

schema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

// ─── Performance indexes ──────────────────────────────────────────────────────
schema.index({ fullName: 1 });
schema.index({ phone: 1 });
schema.index({ isActive: 1 });
schema.index({ createdAt: -1 });

module.exports = mongoose.model('Dealer', schema);
