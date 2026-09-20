import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next', 'node_modules', 'results'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
