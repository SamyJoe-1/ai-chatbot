# Chatbot E-Glotech

Zero-AI multi-tenant cafe chatbot with:

- embeddable `widget.js`
- Node.js + Express backend
- local SQLite storage through Node 22 built-in `node:sqlite`
- simple dashboard for cafes, menu items, and sessions

## Run

```bash
npm install
npm start
```

Server starts on `http://localhost:3500`.

## Dashboard

Open `http://localhost:3500/dashboard`

Default login:

- username: `admin`
- password: `changeme123`

Change that password after first login.

## Embed

```html
<script src="http://localhost:3500/widget.js?token=YOUR_CAFE_TOKEN"></script>
```

## Optional env

Copy `.env.example` to `.env` only if you want to customize the port, DB path, JWT secret, or Google Sheets sync credentials.

## Google Sheets sync

For the cafe `sheet_id` field in the dashboard, you can now paste either:

- the raw Google Sheet ID
- the full Google Sheets URL

Sync works in either of these modes:

- public sheet: no service account file needed
- private sheet: add `google-service-account.json` in the project root, or set `GOOGLE_SERVICE_ACCOUNT_PATH` in `.env`
