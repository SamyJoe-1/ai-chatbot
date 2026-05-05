import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const repoRoot = 'C:/Users/pc/ai-chatbot';
const csvPath = path.join(repoRoot, 'drive', 'sample-cafe', 'menu-sheet-template.csv');
const xlsxPath = path.join(repoRoot, 'drive', 'sample-cafe', 'menu-sheet-template.xlsx');

const csvText = await fs.readFile(csvPath, 'utf8');
const workbook = await Workbook.fromCSV(csvText, { sheetName: 'Menu' });
const sheet = workbook.worksheets.getItem('Menu');

sheet.freezePanes.freezeRows(1);
sheet.getRange('A1:J1').format = {
  fill: '#17443a',
  font: { bold: true, color: '#FFFFFF' },
  wrapText: true,
};

sheet.getRange('A:A').format.columnWidthPx = 150;
sheet.getRange('B:B').format.columnWidthPx = 150;
sheet.getRange('C:C').format.columnWidthPx = 140;
sheet.getRange('D:D').format.columnWidthPx = 140;
sheet.getRange('E:E').format.columnWidthPx = 220;
sheet.getRange('F:F').format.columnWidthPx = 220;
sheet.getRange('G:G').format.columnWidthPx = 90;
sheet.getRange('H:H').format.columnWidthPx = 80;
sheet.getRange('I:I').format.columnWidthPx = 180;
sheet.getRange('J:J').format.columnWidthPx = 90;
sheet.getRange('G2:G500').format.numberFormat = '0.00';

const usedRange = sheet.getUsedRange();
usedRange.format.autofitRows();

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(xlsxPath);

console.log(`Created ${xlsxPath}`);
