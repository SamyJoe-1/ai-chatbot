# Drive Folder Sample

This folder is a sample of how I recommend organizing each cafe if you want to use Google Drive and Google Sheets with this project.

## Recommended structure

Each cafe can have its own folder like this:

```text
drive/
  sample-cafe/
    brand-profile.json
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
- Google Sheet ID
- Drive folder ID

Use the Google Sheet sync for:

- menu item names
- menu categories
- descriptions
- prices
- currency
- sizes
- availability

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
