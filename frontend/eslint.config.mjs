import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  { ignores: ['.next/**', '.tools/**', 'next-env.d.ts'] },
  ...compat.config({ extends: ['next/core-web-vitals', 'next/typescript'] }),
];
