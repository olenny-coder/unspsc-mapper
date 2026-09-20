module.exports = {
  root: true,
  extends: ['next/core-web-vitals'],
  ignorePatterns: ['node_modules/', '.next/', 'dist/', 'samples/*.csv', 'coverage/'],
  rules: {
    'no-console': 'off',
    '@next/next/no-html-link-for-pages': 'off',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-unused-vars': 'off',
  },
};
