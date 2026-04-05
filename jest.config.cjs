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
  // Support ES modules
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
