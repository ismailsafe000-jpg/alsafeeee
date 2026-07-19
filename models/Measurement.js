const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  name:        { type: String, default: '' },
  length:      { type: Number, default: 0 },
  width:       { type: Number, default: 0 },
  area:        { type: Number, default: 0 },
  carpetType:  { type: String, default: '' },
  color:       { type: String, default: '' }
});

const windowSchema = new mongoose.Schema({
  location:          { type: String, default: '' },
  width:             { type: Number, default: 0 },
  height:            { type: Number, default: 0 },
  curtainTypeName:   { type: String, default: '' },
  curtainTypeImage:  { type: String, default: '' },
  fabricType:        { type: String, default: '' },
  color:             { type: String, default: '' },
  openings:          { type: Number, default: 1 },
  notes:             { type: String, default: '' }
});

const sofaSchema = new mongoose.Schema({
  sofaType:     { type: String, default: '' },
  seats:        { type: Number, default: 0 },
  foamType:     { type: String, default: '' },
  fabricType:   { type: String, default: '' },
  color:        { type: String, default: '' },
  legType:      { type: String, default: '' },
  cushionCount: { type: Number, default: 0 },
  styleImage:   { type: String, default: '' },
  notes:        { type: String, default: '' }
});

const measurementSchema = new mongoose.Schema({
  customerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
  measurementDate:{ type: Date, default: Date.now },
  sofa:           { type: sofaSchema, default: () => ({}) },
  qaada:          { type: sofaSchema, default: () => ({}) },
  rooms:          [roomSchema],
  windows:        [windowSchema],
  canvasData:     { type: String, default: '' },
  photos:         [{ url: String, caption: { type: String, default: '' } }],
  generalNotes:   { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Measurement', measurementSchema);
