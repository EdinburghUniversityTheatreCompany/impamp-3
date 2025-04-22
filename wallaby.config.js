module.exports = function (wallaby) {
  return {
    autoDetect: true, // Automatically detect test runner (Vitest in this case)
    testFramework: {
      configFile: './vitest.config.ts', // Use the Vitest configuration file
    },
    env: {
      type: 'node',
      runner: 'node', // Run in Node.js environment
    },
    files: [
      // Source files
      'src/**/*.+(ts|tsx|js|jsx)',
      'src/**/*.d.ts',
      '!src/**/*.test.+(ts|tsx|js|jsx)',
      '!src/**/*.spec.+(ts|tsx|js|jsx)',
      
      // Configuration files
      'vitest.config.ts',
      'tsconfig.json'
    ],
    tests: [
      // Test files
      'src/**/*.test.+(ts|tsx|js|jsx)',
      'src/**/*.spec.+(ts|tsx|js|jsx)'
    ],
    compilers: {
      '**/*.ts?(x)': wallaby.compilers.typeScript({
        module: 'esnext',
        jsx: 'react',
      }),
    },
    setup: function (wallaby) {
      // Load test setup file first
      require('./test/setup');
    },
    workers: {
      restart: true, // Restart workers between test runs
      initial: 1, // Initial number of workers
      regular: 1, // Regular number of workers
    },
    filesWithNoCoverageCalculated: [
      'test/**/*',
      'node_modules/**/*',
      'vitest.config.ts',
      'playwright.config.ts',
    ],
    debug: true, // Enable debug mode
  };
};
