const mongoose = require('mongoose');

const sofaItemSchema = new mongoose.Schema({
  sofaType:     { type: String, default: '' },
  seats:        { type: Number, default: 0 },
  foamType:     { type: String, default: '' },
  fabricType:   { type: String, default: '' },
  color:        { type: String, default: '' },
  legType:      { type: String, default: '' },
  cushionCount: { type: Number, default: 0 },
  styleImage:   { type: String, default: '' },
  notes:        { type: String, default: '' },
  price:        { type: Number, default: 0 }  // ✅ إضافة سعر الكنبة
}, { _id: true });

const qaadaItemSchema = new mongoose.Schema({
  qaadaType:      { type: String, default: '' },
  foamType:       { type: String, default: '' },
  fabricType:     { type: String, default: '' },
  color:          { type: String, default: '' },
  legType:        { type: String, default: '' },
  distance:       { type: Number, default: 0 },
  styleImage:     { type: String, default: '' },
  notes:          { type: String, default: '' },
  pricePerMeter:  { type: Number, default: 0 }  // ✅ إضافة سعر متر القعدة
}, { _id: true });

const roomSchema = new mongoose.Schema({
  name:           { type: String, default: '' },
  length:         { type: Number, default: 0 },
  width:          { type: Number, default: 0 },
  area:           { type: Number, default: 0 },
  carpetType:     { type: String, default: '' },
  color:          { type: String, default: '' },
  pricePerMeter:  { type: Number, default: 0 }  // ✅ إضافة سعر المتر المربع للموكيت
}, { _id: true });

const windowSchema = new mongoose.Schema({
  location:         { type: String, default: '' },
  width:            { type: Number, default: 0 },
  height:           { type: Number, default: 0 },
  count:            { type: Number, default: 1 },
  total:            { type: Number, default: 0 },
  curtainTypeName:  { type: String, default: '' },
  curtainTypeImage: { type: String, default: '' },
  fabricType:       { type: String, default: '' },
  color:            { type: String, default: '' },
  // openings:       { type: Number, default: 1 },  // ❌ تم إزالة هذا الحقل
  notes:            { type: String, default: '' },
  pricePerMeter:    { type: Number, default: 0 }  // ✅ إضافة سعر متر البرادي
}, { _id: true });

const visitSchema = new mongoose.Schema({
  customerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  visitNumber:       { type: Number, default: 1 },
  visitDate:         { type: Date, default: Date.now },
  sofas:             [sofaItemSchema],
  qaadas:            [qaadaItemSchema],
  qaadaCanvasData:   { type: String, default: '' },
  rooms:             [roomSchema],
  windows:           [windowSchema],
  windowsCanvasData: { type: String, default: '' },
  photos:            [{ url: String, caption: { type: String, default: '' } }],
  generalNotes:      { type: String, default: '' }
}, { timestamps: true });

visitSchema.pre('save', async function () {
  if (this.isNew) {
    const last = await this.constructor.findOne({ customerId: this.customerId }).sort({ visitNumber: -1 });
    this.visitNumber = last ? (last.visitNumber || 0) + 1 : 1;
  }
});

module.exports = mongoose.model('Visit', visitSchema);