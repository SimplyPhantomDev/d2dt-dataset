import stylistic from "@stylistic/eslint-plugin";

export default [
    { ignores: ["node_modules/", "training-data/"] },
    {
        files: ["**/*.{js,cjs,mjs}"],
        plugins: { "@stylistic": stylistic },
        rules: {
            "@stylistic/indent": ["error", 4],
        },
    },
];