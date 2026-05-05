# Drive Folder Sample

This folder is a sample of how I recommend organizing each cafe if you want to use Google Drive and Google Sheets with this project.

## Recommended structure

Each cafe can have its own folder like this:

```text
drive/
  sample-cafe/
    brand-profile.json
    menu-sheet-template.xlsx
    menu-sheet-template.csv
    menu-public-link.txt
    notes-for-owner.md
```

## What goes where

Use the dashboard for:

- brand name
- Arabic brand name
- phone
- email
- colors
- logo URL
- about text
- address
- working hours
- welcome messages
- suggestion chips
- active / paused status
- Google Sheet ID or full Google Sheets link
- Drive folder ID

Use the Google Sheet sync for:

- menu item names
- menu categories
- descriptions
- prices
- currency
- sizes
- availability

## Use the right sample file

For Google Sheets sync, use `menu-sheet-template.xlsx`.

Recommended flow:

1. Upload [menu-sheet-template.xlsx](/C:/Users/pc/ai-chatbot/drive/sample-cafe/menu-sheet-template.xlsx) to Google Drive.
2. Open it with Google Sheets.
3. Share that Google Sheet with the service account email as `Viewer`.
4. Copy the Google Sheet URL from the browser.
5. Paste that URL into the dashboard field `Google Sheet ID or link`.

`menu-sheet-template.csv` is only a raw data template. It is not a live Google Sheet by itself.

## Important behavior

If you click `Sync from sheet` in the dashboard, the app replaces the current menu items in the database with the rows from the sheet.

That means:

- manual menu editing works
- sheet sync also works
- if you sync, the sheet becomes the latest source for menu items

So the simplest real workflow is:

1. Put branding and cafe info in the dashboard.
2. Let the cafe owner maintain only the menu sheet.
3. Click `Sync from sheet` whenever you want to refresh the menu.

## Credentials note

The sample `drive/` folder does not include Google API credentials.

Sync can work in two ways:

- If the sheet is public or anyone-with-link readable, you can paste the sheet ID or full sheet URL in the dashboard and sync without a service account file.
- If the sheet is private, add `google-service-account.json` at the project root, or point `GOOGLE_SERVICE_ACCOUNT_PATH` to the JSON file in `.env`.
