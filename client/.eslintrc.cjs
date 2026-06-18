module.exports = {
	root: true,
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:react/recommended',
		'plugin:react/jsx-runtime',
		'plugin:react-hooks/recommended',
		'prettier'
	],
	parser: '@typescript-eslint/parser',
	plugins: ['@typescript-eslint', 'react', 'react-hooks'],
	parserOptions: {
		sourceType: 'module',
		ecmaVersion: 2022,
		ecmaFeatures: { jsx: true }
	},
	env: {
		browser: true,
		es2022: true,
		node: true
	},
	settings: {
		react: { version: 'detect' }
	},
	overrides: [
		{
			// Test code may use non-null assertions on values it has just constructed / knows are defined
			// (e.g. asserting on a Patch's `monitor`). Production code keeps the strict rule.
			files: ['**/*.test.ts', '**/*.test.tsx'],
			rules: { '@typescript-eslint/no-non-null-assertion': 'off' }
		}
	]
};
