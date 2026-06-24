module.exports = {
  testEnvironment: 'jest-environment-jsdom',
  verbose: true,
  moduleFileExtensions: ['js', 'json'],
  transform: {}, // No transform needed for Vanilla JS usually
  setupFilesAfterEnv: ['<rootDir>/tests/mocks/chrome.js'],
  testMatch: ['<rootDir>/tests/unit/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  // Honest denominator: measure all of OUR source, excluding only the vendored
  // webextension-polyfill (not our code to unit-test). Page-injected scripts and
  // orchestration stay IN — "hard to test" is not "exclude from the metric".
  collectCoverageFrom: ['src/**/*.js', '!src/shared/libs/**'],
  // Phase 69 ratchet: set a hair below the honestly-achieved global numbers so
  // the gate locks in progress without blocking minor future changes. Raised as
  // translator.js (Phase 75) and the UI glue (Phase 76) gain real coverage; the
  // Milestone-7 exit target is ≥70%. Do not lower these.
  coverageThreshold: {
    global: {
      statements: 38,
      branches: 34,
      functions: 36,
      lines: 38,
    },
  },
  // Support ES modules
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
