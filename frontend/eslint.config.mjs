import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  { ignores: ['.next/**', '.tools/**', 'next-env.d.ts'] },
  ...compat.config({ extends: ['next/core-web-vitals', 'next/typescript'] }),
];
