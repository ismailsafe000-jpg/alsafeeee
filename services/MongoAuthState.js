'use strict';
/**
 * useMongoAuthState — حفظ جلسة Baileys في MongoDB
 * بديل عن useMultiFileAuthState (الملفات) لضمان بقاء الجلسة بعد restart
 */

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');

const _schema = new mongoose.Schema(
  { _id: String, data: String },
  { versionKey: false }
);

// تجنب إعادة تعريف الموديل عند hot-reload
const WaSession = mongoose.models.WaSession || mongoose.model('WaSession', _schema);

async function useMongoAuthState() {
  // ─── قراءة قيمة من قاعدة البيانات ──────────────────────────────────────────
  const read = async (id) => {
    try {
      const doc = await WaSession.findById(id).lean();
      return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    } catch (_) { return null; }
  };

  // ─── كتابة قيمة ─────────────────────────────────────────────────────────────
  const write = async (id, value) => {
    try {
      const data = JSON.stringify(value, BufferJSON.replacer);
      await WaSession.findByIdAndUpdate(id, { data }, { upsert: true });
    } catch (e) {
      console.error('[WaSession] خطأ في الكتابة:', e.message);
    }
  };

  // ─── حذف قيمة ───────────────────────────────────────────────────────────────
  const del = async (id) => {
    try { await WaSession.deleteOne({ _id: id }); } catch (_) {}
  };

  // ─── تحميل بيانات الاعتماد الحالية ──────────────────────────────────────────
  const savedCreds = await read('creds');

  const state = {
    creds: savedCreds || initAuthCreds(),
    keys: {
      get: async (type, ids) => {
        const result = {};
        await Promise.all(ids.map(async (id) => {
          let val = await read(`${type}-${id}`);
          if (type === 'app-state-sync-key' && val) {
            val = proto.Message.AppStateSyncKeyData.fromObject(val);
          }
          result[id] = val;
        }));
        return result;
      },
      set: async (data) => {
        const tasks = [];
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const val = data[category][id];
            const key  = `${category}-${id}`;
            tasks.push(val ? write(key, val) : del(key));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: () => write('creds', state.creds),
  };
}

module.exports = { useMongoAuthState };
