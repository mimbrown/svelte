/** @import { Derived, Effect, Source, Value } from '#client' */
import { DEV } from 'esm-env';
import {
	current_component_context,
	current_reaction,
	new_deps,
	current_effect,
	current_untracked_writes,
	get,
	is_runes,
	schedule_effect,
	set_current_untracked_writes,
	set_signal_status,
	untrack,
	increment_version,
	update_effect
} from '../runtime.js';
import { equals, safe_equals } from './equality.js';
import {
	CLEAN,
	DERIVED,
	DIRTY,
	BRANCH_EFFECT,
	INSPECT_EFFECT,
	UNOWNED,
	MAYBE_DIRTY
} from '../constants.js';
import * as e from '../errors.js';
import { derived } from './deriveds.js';

let inspect_effects = new Set();

/**
 * @template V
 * @param {V} v
 * @returns {Source<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
export function source(v) {
	return {
		f: 0, // TODO ideally we could skip this altogether, but it causes type errors
		v,
		reactions: null,
		equals,
		version: 0
	};
}

/**
 * @template V
 * @param {() => V} get_value
 * @returns {(value?: V) => V}
 */
export function source_link(get_value) {
	var was_local = false;
	var local_source = source(/** @type {V} */ (undefined));

	var linked_derived = derived(() => {
		var local_value = /** @type {V} */ (get(local_source));
		var linked_value = get_value();

		if (was_local) {
			was_local = false;
			return local_value;
		}

		return linked_value;
	});

	return function (/** @type {any} */ value) {
		if (arguments.length > 0) {
			was_local = true;
			set(local_source, value);
			get(linked_derived);
			return value;
		}

		return (local_source.v = get(linked_derived));
	};
}

/**
 * @template V
 * @param {V} initial_value
 * @returns {Source<V>}
 */
/*#__NO_SIDE_EFFECTS__*/
export function mutable_source(initial_value) {
	const s = source(initial_value);
	s.equals = safe_equals;

	// bind the signal to the component context, in case we need to
	// track updates to trigger beforeUpdate/afterUpdate callbacks
	if (current_component_context !== null && current_component_context.l !== null) {
		(current_component_context.l.s ??= []).push(s);
	}

	return s;
}

/**
 * @template V
 * @param {Value<V>} source
 * @param {V} value
 */
export function mutate(source, value) {
	set(
		source,
		untrack(() => get(source))
	);
	return value;
}

/**
 * @template V
 * @param {Source<V>} source
 * @param {V} value
 * @returns {V}
 */
export function set(source, value) {
	if (current_reaction !== null && is_runes() && (current_reaction.f & DERIVED) !== 0) {
		e.state_unsafe_mutation();
	}

	if (!source.equals(value)) {
		source.v = value;
		source.version = increment_version();

		mark_reactions(source, DIRTY);

		// If the current signal is running for the first time, it won't have any
		// reactions as we only allocate and assign the reactions after the signal
		// has fully executed. So in the case of ensuring it registers the reaction
		// properly for itself, we need to ensure the current effect actually gets
		// scheduled. i.e: `$effect(() => x++)`
		if (
			is_runes() &&
			current_effect !== null &&
			(current_effect.f & CLEAN) !== 0 &&
			(current_effect.f & BRANCH_EFFECT) === 0
		) {
			if (new_deps !== null && new_deps.includes(source)) {
				set_signal_status(current_effect, DIRTY);
				schedule_effect(current_effect);
			} else {
				if (current_untracked_writes === null) {
					set_current_untracked_writes([source]);
				} else {
					current_untracked_writes.push(source);
				}
			}
		}

		if (DEV) {
			for (const effect of inspect_effects) {
				update_effect(effect);
			}

			inspect_effects.clear();
		}
	}

	return value;
}

/**
 * @param {Value} signal
 * @param {number} status should be DIRTY or MAYBE_DIRTY
 * @returns {void}
 */
function mark_reactions(signal, status) {
	var reactions = signal.reactions;
	if (reactions === null) return;

	var runes = is_runes();
	var length = reactions.length;

	for (var i = 0; i < length; i++) {
		var reaction = reactions[i];
		var flags = reaction.f;

		// Skip any effects that are already dirty
		if ((flags & DIRTY) !== 0) continue;

		// In legacy mode, skip the current effect to prevent infinite loops
		if (!runes && reaction === current_effect) continue;

		// Inspect effects need to run immediately, so that the stack trace makes sense
		if (DEV && (flags & INSPECT_EFFECT) !== 0) {
			inspect_effects.add(reaction);
			continue;
		}

		set_signal_status(reaction, status);

		// If the signal a) was previously clean or b) is an unowned derived, then mark it
		if ((flags & (CLEAN | UNOWNED)) !== 0) {
			if ((flags & DERIVED) !== 0) {
				mark_reactions(/** @type {Derived} */ (reaction), MAYBE_DIRTY);
			} else {
				schedule_effect(/** @type {Effect} */ (reaction));
			}
		}
	}
}
