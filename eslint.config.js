// @ts-check
// ESLint flat config — typescript-eslint recommended-type-checked, the
// industry-standard static analysis preset for TypeScript. Formatting is
// Prettier's job (see .prettierrc.json); no stylistic lint rules here.
//
// Run via: mise run lint
import eslint from "eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/**", ".pi/**", "results/**", "docs/**", "**/*.md"],
	},
	...tseslint.configs.recommendedTypeChecked.map((config) => ({
		...config,
		files: ["**/*.ts"],
	})),
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
		rules: {
			// Union growth must be a compile-guided change everywhere a
			// consumer switches on it (architecture-review candidate 1).
			"@typescript-eslint/switch-exhaustiveness-check": "error",
			// Test suites use assert-style flow; keep noise low but the
			// dangerous rules above stay on everywhere.
			"@typescript-eslint/no-unsafe-argument": "warn",
		},
	},
	{
		// Hermetic test files legitimately construct partial fixtures.
		files: ["**/test*.ts", "**/e2e-*.ts", "**/smoke-*.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
);
