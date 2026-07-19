/**
 * clear-wa-session.js
 * يحذف كل جلسات WhatsApp من MongoDB
 * شغّله مرة واحدة ثم أعد تشغيل السيرفر
 *
 * الاستخدام:
 *   node clear-wa-session.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI غير موجود في ملف .env');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ متصل بـ MongoDB');

  // حذف جلسات WhatsApp (Baileys auth)
  const waResult = await mongoose.connection.db
    .collection('wasessions')
    .deleteMany({});
  console.log(`🗑️  حُذفت ${waResult.deletedCount} وثيقة من wasessions`);

  // حذف قفل WhatsApp (إذا كنت تستخدم النسخة المُصلحة)
  try {
    const lockResult = await mongoose.connection.db
      .collection('walocks')
      .deleteMany({});
    console.log(`🔓 حُذف القفل: ${lockResult.deletedCount} وثيقة`);
  } catch (_) {}

  console.log('');
  console.log('✅ انتهى — الآن أعد تشغيل السيرفر وامسح QR جديد من التطبيق');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
