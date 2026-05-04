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
