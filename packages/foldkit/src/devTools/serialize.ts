import {
  Array,
  Function,
  Match,
  Option,
  Predicate,
  Record,
  Redacted,
} from 'effect'

import type {
  SerializedCommand,
  SerializedEntry,
  SerializedMount,
} from './protocol.js'
import type { CommandRecord, HistoryEntry, MountRecord } from './store.js'
import { extractSubmodelInfo } from './submodelPath.js'

const inspectableCache = new WeakMap<object, unknown>()

// The objects on the path from the root to the value being converted. A value
// that appears on its own path is circular. A value that appears twice on
// different paths is shared, and converts in full both times.
const ancestors = new Set<object>()

// Counts the circular markers placed so far, so a conversion can tell whether
// its own subtree held one.
let circularMarkersPlaced = 0

const computeInspectableValue = (value: unknown): unknown =>
  Match.value(value).pipe(
    Match.when(Predicate.isBigInt, bigint => ({
      _summary: 'bigint',
      value: bigint.toString(),
    })),
    Match.when(Predicate.isSymbol, symbol => ({
      _summary: 'symbol',
      description: String(symbol),
    })),
    Match.when(Predicate.isFunction, fn => ({
      _summary: 'function',
      name: fn.name,
    })),
    Match.when(Redacted.isRedacted, globalThis.String),
    Match.when(Match.instanceOf(File), file => ({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
    Match.when(Match.instanceOf(Blob), blob => ({
      size: blob.size,
      type: blob.type,
    })),
    Match.when(Match.instanceOf(Date), date => date.toISOString()),
    Match.when(Match.instanceOf(URL), ({ href }) => href),
    Match.when(globalThis.Array.isArray, items =>
      Array.map(items, item => toInspectableValue(item)),
    ),
    Match.when(Predicate.isObject, record =>
      Record.map(record, child => toInspectableValue(child)),
    ),
    Match.orElse(Function.identity),
  )

/**
 * Convert Effect `Redacted` values to their labeled placeholder strings and
 * DOM-class instances (File, Blob, Date, URL) to plain-object
 * representations so the tree renderer's key-enumeration walk can see their
 * meaningful data, which otherwise lives on the prototype as getters and
 * is invisible to `Object.keys`. Recurses through arrays and records so
 * the transform applies at every level. File is matched before Blob
 * because File extends Blob.
 *
 * Values JSON cannot carry become `{ _summary, ... }` markers that name what
 * they were: a `bigint` is `{ _summary: 'bigint', value: '5' }`, a symbol is
 * `{ _summary: 'symbol', description }` and a function is
 * `{ _summary: 'function', name }`. `JSON.stringify` throws on a `bigint` and
 * silently drops the other two, so the marker keeps the value distinguishable
 * from a string or a missing field on the wire.
 *
 * A value that refers back to one of its own ancestors becomes
 * `{ _summary: 'circular' }` at the repeated reference, so a circular Model or
 * Message converts instead of overflowing the stack. An object reachable by two
 * different paths is not circular and converts in full along both.
 *
 * Memoized by reference. The transform allocates fresh wrappers via
 * `Array.map` / `Record.map` even when the input contains no DOM classes
 * (because `map` always allocates), which would otherwise produce a fresh
 * tree of references on every call. Without memoization, the inspector
 * tree's row-level `lazyTreeNode` cache would miss on every row of every
 * render — the cached row args reference last render's wrapper objects, not
 * this render's. Memoizing on the input reference makes subsequent calls
 * with the same snapshot return identical references end-to-end, so the
 * row lazy actually hits.
 */
export const toInspectableValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') {
    return computeInspectableValue(value)
  }
  if (ancestors.has(value)) {
    circularMarkersPlaced += 1
    return { _summary: 'circular' }
  }
  if (inspectableCache.has(value)) {
    return inspectableCache.get(value)
  }
  const markersBefore = circularMarkersPlaced
  ancestors.add(value)
  try {
    const result = computeInspectableValue(value)
    // A subtree holding a marker depends on the path it was reached by, so it
    // is not memoized.
    if (circularMarkersPlaced === markersBefore) {
      inspectableCache.set(value, result)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Convert a runtime `CommandRecord` to its wire shape. Args are wrapped in an
 * `Option` so `None` cleanly distinguishes argless Commands from Commands that
 * happen to have an empty args record. Nested Effect `Redacted` values become
 * their placeholder strings before transmission.
 */
export const toSerializedCommand = (
  command: CommandRecord,
): SerializedCommand => ({
  name: command.name,
  args: Option.map(
    Option.fromNullishOr(command.args),
    Record.map(toInspectableValue),
  ),
  maybeSubmodelPath: command.maybeSubmodelPath,
})

/**
 * Convert a runtime `MountRecord` to its wire shape. Args are wrapped in an
 * `Option` so `None` cleanly distinguishes argless Mounts from Mounts that
 * happen to have an empty args record. Nested Effect `Redacted` values become
 * their placeholder strings before transmission.
 */
export const toSerializedMount = (mount: MountRecord): SerializedMount => ({
  name: mount.name,
  args: Option.map(
    Option.fromNullishOr(mount.args),
    Record.map(toInspectableValue),
  ),
})

/**
 * Convert a `HistoryEntry` plus its absolute index into the wire-friendly
 * `SerializedEntry` shape. Flattens the diff's `HashSet` path collections to
 * plain string arrays for JSON transmission and runs the message body through
 * `toInspectableValue` so Effect `Redacted` values become placeholders and
 * DOM-class instances become inspectable objects.
 */
export const toSerializedEntry = (
  entry: HistoryEntry,
  index: number,
): SerializedEntry => {
  const { submodelPath, maybeLeafTag } = extractSubmodelInfo(
    entry.tag,
    entry.message,
  )

  return {
    index,
    tag: entry.tag,
    message: toInspectableValue(entry.message),
    commands: Array.map(entry.commands, toSerializedCommand),
    mountStarts: Array.map(entry.mountStarts, toSerializedMount),
    mountEnds: Array.map(entry.mountEnds, toSerializedMount),
    timestamp: entry.timestamp,
    isModelChanged: entry.isModelChanged,
    changedPaths: Array.fromIterable(entry.diff.changedPaths),
    affectedPaths: Array.fromIterable(entry.diff.affectedPaths),
    submodelPath,
    maybeLeafTag,
  }
}
