const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Customer = require('../models/Customer');
const Dealer = require('../models/Dealer');
const Setting = require('../models/Setting');

// ─── Login rate limit: 10 attempts / 15 min ──────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    req.flash('error_msg', 'محاولات تسجيل دخول كثيرة جداً. يرجى الانتظار 15 دقيقة.');
    res.redirect('/');
  }
});

router.get('/', (req, res) => {
  res.render('gateway', { title: 'معرض الصافي للمفروشات' });
});

// ─── Unified login ────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    if (!username || !password) {
      req.flash('error_msg', 'يرجى إدخال اسم المستخدم وكلمة المرور');
      return res.redirect('/');
    }

    const s = await Setting.findOne();

    // ── 1. Admin check (supports both plain-text and bcrypt hashes) ──
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
    const savedPwd = (s && s.adminPassword && s.adminPassword.trim() !== '')
      ? s.adminPassword.trim() : null;
    const envPwd = (process.env.ADMIN_PASSWORD || '').trim() || null;
    const storedPwd = savedPwd || envPwd;

    if (username === adminUsername && storedPwd) {
      let passwordMatch = false;
      // Check if stored password is a bcrypt hash
      if (storedPwd.startsWith('$2b$') || storedPwd.startsWith('$2a$')) {
        passwordMatch = await bcrypt.compare(password, storedPwd);
      } else {
        passwordMatch = (password === storedPwd);
      }
      if (passwordMatch) {
        req.session.adminAuth = true;
        return res.redirect('/admin/dashboard');
      }
    }

    // ── 2. Dealer check (name = username, phone = password) ──
    if (!s || s.enableDealerPortal) {
      const d = await Dealer.findOne({
        fullName: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
        phone: password,
        isActive: true
      });
      if (d) {
        req.session.dealerAuth = true;
        req.session.dealerId = d._id;
        return res.redirect('/dealer/');
      }
    }

    // ── 3. Customer check (name = username, phone = password) ──
    if (!s || s.enableCustomerPortal) {
      const c = await Customer.findOne({
        fullName: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
        phone: password,
        isActive: true
      });
      if (c) {
        req.session.customerAuth = true;
        req.session.customerId = c._id;
        return res.redirect('/customer/');
      }
    }

    req.flash('error_msg', 'اسم المستخدم أو كلمة المرور غير صحيحة');
    res.redirect('/');
  } catch (err) {
    req.flash('error_msg', 'حدث خطأ في تسجيل الدخول');
    res.redirect('/');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
