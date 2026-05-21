# Add E-Commerce Service Type & API JSON Sync

The goal is to implement a new `ecommerce` service type (brain) to handle complex product search inquiries, incorporate thumbnail display capabilities in the chatbot widget, adapt the ordering flow for e-commerce nuances, and provide an API JSON sync option for managing catalog items.

## User Review Required

> [!IMPORTANT]
> - The new "E-Commerce" brain will be added as `src/brains/ecommerce.js`.
> - The chat widget (`widget.js`) will be modified to render images if a `thumbnail` property is passed in the response payload.
> - The ordering flow (`orderFlow.js`) will be updated to make the delivery address optional and hide/ignore quantity adjustments if they are not needed for e-commerce.
> - A new API endpoint for JSON catalog synchronization will be added to the dashboard and portal backends, and a "Sync via API / JSON" button will be added to the UI.

## Open Questions

> [!WARNING]
> - Do you want the JSON API Sync to accept raw JSON text input in a text area, or do you want a file upload feature in the dashboard UI? (The plan assumes providing a textarea / input to paste JSON for now).
> - For the address being optional in the order flow, we'll add a "Skip Address" button during the `awaiting_address` phase. Is that acceptable?
> - For the thumbnail rendering in chat, the image will appear inside the chat bubble above the text description. Is that the desired layout?

## Proposed Changes

### Core Chatbot Brain

#### [NEW] [ecommerce.js](file:///c:/Users/pc/ai-chatbot/src/brains/ecommerce.js)
Create the new e-commerce brain.
- Define `serviceType = 'ecommerce'`.
- Implement dialect-friendly Arabic patterns (including 'هلا', 'شلونك', etc.).
- Add intents for:
  - `ecommerce_search_hot` (hot selling)
  - `ecommerce_category_info`
  - `ecommerce_product_advantages`
  - `ecommerce_check_availability`
  - `ecommerce_country_info`
  - `ecommerce_country_products`
  - `ecommerce_inquire_feature` (color, material, dimensions, etc.)
- Map all extra JSON keys into the `metadata` object of `service_items`.
- In `buildResponse`, attach `thumbnail` URL to the response payload if it exists in the item's metadata.

#### [MODIFY] [index.js](file:///c:/Users/pc/ai-chatbot/src/brains/index.js)
- Register the new `ecommerce` brain.

### Conversational & Order Flow Engine

#### [MODIFY] [orderFlow.js](file:///c:/Users/pc/ai-chatbot/src/engine/orderFlow.js)
- Add logic to make the delivery address step skippable if `business.service_type === 'ecommerce'`.
- Add a "Skip Address" button when in the `awaiting_address` phase.

#### [MODIFY] [message.js](file:///c:/Users/pc/ai-chatbot/src/routes/api/message.js)
- Update payload response mapping to pass `thumbnail` down to the client widget.

### Widget UI (Client)

#### [MODIFY] [widget.js](file:///c:/Users/pc/ai-chatbot/widget.js)
- Update `appendMessage` and `renderMessageEntry` to accept and render an image (thumbnail) element above or next to the text bubble if `thumbnail` is provided in the message payload.
- Adjust the dashboard order cart UI to optionally hide quantity controls for e-commerce.

### Backend API (Dashboard & Portal Sync)

#### [MODIFY] [sync.js](file:///c:/Users/pc/ai-chatbot/src/routes/api/sync.js)
- Add a `POST /json` endpoint to handle bulk importing catalog items from a raw JSON payload directly into the database.

#### [MODIFY] [catalog.js](file:///c:/Users/pc/ai-chatbot/src/routes/dashboard/catalog.js)
- Add `POST /:businessId/sync/json` to handle JSON sync for the admin dashboard.

#### [MODIFY] [portal.js](file:///c:/Users/pc/ai-chatbot/src/routes/portal.js)
- Add `POST /catalog/sync/json` to handle JSON sync for the tenant portal.

### Dashboard & Portal UI (HTML/JS)

#### [MODIFY] [dashboard/index.html](file:///c:/Users/pc/ai-chatbot/dashboard/index.html)
- Add "E-Commerce" to the Service Type dropdowns.
- Add a "Sync JSON" button in the catalog section and a modal to paste JSON array data.

#### [MODIFY] [portal/index.html](file:///c:/Users/pc/ai-chatbot/portal/index.html)
- Add "E-Commerce" to the Service Type dropdown.
- Add a "Sync JSON" button in the catalog section and a modal to paste JSON array data.

#### [MODIFY] dashboard/js/app.js & portal/js/app.js
- (Assuming these handle the frontend logic) Add event listeners for the "Sync JSON" buttons, sending the pasted JSON payload to the respective API endpoints.

## Verification Plan

### Automated Tests
- Test endpoints `POST /api/sync/json`, `POST /dashboard/catalog/:id/sync/json`, and `POST /portal/api/catalog/sync/json`.

### Manual Verification
- Start the server (`npm start`).
- Create an "E-Commerce" business via the dashboard.
- Sync JSON catalog items.
- Open the widget and ask "what is the hot selling products in category X in country Y".
- Verify the bot responds with the matched product and displays its thumbnail image in the chat.
- Start an order and verify that the address step can be bypassed.
