const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  startTime:      { type: Date, default: Date.now },
  endTime:        { type: Date, default: null },
  checksScanned:  { type: Number, default: 0 },
  messagesSent:   { type: Number, default: 0 },
  messagesFailed: { type: Number, default: 0 },
  lastError:      { type: String, default: '' }
});

schema.index({ startTime: -1 });

module.exports = mongoose.model('CronHistory', schema);
