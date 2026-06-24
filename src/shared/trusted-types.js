/**
 * trusted-types.js
 * Handles bypass for YouTube's Trusted Types security policy.
 */

import { devLog, devWarn } from './constants.js';

let policy = null;

export const TrustedTypes = {
  /**
   * Initializes the policy. Must be called once.
   */
  init() {
    if (policy) return;

    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        policy = window.trustedTypes.createPolicy('yousub-policy', {
          createHTML: (html) => html, // We trust our own generated HTML
          createScript: (script) => script,
          createScriptURL: (url) => url,
        });
        devLog('[YouSub] TrustedTypes: Policy created successfully.');
      } catch (e) {
        devWarn('[YouSub] TrustedTypes: Failed to create policy', e.message);
      }
    }
  },

  /**
   * Converts a string to a TrustedHTML object if policy is available.
   * Else returns the string as is.
   */
  toSafeHTML(html) {
    if (policy && policy.createHTML) {
      return policy.createHTML(html);
    }
    return html;
  },
};
