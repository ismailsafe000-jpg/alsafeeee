const express = require('express');
const router = express.Router();
const Catalog = require('../models/Catalog');

router.get('/', async (req, res) => {
  try {
    const catalogs = await Catalog.find({ isActive: true }).sort({ createdAt: -1 });
    res.render('catalog/index', { title: 'كتالوجات المعرض', catalogs });
  } catch (err) {
    res.render('catalog/index', { title: 'كتالوجات المعرض', catalogs: [] });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const catalog = await Catalog.findOne({ _id: req.params.id, isActive: true });
    if (!catalog) return res.redirect('/catalog');
    res.render('catalog/gallery', { title: catalog.name, catalog });
  } catch (err) {
    res.redirect('/catalog');
  }
});

module.exports = router;
