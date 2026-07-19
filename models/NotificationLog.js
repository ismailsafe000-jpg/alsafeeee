const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  partyName:   { type: String, default: '' },
  partyPhone:  { type: String, default: '' },
  checkNumber: { type: String, default: '' },
  checkId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null },
  messageType: {
    type: String,
    enum: [
      'added', 'cleared', 'returned', 'cancelled', 'edited', 'reminder', 'test', 'bulk', 'daily_report',
      'invoice_new', 'invoice_new_mgr',
      'invoice_paid', 'invoice_paid_mgr',
      'payment_received', 'payment_received_mgr',
      'statement_entry', 'statement_entry_mgr'
    ],
    required: true
  },
  messageText: { type: String, default: '' },
  sentAt:      { type: Date, default: Date.now },
  status:      { type: String, enum: ['SUCCESS', 'FAILED'], default: 'SUCCESS' },
  failReason:  { type: String, default: '' },
  retries:     { type: Number, default: 0 },
  sentBy:      { type: String, default: 'system' }
});

schema.index({ sentAt: -1 });
schema.index({ checkId: 1 });
schema.index({ status: 1 });

module.exports = mongoose.model('NotificationLog', schema);
