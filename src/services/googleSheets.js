'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

let authInstance = null;

function normalizeSheetId(sheetIdOrUrl) {
  const value = String(sheetIdOrUrl || '').trim();
  if (!value) {
    return '';
  }

  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    return match[1];
  }

  return value;
}

function resolveServiceAccountPath() {
  const configuredPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
    : null;

  const candidates = [
    configuredPath,
    path.resolve('./google-service-account.json'),
    path.resolve('./drive/google-service-account.json'),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getAuth() {
  const keyPath = resolveServiceAccountPath();
  if (!keyPath) {
    return null;
  }

  if (authInstance) {
    return authInstance;
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

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function mapRowsToItems(rows) {
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

function toA1SheetName(sheetName) {
  const value = String(sheetName || '').trim();
  if (!value) {
    return "'Menu'";
  }

  return `'${value.replace(/'/g, "''")}'`;
}

async function resolveAccessibleSheetName(sheets, spreadsheetId, requestedSheetName) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });

  const titles = (metadata.data.sheets || [])
    .map((sheet) => sheet?.properties?.title)
    .filter(Boolean);

  if (!titles.length) {
    throw new Error('This spreadsheet has no visible sheets.');
  }

  const requested = String(requestedSheetName || '').trim();
  if (!requested) {
    return titles[0];
  }

  const exactMatch = titles.find((title) => title === requested);
  if (exactMatch) {
    return exactMatch;
  }

  const caseInsensitiveMatch = titles.find((title) => title.toLowerCase() === requested.toLowerCase());
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  return titles[0];
}

async function readPublicMenuFromSheet(sheetId, sheetName) {
  const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  exportUrl.searchParams.set('tqx', 'out:csv');
  exportUrl.searchParams.set('sheet', sheetName);

  const response = await fetch(exportUrl);
  if (!response.ok) {
    throw new Error(`Google Sheets public export returned ${response.status}. Make the sheet public or add a service account file.`);
  }

  const csv = await response.text();
  const rows = csv
    .split(/\r?\n/)
    .filter((line) => line.trim().length)
    .map(parseCsvLine);

  return mapRowsToItems(rows);
}

async function readMenuFromSheet(sheetId, sheetName = 'Menu') {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) {
    throw new Error('Google Sheet ID or link is missing.');
  }

  const auth = getAuth();
  if (auth) {
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const resolvedSheetName = await resolveAccessibleSheetName(sheets, normalizedSheetId, sheetName);
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: normalizedSheetId,
        range: `${toA1SheetName(resolvedSheetName)}!A1:J500`,
      });

      return mapRowsToItems(response.data.values || []);
    } catch (error) {
      throw new Error(`Google Sheets API sync failed for sheet ID "${normalizedSheetId}". ${getReadableGoogleError(error)}`);
    }
  }

  try {
    return await readPublicMenuFromSheet(normalizedSheetId, sheetName);
  } catch (error) {
    throw new Error(`Public sheet sync failed. Make sure the tab name is correct and the sheet is shared for link access. ${getReadableGoogleError(error)}`);
  }
}

function getReadableGoogleError(error) {
  const message = error?.response?.data?.error?.message
    || error?.response?.data?.error_description
    || error?.response?.data?.message
    || error?.message
    || 'Unknown Google API error.';

  if (message.includes('must not be an Office file')) {
    return 'The selected file is still an Office .xlsx file in Google Drive, not a native Google Sheet. Open it in Google Sheets and use "File -> Save as Google Sheets", then paste the NEW Google Sheet URL or ID from the new file.';
  }

  return message;
}

module.exports = { readMenuFromSheet };
