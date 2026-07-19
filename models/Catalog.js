const mongoose = require('mongoose');

const catalogSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  cover: { type: String, default: '' },
  images: [{
    url: { type: String, required: true },
    caption: { type: String, default: '' }
  }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Catalog', catalogSchema);
