/*
	Calls the DeepL API to translate the rule questions, titles, notes,
	summaries and suggestions.

	Command: yarn translate -- [options]
*/

const path = require('path')
const glob = require('glob')
const R = require('ramda')
const { exit } = require('process')
const prompt = require('prompt-sync')()

const utils = require('./utils')
const cli = require('./cli')
const deepl = require('./deepl')

const gitDiff = require('git-diff')
const { getModelFromSource } = require('../getModelFromSource')

const { srcLang, destLangs, srcFile, onlyUpdateLocks, interactiveMode } =
	cli.getArgs(
		`Calls the DeepL API to translate the rule questions, titles, notes,
	summaries and suggestions.`,
		{
			source: true,
			target: true,
			file: true,
			onlyUpdateLocks: true,
			defaultSrcFile: 'data/**/*.publicodes',
			interactiveMode: true,
		}
	)

const translateTo = async (
	srcLang,
	destLang,
	destPath,
	entryToTranslate,
	translatedRules
) => {
	let previoulsyReviewedTranslations = []
	let skippedValues = []
	let skippedTranslations = []

	const updateTranslatedRules = (
		rule,
		attr,
		transVal,
		refVal,
		onlyNeedToUpdateLocks
	) => {
		let key = [rule, attr]
		let refKey = [rule, attr + utils.LOCK_KEY_EXT]
		let autoKey = [rule, attr + utils.AUTO_KEY_EXT]
		let previousKey = [rule, attr + utils.PREVIOUS_REVIEW_KEY_EXT]
		let currentVal = translatedRules[rule] && translatedRules[rule][attr]

		if ('mosaique' === attr) {
			key = [rule, attr, 'suggestions']
			refKey = [rule, attr, 'suggestions' + utils.LOCK_KEY_EXT]
			previousKey = [rule, attr, 'suggestions' + utils.PREVIOUS_REVIEW_KEY_EXT]
			autoKey = [rule, attr, 'suggestions' + utils.AUTO_KEY_EXT]
			currentVal =
				translatedRules[rule] && translatedRules[rule][attr]['suggestions']
		}
		if (
			currentVal &&
			translatedRules[rule][attr + utils.AUTO_KEY_EXT] &&
			translatedRules[rule][attr] !==
				translatedRules[rule][attr + utils.AUTO_KEY_EXT] &&
			!onlyNeedToUpdateLocks
		) {
			// The previous translated value has been manually edited, we notify the user.
			translatedRules = R.assocPath(previousKey, currentVal, translatedRules)
			previoulsyReviewedTranslations.push(`${rule} -> ${attr}`)
		}

		if (!onlyNeedToUpdateLocks) {
			translatedRules = R.assocPath(key, transVal, translatedRules)
			translatedRules = R.assocPath(autoKey, transVal, translatedRules)
		}
		translatedRules = R.assocPath(refKey, refVal, translatedRules)
	}
	const translate = (value) => {
		return deepl.fetchTranslation(
			value,
			srcLang.toUpperCase(),
			destLang.toUpperCase()
		)
	}
	const translateMarkdown = (value) => {
		return deepl.fetchTranslationMarkdown(
			value,
			srcLang.toUpperCase(),
			destLang.toUpperCase()
		)
	}

	await Promise.all(
		Object.values(entryToTranslate).map(async ({ rule, attr, refVal }) => {
			let answer
			if (interactiveMode) {
				const translatedRule = translatedRules[rule]
				const isNewRule = translatedRule === undefined
				const diff = gitDiff(
					isNewRule ? '' : translatedRule[attr + utils.LOCK_KEY_EXT],
					refVal,
					{
						color: true,
						forceFake: true,
					}
				)
				console.log(
					`\n${cli.styledRuleNameWithOptionalAttr(rule, attr)}${
						isNewRule ? ` ${cli.italic(cli.green('new'))}` : ''
					}\n${diff}`
				)
				do {
					if (answer === 'p') {
						console.log(`${cli.dim('')}${translatedRules[rule][attr]}`)
					}
					answer = prompt(cli.dim(`(tuspa): `))
				} while (!['u', 's', 't', 'a'].includes(answer))
			}
			if (answer === 'a') {
				console.log('Exiting...')
				exit(0)
			} else if (answer === 's') {
				return skippedValues.push({ rule, msg: 'skipped' })
			}

			const onlyNeedToUpdateLocks = onlyUpdateLocks || answer === 'u'

			try {
				const translatedValue = onlyNeedToUpdateLocks
					? undefined
					: 'description' === attr || 'note' === attr
					? await translateMarkdown(refVal)
					: await translate(refVal)

				if (!translatedValue && !onlyNeedToUpdateLocks) {
					skippedValues.push({
						rule,
						msg: 'an error occurred while translating',
					})
				} else {
					if (onlyNeedToUpdateLocks) {
						skippedTranslations.push(rule)
					}
					updateTranslatedRules(
						rule,
						attr,
						translatedValue,
						refVal,
						onlyNeedToUpdateLocks
					)
				}
			} catch (err) {
				skippedValues.push({ rule, msg: err.message })
			}
		})
	)

	skippedTranslations.forEach((rule) => {
		cli.printInfo(
			`[INFO] - '${rule}': only the reference value has been updated`
		)
	})
	skippedValues.forEach(({ rule, msg }) => {
		cli.printWarn(`[SKIPPED] - '${rule}': ${msg}`)
	})
	previoulsyReviewedTranslations.forEach((rule) => {
		cli.printErr(
			`[PREVIOUSLY REVIEWED] - '${rule}': previous translation has been previously corrected by hand`
		)
	})
	console.log(`Writing translated rules to: ${destPath}`)
	utils.writeYAML(destPath, translatedRules)
}

const rules = getModelFromSource(srcFile, ['data/i18n/**'], { verbose: true })

destLangs.forEach(async (destLang) => {
	const destPath = path.resolve(
		`data/i18n/t9n/translated-rules-${destLang}.yaml`
	)
	const destRules = R.mergeAll(utils.readYAML(destPath))
	console.log(`Getting missing rule for ${destLang}...`)
	let missingRules = utils.getMissingRules(rules, destRules)

	if (0 < missingRules.length) {
		console.log(
			`Translating ${cli.green(
				missingRules.length
			)} new entries to ${cli.yellow(destLang)}...`
		)
		if (interactiveMode) {
			console.log(
				`For each rule, you can choose to:\n\n${cli.styledPromptActions(
					[
						'translate',
						'update .lock attribute',
						'skip',
						'print current translation',
						'abort',
						// TODO: add a 'suggest translation' option?
					],
					'\n'
				)}`
			)
		}

		translateTo(srcLang, destLang, destPath, missingRules, destRules)
	} else {
		console.log(`Found no new entry to translate...`)
	}
})
