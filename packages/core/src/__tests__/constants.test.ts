import { describe, it, expect } from 'vitest';
import {
  TYPE_EMOJIS,
  TYPE_COLORS,
  TYPE_LABELS,
  KNOWN_ENTRY_TYPES,
} from '../constants.js';

describe('constants', () => {
  it('KNOWN_ENTRY_TYPES contains all expected types', () => {
    expect(KNOWN_ENTRY_TYPES).toContain('skill');
    expect(KNOWN_ENTRY_TYPES).toContain('agent');
    expect(KNOWN_ENTRY_TYPES).toContain('command');
    expect(KNOWN_ENTRY_TYPES).toContain('plugin');
    expect(KNOWN_ENTRY_TYPES).toContain('rule');
    expect(KNOWN_ENTRY_TYPES).toContain('hook');
    expect(KNOWN_ENTRY_TYPES).toHaveLength(6);
  });

  describe('TYPE_EMOJIS', () => {
    it('has an entry for every KNOWN_ENTRY_TYPE', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(TYPE_EMOJIS[type]).toBeDefined();
      }
    });

    it('all values are non-empty strings', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(typeof TYPE_EMOJIS[type]).toBe('string');
        expect(TYPE_EMOJIS[type].length).toBeGreaterThan(0);
      }
    });
  });

  describe('TYPE_COLORS', () => {
    it('has an entry for every KNOWN_ENTRY_TYPE', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(TYPE_COLORS[type]).toBeDefined();
      }
    });

    it('all values are non-empty strings', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(typeof TYPE_COLORS[type]).toBe('string');
        expect(TYPE_COLORS[type].length).toBeGreaterThan(0);
      }
    });
  });

  describe('TYPE_LABELS', () => {
    it('has an entry for every KNOWN_ENTRY_TYPE', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(TYPE_LABELS[type]).toBeDefined();
      }
    });

    it('all values are non-empty strings', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(typeof TYPE_LABELS[type]).toBe('string');
        expect(TYPE_LABELS[type].length).toBeGreaterThan(0);
      }
    });

    it('labels are capitalized display names', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        const label = TYPE_LABELS[type];
        // First character should be uppercase
        expect(label[0]).toBe(label[0].toUpperCase());
      }
    });
  });

  describe('cross-map consistency', () => {
    it('all three maps have exactly the same keys', () => {
      const emojiKeys = Object.keys(TYPE_EMOJIS).sort();
      const colorKeys = Object.keys(TYPE_COLORS).sort();
      const labelKeys = Object.keys(TYPE_LABELS).sort();

      expect(emojiKeys).toEqual(colorKeys);
      expect(colorKeys).toEqual(labelKeys);
    });

    it('no type in KNOWN_ENTRY_TYPES is missing from any map', () => {
      for (const type of KNOWN_ENTRY_TYPES) {
        expect(TYPE_EMOJIS).toHaveProperty(type);
        expect(TYPE_COLORS).toHaveProperty(type);
        expect(TYPE_LABELS).toHaveProperty(type);
      }
    });
  });
});
