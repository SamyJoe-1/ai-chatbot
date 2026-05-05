# Notes For Owner

## If you want the easiest setup

Only maintain these two things:

1. Dashboard:
   brand info, phone, colors, address, hours, welcome text
2. Google Sheet:
   menu items and prices

## Start from the sample workbook

Use `menu-sheet-template.xlsx` for upload to Google Drive and open that file in Google Sheets.

Do not rely on `menu-sheet-template.csv` alone unless you are importing it into a real Google Sheet first.

## Sheet columns

Your menu sheet should use exactly these headers:

- `name_en`
- `name_ar`
- `category_en`
- `category_ar`
- `description_en`
- `description_ar`
- `price`
- `currency`
- `sizes`
- `available`

## Sizes format

Put sizes in one cell separated by commas.

Example:

`Small,Medium,Large`

## Availability format

Use:

- `1` for available
- `0` for unavailable

## Sync behavior

When the admin clicks `Sync from sheet`, the app imports the sheet rows into the chatbot database and replaces the existing menu items for that cafe.

## Best workflow

- Use manual menu editing only for quick fixes.
- Use sheet sync as the real source if the owner is comfortable with Google Sheets.
- After upload, copy the Google Sheet URL and paste it into the dashboard field `Google Sheet ID or link`.
