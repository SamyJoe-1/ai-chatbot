'use strict';

function getItemThumbnail(item) {
  let meta = item.metadata || {};
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  return meta.thumbnail || null;
}

/**
 * Builds a messages array for multi-item responses based on thumbnail availability.
 * Returns null when no thumbnails exist — caller falls back to plain text.
 *
 * Same URL for all items  → [ {text:fullList, thumbnail:sharedUrl} ]  (image + list in one bubble)
 * Multiple distinct URLs  → [ {text:heading, thumbnail:null}, ...one message per item ]
 *
 * @param {object[]} items      - catalog items already sliced to display limit
 * @param {string}   headingText - the intro line ("Here are the items in...")
 * @param {function} itemLineFn  - (item) => single-line string for that item
 */
function buildThumbnailMessages(items, headingText, itemLineFn) {
  const thumbs = items.map(getItemThumbnail);
  const withThumb = thumbs.filter(Boolean);
  if (withThumb.length === 0) return null;

  const uniqueThumbs = new Set(withThumb);

  if (uniqueThumbs.size === 1) {
    // All thumbnails share the same URL — one bubble: image on top, full list below
    // (same model as a single item: image + content together in one message).
    const sharedUrl = withThumb[0];
    const listText = [headingText, ...items.map(itemLineFn)].join('\n');
    return [
      { text: listText, thumbnail: sharedUrl },
    ];
  }

  // Multiple distinct URLs — each item as its own bubble
  const messages = [{ text: headingText, thumbnail: null }];
  items.forEach((item, i) => {
    messages.push({ text: itemLineFn(item), thumbnail: thumbs[i] || null });
  });
  return messages;
}

module.exports = { getItemThumbnail, buildThumbnailMessages };
