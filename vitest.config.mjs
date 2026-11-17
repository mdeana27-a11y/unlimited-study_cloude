export default { test: { environment: 'node', include: ['tests/**/*.test.mjs'], testTimeout: 30000, hookTimeout: 60000,
  globalSetup: ['tests/global-setup.mjs'], setupFiles: ['tests/setup.mjs'], fileParallelism: true } };
