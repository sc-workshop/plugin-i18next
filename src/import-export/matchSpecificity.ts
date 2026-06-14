import type { Variant } from "@inlang/sdk";

/**
 * Specificity of a variant's matches, following i18next's key resolution
 * order where the most specific key wins and the base key is the fallback:
 *
 * `key_context_zero` (6) > `key_context_plural` / `key_context_ordinal_*` (5) >
 * `key_context` (4) > `key_zero` (2) > `key_plural` / `key_ordinal_*` (1) >
 * `key` (0)
 *
 * The exact `count = 0` match (`_zero`) outranks the plural category within
 * the same context level, mirroring i18next's lookup order. Cardinal
 * (`countPlural`) and ordinal (`countOrdinal`) literal matches carry the same
 * weight — in i18next they are mutually exclusive lookups (`ordinal: true`) —
 * and ties keep their stable import order, i.e. cardinal variants come first
 * in mixed bundles. Catchall matches and absent matches do not add
 * specificity.
 *
 * https://www.i18next.com/translation-function/context
 * https://www.i18next.com/translation-function/plurals
 */
export function matchSpecificity(variant: {
	matches?: Variant["matches"];
}): number {
	const hasLiteralMatch = (key: string) =>
		(variant.matches ?? []).some(
			(match) => match.type === "literal-match" && match.key === key
		);
	return (
		(hasLiteralMatch("context") ? 4 : 0) +
		(hasLiteralMatch("count") ? 2 : 0) +
		(hasLiteralMatch("countOrdinal") ? 1 : 0) +
		(hasLiteralMatch("countPlural") ? 1 : 0)
	);
}
