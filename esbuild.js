const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const outputFile = 'dist/extension.js';

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: false, // Open source: ship readable, unminified output
		mangleProps: undefined,
		keepNames: false,
		treeShaking: true,
		legalComments: 'none',
		sourcemap: false, // No source maps in production
		sourcesContent: false,
		platform: 'node',
		outfile: outputFile,
		external: ['vscode'],
		logLevel: 'silent',
		...(production && {
			drop: ['debugger', 'console'],
			pure: ['console.log', 'console.debug', 'console.info'],
		}),
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
