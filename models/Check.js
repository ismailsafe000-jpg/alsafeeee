const mongoose = require('mongoose');

const checkSchema = new mongoose.Schema({
  checkNumber: { type: String, required: true, trim: true },
  bankName: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0 },
  type: { type: String, enum: ['received', 'issued'], required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, refPath: 'partyModel', required: true },
  partyModel: { type: String, enum: ['Customer', 'Dealer'], required: true },
  partyName: String,
  receivedDate: { type: Date, default: Date.now },
  maturityDate: { type: Date, required: true },
  clearDate: { type: Date, default: null },
  status: { type: String, enum: ['pending', 'cleared', 'returned', 'transferred_to_dealer'], default: 'pending' },
  notes: String,
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ledger', default: null },
  // عند تحويل شيك زبون لتاجر: يبقى نفس الشيك (لا يُنشأ شيك جديد)، فقط تتغيّر حالته وتُسجَّل بيانات التحويل هنا
  transferredToDealerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', default: null },
  transferredToDealerName: { type: String, default: '' },
  transferDate:            { type: Date, default: null },
  transferVoucherNumber:   { type: String, default: '' },
  transferPaymentId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  transferLedgerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Ledger', default: null },
  // تحصيل الشيك المرتجع: ربط الشيك المرتجع بالشيك البديل أو بعملية التحصيل
  replacedByCheckId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null },         // معرّف الشيك البديل الذي أنشئ لتحصيل هذا الشيك المرتجع
  replacesReturnedCheckId: { type: mongoose.Schema.Types.ObjectId, ref: 'Check', default: null },         // هذا الشيك هو بديل للشيك المرتجع صاحب هذا المعرّف
  collectionRef:           { type: String, default: '' },                                                  // رقم مرجع عملية التحصيل (يجمع كل دفعات نفس عملية التحصيل)
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Check', checkSchema);
