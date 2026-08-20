const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  partyName:   { type: String, default: '' },
  partyPhone:  { type: String, default: '' },
  checkNumber: { type: String, default: '' },
  checkId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null },
  messageType: {
    type: String,
    enum: [
      // إشعارات الشيكات
      'check_added', 'check_cleared', 'check_returned', 'check_cancelled', 'check_edited', 'check_transferred',
      // إشعارات الفواتير
      'invoice_new', 'invoice_paid',
      // إشعارات المدفوعات
      'payment_received', 'payment_batch',
      // إشعارات كشف الحساب
      'statement_entry',
      // التذكيرات والتقارير
      'daily_reminders', 'daily_report', 'reminder_7d', 'reminder_3d', 'reminder_1d', 'reminder_due',
      // اختبار
      'test'
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
