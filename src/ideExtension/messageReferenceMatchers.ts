/* eslint-disable @typescript-eslint/no-non-null-assertion */
/** biome-ignore-all lint/style/noNonNullAssertion: . */
/**
 * Using parsimmon because:
 *
 * 1. Chevrotain is too complicated.
 * 2. TypeScript's compiler doesn't work in the browser.
 * 3. TypeScripts compiler
 */

import Parsimmon from "parsimmon";
import type { PluginSettings } from "../settings.js";

const escapeRegex = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createFunctionNameParser = (functions: string[]) => {
	const safe = functions.map(escapeRegex);

	if (safe.length === 0) {
		return Parsimmon.fail("No functions provided");
	}

	return Parsimmon.alt(...safe.map((fn) => Parsimmon.string(fn)));
};

const createParser = (
	settings: PluginSettings,
	defaultNS: string | undefined,
	keyPrefix: string | undefined,
) => {
	const functions = settings.functions ?? ["t"];
	const functionName = createFunctionNameParser(functions);

	return Parsimmon.createLanguage({
		entry: (r) => {
			return Parsimmon.alt(r.FunctionCall!, Parsimmon.any)
				.many()
				.map((matches) => matches.filter((m) => typeof m === "object"));
		},

		stringLiteral: (r) => {
			return Parsimmon.alt(r.doubleQuotedString!, r.singleQuotedString!);
		},

		doubleQuotedString: () => {
			return Parsimmon.string('"')
				.then(Parsimmon.regex(/[^"]*/))
				.skip(Parsimmon.string('"'));
		},

		singleQuotedString: () => {
			return Parsimmon.string("'")
				.then(Parsimmon.regex(/[^']*/))
				.skip(Parsimmon.string("'"));
		},

		whitespace: () => Parsimmon.optWhitespace,

		colon: (r) => Parsimmon.string(":").trim(r.whitespace!),

		comma: (r) => Parsimmon.string(",").trim(r.whitespace!),

		nsValue: (r) => {
			return Parsimmon.seq(
				r.whitespace!,
				Parsimmon.string("ns").trim(r.whitespace!).skip(r.colon!),
				r.stringLiteral!.trim(r.whitespace!),
			).map(([, , val]) => `${val}`);
		},

		FunctionCall: (r) =>
			Parsimmon.seqMap(
				Parsimmon.regex(/[^a-zA-Z0-9]/),
				functionName,
				Parsimmon.string("("),
				Parsimmon.index,
				r.stringLiteral!,
				Parsimmon.index,
				Parsimmon.regex(/[^)]*/),
				Parsimmon.string(")"),
				(_, fn, __, start, messageId, end, rest) => {
					const namespaceParser = r
						.comma!.then(Parsimmon.string("{"))
						.trim(r.whitespace!)
						.then(r.nsValue!)
						.skip(Parsimmon.string("}"))
						.skip(Parsimmon.regex(/[^)]*/))
						.trim(r.whitespace!);

					const namespace = (
						namespaceParser.parse(rest) as { status: boolean; value: string }
					).value;

					// -- namespace handling --
					if (typeof settings.pathPattern === "object") {
						if (namespace) {
							messageId =
								namespace +
								":" +
								(keyPrefix ? keyPrefix + "." : "") +
								messageId;
						} else if (!messageId.includes(":")) {
							const defaultNamespace = defaultNS
								? defaultNS
								: Object.keys(settings.pathPattern)[0];

							messageId =
								defaultNamespace +
								":" +
								(keyPrefix ? keyPrefix + "." : "") +
								messageId;
						}
					}

					return {
						messageId,
						position: {
							start: {
								line: start.line,
								character: start.column,
							},
							end: {
								line: end.line,
								character: end.column,
							},
						},
					};
				},
			),
	});
};

const createNamespaceParser = (pattern: string) => {
	return Parsimmon.createLanguage({
		entry: (r) => {
			return Parsimmon.alt(r.FunctionCall!, Parsimmon.any)
				.many()
				.map((matches) => matches.filter((m) => typeof m === "object"));
		},

		stringLiteral: (r) => {
			return Parsimmon.alt(r.doubleQuotedString!, r.singleQuotedString!);
		},

		doubleQuotedString: () => {
			return Parsimmon.string('"')
				.then(Parsimmon.regex(/[^"]*/))
				.skip(Parsimmon.string('"'));
		},

		singleQuotedString: () => {
			return Parsimmon.string("'")
				.then(Parsimmon.regex(/[^']*/))
				.skip(Parsimmon.string("'"));
		},

		comma: (r) => Parsimmon.string(",").trim(r.whitespace!),

		whitespace: () => Parsimmon.optWhitespace,

		colon: (r) => Parsimmon.string(":").trim(r.whitespace!),

		keyPrefixValue: (r) => {
			return Parsimmon.seq(
				r.whitespace!,
				Parsimmon.string("keyPrefix").trim(r.whitespace!).skip(r.colon!),
				r.stringLiteral!.trim(r.whitespace!),
			).map(([, , val]) => `${val}`);
		},

		FunctionCall: (r) =>
			Parsimmon.seqMap(
				Parsimmon.regex(/[^a-zA-Z0-9]/),
				Parsimmon.regex(/\buseTranslations?\b/),
				Parsimmon.string(pattern),
				Parsimmon.index,
				r.stringLiteral!,
				Parsimmon.index,
				Parsimmon.regex(/[^)]*/),
				Parsimmon.string(")"),
				(_, __, ___, ____, namespace, _end, rest) => {
					const keyPrefixParser = r
						.comma!.then(Parsimmon.string("{"))
						.trim(r.whitespace!)
						.then(r.keyPrefixValue!)
						.skip(Parsimmon.string("}"))
						.skip(Parsimmon.regex(/[^)]*/))
						.trim(r.whitespace!);

					const keyPrefix = (
						keyPrefixParser.parse(rest) as { status: boolean; value: string }
					).value;

					return {
						ns: namespace,
						keyPrefix,
					};
				},
			),
	});
};

function parseNameSpaces(settings: PluginSettings, sourceCode: string) {
	if (typeof settings.pathPattern === "object") {
		const namespaceParser = createNamespaceParser("(");
		const namespaces = namespaceParser.entry!.tryParse(sourceCode);

		if (namespaces.length > 0) {
			return {
				ns: namespaces[0].ns,
				keyPrefix: namespaces[0].keyPrefix,
			};
		} else {
			const namespaceArrayParser = createNamespaceParser("([");

			const namespaces = namespaceArrayParser.entry!.tryParse(sourceCode);

			if (namespaces.length > 0) {
				return {
					ns: namespaces[0].ns,
					keyPrefix: namespaces[0].keyPrefix,
				};
			}

			return undefined;
		}
	}

	return undefined;
}

// Parse the expression
export function parse(sourceCode: string, settings: PluginSettings) {
	try {
		const namespaceParserResult = parseNameSpaces(settings, sourceCode);

		const namespace = namespaceParserResult?.ns;
		const keyPrefix = namespaceParserResult?.keyPrefix;

		const parser = createParser(settings, namespace, keyPrefix);

		return parser.entry!.tryParse(sourceCode);
	} catch {
		return [];
	}
}
