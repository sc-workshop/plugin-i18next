/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { inspect } from "node:util";
import type {
	Bundle,
	BundleImport,
	Declaration,
	Message,
	MessageImport,
	Pattern,
	VariableReference,
	Variant,
	VariantImport,
} from "@inlang/sdk";
import { flatten } from "flat";
import type { plugin } from "../plugin.js";
import type { PluginSettings } from "../settings.js";
import { matchSpecificity } from "./matchSpecificity.js";

export const importFiles: NonNullable<(typeof plugin)["importFiles"]> = async ({
	files,
	settings,
}) => {
	const bundles: BundleImport[] = [];
	const messages: MessageImport[] = [];
	const variants: VariantImport[] = [];

	for (const file of files) {
		const namespace = file.toBeImportedFilesMetadata?.namespace;
		const result = parseFile({
			namespace,
			locale: file.locale,
			content: file.content,
			settings: settings?.["plugin.neko.i18next"],
		});

		bundles.push(...result.bundles);
		messages.push(...result.messages);
		variants.push(...result.variants);
	}

	// merge the bundle declarations
	const uniqueBundleIds = [...new Set(bundles.map((bundle) => bundle.id))];
	const uniqueBundles: BundleImport[] = uniqueBundleIds.map((id) => {
		const _bundles = bundles.filter((bundle) => bundle.id === id);
		const declarations = removeDuplicates(
			_bundles.flatMap((bundle) => bundle.declarations),
		);
		return { id, declarations };
	});

	return { bundles: uniqueBundles, messages, variants };
};

function parseFile(args: {
	namespace?: string;
	locale: string;
	content: ArrayBuffer;
	settings?: PluginSettings;
}): {
	bundles: BundleImport[];
	messages: MessageImport[];
	variants: VariantImport[];
} {
	const table = JSON.parse(new TextDecoder().decode(args.content));
	const resource: Record<string, string> = flatten(table);

	const bundles: BundleImport[] = [];
	const messages: MessageImport[] = [];
	const variants: VariantImport[] = [];

	// sibling keys of the same bundle (`friend` -> `friend_one`,
	// `friend_male_one`, ...) decide which selectors the bundle has. the
	// summary is precomputed in a single pass to avoid rescanning the
	// resource for every key.
	// https://www.i18next.com/translation-function/context#combining-with-plurals
	const bundleSelectorsByRootKey = new Map<
		string,
		{
			hasPlurals: boolean;
			hasContext: boolean;
			hasZero: boolean;
			hasOrdinal: boolean;
		}
	>();
	for (const key in resource) {
		const { rootKey, isOrdinal, isCardinalPlural, isZero, hasContext } =
			classifyKey(key);
		const summary = bundleSelectorsByRootKey.get(rootKey) ?? {
			hasPlurals: false,
			hasContext: false,
			hasZero: false,
			hasOrdinal: false,
		};
		summary.hasPlurals = summary.hasPlurals || isCardinalPlural;
		summary.hasOrdinal = summary.hasOrdinal || isOrdinal;
		summary.hasContext = summary.hasContext || hasContext;
		summary.hasZero = summary.hasZero || isZero;
		bundleSelectorsByRootKey.set(rootKey, summary);
	}

	for (const key in resource) {
		const { rootKey } = classifyKey(key);

		const value = resource[key]!;
		const parsed = parseMessage({
			namespace: args.namespace,
			key,
			value,
			locale: args.locale,
			bundleSelectors: bundleSelectorsByRootKey.get(rootKey)!,
			settings: args.settings,
		});

		// console.log("I18NEXT MESSAGE!!!");
		// console.log(
		// 	inspect(
		// 		{
		// 			bundle: parsed.bundle,
		// 			message: parsed.message,
		// 			variants: parsed.variants,
		// 		},
		// 		{ depth: null },
		// 	),
		// );
		bundles.push(parsed.bundle);
		messages.push(parsed.message);
		variants.push(...parsed.variants);
	}

	// order each bundle's variants most-specific-first (`friend_male_one` >
	// `friend_male` > `friend_one` > `friend`) so that first-match-wins
	// consumers (e.g. the paraglide compiler) resolve context and plurals
	// the way i18next does.
	// https://github.com/opral/inlang/issues/4354
	const variantsByBundleId = new Map<string, VariantImport[]>();
	for (const variant of variants) {
		const group = variantsByBundleId.get(variant.messageBundleId!) ?? [];
		group.push(variant);
		variantsByBundleId.set(variant.messageBundleId!, group);
	}
	const sortedVariants = [...variantsByBundleId.values()].flatMap((group) =>
		group.sort((a, b) => matchSpecificity(b) - matchSpecificity(a)),
	);

	return { bundles, messages, variants: sortedVariants };
}

function parseMessage(args: {
	namespace?: string;
	key: string;
	value: string;
	locale: string;
	bundleSelectors: {
		hasPlurals: boolean;
		hasContext: boolean;
		hasZero: boolean;
		hasOrdinal: boolean;
	};
	settings?: PluginSettings;
}): {
	bundle: BundleImport;
	message: MessageImport;
	variants: VariantImport[];
} {
	const pattern = parsePattern(args.value, args.settings);

	// i18next suffixes keys with context or plurals
	// "friend_female_one" -> "friend"
	const {
		keyParts,
		isOrdinal,
		isCardinalPlural: hasPlurals,
		isZero,
		hasContext,
	} = classifyKey(args.key);
	let bundleId = keyParts[0]!;
	if (args.namespace) {
		// following i18next's convention
		// https://www.i18next.com/principles/namespaces#sample
		bundleId = `${args.namespace}:${bundleId}`;
	}

	const bundle: Bundle = {
		id: bundleId,
		declarations: pattern.variableReferences.map((variableReference) => ({
			type: "input-variable",
			name: variableReference.name,
		})),
	};
	bundle.declarations.push(...pattern.declarations);

	const message: MessageImport = {
		bundleId: bundleId,
		selectors: [],
		locale: args.locale,
	};

	const variant: VariantImport = {
		messageBundleId: bundleId,
		messageLocale: args.locale,
		matches: [],
		pattern: pattern.result,
	};

	// base keys are the fallback for their context/plural siblings and get
	// explicit catchall matches (see the per-bundle summary in parseFile).
	const {
		hasPlurals: bundleHasPlurals,
		hasContext: bundleHasContext,
		hasZero: bundleHasZero,
		hasOrdinal: bundleHasOrdinal,
	} = args.bundleSelectors;

	const selectors: Message["selectors"] = [
		{ type: "variable-reference", name: "emoji" },
	];
	const matches: Variant["matches"] = [];

	if (bundleHasContext) {
		bundle.declarations.push({
			type: "input-variable",
			name: "context",
		});
		selectors.push({
			type: "variable-reference",
			name: "context",
		});
		matches.push(
			hasContext
				? {
						type: "literal-match",
						// i18next always uses "context" as the key
						// "friend_male" -> ["friend", "male"]
						key: "context",
						value: keyParts[1]!,
					}
				: // the base key is the fallback for all context variants
					{
						type: "catchall-match",
						key: "context",
					},
		);
	}

	if (bundleHasZero) {
		// `_zero` matches exactly `count === 0` in i18next, in every
		// language — expressed as a selector on the `count` input itself,
		// ahead of the plural category (the mechanism proposed in
		// https://github.com/opral/paraglide-js/issues/552).
		// https://github.com/opral/inlang/issues/4357
		selectors.push({
			type: "variable-reference",
			name: "count",
		});
		matches.push(
			isZero
				? {
						type: "literal-match",
						key: "count",
						value: "0",
					}
				: {
						type: "catchall-match",
						key: "count",
					},
		);
	}

	if (bundleHasOrdinal) {
		bundle.declarations.push({
			type: "input-variable",
			name: "count",
		});
		bundle.declarations.push({
			type: "local-variable",
			name: "countOrdinal",
			value: {
				type: "expression",
				arg: {
					type: "variable-reference",
					name: "count",
				},
				annotation: {
					type: "function-reference",
					name: "plural",
					options: [
						{
							name: "type",
							value: { type: "literal", value: "ordinal" },
						},
					],
				},
			},
		});
		selectors.push({
			type: "variable-reference",
			name: "countOrdinal",
		});
		matches.push(
			isOrdinal
				? {
						type: "literal-match",
						key: "countOrdinal",
						value: keyParts.at(-1)!,
					}
				: // cardinal/zero/base variants are the fallback for ordinal
					// lookups of the same key
					{
						type: "catchall-match",
						key: "countOrdinal",
					},
		);
	}

	if (bundleHasPlurals) {
		bundle.declarations.push({
			type: "input-variable",
			name: "count",
		});
		bundle.declarations.push({
			type: "local-variable",
			name: "countPlural",
			value: {
				type: "expression",
				arg: {
					type: "variable-reference",
					name: "count",
				},
				annotation: {
					type: "function-reference",
					name: "plural",
					options: [],
				},
			},
		});
		selectors.push({
			type: "variable-reference",
			// i18next only allows matching against a count variable.
			// suffixing plural here because the inlang sdk v2 purposefully
			// did not allow using a variable with a function like `plural`
			// without declaring a new variable
			name: "countPlural",
		});
		matches.push(
			// the exact `count = 0` variant matches any plural category
			hasPlurals && !isZero
				? {
						type: "literal-match",
						key: "countPlural",
						value: keyParts.at(-1)!,
					}
				: // the base key is the fallback for all plural variants
					{
						type: "catchall-match",
						key: "countPlural",
					},
		);
	}

	message.selectors = selectors;
	variant.matches = matches;

	const variants: VariantImport[] = [variant];

	if (isZero) {
		// `_zero` additionally serves as the Intl "zero" plural category key
		// (selected for counts other than 0 in languages like Latvian), so a
		// second variant keeps category-based selection working alongside
		// the exact-0 match.
		variants.push({
			messageBundleId: bundleId,
			messageLocale: args.locale,
			matches: matches.map((match) =>
				match.key === "count"
					? { type: "catchall-match", key: "count" }
					: match.key === "countPlural"
						? { type: "literal-match", key: "countPlural", value: "zero" }
						: match,
			),
			pattern: pattern.result,
		});
	}

	bundle.declarations = removeDuplicates(bundle.declarations);

	return { bundle, message, variants };
}

function parsePattern(
	value: string,
	settings?: PluginSettings,
): {
	variableReferences: VariableReference[];
	declarations: Declaration[];
	result: Pattern;
} {
	const result: Variant["pattern"] = [];
	const variableReferences: VariableReference[] = [];
	const declarations: Declaration[] = [];

	const variableCounter = 0;
	const pattern = settings?.variableReferencePattern ?? ["{{", "}}"];
	const openPattern = pattern[0];
	const closePattern = pattern[1];
	let buffer = "";

	const flushBuffer = () => {
		if (buffer.length > 0) {
			result.push({ type: "text", value: buffer });
			buffer = "";
		}
	};

	for (let index = 0; index < value.length; index += 1) {
		// parse interpolation first to avoid conflicts with custom patterns
		if (openPattern && closePattern && value.startsWith(openPattern, index)) {
			const closingIndex = value.indexOf(
				closePattern,
				index + openPattern.length,
			);
			if (closingIndex !== -1) {
				flushBuffer();

				// i18next allows for annotations like `{{name, uppercase}}`
				const subparts = value
					.slice(index + openPattern.length, closingIndex)
					.split(",");

				const arg = subparts[0]?.trim();
				const annotation = subparts[1]?.trim();

				if (arg === undefined) {
					throw new Error(
						"Expected an argument in the expression but received undefined.",
					);
				}

				if (!annotation) {
					const variableReference: VariableReference = {
						type: "variable-reference",
						name: arg,
					};

					variableReferences.push(variableReference);

					result.push({
						type: "expression",
						arg: variableReference,
					});
				} else {
					const formaterName = annotation;

					const localVariableName = `${arg}Formatted${variableCounter}`;

					// Declaring variables with custom formater
					declarations.push({
						type: "local-variable",
						name: localVariableName,
						value: {
							type: "expression",
							arg: {
								type: "literal",
								value: formaterName,
							},
							annotation: {
								type: "function-reference",
								name: "customFormatter",
								options: [
									{
										name: "value",
										value: {
											type: "literal",
											value: arg,
										},
									},
								],
							},
						},
					});

					// Adding to message queue
					result.push({
						type: "expression",
						arg: {
							type: "variable-reference",
							name: localVariableName,
						},
					});
				}

				index = closingIndex + closePattern.length - 1;
				continue;
			}
		}

		const markupMatch = parseMarkupTagAt(value, index);
		if (markupMatch) {
			flushBuffer();
			result.push(markupMatch.part);
			index = markupMatch.endIndex;
			continue;
		}

		buffer += value[index]!;
	}

	flushBuffer();

	return { variableReferences, declarations, result };
}

function parseMarkupTagAt(
	value: string,
	startIndex: number,
):
	| {
			part: Pattern[number];
			endIndex: number;
	  }
	| undefined {
	const rest = value.slice(startIndex);

	const standalone = rest.match(/^<([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\/>/);
	if (standalone) {
		const name = standalone[1]!;
		return {
			part: { type: "markup-standalone", name },
			endIndex: startIndex + standalone[0].length - 1,
		};
	}

	const end = rest.match(/^<\/([A-Za-z0-9][A-Za-z0-9_.-]*)\s*>/);
	if (end) {
		const name = end[1]!;
		return {
			part: { type: "markup-end", name },
			endIndex: startIndex + end[0].length - 1,
		};
	}

	const start = rest.match(/^<([A-Za-z0-9][A-Za-z0-9_.-]*)\s*>/);
	if (start) {
		const name = start[1]!;
		return {
			part: { type: "markup-start", name },
			endIndex: startIndex + start[0].length - 1,
		};
	}

	return undefined;
}
const removeDuplicates = <T extends any[]>(arr: T) =>
	[...new Set(arr.map((item) => JSON.stringify(item)))].map((item) =>
		JSON.parse(item),
	);

const testForPlurals = (key: string) =>
	key.endsWith("_zero") ||
	key.endsWith("_one") ||
	key.endsWith("_two") ||
	key.endsWith("_few") ||
	key.endsWith("_many") ||
	key.endsWith("_other");

/**
 * Classifies an i18next key by its suffixes — the single source of truth for
 * the per-bundle summary in `parseFile` and the per-key parsing in
 * `parseMessage`.
 *
 * - cardinal plural categories: `key_one`, `key_other`, ...
 *   (https://www.i18next.com/misc/json-format#i18next-json-v4)
 * - ordinal plurals use the reserved `_ordinal_<category>` suffix:
 *   `key_ordinal_one`
 *   (https://www.i18next.com/translation-function/plurals#ordinal-plurals)
 * - `_zero` is i18next's exact `count === 0` match in every language, in
 *   addition to the Intl "zero" plural category — cardinal only
 *   (https://www.i18next.com/translation-function/plurals)
 * - context adds one segment between the root key and the plural suffix:
 *   `key_male`, `key_male_one`, `key_male_ordinal_one`
 *   (https://www.i18next.com/translation-function/context)
 */
function classifyKey(key: string): {
	keyParts: string[];
	rootKey: string;
	isOrdinal: boolean;
	isCardinalPlural: boolean;
	isZero: boolean;
	hasContext: boolean;
} {
	const keyParts = key.split("_");
	const hasPluralSuffix = testForPlurals(key);
	const isOrdinal = hasPluralSuffix && keyParts.at(-2) === "ordinal";
	return {
		keyParts,
		rootKey: keyParts[0]!,
		isOrdinal,
		isCardinalPlural: hasPluralSuffix && !isOrdinal,
		isZero: !isOrdinal && key.endsWith("_zero"),
		hasContext: isOrdinal
			? keyParts.length === 4
			: hasPluralSuffix
				? keyParts.length === 3
				: keyParts.length === 2,
	};
}
