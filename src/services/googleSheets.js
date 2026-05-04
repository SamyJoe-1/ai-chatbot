'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

let authInstance = null;

function getAuth() {
  if (authInstance) {
    return authInstance;
  }

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './google-service-account.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Google service account file was not found at ${keyPath}`);
  }

  authInstance = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });

  return authInstance;
}

async function readMenuFromSheet(sheetId, sheetName = 'Menu') {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:J500`,
  });

  const rows = response.data.values || [];
  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map((header) => String(header).trim().toLowerCase().replace(/\s+/g, '_'));
  const items = [];

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || !row[0]) continue;

    const record = {};
    headers.forEach((header, columnIndex) => {
      record[header] = row[columnIndex] ? String(row[columnIndex]).trim() : '';
    });

    const sizes = record.sizes
      ? record.sizes.split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];

    items.push({
      name_en: record.name_en || record.name || '',
      name_ar: record.name_ar || '',
      category_en: record.category_en || record.category || '',
      category_ar: record.category_ar || '',
      description_en: record.description_en || record.description || '',
      description_ar: record.description_ar || '',
      price: record.price ? Number(record.price) : null,
      currency: record.currency || 'EGP',
      sizes: JSON.stringify(sizes),
      available: ['0', 'false', 'no'].includes((record.available || '').toLowerCase()) ? 0 : 1,
    });
  }

  return items;
}

module.exports = { readMenuFromSheet };
