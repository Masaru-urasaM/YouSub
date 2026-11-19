import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS_HTML = path.resolve(__dirname, '../../src/options/options.html');

describe('options.html accessibility wiring', () => {
  let doc;

  beforeAll(() => {
    const html = fs.readFileSync(OPTIONS_HTML, 'utf8');
    doc = new DOMParser().parseFromString(html, 'text/html');
  });

  test('tab-list has role="tablist"', () => {
    const list = doc.querySelector('.tab-list');
    expect(list).not.toBeNull();
    expect(list.getAttribute('role')).toBe('tablist');
  });

  test('each tab button has role="tab" + aria-controls pointing at its panel', () => {
    const tabs = doc.querySelectorAll('.tab-btn');
    expect(tabs.length).toBe(4);
    tabs.forEach((tab) => {
      expect(tab.getAttribute('role')).toBe('tab');
      const target = tab.getAttribute('data-target');
      expect(tab.getAttribute('aria-controls')).toBe(target);
      expect(tab.getAttribute('id')).toBe(`${target}-tab`);
      expect(['true', 'false']).toContain(tab.getAttribute('aria-selected'));
      expect(['0', '-1']).toContain(tab.getAttribute('tabindex'));
    });
  });

  test('exactly one tab is selected (the translation tab) and is in tab order', () => {
    const selected = doc.querySelectorAll('.tab-btn[aria-selected="true"]');
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute('data-target')).toBe('tab-translation');
    expect(selected[0].getAttribute('tabindex')).toBe('0');
  });

  test('each tab panel has role="tabpanel" + aria-labelledby pointing at its tab', () => {
    const panels = doc.querySelectorAll('.tab-pane');
    expect(panels.length).toBe(4);
    panels.forEach((panel) => {
      const id = panel.getAttribute('id');
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(`${id}-tab`);
      expect(panel.getAttribute('tabindex')).toBe('0');
    });
  });

  test('confirm modal is a labelled, described modal dialog', () => {
    const modal = doc.getElementById('confirm-modal');
    expect(modal).not.toBeNull();
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-labelledby')).toBe('modal-title');
    expect(modal.getAttribute('aria-describedby')).toBe('modal-message');
    expect(doc.getElementById('modal-title')).not.toBeNull();
    expect(doc.getElementById('modal-message')).not.toBeNull();
  });

  test('delete-custom-model icon button has an accessible label', () => {
    // This button lives inside the <template id="api-key-row-template">,
    // so it must be queried from the template's content fragment.
    const tpl = doc.getElementById('api-key-row-template');
    expect(tpl).not.toBeNull();
    const btn = tpl.content.querySelector('.delete-custom-model-btn');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Delete custom model');
  });
});
