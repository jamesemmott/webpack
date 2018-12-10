/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const Stats = require("./Stats");

/** @typedef {import("../declarations/WebpackOptions").WatchOptions} WatchOptions */
/** @typedef {import("./Compilation")} Compilation */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./Stats")} Stats */

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} result
 */

// TODO refactor watchpack to report timestamps in the correct format
const toFileSystemInfoEntryMap = timestamps => {
	const map = new Map();
	for (const [key, ts] of timestamps) {
		map.set(key, { safeTime: ts });
	}
	return map;
};

class Watching {
	/**
	 * @param {Compiler} compiler the compiler
	 * @param {WatchOptions} watchOptions options
	 * @param {Callback<Stats>} handler completion handler
	 */
	constructor(compiler, watchOptions, handler) {
		this.startTime = null;
		this.invalid = false;
		this.handler = handler;
		/** @type {Callback<void>[]} */
		this.callbacks = [];
		this.closed = false;
		if (typeof watchOptions === "number") {
			this.watchOptions = {
				aggregateTimeout: watchOptions
			};
		} else if (watchOptions && typeof watchOptions === "object") {
			this.watchOptions = Object.assign({}, watchOptions);
		} else {
			this.watchOptions = {};
		}
		this.watchOptions.aggregateTimeout =
			this.watchOptions.aggregateTimeout || 200;
		this.compiler = compiler;
		this.running = true;
		this.compiler.readRecords(err => {
			if (err) return this._done(err);

			this._go();
		});
	}

	_go() {
		this.startTime = Date.now();
		this.running = true;
		this.invalid = false;
		this.compiler.cache.endIdle(err => {
			if (err) return this._done(err);
			this.compiler.hooks.watchRun.callAsync(this.compiler, err => {
				if (err) return this._done(err);
				const onCompiled = (err, compilation) => {
					if (err) return this._done(err);
					if (this.invalid) return this._done();

					if (this.compiler.hooks.shouldEmit.call(compilation) === false) {
						return this._done(null, compilation);
					}

					this.compiler.emitAssets(compilation, err => {
						if (err) return this._done(err);
						if (this.invalid) return this._done();

						this.compiler.emitRecords(err => {
							if (err) return this._done(err);

							if (compilation.hooks.needAdditionalPass.call()) {
								compilation.needAdditionalPass = true;

								const stats = new Stats(compilation);
								stats.startTime = this.startTime;
								stats.endTime = Date.now();
								this.compiler.hooks.done.callAsync(stats, err => {
									if (err) return this._done(err);

									this.compiler.hooks.additionalPass.callAsync(err => {
										if (err) return this._done(err);
										this.compiler.compile(onCompiled);
									});
								});
								return;
							}
							return this._done(null, compilation);
						});
					});
				};
				this.compiler.compile(onCompiled);
			});
		});
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {Stats} the compilation stats
	 */
	_getStats(compilation) {
		const stats = new Stats(compilation);
		stats.startTime = this.startTime;
		stats.endTime = Date.now();
		return stats;
	}

	/**
	 * @param {Error=} err an optional error
	 * @param {Compilation=} compilation the compilation
	 * @returns {void}
	 */
	_done(err, compilation) {
		this.running = false;
		if (this.invalid) return this._go();

		const stats = compilation ? this._getStats(compilation) : null;
		if (err) {
			this.compiler.hooks.failed.call(err);
			this.compiler.cache.beginIdle();
			this.handler(err, stats);
			return;
		}

		this.compiler.hooks.done.callAsync(stats, () => {
			this.compiler.cache.beginIdle();
			this.handler(null, stats);
			if (!this.closed) {
				this.watch(
					Array.from(compilation.fileDependencies),
					Array.from(compilation.contextDependencies),
					Array.from(compilation.missingDependencies)
				);
			}
			for (const cb of this.callbacks) cb();
			this.callbacks.length = 0;
		});
	}

	watch(files, dirs, missing) {
		this.pausedWatcher = null;
		this.watcher = this.compiler.watchFileSystem.watch(
			files,
			dirs,
			missing,
			this.startTime,
			this.watchOptions,
			(
				err,
				filesModified,
				contextModified,
				missingModified,
				fileTimestamps,
				contextTimestamps,
				removedFiles
			) => {
				this.pausedWatcher = this.watcher;
				this.watcher = null;
				if (err) {
					return this.handler(err);
				}
				this.compiler.fileTimestamps = toFileSystemInfoEntryMap(fileTimestamps);
				this.compiler.contextTimestamps = toFileSystemInfoEntryMap(
					contextTimestamps
				);
				this.compiler.removedFiles = removedFiles;
				this._invalidate();
			},
			(fileName, changeTime) => {
				this.compiler.hooks.invalid.call(fileName, changeTime);
			}
		);
	}

	/**
	 * @param {Callback<void>=} callback signals when the build is invalidated
	 * @returns {void}
	 */
	invalidate(callback) {
		if (callback) {
			this.callbacks.push(callback);
		}
		if (this.watcher) {
			this.compiler.fileTimestamps = toFileSystemInfoEntryMap(
				this.watcher.getFileTimestamps()
			);
			this.compiler.contextTimestamps = toFileSystemInfoEntryMap(
				this.watcher.getContextTimestamps()
			);
		}
		this._invalidate();
	}

	_invalidate() {
		if (this.watcher) {
			this.pausedWatcher = this.watcher;
			this.watcher.pause();
			this.watcher = null;
		}
		if (this.running) {
			this.invalid = true;
		} else {
			this._go();
		}
	}

	/**
	 * @param {Callback<void>} callback signals when the watcher is closed
	 * @returns {void}
	 */
	close(callback) {
		const finalCallback = () => {
			this.compiler.running = false;
			this.compiler.watchMode = false;
			this.compiler.fileTimestamps = undefined;
			this.compiler.contextTimestamps = undefined;
			this.compiler.removedFiles = undefined;
			this.compiler.cache.shutdown(err => {
				this.compiler.hooks.watchClose.call();
				if (callback !== undefined) callback(err);
			});
		};

		this.closed = true;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.pausedWatcher) {
			this.pausedWatcher.close();
			this.pausedWatcher = null;
		}
		if (this.running) {
			this.invalid = true;
			this._done = finalCallback;
		} else {
			finalCallback();
		}
	}
}

module.exports = Watching;
