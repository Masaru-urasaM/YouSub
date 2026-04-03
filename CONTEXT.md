# YouSub — Context and Background

> **Purpose**: This document provides the high-level reasons, goals, and desired outcomes of the YouSub project. It captures *why* the project exists so the developer and AI can remain aligned on the core mission.

## 1. Background
The creator of YouSub is a solo developer looking to build a browser extension to significantly improve the YouTube viewing experience. The developer is focusing on building a practical, feasible project using standard web technologies (HTML, CSS, JS) built upon the modern WebExtensions API (Manifest V3).

## 2. The Core Goal
To create a Browser Extension (focusing on Chrome, scalable to Firefox) that acts as a real-time subtitle translator for YouTube. 
**Mechanism**:
- Access YouTube's native transcripts/subtitles (including auto-generated ones) while the video is playing.
- Extract the precise timestamps and original language text blocks.
- Process and translate this text into the user's desired language.
- Project the translated subtitles onto the screen using a custom UI overlay, perfectly synchronized with the video's current time.

## 3. Reasons (The "Why")
- **Limitations of Native Features**: YouTube's native auto-translate capabilities can sometimes be rigid, poorly formatted, or lack customization options for the viewer.
- **Personal Need & Control**: The developer needs a reliable, beautifully rendered subtitle system over which they hold complete design and functional control (e.g., dual subtitles, better fonts, customizable background boxes).
- **Ideal Solo Project**: It provides a highly defined scope for a solo developer to combine DOM manipulation, browser background scripts, network interception, and third-party APIs into one cohesive product.

## 4. Desired Outcomes
- **A Working Manifest V3 Extension**: Built, functional, and installable initially as a local unpacked extension.
- **Efficient Data Interception**: The extension successfully captures YouTube's subtitle payloads (XML/JSON data) natively without causing performance degradation.
- **Accurate Translation**: A mechanism is established to translate these payloads optimally (translating in bulk upfront vs. real-time chunks) via preferred translation services.
- **Perfect Syncing & UI**: The translated text appears on screen with millisecond accuracy tied to the YouTube player's HTML5 `<video>` tag. The UI should be highly polished and premium.
- **Low Maintenance Constraints**: A somewhat resilient approach to DOM injection so that minor YouTube UI updates do not constantly break the extension.
