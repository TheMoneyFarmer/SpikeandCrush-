'use strict';

// This admin's own preferences (report date range etc.). Every admin role,
// support agents included, may read and write only their own.
const express = require('express');
const prefs = require('../lib/adminPrefs');

function router() {
  const r = express.Router();
  r.get('/', async (req, res) => res.json(await prefs.get(req.admin)));
  r.put('/', async (req, res) => {
    try {
      res.json(await prefs.set(req.admin, req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return r;
}

module.exports = router;
