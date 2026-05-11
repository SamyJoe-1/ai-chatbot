# Notes For Owner

## What this sample is

This folder is a real-estate sample mapped to your current app schema for `service_type = real_estate`.

It uses:

1. `business-profile.json` for the dashboard/business settings shape
2. `properties-sheet-template.csv` for the Google Sheet import shape

## Sheet tab name

Use the sheet tab name:

`Properties`

That matches `src/brains/realEstate.js`.

## Exact CSV headers used

- `title_en`
- `title_ar`
- `category_en`
- `category_ar`
- `description_en`
- `description_ar`
- `price`
- `currency`
- `location`
- `district`
- `compound`
- `bedrooms`
- `bathrooms`
- `area_sqm`
- `listing_type`
- `available`

## Important fit issue

Your current real-estate importer is shaped more like a listings table than a developer-project portfolio.

That means this Pyramids sample maps **one project per row**.

That fits the schema cleanly enough for demos and testing, but these rows are not unit-level inventory.

Fields like:

- `bedrooms`
- `bathrooms`
- `price`

were left blank when Pyramids did not publicly publish reliable project-level values on the official pages I used.

## Another fit issue

`area_sqm` is only filled when the official page gave a value already in square meters.

I did **not** convert every acreage-style figure because some Pyramids pages and third-party pages appear to mix `acres` and `feddan`, and forcing conversions there would risk fake precision.

## Colors

The official public pages I checked expose the brand visually but do not publish clear brand hex codes in the text output I could verify.

So:

- `primary_color`
- `secondary_color`

in `business-profile.json` are best-effort approximations for dashboard preview only, not verified official brand codes.

## Address

I left the address empty because the official Pyramids Developments pages I used clearly exposed phone, email, and working hours, but not a clean head-office street address in the same verified source set.

## Official source pages used

- Company overview and full official project list:
  `https://site.pyramidsdevelopments.com/about/`
- Projects index:
  `https://site.pyramidsdevelopments.com/projects/`
- New Capital projects index:
  `https://site.pyramidsdevelopments.com/new-capital/`
- Contact and customer service:
  `https://site.pyramidsdevelopments.com/contact/`
  `https://site.pyramidsdevelopments.com/customerservice/`
- Individual project pages:
  `https://site.pyramidsdevelopments.com/la-capitale/`
  `https://site.pyramidsdevelopments.com/grand-square/`
  `https://site.pyramidsdevelopments.com/champs-elysees/`
  `https://site.pyramidsdevelopments.com/paris-mall/`
  `https://site.pyramidsdevelopments.com/paris-east-mall/`
  `https://site.pyramidsdevelopments.com/la-capitale-suite-lagoons/`
  `https://site.pyramidsdevelopments.com/pyramids-mall/`
  `https://site.pyramidsdevelopments.com/pyramids-business-tower/`
  `https://site.pyramidsdevelopments.com/pyramidscity/`
  `https://site.pyramidsdevelopments.com/sky-city/`

## Recommended next step if you want a stronger real-estate model

If you want real estate to behave properly beyond a demo, split the catalog into either:

1. `projects`
2. `units/listings`

Right now the chatbot brain can work with this sample, but project portfolios and unit inventory are being forced into one table.
