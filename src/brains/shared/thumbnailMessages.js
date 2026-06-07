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
 * Same URL for all items  → [ {text:'', thumbnail:sharedUrl}, {text:fullList, thumbnail:null} ]
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
    // All thumbnails share the same URL — show image once, then the full combined list
    const sharedUrl = withThumb[0];
    const listText = [headingText, ...items.map(itemLineFn)].join('\n');
    return [
      { text: '', thumbnail: sharedUrl },
      { text: listText, thumbnail: null },
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
