import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Flat config (ESLint 9). Mirrors the old .eslintrc.cjs stack: eslint:recommended +
// typescript-eslint recommended + react (+ jsx-runtime) + react-hooks, with prettier last to
// switch off formatting rules. The old .eslintignore is folded into `ignores` below — flat config
// no longer reads that file.
export default tseslint.config(
	{
		ignores: [
			'build/**',
			'coverage/**',
			'test-results/**',
			'playwright-report/**',
			'blob-report/**',
			'.playwright-mcp/**',
			'playwright/.cache/**'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	react.configs.flat.recommended,
	react.configs.flat['jsx-runtime'],
	reactHooks.configs.flat.recommended,
	{
		settings: { react: { version: 'detect' } },
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	prettier,
	{
		// Test code may use non-null assertions on values it has just constructed / knows are defined
		// (e.g. asserting on a Patch's `monitor`). Production code keeps the strict rule.
		files: ['**/*.test.ts', '**/*.test.tsx'],
		rules: { '@typescript-eslint/no-non-null-assertion': 'off' }
	}
);
