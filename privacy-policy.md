<!--
  In-repo mirror of the canonical published privacy policy:
  https://gist.github.com/Masaru-urasaM/15f9846972ccb68a120d29e988f42847
  Keep this file in sync with that gist (the gist is what the store listings link to).
-->

# Privacy Policy for YouSub Browser Extension

**Last updated:** April 21, 2026

## Overview

YouSub is a browser extension that translates YouTube subtitles in real-time. This privacy policy explains how YouSub handles user data.

## Data Collection

YouSub does **NOT** collect, store, or transmit any personal data to external servers owned or operated by the developer.

### What YouSub stores locally on your device:

- **API Keys**: User-provided LLM API keys (e.g., OpenAI, Groq, Google Gemini, Anthropic, etc.) are stored in `chrome.storage.local` on your device only. They are never sent to any server other than the respective API provider you configured.
- **Translation Cache**: Translated subtitle text is cached locally in `chrome.storage.local` to avoid redundant API calls.
- **User Preferences**: Display settings (font size, color, position) are stored locally in `chrome.storage.local`.

### What YouSub accesses on web pages:

- **YouTube Subtitle Data**: YouSub reads native YouTube transcript/subtitle data from YouTube video pages to perform translation. This data is only used locally for translation purposes and is never transmitted to any third party.

## Data Transmission

YouSub sends subtitle text **only** to the LLM API provider that **you** configure (e.g., OpenAI, Groq, Google Gemini, Anthropic, DeepSeek, xAI, Mistral, OpenRouter, or your local Ollama instance). No data is sent to any other external service.

For internal subtitle-alignment checks, YouSub may use Chrome's built-in **on-device** translation API. This runs locally on your device and does **not** transmit any subtitle text over the network.

The developer of YouSub has **no access** to your API keys, your translation history, or any other data.

## Limited Use

YouSub's handling of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Data accessed by YouSub (subtitle text and your API keys) is used **solely** to provide the in-extension translation feature, is processed only on your device and sent only to the LLM provider **you** configure, and is **never** sold, transferred to third parties, or used for advertising, profiling, or any purpose unrelated to the extension's core function.

## Third-Party Services

YouSub uses a "Bring Your Own Key" (BYOK) model. You are responsible for reviewing the privacy policies of the LLM providers you choose to use.

## Permissions Justification

- **`activeTab`**: Required to access the current YouTube page and read subtitle data.
- **`storage`**: Required to save your API keys, preferences, and translation cache locally.
- **Host permissions for youtube.com**: Required to inject the subtitle overlay and read transcript data.
- **Host permissions for API endpoints**: Required to send translation requests to your configured LLM provider.

## Data Security

- All API communication uses HTTPS encryption.
- API keys are stored in Chrome's sandboxed extension storage, isolated from other extensions and websites.
- No analytics, tracking, or telemetry is included in this extension.

## Children's Privacy

YouSub does not knowingly collect any data from children under 13.

## Changes to This Policy

Any changes to this privacy policy will be reflected in this document with an updated date.

## Contact

If you have questions about this privacy policy, please contact: sytacxinh1123@gmail.com
