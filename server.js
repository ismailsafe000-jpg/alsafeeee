const app = require('./app');
const mongoose = require('mongoose');
const { startAutoBackup } = require('./routes/backup');
const WhatsAppService = require('./services/WhatsAppService');
const WhatsAppBot = require('./services/WhatsAppBot');  // ← أضف هذا السطر
const CheckNotificationService  = require('./services/CheckNotificationService');
const ManagerReportService      = require('./services/ManagerReportService');
require('dotenv').config();

const PORT       = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

mongoose.connect(MONGODB_URI, { maxPoolSize: 50 })
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Saffi ERP running on port ${PORT}`);
      startAutoBackup();
      WhatsAppService.start();
      WhatsAppBot.startBot().catch(e => console.error('[WA-Bot] خطأ:', e.message));  // ← أضف هذا السطر
      CheckNotificationService.setupCron().catch(err => console.error('[WA-Cron] خطأ:', err.message));
      ManagerReportService.setupWeeklyCron().catch(err => console.error('[ManagerReport] خطأ في الإعداد:', err.message));
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
