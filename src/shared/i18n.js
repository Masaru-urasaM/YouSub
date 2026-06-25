/**
 * Lightweight WebExtensions i18n helper for static UI localization.
 *
 * Localizes any element carrying a `data-i18n` attribute (textContent) and the
 * attribute variants below. The message is only applied when `getMessage`
 * returns a non-empty string, so untagged or missing strings keep their
 * hardcoded English — graceful fallback, never blank.
 *
 * Supported attributes:
 *   data-i18n               -> textContent
 *   data-i18n-placeholder   -> placeholder attribute
 *   data-i18n-aria-label    -> aria-label attribute
 *   data-i18n-title         -> title attribute
 *
 * `browser` is provided by the vendored webextension-polyfill (popup/options
 * load it before this module) and is aliased to `chrome` in the test mock.
 */

const ATTR_MAP = {
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-aria-label': 'aria-label',
  'data-i18n-title': 'title',
};

/**
 * Safely resolve a localized message. Returns '' if the i18n API is
 * unavailable or the key is missing/empty.
 * @param {string} key
 * @returns {string}
 */
function getMessage(key) {
  try {
    if (
      typeof browser !== 'undefined' &&
      browser.i18n &&
      typeof browser.i18n.getMessage === 'function'
    ) {
      return browser.i18n.getMessage(key) || '';
    }
  } catch {
    // i18n API not available in this context — fall through to empty.
  }
  return '';
}

/**
 * Apply localized strings to every tagged element under `root`.
 * @param {ParentNode} [root=document] - element/fragment to localize.
 */
export function applyI18n(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  // Text content
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });

  // Attribute variants
  Object.keys(ATTR_MAP).forEach((dataAttr) => {
    root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
      const msg = getMessage(el.getAttribute(dataAttr));
      if (msg) el.setAttribute(ATTR_MAP[dataAttr], msg);
    });
  });
}
